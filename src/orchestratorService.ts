import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  AckRunNotificationInputSchema,
  BackendSchema,
  CancelRunInputSchema,
  CodexNetworkSchema,
  GetObservabilitySnapshotInputSchema,
  GetOrchestratorStatusInputSchema,
  GetRunEventsInputSchema,
  GetRunProgressInputSchema,
  isTerminalStatus,
  ListRunNotificationsInputSchema,
  ListWorkerProfilesInputSchema,
  orchestratorError,
  PruneRunsInputSchema,
  ReasoningEffortSchema,
  RegisterSupervisorInputSchema,
  RunIdInputSchema,
  SendFollowupInputSchema,
  ShutdownInputSchema,
  SignalSupervisorEventInputSchema,
  StartRunInputSchema,
  ServiceTierSchema,
  UnregisterSupervisorInputSchema,
  UpsertWorkerProfileInputSchema,
  WaitForAnyRunInputSchema,
  WaitForRunInputSchema,
  WorkerPostureSchema,
  wrapErr,
  wrapOk,
  type Backend,
  type CodexNetwork,
  type RunDisplayMetadata,
  type RunMeta,
  type RunNotification,
  type RunNotificationKind,
  type ReasoningEffort,
  type ModelSource,
  type OrchestratorError,
  type RpcPolicyContext,
  type StartRun,
  type RunStatus,
  type RunModelSettings,
  type RunError,
  type RunErrorCategory,
  type ServiceTier,
  type SupervisorEvent,
  type ToolResponse,
  type UpsertWorkerProfile,
  type WorkerEvent,
  type WorkerPosture,
  type WorkerResult,
} from './contract.js';
import { errorFromEvent } from './backend/common.js';
import { OrchestratorRegistry } from './daemon/orchestratorRegistry.js';
import { computeOrchestratorStatusSnapshot } from './daemon/orchestratorStatus.js';
import { validateClaudeModelAndEffort } from './backend/claudeValidation.js';
import type { AccountSpawnContribution, RuntimeRunHandle, WorkerRuntime } from './backend/runtime.js';
import type { EarlyEventInterceptor, EarlyEventInterceptorOutcome } from './backend/WorkerBackend.js';
import { copySessionJsonlForRotation, type CopyOutcome } from './claude/sessionCopy.js';
import {
  appendRotationEntry,
  readAccountUsed,
  readRotationHistory,
  readRotationState,
  resolveClaudeAccountBinding,
  ROTATION_HISTORY_CAP,
  type ClaudeRotationHistoryEntry,
  type ClaudeRotationState,
} from './claude/accountBinding.js';
import {
  accountRegistryPaths,
  loadAccountRegistry,
  markAccountCooledDown,
  pickHealthyAccount,
  resolveAccountSpawn,
} from './claude/accountRegistry.js';
import { getBackendStatus } from './diagnostics.js';
import { captureGitSnapshot } from './gitSnapshot.js';
import { buildObservabilitySnapshot } from './observability.js';
import {
  createWorkerCapabilityCatalog,
  inspectWorkerProfiles,
  parseWorkerProfileManifest,
  type InspectedWorkerProfiles,
  type InvalidWorkerProfile,
  type ValidatedWorkerProfile,
  type WorkerProfile,
  type WorkerProfileManifest,
} from './opencode/capabilities.js';
import { getPackageVersion } from './packageMetadata.js';
import { RunStore } from './runStore.js';
import { loadInspectedWorkerProfilesFromFile, resolveWorkerProfilesFile } from './workerRouting.js';

interface OrchestratorConfig {
  default_idle_timeout_seconds: number;
  max_idle_timeout_seconds: number;
  default_execution_timeout_seconds: number | null;
  max_execution_timeout_seconds: number;
}

const defaultConfig: OrchestratorConfig = {
  default_idle_timeout_seconds: 20 * 60,
  max_idle_timeout_seconds: 2 * 60 * 60,
  default_execution_timeout_seconds: null,
  max_execution_timeout_seconds: 4 * 60 * 60,
};

const legacyGeneratedConfig: OrchestratorConfig = {
  default_idle_timeout_seconds: defaultConfig.default_idle_timeout_seconds,
  max_idle_timeout_seconds: defaultConfig.max_idle_timeout_seconds,
  default_execution_timeout_seconds: 30 * 60,
  max_execution_timeout_seconds: 4 * 60 * 60,
};

type ToolResult = ToolResponse<object>;
type OrchestratorLogger = (message: string) => void;

/**
 * D-COR-Resume-Layer Step 2: window for the in-run session_not_found
 * interceptor. Not on the public contract.
 */
const SESSION_NOT_FOUND_INTERCEPT_THRESHOLD = { events: 50, ms: 5_000 } as const;

interface RotationTrackerEntry {
  /** Promise gating the in-flight picker for this parent. */
  lock: Promise<void>;
  /**
   * Destinations already bound to a child run of this parent. Source-of-truth
   * is the run store (`metadata.claude_account_used`); this is a cache.
   */
  claimed: Set<string>;
  /** True once `claimed` has been hydrated from disk for this parent. */
  reconstructed: boolean;
}

export interface OrchestratorDispatchContext {
  frontend_version?: string | null;
  policy_context?: RpcPolicyContext | null;
}

interface ResolvedStartRunTarget {
  backendName: Backend;
  runtime: WorkerRuntime;
  model: string | null;
  reasoningEffort: ReasoningEffort | undefined;
  serviceTier: ServiceTier | undefined;
  codexNetwork: CodexNetwork | undefined;
  // Issue #58: resolved worker posture from profile or direct-mode input.
  // `undefined` means "not specified"; `modelSettingsForBackend` normalizes
  // to the concrete `'trusted'` default before persistence.
  workerPosture: WorkerPosture | undefined;
  metadata: Record<string, unknown>;
  profileId: string | null;
  accountSpawn?: AccountSpawnContribution;
}

export type RunLifecycleEventKind = 'started' | 'activity' | 'terminal' | 'notification';

export interface RunLifecycleEvent {
  kind: RunLifecycleEventKind;
  run_id: string;
  orchestrator_id: string | null;
  status?: RunStatus;
  notification?: RunNotification;
}

export type RunLifecycleListener = (event: RunLifecycleEvent) => void;

export class OrchestratorService {
  private readonly activeRuns = new Map<string, RuntimeRunHandle>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly profileUpdateLocks = new Map<string, Promise<void>>();
  /**
   * Per-parent rotation tracker (D-COR-Lock). Hydrated lazily; entries live
   * until the parent run is pruned. The in-memory state is a cache; the
   * source-of-truth is `metadata.claude_rotation_state.parent_run_id` +
   * `metadata.claude_account_used` written to each child run's `meta.json`.
   */
  private readonly rotationTrackers = new Map<string, RotationTrackerEntry>();
  private config: OrchestratorConfig = defaultConfig;
  private shuttingDown = false;
  readonly orchestratorRegistry = new OrchestratorRegistry();
  private readonly runLifecycleListeners = new Set<RunLifecycleListener>();

  constructor(
    readonly store: RunStore,
    private readonly runtimes: Map<Backend, WorkerRuntime>,
    private readonly logger: OrchestratorLogger = defaultLogger,
  ) {}

  onRunLifecycle(listener: RunLifecycleListener): () => void {
    this.runLifecycleListeners.add(listener);
    return () => {
      this.runLifecycleListeners.delete(listener);
    };
  }

  emitRunLifecycle(event: RunLifecycleEvent): void {
    for (const listener of this.runLifecycleListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger(`run lifecycle listener threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async initialize(): Promise<void> {
    await this.store.ensureReady();
    await this.loadConfig();
    await this.orphanRunningRuns();
  }

  async dispatch(method: string, params: unknown, context: OrchestratorDispatchContext = {}): Promise<unknown> {
    switch (method) {
      case 'ping':
        return wrapOk({ pong: true, daemon_pid: process.pid, daemon_version: getPackageVersion() });
      case 'shutdown':
        return this.shutdown(params);
      case 'prune_runs':
        return this.pruneRuns(params);
      case 'start_run':
        return this.startRun(params, context);
      case 'list_worker_profiles':
        return this.listWorkerProfiles(params);
      case 'upsert_worker_profile':
        return this.upsertWorkerProfile(params, context);
      case 'list_runs':
        return wrapOk({ runs: await this.store.listRuns() });
      case 'get_run_status':
        return this.getRunStatus(params);
      case 'get_run_events':
        return this.getRunEvents(params);
      case 'get_run_progress':
        return this.getRunProgress(params);
      case 'wait_for_run':
        return this.waitForRun(params);
      case 'wait_for_any_run':
        return this.waitForAnyRun(params);
      case 'list_run_notifications':
        return this.listRunNotifications(params);
      case 'ack_run_notification':
        return this.ackRunNotification(params);
      case 'get_run_result':
        return this.getRunResult(params);
      case 'send_followup':
        return this.sendFollowup(params, context);
      case 'cancel_run':
        return this.cancelRun(params);
      case 'get_backend_status':
        return wrapOk({
          status: await getBackendStatus({
            frontendVersion: context.frontend_version ?? getPackageVersion(),
            daemonVersion: getPackageVersion(),
            daemonPid: process.pid,
          }),
        });
      case 'get_observability_snapshot':
        return this.getObservabilitySnapshot(params, context);
      case 'register_supervisor':
        return this.registerSupervisor(params);
      case 'signal_supervisor_event':
        return this.signalSupervisorEvent(params);
      case 'unregister_supervisor':
        return this.unregisterSupervisor(params);
      case 'get_orchestrator_status':
        return this.getOrchestratorStatus(params);
      default:
        return wrapErr(orchestratorError('INVALID_INPUT', `Unknown method: ${method}`));
    }
  }

  registerSupervisor(params: unknown): ToolResult {
    const parsed = RegisterSupervisorInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const record = this.orchestratorRegistry.register({
      client: parsed.data.client,
      label: parsed.data.label,
      cwd: parsed.data.cwd,
      display: parsed.data.display,
      orchestrator_id: parsed.data.orchestrator_id,
    });
    return wrapOk({ orchestrator: record });
  }

  signalSupervisorEvent(params: unknown): ToolResult {
    const parsed = SignalSupervisorEventInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const updated = this.orchestratorRegistry.applyEvent(parsed.data.orchestrator_id, parsed.data.event as SupervisorEvent);
    if (!updated) {
      return wrapErr(orchestratorError('INVALID_INPUT', `Unknown orchestrator id: ${parsed.data.orchestrator_id}`));
    }
    return wrapOk({ orchestrator_id: parsed.data.orchestrator_id, event: parsed.data.event });
  }

  unregisterSupervisor(params: unknown): ToolResult {
    const parsed = UnregisterSupervisorInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const removed = this.orchestratorRegistry.unregister(parsed.data.orchestrator_id);
    return wrapOk({ orchestrator_id: parsed.data.orchestrator_id, removed });
  }

  async getOrchestratorStatus(params: unknown): Promise<ToolResult> {
    const parsed = GetOrchestratorStatusInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const state = this.orchestratorRegistry.get(parsed.data.orchestrator_id);
    if (!state) {
      return wrapErr(orchestratorError('INVALID_INPUT', `Unknown orchestrator id: ${parsed.data.orchestrator_id}`));
    }
    const ownedRunSnapshot = await this.collectOwnedRunSnapshot(parsed.data.orchestrator_id);
    const status = computeOrchestratorStatusSnapshot(state, ownedRunSnapshot);
    return wrapOk({
      orchestrator: state.record,
      status,
      display: state.record.display,
    });
  }

  /**
   * Snapshot the orchestrator's owned worker runs for the aggregate-status
   * computation. Pure read-only scan.
   *
   * `running_child_count` counts owned runs whose status is non-terminal.
   * `failed_unacked_count` counts unacked `fatal_error` notifications across
   * **all** owned runs, including still-running runs (D3b rule 1: `attention`
   * must dominate while ANY owned run has an unacked fatal notification, even
   * if that run hasn't reached terminal state yet).
   */
  async collectOwnedRunSnapshot(orchestratorId: string): Promise<{ running: number; failed_unacked: number }> {
    const runs = await this.store.listRuns();
    let running = 0;
    const ownedRunIds: string[] = [];
    for (const run of runs) {
      const stamped = typeof run.metadata?.orchestrator_id === 'string' ? run.metadata.orchestrator_id : null;
      if (stamped !== orchestratorId) continue;
      ownedRunIds.push(run.run_id);
      if (!isTerminalStatus(run.status)) running += 1;
    }
    if (ownedRunIds.length === 0) return { running, failed_unacked: 0 };
    const notifications = await this.store.listNotifications({
      runIds: ownedRunIds,
      kinds: ['fatal_error'],
      includeAcked: false,
      limit: ownedRunIds.length,
    });
    return { running, failed_unacked: notifications.length };
  }

  async startRun(params: unknown, context: OrchestratorDispatchContext = {}): Promise<ToolResult> {
    const parsed = StartRunInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const input = parsed.data;
    const resolved = await this.resolveStartRunTarget(input);
    if (!resolved.ok) return wrapErr(resolved.error);
    const { backendName, runtime, model, reasoningEffort, serviceTier, codexNetwork, workerPosture, metadata: resolvedMetadata, profileId } = resolved.value;
    const metadata = stampOrchestratorIdInMetadata(resolvedMetadata, context.policy_context);
    const accountSpawn = resolved.value.accountSpawn;
    const idleTimeout = this.resolveIdleTimeout(input.idle_timeout_seconds);
    if (!idleTimeout.ok) return wrapErr(idleTimeout.error);
    const executionTimeout = this.resolveExecutionTimeout(input.execution_timeout_seconds);
    if (!executionTimeout.ok) return wrapErr(executionTimeout.error);
    const settings = modelSettingsForBackend(backendName, model, reasoningEffort, serviceTier, codexNetwork, workerPosture);
    if (!settings.ok) return wrapErr(settings.error);

    const meta = await this.store.createRun({
      backend: backendName,
      cwd: input.cwd,
      prompt: input.prompt,
      model,
      model_source: model ? 'explicit' : 'backend_default',
      model_settings: settings.value,
      display: displayMetadata(input.metadata, input.prompt),
      metadata,
      idle_timeout_seconds: idleTimeout.value,
      execution_timeout_seconds: executionTimeout.value,
    });
    await this.captureAndPersistGitSnapshot(meta.run_id, input.cwd);
    await this.maybeEmitCodexNetworkDefaultWarning(meta.run_id, backendName, codexNetwork, profileId, settings.value.worker_posture ?? 'trusted');

    await this.startManagedRun(meta.run_id, runtime, input.prompt, input.cwd, idleTimeout.value, executionTimeout.value, settings.value, model, undefined, accountSpawn);
    return wrapOk({ run_id: meta.run_id });
  }

  // C12 / T11: emit a single non-blocking lifecycle warning event when a codex
  // run resolved its codex_network from the issue #31 OD1=B default
  // ('isolated', --ignore-user-config, no network) because neither the
  // profile nor the direct-mode argument set it explicitly. The warning
  // surfaces in the run's event log alongside failing tool calls so users
  // hitting the breaking change can correlate.
  //
  // Issue #58 review follow-up (Medium 1): suppress the warning under
  // `worker_posture: 'trusted'`. The trusted-default behavior (workspace-write
  // sandbox + network on) is the intended product direction, not a surprise
  // breaking change; there is also no explicit `codex_network` enum value
  // an operator could set to preserve the same argv (null is the trusted
  // default, distinct from 'isolated' / 'workspace' / 'user-config'). Only
  // restricted+absent keeps emitting the warning, since restricted preserves
  // the issue #31 closed-by-default isolated behavior.
  private async maybeEmitCodexNetworkDefaultWarning(
    runId: string,
    backendName: Backend,
    explicitCodexNetwork: CodexNetwork | undefined,
    profileId: string | null,
    workerPosture: WorkerPosture,
  ): Promise<void> {
    if (backendName !== 'codex' || explicitCodexNetwork !== undefined) return;
    if (workerPosture !== 'restricted') return;
    const profilePart = profileId ? `profile ${profileId}` : 'direct-mode run';
    const message = `agent-orchestrator codex_network not set on ${profilePart} (worker_posture=restricted); defaulting to 'isolated' (no network access, --ignore-user-config). Set codex_network explicitly to silence this warning, or move the profile to worker_posture: 'trusted' to opt into backend-native parity. See docs/development/codex-backend.md for migration.`;
    try {
      await this.store.appendEvent(runId, {
        type: 'lifecycle',
        payload: {
          state: 'codex_network_defaulted',
          warning: message,
          profile: profileId,
          worker_posture: workerPosture,
          resolved_codex_network: 'isolated',
          migration_doc: 'docs/development/codex-backend.md',
          issue: 31,
        },
      });
    } catch (error) {
      this.logger(`failed to emit codex_network default warning for run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async resolveStartRunTarget(input: StartRun): Promise<{ ok: true; value: ResolvedStartRunTarget } | { ok: false; error: OrchestratorError }> {
    if (!input.profile) {
      if (!input.backend) {
        return { ok: false, error: orchestratorError('INVALID_INPUT', 'Direct worker starts require backend') };
      }
      if (input.codex_network !== undefined && input.backend !== 'codex') {
        return { ok: false, error: orchestratorError('INVALID_INPUT', `codex_network is only supported on the codex backend; got backend ${input.backend}`) };
      }
      const runtime = this.runtimes.get(input.backend);
      if (!runtime) return { ok: false, error: orchestratorError('BACKEND_NOT_FOUND', `Backend not found: ${input.backend}`) };

      const claudeBinding = await this.resolveClaudeBindingFromDirect(input);
      if (!claudeBinding.ok) return { ok: false, error: claudeBinding.error };

      const metadata = applyClaudeBindingToMetadata(input.metadata, claudeBinding.binding);
      return {
        ok: true,
        value: {
          backendName: input.backend,
          runtime,
          model: input.model ?? null,
          reasoningEffort: input.reasoning_effort,
          serviceTier: input.service_tier,
          codexNetwork: input.codex_network,
          workerPosture: input.worker_posture,
          metadata,
          profileId: null,
          accountSpawn: claudeBinding.binding?.accountSpawn,
        },
      };
    }

    const profilesFile = resolveWorkerProfilesFile(input.profiles_file, input.cwd);
    const loaded = await this.loadLiveWorkerProfiles(profilesFile);
    if (!loaded.ok) {
      return {
        ok: false,
        error: orchestratorError('INVALID_INPUT', `Worker profiles manifest is invalid: ${loaded.errors.join('; ')}`, {
          profiles_file: profilesFile,
          errors: loaded.errors,
        }),
      };
    }

    const profile = loaded.profiles.profiles[input.profile ?? ''];
    if (!profile) {
      const invalidProfile = loaded.profiles.invalid_profiles[input.profile ?? ''];
      if (invalidProfile) {
        return {
          ok: false,
          error: orchestratorError('INVALID_INPUT', `Worker profile ${input.profile} is invalid: ${invalidProfile.errors.join('; ')}`, {
            profile: input.profile,
            profiles_file: profilesFile,
            errors: invalidProfile.errors,
          }),
        };
      }
      return {
        ok: false,
        error: orchestratorError('INVALID_INPUT', `Worker profile ${input.profile} was not found in ${profilesFile}`, {
          profiles_file: profilesFile,
        }),
      };
    }

    const backendName = BackendSchema.safeParse(profile.backend);
    if (!backendName.success) {
      return {
        ok: false,
        error: orchestratorError('BACKEND_NOT_FOUND', `Backend not found: ${profile.backend}`, {
          profile: profile.id,
          profiles_file: profilesFile,
        }),
      };
    }
    const runtime = this.runtimes.get(backendName.data);
    if (!runtime) {
      return {
        ok: false,
        error: orchestratorError('BACKEND_NOT_FOUND', `Backend not found: ${backendName.data}`, {
          profile: profile.id,
          profiles_file: profilesFile,
        }),
      };
    }

    const profileSettings = parseProfileModelSettings(profile, profilesFile);
    if (!profileSettings.ok) return { ok: false, error: profileSettings.error };

    const claudeBinding = await this.resolveClaudeBindingFromProfile(backendName.data, profile);
    if (!claudeBinding.ok) return { ok: false, error: claudeBinding.error };

    const baseMetadata: Record<string, unknown> = {
      ...input.metadata,
      worker_profile: {
        mode: 'profile',
        profile: profile.id,
        profiles_file: profilesFile,
      },
    };
    return {
      ok: true,
      value: {
        backendName: backendName.data,
        runtime,
        model: profile.model ?? null,
        reasoningEffort: profileSettings.reasoningEffort,
        serviceTier: profileSettings.serviceTier,
        codexNetwork: profileSettings.codexNetwork,
        workerPosture: profileSettings.workerPosture,
        metadata: applyClaudeBindingToMetadata(baseMetadata, claudeBinding.binding),
        profileId: profile.id,
        accountSpawn: claudeBinding.binding?.accountSpawn,
      },
    };
  }

  private async resolveClaudeBindingFromDirect(input: StartRun): Promise<ClaudeBindingResolution> {
    if (input.backend !== 'claude') {
      // Schema-level guard rejects claude_* on non-claude backends, but be defensive.
      return { ok: true, binding: null };
    }
    if (!input.claude_account && !input.claude_accounts) {
      return { ok: true, binding: null };
    }
    const result = await resolveClaudeAccountBinding({
      home: this.store.root,
      account: input.claude_account,
      priority: input.claude_accounts ? [...input.claude_accounts] : undefined,
      source: 'direct',
    });
    return result.ok ? { ok: true, binding: result.value } : { ok: false, error: result.error };
  }

  private async resolveClaudeBindingFromProfile(
    backendName: Backend,
    profile: ValidatedWorkerProfile,
  ): Promise<ClaudeBindingResolution> {
    if (backendName !== 'claude') return { ok: true, binding: null };
    const account = profile.claude_account;
    const priority = profile.claude_account_priority;
    if (!account && !priority) return { ok: true, binding: null };
    const result = await resolveClaudeAccountBinding({
      home: this.store.root,
      account,
      priority: priority ? [...priority] : undefined,
      cooldownSecondsOverride: profile.claude_cooldown_seconds,
      source: 'profile',
    });
    return result.ok ? { ok: true, binding: result.value } : { ok: false, error: result.error };
  }

  async listWorkerProfiles(params: unknown): Promise<ToolResult> {
    const parsed = ListWorkerProfilesInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const profilesFile = resolveWorkerProfilesFile(parsed.data.profiles_file, parsed.data.cwd);
    const loaded = await this.loadLiveWorkerProfiles(profilesFile);
    if (!loaded.ok) {
      return wrapErr(orchestratorError('INVALID_INPUT', `Worker profiles manifest is invalid: ${loaded.errors.join('; ')}`, {
        profiles_file: profilesFile,
        errors: loaded.errors,
      }));
    }
    return wrapOk({
      profiles_file: profilesFile,
      profiles: Object.values(loaded.profiles.profiles)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(formatValidProfile),
      invalid_profiles: invalidProfileList(loaded.profiles),
      diagnostics: loaded.profiles.errors,
    });
  }

  async upsertWorkerProfile(params: unknown, context: OrchestratorDispatchContext = {}): Promise<ToolResult> {
    const parsed = UpsertWorkerProfileInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const input = parsed.data;
    const profilesFile = resolveWorkerProfilesFile(input.profiles_file, input.cwd);
    const policyError = enforcePolicyContextForUpsert(profilesFile, context.policy_context, input.cwd);
    if (policyError) return wrapErr(policyError);
    return await this.withProfileUpdateLock(profilesFile, () => this.upsertWorkerProfileLocked(input, profilesFile));
  }

  private async upsertWorkerProfileLocked(input: UpsertWorkerProfile, profilesFile: string): Promise<ToolResult> {
    const loaded = await readWorkerProfileManifestForUpdate(profilesFile);
    if (!loaded.ok) return wrapErr(loaded.error);
    const previous = loaded.manifest.profiles[input.profile] ?? null;
    if (!previous && !input.create_if_missing) {
      return wrapErr(orchestratorError('INVALID_INPUT', `Worker profile ${input.profile} was not found in ${profilesFile}`, {
        profile: input.profile,
        profiles_file: profilesFile,
      }));
    }

    const nextProfile = workerProfileFromUpsert(input);
    const nextManifest: WorkerProfileManifest = {
      version: loaded.manifest.version,
      profiles: {
        ...loaded.manifest.profiles,
        [input.profile]: nextProfile,
      },
    };

    const parsedManifest = parseWorkerProfileManifest(nextManifest);
    if (!parsedManifest.ok) {
      return wrapErr(orchestratorError('INVALID_INPUT', `Worker profiles manifest would be invalid: ${parsedManifest.errors.join('; ')}`, {
        profiles_file: profilesFile,
        errors: parsedManifest.errors,
      }));
    }
    const status = await getBackendStatus();
    const accounts = await this.loadClaudeAccountNames();
    if (!accounts.ok) {
      return wrapErr(orchestratorError('INVALID_STATE', accounts.message));
    }
    const inspected = inspectWorkerProfiles(parsedManifest.value, createWorkerCapabilityCatalog(status), {
      knownClaudeAccounts: accounts.value,
    });
    const invalidTarget = inspected.invalid_profiles[input.profile];
    if (invalidTarget) {
      return wrapErr(orchestratorError('INVALID_INPUT', `Worker profile ${input.profile} would be invalid: ${invalidTarget.errors.join('; ')}`, {
        profile: input.profile,
        profiles_file: profilesFile,
        errors: invalidTarget.errors,
      }));
    }

    await mkdir(dirname(profilesFile), { recursive: true, mode: 0o700 });
    await atomicWriteWorkerProfiles(profilesFile, `${JSON.stringify(parsedManifest.value, null, 2)}\n`);
    const updated = inspected.profiles[input.profile]!;
    return wrapOk({
      profiles_file: profilesFile,
      profile: formatValidProfile(updated),
      previous_profile: previous,
      created: previous === null,
      invalid_profiles: invalidProfileList(inspected),
      diagnostics: inspected.errors,
    });
  }

  /**
   * Serialize per-manifest read/validate/write so concurrent upserts to the
   * same profiles file cannot race and clobber unrelated profile changes.
   */
  private async withProfileUpdateLock<T>(profilesFile: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.profileUpdateLocks.get(profilesFile) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => released);
    this.profileUpdateLocks.set(profilesFile, tail);
    try {
      await previous;
      return await fn();
    } finally {
      release();
      if (this.profileUpdateLocks.get(profilesFile) === tail) {
        this.profileUpdateLocks.delete(profilesFile);
      }
    }
  }

  private async loadLiveWorkerProfiles(profilesFile: string): ReturnType<typeof loadInspectedWorkerProfilesFromFile> {
    const status = await getBackendStatus();
    const accounts = await this.loadClaudeAccountNames();
    if (!accounts.ok) {
      return { ok: false, errors: [accounts.message] };
    }
    return loadInspectedWorkerProfilesFromFile(profilesFile, createWorkerCapabilityCatalog(status), {
      knownClaudeAccounts: accounts.value,
    });
  }

  /**
   * Read the claude account registry as a name set. Returns a structured error
   * for schema-version mismatch so callers can distinguish "tampered/old
   * registry" from "valid registry that happens to contain no matching name".
   */
  private async loadClaudeAccountNames(): Promise<
    | { ok: true; value: ReadonlySet<string> }
    | { ok: false; message: string }
  > {
    try {
      const loaded = await loadAccountRegistry(accountRegistryPaths(this.store.root));
      if (!loaded.ok) {
        return {
          ok: false,
          message: `claude account registry version mismatch (observed: ${String(loaded.observed_version)}); resolve manually before resolving worker profiles`,
        };
      }
      return { ok: true, value: new Set(loaded.file.accounts.map((entry) => entry.name)) };
    } catch {
      return { ok: true, value: new Set() };
    }
  }

  // Walk parent_run_id back to the chain root and report whether the root
  // run's metadata records a profile-mode origin. Bounded by a generous
  // depth limit so a corrupt chain cannot loop forever. Used by send_followup
  // to enforce OD2=B against chained follow-ups (issue #31 B1).
  //
  // Security tradeoff: this function fails OPEN on max-depth exhaustion,
  // ancestry cycles, or a missing/unreadable parent meta — it returns false,
  // which lets the codex_network override through. The alternative (fail
  // closed) would reject legitimate direct-mode follow-ups whenever the
  // run-store had transient I/O issues. The closed-by-default OD1=B posture
  // (codex_network defaults to 'isolated' on every codex run) limits the
  // blast radius of a fail-open false negative; the worst case is that a
  // user with a corrupt run-store can still issue a one-off network override
  // that the chain check would otherwise have rejected.
  private async chainOriginatedFromProfileMode(start: RunMeta): Promise<boolean> {
    let current: RunMeta | null = start;
    const seen = new Set<string>();
    const maxDepth = 1000;
    let depth = 0;
    while (current && depth < maxDepth) {
      if (isProfileModeMetadata(current.metadata)) return true;
      if (!current.parent_run_id) return false;
      if (seen.has(current.parent_run_id)) return false;
      seen.add(current.parent_run_id);
      try {
        current = await this.store.loadMeta(current.parent_run_id);
      } catch {
        return false;
      }
      depth += 1;
    }
    return false;
  }

  async sendFollowup(params: unknown, context: OrchestratorDispatchContext = {}): Promise<ToolResult> {
    const parsed = SendFollowupInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const parent = await this.store.loadRun(parsed.data.run_id);
    if (!parent) return unknownRun(parsed.data.run_id);
    if (!isTerminalStatus(parent.meta.status)) {
      return wrapErr(orchestratorError('INVALID_STATE', 'Cannot send follow-up while parent run is still running'));
    }

    const backendName = BackendSchema.parse(parent.meta.backend);
    const runtime = this.runtimes.get(backendName);
    if (!runtime) return wrapErr(orchestratorError('BACKEND_NOT_FOUND', `Backend not found: ${backendName}`));
    // OD2 = B (locked 2026-05-05): direct-mode-only override. send_followup
    // must reject codex_network whenever the originating start_run was a
    // profile-mode call, not just when the immediate parent was.
    const chainOriginIsProfileMode = await this.chainOriginatedFromProfileMode(parent.meta);
    if (parsed.data.codex_network !== undefined && chainOriginIsProfileMode) {
      return wrapErr(orchestratorError('INVALID_INPUT', 'Profile-mode follow-ups cannot override codex_network; edit the profile or run a direct-mode follow-up instead'));
    }
    if (parsed.data.codex_network !== undefined && backendName !== 'codex') {
      return wrapErr(orchestratorError('INVALID_INPUT', `codex_network is only supported on the codex backend; got backend ${backendName}`));
    }
    // Issue #58: worker_posture override mirrors the codex_network rule —
    // profile-mode chains reject direct overrides so the profile manifest
    // stays authoritative for the chain. Direct-mode chains accept the
    // override and persist the new value on the child run record.
    if (parsed.data.worker_posture !== undefined && chainOriginIsProfileMode) {
      return wrapErr(orchestratorError('INVALID_INPUT', 'Profile-mode follow-ups cannot override worker_posture; edit the profile or run a direct-mode follow-up instead'));
    }
    // Rotation eligibility check (D7 / D8). The decision carries a
    // `releaseLock` callback when rotation succeeded — must be called after
    // the new child's meta.json is durably written.
    const rotationDecision = await this.evaluateRotation(backendName, parent.meta, parent.meta.run_id);
    if (!rotationDecision.ok) return wrapErr(rotationDecision.error);

    const isRotation = rotationDecision.rotation !== null;
    const releaseLock = rotationDecision.releaseLock;
    let resumeSessionId: string | null = null;
    if (!isRotation) {
      resumeSessionId = parent.meta.observed_session_id ?? parent.meta.session_id;
      if (!resumeSessionId) {
        return wrapErr(orchestratorError('INVALID_STATE', 'Cannot send follow-up because parent run has no backend session id'));
      }
    }

    const idleTimeout = this.resolveIdleTimeout(parsed.data.idle_timeout_seconds);
    if (!idleTimeout.ok) {
      releaseLock?.();
      return wrapErr(idleTimeout.error);
    }
    const executionTimeout = this.resolveExecutionTimeout(parsed.data.execution_timeout_seconds);
    if (!executionTimeout.ok) {
      releaseLock?.();
      return wrapErr(executionTimeout.error);
    }
    const model = parsed.data.model ?? parent.meta.model;
    const baseMetadata = stampOrchestratorIdInMetadata(
      metadataForFollowup(parent.meta.metadata, parsed.data.metadata),
      context.policy_context,
    );
    const modelSource: ModelSource = parsed.data.model ? 'explicit' : parent.meta.model ? 'inherited' : 'backend_default';
    // S3 / R8 / T10 (issue #31): inherit codex_network from the parent unless
    // the follow-up sets it explicitly. The parent's resolved value is
    // recorded on parent.meta.model_settings.codex_network; an unset
    // follow-up argument must not silently flip the new run back to the C4
    // default.
    const inheritedCodexNetwork = parsed.data.codex_network !== undefined
      ? parsed.data.codex_network
      : (parent.meta.model_settings.codex_network ?? undefined);
    // Issue #58: inherit worker_posture from parent unless the follow-up
    // overrides it. Legacy parents (pre-#58) have `null`; that gets
    // normalized to 'trusted' on the child write below.
    const inheritedWorkerPosture: WorkerPosture | undefined = parsed.data.worker_posture !== undefined
      ? parsed.data.worker_posture
      : (parent.meta.model_settings.worker_posture ?? undefined);
    const settings = hasModelSettingsInput(parsed.data)
      ? modelSettingsForBackend(backendName, model, parsed.data.reasoning_effort, parsed.data.service_tier, inheritedCodexNetwork, inheritedWorkerPosture)
      : parsed.data.codex_network !== undefined
        ? patchCodexNetwork(parent.meta.model_settings, parsed.data.codex_network, inheritedWorkerPosture)
        : {
            ok: true as const,
            value: parsed.data.worker_posture !== undefined
              ? { ...parent.meta.model_settings, worker_posture: parsed.data.worker_posture }
              : parent.meta.model_settings,
          };
    if (!settings.ok) {
      releaseLock?.();
      return wrapErr(settings.error);
    }
    // Issue #58 review Major (Comment 6): the posture-only branch above
    // intentionally skips backend validation so a follow-up that only flips
    // worker_posture does not have to re-validate the parent's inherited
    // settings. But if the follow-up *also* changes the model (or targets
    // cursor), the merged settings must run through
    // validateInheritedModelSettingsForBackend just like a non-posture
    // model-changing follow-up does — otherwise a `worker_posture + model`
    // override could persist an invalid claude reasoning_effort/model
    // combination or an incomplete cursor setup.
    const validated = parsed.data.model || backendName === 'cursor'
      ? validateInheritedModelSettingsForBackend(backendName, model, settings.value)
      : settings;
    if (!validated.ok) {
      releaseLock?.();
      return wrapErr(validated.error);
    }
    // B2 (issue #31): normalize legacy parent records before persisting the
    // child. A legacy codex parent has model_settings.codex_network === null;
    // sandboxArgs() defensively treats that as 'isolated' under restricted,
    // and the child run record must reflect the *effective* posture under
    // restricted (plan invariant: "effective codex_network lands in
    // run_summary.model_settings"). Only normalize for the codex backend;
    // non-codex follow-ups must keep codex_network: null.
    //
    // Issue #58: same pattern for worker_posture (every backend), with one
    // refinement for codex — the legacy-null → 'isolated' normalization is
    // restricted-only. Under trusted, codex_network=null is the *effective*
    // value (it means "trusted-default sandbox": workspace-write + network on)
    // and must persist as null so re-runs spawn with the trusted-default argv.
    const childPosture: WorkerPosture = validated.value.worker_posture ?? 'trusted';
    const codexNormalized = backendName === 'codex' && validated.value.codex_network === null && childPosture === 'restricted'
      ? { ...validated.value, codex_network: 'isolated' as CodexNetwork, mode: 'normal' as const }
      : validated.value;
    const persistedSettings: RunModelSettings = codexNormalized.worker_posture === null
      ? { ...codexNormalized, worker_posture: 'trusted' as WorkerPosture }
      : codexNormalized;

    let accountSpawn: AccountSpawnContribution | undefined;
    let metadata: Record<string, unknown> = baseMetadata;
    let terminalContext: Record<string, unknown> | null = null;
    let rotationResumeSessionId: string | null = null;
    let rotationResumed = false;

    if (isRotation && rotationDecision.rotation) {
      const rotation = rotationDecision.rotation;
      // Mark the prior account cooled-down. Best-effort; never fail the
      // follow-up because of a registry-write hiccup.
      if (rotation.priorAccount) {
        try {
          await markAccountCooledDown(accountRegistryPaths(this.store.root), {
            name: rotation.priorAccount,
            cooldownSeconds: rotation.cooldownSeconds,
            errorCategory: rotation.parentErrorCategory,
          });
        } catch (error) {
          this.logger(`failed to mark claude account ${rotation.priorAccount} cooled-down: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      accountSpawn = rotation.binding.accountSpawn;

      // D-COR state diagram: api_env gate -> source-existence -> copy helper.
      const rotationFields = {
        parent_run_id: parent.meta.run_id,
        prior_account: rotation.priorAccount,
        new_account: rotation.binding.account.name,
        parent_error_category: rotation.parentErrorCategory,
      };
      const observedSessionId = parent.meta.observed_session_id ?? parent.meta.session_id;
      const accountModes = await this.readAccountModesForRotation(rotation.priorAccount, rotation.binding.account.name);

      if (accountModes.priorMode === 'api_env' || accountModes.newMode === 'api_env') {
        // D-COR-API: skip the copy entirely.
        terminalContext = {
          kind: 'fresh_chat_after_rotation',
          copy_skip_reason: 'api_env_in_rotation_path',
          details: { prior_mode: accountModes.priorMode, new_mode: accountModes.newMode },
          ...rotationFields,
        };
      } else if (!observedSessionId) {
        terminalContext = {
          kind: 'fresh_chat_after_rotation',
          copy_skip_reason: 'no_observed_session_id',
          details: {},
          ...rotationFields,
        };
      } else {
        const accountsRoot = accountRegistryPaths(this.store.root).accountsRoot;
        let outcome: CopyOutcome;
        try {
          outcome = await copySessionJsonlForRotation({
            accountsRoot,
            priorAccount: rotation.priorAccount ?? '',
            newAccount: rotation.binding.account.name,
            cwd: parent.meta.cwd,
            sessionId: observedSessionId,
          });
        } catch (error) {
          outcome = {
            ok: false,
            reason: 'copy_failed',
            details: { error: error instanceof Error ? error.message : String(error) },
          };
        }
        if (outcome.ok) {
          rotationResumed = true;
          rotationResumeSessionId = outcome.resumed_session_id;
          terminalContext = {
            kind: 'resumed_after_rotation',
            resumed_session_id: outcome.resumed_session_id,
            source_path: outcome.source_path,
            target_path: outcome.target_path,
            copied_bytes: outcome.copied_bytes,
            copy_duration_ms: outcome.copy_duration_ms,
            ...(outcome.collision_resolution ? { collision_resolution: outcome.collision_resolution } : {}),
            ...rotationFields,
          };
        } else {
          terminalContext = {
            kind: 'fresh_chat_after_rotation',
            copy_skip_reason: outcome.reason,
            details: outcome.details,
            ...rotationFields,
          };
        }
      }

      metadata = applyRotationMetadata(baseMetadata, rotation, parent.meta.run_id, rotationResumed);
    } else {
      // Non-rotation follow-up: re-bind the parent's account if any so the
      // env-scrub policy still fires.
      const accountBindingForFollowup = await this.resolveBindingForFollowup(backendName, parent.meta);
      if (!accountBindingForFollowup.ok) return wrapErr(accountBindingForFollowup.error);
      if (accountBindingForFollowup.binding) {
        accountSpawn = accountBindingForFollowup.binding.accountSpawn;
        metadata = { ...metadata, claude_account_used: accountBindingForFollowup.binding.account.name };
      }
    }

    // For the rotated child run, set requested_session_id to the resumed
    // session id ONLY when resume was chosen (D-COR-Resume / T-COR2 step 7).
    const isResumeAfterRotation = isRotation && rotationResumed && rotationResumeSessionId !== null;
    const childRequestedSessionId = isRotation
      ? (isResumeAfterRotation ? rotationResumeSessionId : null)
      : resumeSessionId;
    const childSessionId = isRotation ? null : resumeSessionId;

    let meta;
    try {
      meta = await this.store.createRun({
        backend: backendName,
        cwd: parent.meta.cwd,
        prompt: parsed.data.prompt,
        parent_run_id: parent.meta.run_id,
        session_id: childSessionId,
        requested_session_id: childRequestedSessionId,
        model,
        model_source: modelSource,
        model_settings: persistedSettings,
        display: displayMetadata(parsed.data.metadata, parsed.data.prompt, parent.meta.display),
        metadata,
        idle_timeout_seconds: idleTimeout.value,
        execution_timeout_seconds: executionTimeout.value,
      });
      await this.captureAndPersistGitSnapshot(meta.run_id, parent.meta.cwd);

      if (terminalContext) {
        await this.store.updateMeta(meta.run_id, (current) => ({
          ...current,
          terminal_context: { ...(current.terminal_context ?? {}), ...terminalContext },
        }));
      }

      // D-COR-Lock: at this point the new child's meta.json is durably
      // written carrying claude_rotation_state.parent_run_id +
      // claude_account_used. Update the in-memory tracker AND release the
      // picker lock together. The disk write happens before the in-memory
      // add, so a daemon-restart reconstruction always reads at least as
      // up-to-date a state as the cache.
      if (isRotation && rotationDecision.rotation) {
        const tracker = this.rotationTrackers.get(parent.meta.run_id);
        tracker?.claimed.add(rotationDecision.rotation.binding.account.name);
      }
    } finally {
      releaseLock?.();
    }

    // Sub-task 5 / D-COR-Resume-Layer: when the spawn shape is resume,
    // build the in-run interceptor with retryInvocation in start-shape.
    let earlyEventInterceptor: EarlyEventInterceptor | undefined;
    let effectiveTerminalContext = terminalContext;
    let effectiveSessionIdForSpawn: string | undefined;
    if (isRotation && isResumeAfterRotation && rotationResumeSessionId) {
      const built = await runtime.buildStartInvocation({
        runId: meta.run_id,
        prompt: parsed.data.prompt,
        cwd: parent.meta.cwd,
        model,
        modelSettings: persistedSettings,
        accountSpawn,
      });
      if (built.ok) {
        const downgradeContext = {
          ...(terminalContext ?? {}),
          kind: 'fresh_chat_after_rotation' as const,
          resume_attempted: true,
          resume_failure_reason: 'session_not_found' as const,
        };
        earlyEventInterceptor = {
          thresholdEvents: SESSION_NOT_FOUND_INTERCEPT_THRESHOLD.events,
          thresholdMs: SESSION_NOT_FOUND_INTERCEPT_THRESHOLD.ms,
          classify: classifySessionNotFound,
          retryInvocation: built.invocation,
          // Reviewer fix #2b: write the post-retry terminal_context to meta
          // synchronously, BEFORE the retry attempt's `markTerminal` runs.
          // This closes the race where a reader between `markTerminal` and
          // the post-completion re-merge would observe stale
          // `kind: "resumed_after_rotation"`.
          onRetryFired: async () => {
            await this.store.updateMeta(meta.run_id, (current) => ({
              ...current,
              terminal_context: { ...(current.terminal_context ?? {}), ...downgradeContext },
            }));
          },
        };
        effectiveSessionIdForSpawn = rotationResumeSessionId;
      } else {
        // Failed to pre-bake the retry invocation; fall back to fresh-chat
        // so the resume worker is not spawned without a retry plan. This
        // is essentially impossible in practice (resume() would also fail
        // if the binary is missing) but the contingency is cheap.
        this.logger(`failed to build retry invocation for run ${meta.run_id}; falling back to fresh-chat: ${built.failure.message}`);
        const fallback: Record<string, unknown> = {
          kind: 'fresh_chat_after_rotation',
          copy_skip_reason: 'retry_invocation_unavailable',
          details: { ...built.failure.details, code: built.failure.code },
          parent_run_id: parent.meta.run_id,
          prior_account: rotationDecision.rotation?.priorAccount ?? null,
          new_account: rotationDecision.rotation?.binding.account.name ?? null,
          parent_error_category: rotationDecision.rotation?.parentErrorCategory ?? null,
        };
        effectiveTerminalContext = fallback;
        await this.store.updateMeta(meta.run_id, (current) => ({
          ...current,
          requested_session_id: null,
          terminal_context: { ...(current.terminal_context ?? {}), ...fallback },
        }));
      }
    } else if (!isRotation && resumeSessionId) {
      effectiveSessionIdForSpawn = resumeSessionId;
    }

    await this.startManagedRun(
      meta.run_id,
      runtime,
      parsed.data.prompt,
      parent.meta.cwd,
      idleTimeout.value,
      executionTimeout.value,
      persistedSettings,
      model,
      effectiveSessionIdForSpawn,
      accountSpawn,
      effectiveTerminalContext,
      earlyEventInterceptor,
    );
    return wrapOk({ run_id: meta.run_id });
  }

  private async readAccountModesForRotation(
    priorAccount: string | null,
    newAccount: string,
  ): Promise<{ priorMode: 'config_dir' | 'api_env' | null; newMode: 'config_dir' | 'api_env' | null }> {
    try {
      const loaded = await loadAccountRegistry(accountRegistryPaths(this.store.root));
      if (!loaded.ok) return { priorMode: null, newMode: null };
      const priorEntry = priorAccount ? loaded.file.accounts.find((entry) => entry.name === priorAccount) : null;
      const newEntry = loaded.file.accounts.find((entry) => entry.name === newAccount);
      return {
        priorMode: priorEntry?.mode ?? null,
        newMode: newEntry?.mode ?? null,
      };
    } catch {
      return { priorMode: null, newMode: null };
    }
  }

  private async evaluateRotation(
    backendName: Backend,
    parent: { metadata: Record<string, unknown>; latest_error: { category?: string } | null },
    parentRunId: string,
  ): Promise<RotationDecision> {
    if (backendName !== 'claude') return { ok: true, rotation: null };
    const rotationState = readRotationState(parent.metadata);
    if (!rotationState) return { ok: true, rotation: null };
    const errorCategory = parent.latest_error?.category;
    if (errorCategory !== 'rate_limit' && errorCategory !== 'quota') {
      return { ok: true, rotation: null };
    }
    const priorAccount = readAccountUsed(parent.metadata);

    // D-COR-Lock: serialize the picker per parent. Chain a new promise onto
    // the tracker's existing lock BEFORE awaiting any I/O so concurrent
    // callers see the new lock immediately.
    const tracker = this.getOrCreateRotationTracker(parentRunId);
    const previousLock = tracker.lock;
    let releaseLock!: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    tracker.lock = newLock;
    await previousLock.catch(() => undefined);

    try {
      // Lazy reconstruction of `claimed` from on-disk run records. Hidden
      // behind the lock so concurrent callers do not duplicate the scan.
      if (!tracker.reconstructed) {
        try {
          tracker.claimed = await this.reconstructClaimedDestinations(parentRunId);
        } catch {
          tracker.claimed = new Set<string>();
        }
        tracker.reconstructed = true;
      }

      const paths = accountRegistryPaths(this.store.root);
      const loaded = await loadAccountRegistry(paths);
      if (!loaded.ok) {
        releaseLock();
        return {
          ok: false,
          error: orchestratorError('INVALID_STATE', `claude account registry version mismatch (observed: ${String(loaded.observed_version)})`),
        };
      }
      const accounts = loaded.file.accounts;
      const now = Date.now();

      // Filter the priority list: skip prior account AND skip already-claimed
      // destinations BEFORE handing the remaining list to the cooldown filter.
      const filteredPriority = rotationState.accounts.filter((name) => {
        if (priorAccount && name === priorAccount) return false;
        if (tracker.claimed.has(name)) return false;
        return true;
      });
      const { picked, cooldownSummary } = pickHealthyAccount(accounts, filteredPriority, now);
      if (!picked) {
        releaseLock();
        // Distinguish "exhausted by claimed" from "all cooled-down".
        const reason = tracker.claimed.size > 0 || (priorAccount && rotationState.accounts.includes(priorAccount))
          ? 'priority_exhausted_for_parent'
          : 'all_cooled_down';
        if (reason === 'priority_exhausted_for_parent') {
          return {
            ok: false,
            error: orchestratorError('INVALID_STATE', 'no claude account available for this parent rotation: every priority entry is either the prior account, already bound to a sibling rotation, or cooled-down', {
              reason,
              claimed: Array.from(tracker.claimed),
              cooled_down: cooldownSummary,
              priority: rotationState.accounts,
              prior_account: priorAccount,
            }),
          };
        }
        return {
          ok: false,
          error: orchestratorError('INVALID_STATE', 'all claude accounts in the rotation priority list are currently cooled-down', {
            cooldown_summary: cooldownSummary,
          }),
        };
      }
      const spawn = resolveAccountSpawn({ paths, account: picked });
      if (!spawn.ok) {
        releaseLock();
        return {
          ok: false,
          error: orchestratorError('INVALID_STATE', `claude account ${picked.name} cannot be bound: ${spawn.reason}`, {
            reason: spawn.reason,
            ...spawn.details,
          }),
        };
      }
      return {
        ok: true,
        rotation: {
          binding: {
            account: picked,
            accountSpawn: { env: spawn.env, envPolicy: spawn.envPolicy },
          },
          priorAccount,
          parentErrorCategory: errorCategory,
          rotationState,
          cooldownSeconds: rotationState.cooldown_seconds,
        },
        releaseLock,
      };
    } catch (error) {
      releaseLock();
      throw error;
    }
  }

  private getOrCreateRotationTracker(parentRunId: string): RotationTrackerEntry {
    let tracker = this.rotationTrackers.get(parentRunId);
    if (!tracker) {
      tracker = {
        lock: Promise.resolve(),
        claimed: new Set<string>(),
        reconstructed: false,
      };
      this.rotationTrackers.set(parentRunId, tracker);
    }
    return tracker;
  }

  /**
   * D-COR-Lock reconstruction algorithm. Returns the set of accounts already
   * bound to a rotated child run of the given parent, sourced from on-disk
   * run metadata. A child counts as a rotation child if it carries the
   * top-level `parent_run_id` AND a `claude_rotation_state` (the rotation
   * state is what distinguishes a rotated child from a plain followup).
   * Schema-invalid entries are silently skipped.
   */
  private async reconstructClaimedDestinations(parentRunId: string): Promise<Set<string>> {
    const claimed = new Set<string>();
    let runs;
    try {
      runs = await this.store.listRuns();
    } catch {
      return claimed;
    }
    for (const run of runs) {
      if ((run as { parent_run_id?: unknown }).parent_run_id !== parentRunId) continue;
      const metadata = (run as { metadata?: unknown }).metadata;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
      const meta = metadata as Record<string, unknown>;
      const rotationState = meta.claude_rotation_state;
      if (!rotationState || typeof rotationState !== 'object' || Array.isArray(rotationState)) continue;
      const accountUsed = meta.claude_account_used;
      if (typeof accountUsed === 'string' && accountUsed.length > 0) {
        claimed.add(accountUsed);
      }
    }
    return claimed;
  }

  private async resolveBindingForFollowup(
    backendName: Backend,
    parentMeta: { metadata: Record<string, unknown> },
  ): Promise<ClaudeBindingResolution> {
    if (backendName !== 'claude') return { ok: true, binding: null };
    const accountName = readAccountUsed(parentMeta.metadata);
    if (!accountName) return { ok: true, binding: null };
    const paths = accountRegistryPaths(this.store.root);
    const loaded = await loadAccountRegistry(paths);
    if (!loaded.ok) {
      return {
        ok: false,
        error: orchestratorError('INVALID_STATE', `claude account registry version mismatch (observed: ${String(loaded.observed_version)})`),
      };
    }
    const account = loaded.file.accounts.find((entry) => entry.name === accountName);
    if (!account) {
      return {
        ok: false,
        error: orchestratorError('INVALID_STATE', `claude account ${accountName} (used by parent run) is no longer registered`, {
          account: accountName,
        }),
      };
    }
    const spawn = resolveAccountSpawn({ paths, account });
    if (!spawn.ok) {
      return {
        ok: false,
        error: orchestratorError('INVALID_STATE', `claude account ${accountName} cannot be bound: ${spawn.reason}`, {
          reason: spawn.reason,
          ...spawn.details,
        }),
      };
    }
    return {
      ok: true,
      binding: {
        account,
        accountSpawn: { env: spawn.env, envPolicy: spawn.envPolicy },
        rotationState: null,
        cooldownSeconds: 0,
      },
    };
  }

  async cancelRun(params: unknown): Promise<ToolResult> {
    const parsed = CancelRunInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const run = await this.store.loadRun(parsed.data.run_id);
    if (!run) return unknownRun(parsed.data.run_id);
    if (isTerminalStatus(run.meta.status)) {
      return wrapErr(orchestratorError('INVALID_STATE', `Run is already terminal: ${run.meta.status}`));
    }

    const managed = this.activeRuns.get(parsed.data.run_id);
    if (!managed) {
      return wrapErr(orchestratorError('INVALID_STATE', 'Run is not managed by this daemon'));
    }

    this.clearRunTimer(parsed.data.run_id);
    managed.cancel('cancelled');
    return wrapOk({ accepted: true, status: 'running' as RunStatus });
  }

  async getRunStatus(params: unknown): Promise<ToolResult> {
    const parsed = RunIdInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const run = await this.store.loadRun(parsed.data.run_id);
    if (!run) return unknownRun(parsed.data.run_id);
    return wrapOk({ run_summary: run.meta });
  }

  async getRunEvents(params: unknown): Promise<ToolResult> {
    const parsed = GetRunEventsInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const run = await this.store.loadRun(parsed.data.run_id);
    if (!run) return unknownRun(parsed.data.run_id);
    return wrapOk(await this.store.readEvents(parsed.data.run_id, parsed.data.after_sequence, parsed.data.limit));
  }

  async getRunProgress(params: unknown): Promise<ToolResult> {
    const parsed = GetRunProgressInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const { run_id, after_sequence, limit, max_text_chars } = parsed.data;
    let runSummary;
    try {
      runSummary = await this.store.loadMeta(run_id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return unknownRun(run_id);
      throw error;
    }

    const summary = await this.store.readEventSummary(run_id, after_sequence === undefined ? limit : 0);
    const page = after_sequence === undefined
      ? {
        events: summary.recent_events,
        next_sequence: summary.recent_events.at(-1)?.seq ?? 0,
        has_more: summary.event_count > summary.recent_events.length,
      }
      : await this.store.readEvents(run_id, after_sequence, limit);
    const recentEvents = page.events.map((event) => summarizeProgressEvent(event, max_text_chars));

    return wrapOk({
      run_summary: runSummary,
      progress: {
        event_count: summary.event_count,
        next_sequence: page.next_sequence,
        has_more: page.has_more,
        latest_event_sequence: summary.last_event?.seq ?? null,
        latest_event_at: summary.last_event?.ts ?? null,
        latest_text: latestProgressText(page.events, max_text_chars),
        recent_events: recentEvents,
      },
    });
  }

  async waitForRun(params: unknown): Promise<ToolResult> {
    const parsed = WaitForRunInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const deadline = Date.now() + parsed.data.wait_seconds * 1000;
    while (Date.now() < deadline) {
      const run = await this.store.loadRun(parsed.data.run_id);
      if (!run) return unknownRun(parsed.data.run_id);
      if (isTerminalStatus(run.meta.status)) {
        return wrapOk({ status: run.meta.status, run_summary: run.meta });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const run = await this.store.loadRun(parsed.data.run_id);
    if (!run) return unknownRun(parsed.data.run_id);
    return wrapOk({ status: 'still_running', wait_exceeded: true, run_summary: run.meta });
  }

  async waitForAnyRun(params: unknown): Promise<ToolResult> {
    const parsed = WaitForAnyRunInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const { run_ids, wait_seconds, after_notification_id, kinds } = parsed.data;
    const kindFilter = kinds ?? (['terminal', 'fatal_error'] as RunNotificationKind[]);
    const deadline = Date.now() + wait_seconds * 1000;
    while (true) {
      const notifications = await this.store.listNotifications({
        runIds: run_ids,
        sinceNotificationId: after_notification_id,
        kinds: kindFilter,
        includeAcked: true,
        limit: 50,
      });
      if (notifications.length > 0) {
        return wrapOk({
          notifications,
          wait_exceeded: false,
        });
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return wrapOk({ notifications: [] as RunNotification[], wait_exceeded: true });
  }

  async listRunNotifications(params: unknown): Promise<ToolResult> {
    const parsed = ListRunNotificationsInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const { run_ids, since_notification_id, kinds, include_acked, limit } = parsed.data;
    const notifications = await this.store.listNotifications({
      runIds: run_ids,
      sinceNotificationId: since_notification_id,
      kinds,
      includeAcked: include_acked,
      limit,
    });
    return wrapOk({ notifications });
  }

  async ackRunNotification(params: unknown): Promise<ToolResult> {
    const parsed = AckRunNotificationInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const result = await this.store.markNotificationAcked(parsed.data.notification_id);
    if (result.acked) {
      // Acking a fatal notification can clear `attention` (D3b rule 1). The
      // status engine subscribes to lifecycle 'notification' events; emit one
      // for every registered orchestrator so the engine recomputes for any
      // owner whose unacked fatal count just changed. The 250ms debounce +
      // last-payload de-dup in the engine collapses no-op recomputes.
      for (const state of this.orchestratorRegistry.list()) {
        this.emitRunLifecycle({
          kind: 'notification',
          run_id: '',
          orchestrator_id: state.record.id,
        });
      }
    }
    return wrapOk({ acked: result.acked, notification_id: parsed.data.notification_id });
  }

  async getRunResult(params: unknown): Promise<ToolResult> {
    const parsed = RunIdInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const run = await this.store.loadRun(parsed.data.run_id);
    if (!run) return unknownRun(parsed.data.run_id);
    return wrapOk({ run_summary: run.meta, result: resultWithAssistantSummaryFallback(run.result, run.events) });
  }

  async shutdown(params: unknown): Promise<ToolResult> {
    const parsed = ShutdownInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const active = Array.from(this.activeRuns.keys());
    if (active.length > 0 && !parsed.data.force) {
      return wrapErr(orchestratorError('INVALID_STATE', 'Active runs are still running', { active_runs: active }));
    }

    this.shuttingDown = true;
    for (const runId of active) {
      this.activeRuns.get(runId)?.cancel('cancelled');
    }
    await Promise.all(Array.from(this.activeRuns.values()).map((run) => run.completion.catch(() => undefined)));
    scheduleProcessExit();
    return wrapOk({ accepted: true });
  }

  async pruneRuns(params: unknown): Promise<ToolResult> {
    const parsed = PruneRunsInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    return wrapOk(await this.store.pruneTerminalRuns(parsed.data.older_than_days, parsed.data.dry_run));
  }

  async getObservabilitySnapshot(params: unknown, context: OrchestratorDispatchContext = {}): Promise<ToolResult> {
    const parsed = GetObservabilitySnapshotInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    return wrapOk({
      snapshot: await buildObservabilitySnapshot(this.store, {
        limit: parsed.data.limit,
        includePrompts: parsed.data.include_prompts,
        recentEventLimit: parsed.data.recent_event_limit,
        daemonPid: process.pid,
        backendStatus: parsed.data.diagnostics ? await getBackendStatus({
          frontendVersion: context.frontend_version ?? getPackageVersion(),
          daemonVersion: getPackageVersion(),
          daemonPid: process.pid,
        }) : null,
      }),
    });
  }

  private async startManagedRun(
    runId: string,
    runtime: WorkerRuntime,
    prompt: string,
    cwd: string,
    idleTimeoutSeconds: number,
    executionTimeoutSeconds: number | null,
    modelSettings: RunModelSettings,
    model: string | null | undefined,
    sessionId: string | undefined,
    accountSpawn?: AccountSpawnContribution,
    rotationTerminalContext?: Record<string, unknown> | null,
    earlyEventInterceptor?: EarlyEventInterceptor,
  ): Promise<void> {
    try {
      await access(cwd, constants.R_OK | constants.W_OK);
    } catch (error) {
      await this.failPreSpawn(runId, runtime.name, 'cwd is not readable and writable', { error: error instanceof Error ? error.message : String(error) }, rotationTerminalContext);
      return;
    }

    const startInput = { runId, prompt, cwd, model, modelSettings, accountSpawn, earlyEventInterceptor };
    const result = sessionId
      ? await runtime.resume(sessionId, startInput)
      : await runtime.start(startInput);
    if (!result.ok) {
      const failure = result.failure;
      await this.failPreSpawn(runId, runtime.name, failure.message, { ...failure.details, code: failure.code }, rotationTerminalContext);
      return;
    }

    const handle = result.handle;
    this.activeRuns.set(runId, handle);
    this.armRunTimer(runId, idleTimeoutSeconds, executionTimeoutSeconds, handle);
    const startMeta = await this.store.loadMeta(runId).catch(() => null);
    this.emitRunLifecycle({
      kind: 'started',
      run_id: runId,
      orchestrator_id: orchestratorIdFromMeta(startMeta?.metadata),
      status: startMeta?.status,
    });
    handle.completion.then(async (terminalMeta) => {
      this.clearRunTimer(runId);
      this.activeRuns.delete(runId);
      this.emitRunLifecycle({
        kind: 'terminal',
        run_id: runId,
        orchestrator_id: orchestratorIdFromMeta(terminalMeta.metadata),
        status: terminalMeta.status,
      });
      if (terminalMeta.latest_error?.fatal) {
        this.emitRunLifecycle({
          kind: 'notification',
          run_id: runId,
          orchestrator_id: orchestratorIdFromMeta(terminalMeta.metadata),
        });
      }
      if (this.shuttingDown && this.activeRuns.size === 0) {
        scheduleProcessExit();
      }
    }).catch(() => undefined);

    // Preserve the rotation marker in `terminal_context` regardless of how
    // the worker terminates (success, failure, cancellation). The
    // `markTerminal` path overrides terminal_context when a terminal override
    // supplies its own context, so we re-merge after completion. When the
    // resume interceptor fired, additionally merge the
    // `resume_attempted` / `resume_failure_reason` fields and downgrade
    // `kind` to `fresh_chat_after_rotation` (D-COR-Resume-Layer Step 2).
    if (rotationTerminalContext || earlyEventInterceptor) {
      handle.completion.then(async () => {
        try {
          let interceptorFired = false;
          if (earlyEventInterceptor) {
            interceptorFired = await this.didSessionNotFoundInterceptorFire(runId);
          }
          await this.store.updateMeta(runId, (current) => {
            const mergedBase = { ...(current.terminal_context ?? {}), ...(rotationTerminalContext ?? {}) };
            const merged = interceptorFired
              ? {
                  ...mergedBase,
                  kind: 'fresh_chat_after_rotation',
                  resume_attempted: true,
                  resume_failure_reason: 'session_not_found',
                }
              : mergedBase;
            return { ...current, terminal_context: merged };
          });
        } catch (error) {
          this.logger(`failed to persist rotation terminal_context for run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, () => undefined).catch(() => undefined);
    }

    // When a rotation-eligible account-bound run reaches terminal with a
    // rate_limit / quota error, persist the cooldown to the registry so the
    // next start_run with the same priority array skips this account — and
    // so a daemon restart between terminal and any send_followup picks the
    // cooldown up off disk. Single-account direct runs (no rotation_state)
    // do not trigger a cooldown write (BI5).
    if (runtime.name === 'claude') {
      handle.completion.then(async (terminalMeta) => {
        const errorCategory = terminalMeta.latest_error?.category;
        if (errorCategory !== 'rate_limit' && errorCategory !== 'quota') return;
        const rotationState = readRotationState(terminalMeta.metadata);
        if (!rotationState) return;
        const accountUsed = readAccountUsed(terminalMeta.metadata);
        if (!accountUsed) return;
        try {
          await markAccountCooledDown(accountRegistryPaths(this.store.root), {
            name: accountUsed,
            cooldownSeconds: rotationState.cooldown_seconds,
            errorCategory,
          });
        } catch (error) {
          this.logger(`failed to mark claude account ${accountUsed} cooled-down at terminal: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, () => undefined).catch(() => undefined);
    }
  }

  private async failPreSpawn(
    runId: string,
    backend: Backend,
    message: string,
    context: Record<string, unknown>,
    rotationTerminalContext?: Record<string, unknown> | null,
  ): Promise<void> {
    const latestError = preSpawnError(backend, message, context);
    const result: WorkerResult = {
      status: 'failed',
      summary: message,
      files_changed: [],
      commands_run: [],
      artifacts: this.store.defaultArtifacts(runId),
      errors: [latestError],
    };
    // Reviewer fix #2a: when the run is a rotation child, the rotation marker
    // (`kind: "resumed_after_rotation"` or `kind: "fresh_chat_after_rotation"`
    // plus parent_run_id / prior_account / new_account / parent_error_category)
    // was pre-set on the run's meta in `sendFollowup`. `markTerminal` would
    // overwrite `terminal_context` with the failure context unless we merge
    // the rotation marker into it here. The failure error rides alongside the
    // rotation marker, so supervisors still see both.
    let mergedContext: Record<string, unknown> = { ...context };
    if (rotationTerminalContext) {
      mergedContext = { ...rotationTerminalContext, ...mergedContext };
    } else {
      try {
        const current = await this.store.loadMeta(runId);
        if (current.terminal_context && typeof current.terminal_context === 'object') {
          mergedContext = { ...(current.terminal_context as Record<string, unknown>), ...mergedContext };
        }
      } catch {
        // Best-effort — fall through to the non-merged context.
      }
    }
    await this.store.markTerminal(runId, 'failed', result.errors, result, {
      reason: 'pre_spawn_failed',
      latest_error: latestError,
      context: mergedContext,
    });
    // Pre-spawn failures must drive the aggregate-status engine immediately
    // so a fatal pre-spawn error transitions the orchestrator to `attention`
    // without waiting for some other lifecycle signal (issue #40, F4).
    try {
      const meta = await this.store.loadMeta(runId);
      const orchestratorId = orchestratorIdFromMeta(meta.metadata);
      this.emitRunLifecycle({
        kind: 'terminal',
        run_id: runId,
        orchestrator_id: orchestratorId,
        status: meta.status,
      });
      if (meta.latest_error?.fatal) {
        this.emitRunLifecycle({
          kind: 'notification',
          run_id: runId,
          orchestrator_id: orchestratorId,
        });
      }
    } catch (error) {
      this.logger(`failPreSpawn lifecycle emit failed for ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async captureAndPersistGitSnapshot(runId: string, cwd: string): Promise<void> {
    const git = await captureGitSnapshot(cwd);
    try {
      await this.store.updateMeta(runId, (meta) => ({
        ...meta,
        git_snapshot_status: git.status,
        git_snapshot: git.snapshot,
        git_snapshot_at_start: git.snapshot,
      }));
    } catch (error) {
      this.logger(`failed to persist git snapshot for run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private armRunTimer(runId: string, idleTimeoutSeconds: number, executionTimeoutSeconds: number | null, managed: RuntimeRunHandle): void {
    const idleTimeoutMs = idleTimeoutSeconds * 1000;
    const startedMs = Date.now();
    const hardDeadlineMs = executionTimeoutSeconds === null ? null : startedMs + (executionTimeoutSeconds * 1000);
    const schedule = () => {
      const now = Date.now();
      const idleDeadlineMs = managed.lastActivityMs() + idleTimeoutMs;
      if (hardDeadlineMs !== null && now >= hardDeadlineMs) {
        this.timers.delete(runId);
        managed.cancel('timed_out', {
          reason: 'execution_timeout',
          timeout_reason: 'execution_timeout',
          context: {
            execution_timeout_seconds: executionTimeoutSeconds,
            elapsed_seconds: Math.max(0, Math.round((now - startedMs) / 1000)),
          },
        });
        return;
      }

      if (now >= idleDeadlineMs) {
        this.timers.delete(runId);
        managed.cancel('timed_out', {
          reason: 'idle_timeout',
          timeout_reason: 'idle_timeout',
          context: {
            idle_timeout_seconds: idleTimeoutSeconds,
            idle_seconds: Math.max(0, Math.round((now - managed.lastActivityMs()) / 1000)),
          },
        });
        return;
      }

      const nextDeadlineMs = Math.min(idleDeadlineMs, hardDeadlineMs ?? Number.POSITIVE_INFINITY);
      const delayMs = Math.max(50, Math.min(nextDeadlineMs - now, 60_000));
      const timer = setTimeout(schedule, delayMs);
      this.timers.set(runId, timer);
    };

    schedule();
  }

  private clearRunTimer(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer) clearTimeout(timer);
    this.timers.delete(runId);
  }

  private resolveIdleTimeout(value: number | undefined): { ok: true; value: number } | { ok: false; error: OrchestratorError } {
    const timeout = value ?? this.config.default_idle_timeout_seconds;
    if (timeout <= 0 || timeout > this.config.max_idle_timeout_seconds) {
      return {
        ok: false,
        error: orchestratorError('INVALID_INPUT', `idle_timeout_seconds must be between 1 and ${this.config.max_idle_timeout_seconds}`),
      };
    }
    return { ok: true, value: timeout };
  }

  private resolveExecutionTimeout(value: number | undefined): { ok: true; value: number | null } | { ok: false; error: OrchestratorError } {
    const timeout = value ?? this.config.default_execution_timeout_seconds;
    if (timeout === null) return { ok: true, value: null };
    if (timeout <= 0 || timeout > this.config.max_execution_timeout_seconds) {
      return {
        ok: false,
        error: orchestratorError('INVALID_INPUT', `execution_timeout_seconds must be between 1 and ${this.config.max_execution_timeout_seconds}`),
      };
    }
    return { ok: true, value: timeout };
  }

  private async loadConfig(): Promise<void> {
    const configPath = `${this.store.root}/config.json`;
    try {
      const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      const normalized = normalizeConfig(parsed);
      this.config = normalized.config;
      if (normalized.shouldWrite) {
        await writeFile(configPath, `${JSON.stringify(normalized.fileValue, null, 2)}\n`, { mode: 0o600 });
      }
    } catch {
      this.config = defaultConfig;
      await writeFile(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, { mode: 0o600 });
    }
  }

  /**
   * Inspect the run's events stream for the lifecycle marker emitted by
   * `ProcessManager` when the early-event interceptor fired and the resume
   * worker was killed-and-replaced (D-COR-Resume-Layer Step 1).
   */
  private async didSessionNotFoundInterceptorFire(runId: string): Promise<boolean> {
    try {
      const result = await this.store.readEvents(runId, 0, 10_000);
      for (const event of result.events) {
        if (event.type !== 'lifecycle') continue;
        const payload = event.payload as Record<string, unknown> | undefined;
        if (payload && payload.subtype === 'session_not_found_in_run_retry') {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  private async orphanRunningRuns(): Promise<void> {
    for (const run of await this.store.listRuns()) {
      if (run.status !== 'running') continue;
      try {
        await this.store.markTerminal(run.run_id, 'orphaned', [{
          message: 'orphaned by daemon restart; worker process state unknown',
          context: {
            previous_daemon_pid: run.daemon_pid_at_spawn,
            worker_pid: run.worker_pid,
          },
        }]);
        this.logger(`orphaned run ${run.run_id} previous_daemon_pid=${run.daemon_pid_at_spawn ?? 'unknown'} worker_pid=${run.worker_pid ?? 'unknown'}`);
      } catch (error) {
        this.logger(`failed to orphan run ${run.run_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function defaultLogger(message: string): void {
  process.stderr.write(`agent-orchestrator: ${message}\n`);
}

/**
 * D-COR-Resume-Layer Step 2: classifier for the early-event interceptor.
 * Returns `retry_with_start` only when the parsed event corresponds to a
 * structured `session_not_found` from Claude (the only error category that
 * is genuinely benign for the in-run retry — see plan D-COR5 / D-COR-Resume).
 */
function classifySessionNotFound(event: { type: string; payload: Record<string, unknown> }): EarlyEventInterceptorOutcome {
  if (event.type !== 'error') return 'continue';
  const err = errorFromEvent(event.payload, 'claude');
  return err?.category === 'session_not_found' ? 'retry_with_start' : 'continue';
}

function invalidInput(message: string): ToolResult {
  return wrapErr(orchestratorError('INVALID_INPUT', message));
}

function unknownRun(runId: string): ToolResult {
  return wrapErr(orchestratorError('UNKNOWN_RUN', `Unknown run: ${runId}`));
}

function summarizeProgressEvent(event: WorkerEvent, maxTextChars: number): {
  seq: number;
  ts: string;
  type: WorkerEvent['type'];
  summary: string | null;
  text: string | null;
} {
  return {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    summary: progressEventSummary(event),
    text: progressEventText(event, maxTextChars),
  };
}

function latestProgressText(events: WorkerEvent[], maxTextChars: number): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const text = progressEventText(events[index]!, maxTextChars);
    if (text) return text;
  }
  return null;
}

function progressEventText(event: WorkerEvent, maxTextChars: number): string | null {
  if (event.type !== 'assistant_message' && event.type !== 'tool_result' && event.type !== 'error') {
    return null;
  }
  const text = textFromValue(event.payload);
  return text ? compactText(text, maxTextChars) : null;
}

function progressEventSummary(event: WorkerEvent): string | null {
  if (event.type === 'assistant_message') {
    return compactText(textFromValue(event.payload) ?? '', 240) || null;
  }
  if (event.type === 'tool_use') {
    const name = toolName(event.payload);
    const command = stringFromRecord(event.payload, 'command')
      ?? commandFromInput(event.payload.input)
      ?? commandFromInput(event.payload.arguments)
      ?? commandFromInput(event.payload.args);
    if (command) return `${name}: ${compactText(command, 180)}`;
    const path = pathFromInput(event.payload.input)
      ?? pathFromInput(event.payload.arguments)
      ?? pathFromInput(event.payload.args)
      ?? stringFromRecord(event.payload, 'path');
    return path ? `${name}: ${compactText(path, 180)}` : name;
  }
  if (event.type === 'tool_result') {
    const status = stringFromRecord(event.payload, 'status')
      ?? stringFromRecord(event.payload, 'state')
      ?? stringFromRecord(event.payload, 'subtype');
    const text = compactText(textFromValue(event.payload) ?? '', 220);
    if (status && text) return `tool_result ${status}: ${text}`;
    return text || (status ? `tool_result ${status}` : 'tool_result');
  }
  if (event.type === 'error') {
    return compactText(textFromValue(event.payload) ?? jsonPreview(event.payload), 240);
  }
  if (event.type === 'lifecycle') {
    const status = stringFromRecord(event.payload, 'status')
      ?? stringFromRecord(event.payload, 'state')
      ?? stringFromRecord(event.payload, 'subtype');
    return status ? `lifecycle: ${status}` : 'lifecycle';
  }
  return null;
}

function resultWithAssistantSummaryFallback(result: WorkerResult | null, events: WorkerEvent[]): WorkerResult | null {
  if (!result || result.summary.trim()) return result;
  const fallback = latestAssistantMessage(events);
  return fallback ? { ...result, summary: fallback } : result;
}

function latestAssistantMessage(events: WorkerEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== 'assistant_message') continue;
    const text = textFromValue(event.payload);
    if (text) return text;
  }
  return null;
}

function toolName(payload: Record<string, unknown>): string {
  return stringFromRecord(payload, 'name')
    ?? stringFromRecord(payload, 'tool_name')
    ?? stringFromRecord(payload, 'toolName')
    ?? stringFromRecord(payload, 'type')
    ?? 'tool';
}

function commandFromInput(input: unknown): string | null {
  const rec = record(input);
  if (!rec) return typeof input === 'string' && input.trim() ? input.trim() : null;
  return stringFromRecord(rec, 'command')
    ?? stringFromRecord(rec, 'cmd')
    ?? stringFromRecord(rec, 'script');
}

function pathFromInput(input: unknown): string | null {
  const rec = record(input);
  if (!rec) return null;
  return stringFromRecord(rec, 'file_path')
    ?? stringFromRecord(rec, 'filepath')
    ?? stringFromRecord(rec, 'path')
    ?? stringFromRecord(rec, 'filename');
}

function textFromValue(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (Array.isArray(value)) {
    return joinText(value.map((item) => textFromValue(item, depth + 1)));
  }
  const rec = record(value);
  if (!rec) return null;
  for (const key of ['text', 'message', 'result', 'output', 'summary', 'content']) {
    if (key === 'message' && typeof rec[key] === 'object') {
      const nested = textFromValue(rec[key], depth + 1);
      if (nested) return nested;
      continue;
    }
    const text = textFromValue(rec[key], depth + 1);
    if (text) return text;
  }
  const error = rec.error;
  if (typeof error === 'string') return error.trim() || null;
  const nestedError = record(error);
  return nestedError ? stringFromRecord(nestedError, 'message') : null;
}

function joinText(values: Array<string | null>): string | null {
  const joined = values.filter((item): item is string => Boolean(item)).join('\n').trim();
  return joined || null;
}

function stringFromRecord(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function jsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value, (key, child) => key === 'raw' ? '[raw omitted]' : child);
  } catch {
    return String(value);
  }
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function preSpawnError(backend: Backend, message: string, context: Record<string, unknown>): RunError {
  const code = typeof context.code === 'string' ? context.code : null;
  const explicitCategory = typeof context.category === 'string' ? context.category as RunErrorCategory : null;
  const explicitRetryable = typeof context.retryable === 'boolean' ? context.retryable : null;
  const category: RunErrorCategory = explicitCategory ?? (
    code === 'WORKER_BINARY_MISSING'
      ? 'worker_binary_missing'
      : message.toLowerCase().includes('cwd')
        ? 'permission'
        : 'backend_unavailable'
  );
  return {
    message,
    category,
    source: 'pre_spawn',
    backend,
    retryable: explicitRetryable ?? (code !== 'WORKER_BINARY_MISSING'),
    fatal: true,
    context,
  };
}

function enforcePolicyContextForUpsert(
  resolvedProfilesFile: string,
  policyContext: RpcPolicyContext | null | undefined,
  requestCwd: string | undefined,
): OrchestratorError | null {
  const allowed = policyContext?.writable_profiles_file;
  if (!allowed) return null;
  const resolvedAllowed = resolveWorkerProfilesFile(allowed, requestCwd);
  if (resolvedAllowed === resolvedProfilesFile) return null;
  return orchestratorError(
    'INVALID_INPUT',
    `upsert_worker_profile is restricted to the harness-pinned profiles manifest (${resolvedAllowed}); refusing to write ${resolvedProfilesFile}`,
    { profiles_file: resolvedProfilesFile, allowed_profiles_file: resolvedAllowed },
  );
}

let atomicWriteCounter = 0;

/**
 * Replace a profiles manifest file atomically. Concurrent readers
 * (`list_worker_profiles`, `start_run`, etc.) only ever see the prior or new
 * full file, never a half-written truncated one. The per-manifest update lock
 * still serializes writers; this protects independent readers.
 */
async function atomicWriteWorkerProfiles(profilesFile: string, content: string): Promise<void> {
  const dir = dirname(profilesFile);
  // Unique per-process suffix so overlapping operations cannot share a temp
  // path even if invoked back-to-back at the same millisecond.
  atomicWriteCounter = (atomicWriteCounter + 1) >>> 0;
  const suffix = `${process.pid}-${Date.now()}-${atomicWriteCounter}-${randomBytes(6).toString('hex')}`;
  const tempFile = join(dir, `.${basename(profilesFile)}.tmp-${suffix}`);
  try {
    await writeFile(tempFile, content, { mode: 0o600 });
    await rename(tempFile, profilesFile);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readWorkerProfileManifestForUpdate(
  profilesFile: string,
): Promise<{ ok: true; manifest: WorkerProfileManifest } | { ok: false; error: OrchestratorError }> {
  let value: unknown = { version: 1, profiles: {} };
  try {
    value = JSON.parse(await readFile(profilesFile, 'utf8')) as unknown;
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (code !== 'ENOENT') {
      return {
        ok: false,
        error: orchestratorError('INVALID_INPUT', `Failed to read worker profiles manifest ${profilesFile}: ${error instanceof Error ? error.message : String(error)}`, {
          profiles_file: profilesFile,
        }),
      };
    }
  }

  const parsed = parseWorkerProfileManifest(value);
  if (!parsed.ok) {
    return {
      ok: false,
      error: orchestratorError('INVALID_INPUT', `Worker profiles manifest is invalid: ${parsed.errors.join('; ')}`, {
        profiles_file: profilesFile,
        errors: parsed.errors,
      }),
    };
  }
  return { ok: true, manifest: parsed.value };
}

function workerProfileFromUpsert(input: UpsertWorkerProfile): WorkerProfile {
  const profile: WorkerProfile = { backend: input.backend };
  if (input.model !== undefined) profile.model = input.model;
  if (input.variant !== undefined) profile.variant = input.variant;
  if (input.reasoning_effort !== undefined) profile.reasoning_effort = input.reasoning_effort;
  if (input.service_tier !== undefined) profile.service_tier = input.service_tier;
  if (input.codex_network !== undefined) profile.codex_network = input.codex_network;
  if (input.worker_posture !== undefined) profile.worker_posture = input.worker_posture;
  if (input.description !== undefined) profile.description = input.description;
  if (input.metadata !== undefined) profile.metadata = input.metadata;
  if (input.claude_account !== undefined) profile.claude_account = input.claude_account;
  if (input.claude_account_priority !== undefined) profile.claude_account_priority = [...input.claude_account_priority];
  if (input.claude_cooldown_seconds !== undefined) profile.claude_cooldown_seconds = input.claude_cooldown_seconds;
  return profile;
}

function formatValidProfile(profile: ValidatedWorkerProfile): Record<string, unknown> {
  return {
    id: profile.id,
    backend: profile.backend,
    model: profile.model ?? null,
    variant: profile.variant ?? null,
    reasoning_effort: profile.reasoning_effort ?? null,
    service_tier: profile.service_tier ?? null,
    codex_network: profile.codex_network ?? null,
    worker_posture: profile.worker_posture ?? null,
    description: profile.description ?? null,
    metadata: profile.metadata ?? {},
    claude_account: profile.claude_account ?? null,
    claude_account_priority: profile.claude_account_priority ?? null,
    claude_cooldown_seconds: profile.claude_cooldown_seconds ?? null,
    capability: {
      backend: profile.capability.backend,
      display_name: profile.capability.display_name,
      availability_status: profile.capability.availability_status,
      supports_start: profile.capability.supports_start,
      supports_resume: profile.capability.supports_resume,
    },
  };
}

function invalidProfileList(profiles: InspectedWorkerProfiles): InvalidWorkerProfile[] {
  return Object.values(profiles.invalid_profiles).sort((a, b) => a.id.localeCompare(b.id));
}

// Only reasoning_effort/service_tier trigger the "rebuild settings from
// scratch" path on send_followup. codex_network is a separable concern
// (network egress posture) and should not reset reasoning_effort or
// service_tier on a one-off network override; it is patched onto the
// inherited settings instead. See T10 / S3 / R8.
function hasModelSettingsInput(input: { reasoning_effort?: ReasoningEffort; service_tier?: ServiceTier }): boolean {
  return input.reasoning_effort !== undefined || input.service_tier !== undefined;
}

function patchCodexNetwork(settings: RunModelSettings, codexNetwork: CodexNetwork, workerPosture: WorkerPosture | undefined): { ok: true; value: RunModelSettings } {
  // Preserve reasoning_effort/service_tier from the parent; only patch
  // codex_network (and re-derive the mode breadcrumb). Issue #58: a
  // follow-up may also override worker_posture; preserve the inherited
  // value when the follow-up did not.
  return {
    ok: true,
    value: {
      ...settings,
      mode: codexNetwork === 'isolated' ? 'normal' : null,
      codex_network: codexNetwork,
      worker_posture: workerPosture ?? settings.worker_posture ?? null,
    },
  };
}

function isProfileModeMetadata(metadata: Record<string, unknown>): boolean {
  const workerProfile = metadata.worker_profile;
  if (!workerProfile || typeof workerProfile !== 'object' || Array.isArray(workerProfile)) return false;
  return (workerProfile as { mode?: unknown }).mode === 'profile';
}

function parseProfileModelSettings(
  profile: ValidatedWorkerProfile,
  profilesFile: string,
): { ok: true; reasoningEffort: ReasoningEffort | undefined; serviceTier: ServiceTier | undefined; codexNetwork: CodexNetwork | undefined; workerPosture: WorkerPosture | undefined } | { ok: false; error: OrchestratorError } {
  const reasoningEffort = profile.reasoning_effort
    ? ReasoningEffortSchema.safeParse(profile.reasoning_effort)
    : null;
  if (reasoningEffort && !reasoningEffort.success) {
    return {
      ok: false,
      error: orchestratorError('INVALID_INPUT', `Profile ${profile.id} has invalid reasoning_effort ${profile.reasoning_effort}`, {
        profile: profile.id,
        profiles_file: profilesFile,
      }),
    };
  }

  const serviceTier = profile.service_tier
    ? ServiceTierSchema.safeParse(profile.service_tier)
    : null;
  if (serviceTier && !serviceTier.success) {
    return {
      ok: false,
      error: orchestratorError('INVALID_INPUT', `Profile ${profile.id} has invalid service_tier ${profile.service_tier}`, {
        profile: profile.id,
        profiles_file: profilesFile,
      }),
    };
  }

  const codexNetwork = profile.codex_network
    ? CodexNetworkSchema.safeParse(profile.codex_network)
    : null;
  if (codexNetwork && !codexNetwork.success) {
    return {
      ok: false,
      error: orchestratorError('INVALID_INPUT', `Profile ${profile.id} has invalid codex_network ${profile.codex_network}`, {
        profile: profile.id,
        profiles_file: profilesFile,
      }),
    };
  }

  // Issue #58: profile manifests store worker_posture as a plain string
  // (`WorkerProfileSchema`); validate against the orchestrator's typed enum
  // here so invalid values fail at start-run time with a clear error.
  const workerPosture = profile.worker_posture
    ? WorkerPostureSchema.safeParse(profile.worker_posture)
    : null;
  if (workerPosture && !workerPosture.success) {
    return {
      ok: false,
      error: orchestratorError('INVALID_INPUT', `Profile ${profile.id} has invalid worker_posture ${profile.worker_posture} (must be 'trusted' or 'restricted')`, {
        profile: profile.id,
        profiles_file: profilesFile,
      }),
    };
  }

  return {
    ok: true,
    reasoningEffort: reasoningEffort?.data,
    serviceTier: serviceTier?.data,
    codexNetwork: codexNetwork?.data,
    workerPosture: workerPosture?.data,
  };
}

function metadataForFollowup(
  parentMetadata: Record<string, unknown>,
  childMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const { worker_profile: _workerProfile, ...inheritedMetadata } = parentMetadata;
  return { ...inheritedMetadata, ...childMetadata };
}

interface ClaudeBindingValue {
  account: { name: string };
  accountSpawn: AccountSpawnContribution;
  rotationState: ClaudeRotationState | null;
  cooldownSeconds: number;
}

type ClaudeBindingResolution =
  | { ok: true; binding: ClaudeBindingValue | null }
  | { ok: false; error: OrchestratorError };

interface RotationContext {
  binding: { account: { name: string }; accountSpawn: AccountSpawnContribution };
  priorAccount: string | null;
  parentErrorCategory: string;
  rotationState: ClaudeRotationState;
  cooldownSeconds: number;
}

type RotationDecision =
  | { ok: true; rotation: RotationContext | null; releaseLock?: () => void }
  | { ok: false; error: OrchestratorError };

function applyClaudeBindingToMetadata(
  metadata: Record<string, unknown>,
  binding: ClaudeBindingValue | null,
): Record<string, unknown> {
  if (!binding) return metadata;
  const out: Record<string, unknown> = { ...metadata, claude_account_used: binding.account.name };
  if (binding.rotationState) out.claude_rotation_state = binding.rotationState;
  return out;
}

function applyRotationMetadata(
  base: Record<string, unknown>,
  rotation: RotationContext,
  parentRunId: string,
  resumed: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  out.claude_account_used = rotation.binding.account.name;
  out.claude_rotation_state = rotation.rotationState;
  const history = readRotationHistory(base);
  const entry: ClaudeRotationHistoryEntry = {
    parent_run_id: parentRunId,
    prior_account: rotation.priorAccount ?? '',
    new_account: rotation.binding.account.name,
    parent_error_category: rotation.parentErrorCategory,
    rotated_at: new Date().toISOString(),
    resumed,
  };
  const result = appendRotationEntry(history, entry);
  void ROTATION_HISTORY_CAP; // keep import for documentation tests
  out.claude_rotation_history = result.history;
  return out;
}

function orchestratorIdFromMeta(metadata: Record<string, unknown> | undefined): string | null {
  const value = metadata?.orchestrator_id;
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Stamp `metadata.orchestrator_id` from `RpcPolicyContext.orchestrator_id`
 * (issue #40, Decision 10 / R8). The harness-owned MCP server entry pins
 * this value via env so the model never authors it.
 *
 * Forge-prevention invariant: any model- or parent-supplied
 * `orchestrator_id` on the incoming metadata is **stripped first**,
 * regardless of whether a pinned id is present. Then, only when a pinned id
 * exists, it is added back from the policy context.
 *
 * Calls without a pinned id (e.g. CLI smoke tests) end with no
 * `orchestrator_id` on the run, so the run is never aggregated to any
 * orchestrator. This applies to direct `start_run` calls and to follow-up
 * runs whose parent metadata may itself carry a stamp from a previous turn.
 */
export function stampOrchestratorIdInMetadata(
  metadata: Record<string, unknown>,
  policyContext: RpcPolicyContext | null | undefined,
): Record<string, unknown> {
  const { orchestrator_id: _stripped, ...rest } = metadata;
  void _stripped;
  const pinned = policyContext?.orchestrator_id;
  if (!pinned) return rest;
  return { ...rest, orchestrator_id: pinned };
}

function modelSettingsForBackend(
  backend: Backend,
  model: string | null | undefined,
  reasoningEffort: ReasoningEffort | undefined,
  serviceTier: ServiceTier | undefined,
  codexNetwork: CodexNetwork | undefined,
  workerPosture: WorkerPosture | undefined,
): { ok: true; value: RunModelSettings } | { ok: false; error: OrchestratorError } {
  // Issue #58: resolved posture lands on every run record. Default to
  // 'trusted' when the caller did not specify one, so new runs always carry
  // a concrete value (legacy null only persists for pre-#58 run records).
  const resolvedWorkerPosture: WorkerPosture = workerPosture ?? 'trusted';
  if (backend === 'codex') {
    if (reasoningEffort === 'max') {
      return { ok: false, error: orchestratorError('INVALID_INPUT', 'Codex reasoning_effort must be one of none, minimal, low, medium, high, or xhigh') };
    }
    // Issue #58 review follow-up (High): codex_network defaulting is now
    // posture-aware. The trusted-default argv (sandbox_mode="workspace-write"
    // + network_access=true) is distinct from explicit codex_network='isolated'
    // (no flags) and from explicit codex_network='workspace' (only
    // network_access=true). To preserve those three argv cells distinctly,
    // trusted+absent must leave codex_network null on the run record so
    // `sandboxArgs()` can emit the trusted-default flags. Restricted keeps the
    // issue #31 OD1=B uniform default of 'isolated' on absent so the v1
    // contract continues to hold for opt-in callers.
    //
    // The internal `mode` field stays as a derived breadcrumb: 'normal' only
    // when the resolved codex_network is 'isolated', otherwise null.
    // service_tier='normal' continues to be suppressed in serialization
    // because codex's CLI default is 'normal'.
    const resolvedCodexNetwork: CodexNetwork | null = codexNetwork
      ?? (resolvedWorkerPosture === 'restricted' ? 'isolated' : null);
    return {
      ok: true,
      value: {
        reasoning_effort: reasoningEffort ?? null,
        service_tier: serviceTier && serviceTier !== 'normal' ? serviceTier : null,
        mode: resolvedCodexNetwork === 'isolated' ? 'normal' : null,
        codex_network: resolvedCodexNetwork,
        worker_posture: resolvedWorkerPosture,
      },
    };
  }

  if (codexNetwork !== undefined) {
    return { ok: false, error: orchestratorError('INVALID_INPUT', `codex_network is only supported on the codex backend; got backend ${backend}`) };
  }

  if (backend === 'cursor') {
    if (reasoningEffort !== undefined) {
      return { ok: false, error: orchestratorError('INVALID_INPUT', 'Cursor backend does not support reasoning_effort in this release; pass model only') };
    }
    if (serviceTier !== undefined) {
      return { ok: false, error: orchestratorError('INVALID_INPUT', 'Cursor backend does not support service_tier; pass model only') };
    }
    if (typeof model !== 'string' || model.trim() === '') {
      return { ok: false, error: orchestratorError('INVALID_INPUT', 'Cursor backend requires an explicit model id (no backend default); set the model field') };
    }
    return {
      ok: true,
      value: {
        reasoning_effort: null,
        service_tier: null,
        mode: null,
        codex_network: null,
        worker_posture: resolvedWorkerPosture,
      },
    };
  }

  if (serviceTier !== undefined) {
    return { ok: false, error: orchestratorError('INVALID_INPUT', 'Claude does not support service_tier; set reasoning_effort and model only') };
  }
  const claudeModelError = validateClaudeModelAndEffort(model, reasoningEffort);
  if (claudeModelError) return { ok: false, error: orchestratorError('INVALID_INPUT', claudeModelError) };
  return {
    ok: true,
    value: {
      reasoning_effort: reasoningEffort ?? null,
      service_tier: null,
      mode: null,
      codex_network: null,
      worker_posture: resolvedWorkerPosture,
    },
  };
}

function validateInheritedModelSettingsForBackend(
  backend: Backend,
  model: string | null | undefined,
  settings: RunModelSettings,
): { ok: true; value: RunModelSettings } | { ok: false; error: OrchestratorError } {
  if (backend === 'cursor') {
    if (settings.reasoning_effort !== null || settings.service_tier !== null) {
      return { ok: false, error: orchestratorError('INVALID_INPUT', 'Cursor backend does not support reasoning_effort or service_tier; clear them before sending a follow-up') };
    }
    if (typeof model !== 'string' || model.trim() === '') {
      return { ok: false, error: orchestratorError('INVALID_INPUT', 'Cursor backend requires an explicit model id; the parent run does not provide one to inherit') };
    }
    return { ok: true, value: settings };
  }
  if (backend !== 'claude') return { ok: true, value: settings };
  const reasoningEffort = parseReasoningEffort(settings.reasoning_effort);
  const error = validateClaudeModelAndEffort(model, reasoningEffort);
  return error ? { ok: false, error: orchestratorError('INVALID_INPUT', error) } : { ok: true, value: settings };
}

function parseReasoningEffort(value: string | null | undefined): ReasoningEffort | undefined {
  const parsed = value ? ReasoningEffortSchema.safeParse(value) : null;
  return parsed?.success ? parsed.data : undefined;
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function nullablePositiveInt(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return positiveInt(value) ?? undefined;
}

function normalizeConfig(parsed: Record<string, unknown>): { config: OrchestratorConfig; fileValue: Record<string, unknown>; shouldWrite: boolean } {
  if (isLegacyGeneratedConfig(parsed)) {
    return {
      config: defaultConfig,
      fileValue: { ...defaultConfig },
      shouldWrite: true,
    };
  }

  const maxIdle = positiveInt(parsed.max_idle_timeout_seconds) ?? defaultConfig.max_idle_timeout_seconds;
  const defaultIdleCandidate = positiveInt(parsed.default_idle_timeout_seconds) ?? defaultConfig.default_idle_timeout_seconds;
  const defaultIdle = defaultIdleCandidate <= maxIdle ? defaultIdleCandidate : Math.min(defaultConfig.default_idle_timeout_seconds, maxIdle);
  const maxExecution = positiveInt(parsed.max_execution_timeout_seconds) ?? defaultConfig.max_execution_timeout_seconds;
  const defaultExecutionCandidate = nullablePositiveInt(parsed.default_execution_timeout_seconds);
  const defaultExecution = defaultExecutionCandidate === undefined ? defaultConfig.default_execution_timeout_seconds : defaultExecutionCandidate;
  const boundedDefaultExecution = defaultExecution !== null && defaultExecution > maxExecution ? defaultConfig.default_execution_timeout_seconds : defaultExecution;
  const config: OrchestratorConfig = {
    default_idle_timeout_seconds: defaultIdle,
    max_idle_timeout_seconds: maxIdle,
    default_execution_timeout_seconds: boundedDefaultExecution,
    max_execution_timeout_seconds: maxExecution,
  };
  const fileValue = { ...parsed, ...config };
  return {
    config,
    fileValue,
    shouldWrite: missingConfigFields(parsed) || !sameConfigFields(parsed, config),
  };
}

function isLegacyGeneratedConfig(parsed: Record<string, unknown>): boolean {
  return parsed.default_execution_timeout_seconds === legacyGeneratedConfig.default_execution_timeout_seconds
    && parsed.max_execution_timeout_seconds === legacyGeneratedConfig.max_execution_timeout_seconds
    && parsed.default_idle_timeout_seconds === undefined
    && parsed.max_idle_timeout_seconds === undefined;
}

function missingConfigFields(parsed: Record<string, unknown>): boolean {
  return parsed.default_idle_timeout_seconds === undefined
    || parsed.max_idle_timeout_seconds === undefined
    || parsed.default_execution_timeout_seconds === undefined
    || parsed.max_execution_timeout_seconds === undefined;
}

function sameConfigFields(parsed: Record<string, unknown>, config: OrchestratorConfig): boolean {
  return parsed.default_idle_timeout_seconds === config.default_idle_timeout_seconds
    && parsed.max_idle_timeout_seconds === config.max_idle_timeout_seconds
    && parsed.default_execution_timeout_seconds === config.default_execution_timeout_seconds
    && parsed.max_execution_timeout_seconds === config.max_execution_timeout_seconds;
}

function displayMetadata(
  metadata: Record<string, unknown>,
  prompt: string,
  parent?: RunDisplayMetadata,
): RunDisplayMetadata {
  const promptFallback = promptTitleFromPrompt(prompt);
  return {
    session_title: metadataString(metadata, 'session_title') ?? parent?.session_title ?? metadataString(metadata, 'title') ?? promptFallback,
    session_summary: metadataString(metadata, 'session_summary') ?? parent?.session_summary ?? metadataString(metadata, 'summary'),
    prompt_title: metadataString(metadata, 'prompt_title') ?? metadataString(metadata, 'title') ?? promptFallback,
    prompt_summary: metadataString(metadata, 'prompt_summary') ?? metadataString(metadata, 'summary'),
  };
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function promptTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine) return 'Untitled prompt';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function scheduleProcessExit(): void {
  setTimeout(() => process.exit(0), 100);
}
