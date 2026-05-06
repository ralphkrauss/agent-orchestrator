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
  type WorkerResult,
} from './contract.js';
import { OrchestratorRegistry } from './daemon/orchestratorRegistry.js';
import { computeOrchestratorStatusSnapshot } from './daemon/orchestratorStatus.js';
import { validateClaudeModelAndEffort } from './backend/claudeValidation.js';
import type { RuntimeRunHandle, WorkerRuntime } from './backend/runtime.js';
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
  metadata: Record<string, unknown>;
  profileId: string | null;
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
    const { backendName, runtime, model, reasoningEffort, serviceTier, codexNetwork, metadata: resolvedMetadata, profileId } = resolved.value;
    const metadata = stampOrchestratorIdInMetadata(resolvedMetadata, context.policy_context);
    const idleTimeout = this.resolveIdleTimeout(input.idle_timeout_seconds);
    if (!idleTimeout.ok) return wrapErr(idleTimeout.error);
    const executionTimeout = this.resolveExecutionTimeout(input.execution_timeout_seconds);
    if (!executionTimeout.ok) return wrapErr(executionTimeout.error);
    const settings = modelSettingsForBackend(backendName, model, reasoningEffort, serviceTier, codexNetwork);
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
    await this.maybeEmitCodexNetworkDefaultWarning(meta.run_id, backendName, codexNetwork, profileId);

    await this.startManagedRun(meta.run_id, runtime, input.prompt, input.cwd, idleTimeout.value, executionTimeout.value, settings.value, model, undefined);
    return wrapOk({ run_id: meta.run_id });
  }

  // C12 / T11: emit a single non-blocking lifecycle warning event when a codex
  // run resolved its codex_network from the OD1=B default ('isolated') because
  // neither the profile nor the direct-mode argument set it explicitly. The
  // warning never blocks the run; it surfaces in the run's event log alongside
  // failing tool calls so users hitting the breaking change can correlate.
  private async maybeEmitCodexNetworkDefaultWarning(
    runId: string,
    backendName: Backend,
    explicitCodexNetwork: CodexNetwork | undefined,
    profileId: string | null,
  ): Promise<void> {
    if (backendName !== 'codex' || explicitCodexNetwork !== undefined) return;
    const profilePart = profileId ? `profile ${profileId}` : 'direct-mode run';
    const message = `agent-orchestrator codex_network not set on ${profilePart}; defaulting to 'isolated' (no network access). Set codex_network explicitly to silence this warning. See docs/development/codex-backend.md for migration.`;
    try {
      await this.store.appendEvent(runId, {
        type: 'lifecycle',
        payload: {
          state: 'codex_network_defaulted',
          warning: message,
          profile: profileId,
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
      return {
        ok: true,
        value: {
          backendName: input.backend,
          runtime,
          model: input.model ?? null,
          reasoningEffort: input.reasoning_effort,
          serviceTier: input.service_tier,
          codexNetwork: input.codex_network,
          metadata: input.metadata,
          profileId: null,
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
    return {
      ok: true,
      value: {
        backendName: backendName.data,
        runtime,
        model: profile.model ?? null,
        reasoningEffort: profileSettings.reasoningEffort,
        serviceTier: profileSettings.serviceTier,
        codexNetwork: profileSettings.codexNetwork,
        metadata: {
          ...input.metadata,
          worker_profile: {
            mode: 'profile',
            profile: profile.id,
            profiles_file: profilesFile,
          },
        },
        profileId: profile.id,
      },
    };
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
    const inspected = inspectWorkerProfiles(parsedManifest.value, createWorkerCapabilityCatalog(status));
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
    return loadInspectedWorkerProfilesFromFile(profilesFile, createWorkerCapabilityCatalog(status));
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
    const resumeSessionId = parent.meta.observed_session_id ?? parent.meta.session_id;
    if (!resumeSessionId) {
      return wrapErr(orchestratorError('INVALID_STATE', 'Cannot send follow-up because parent run has no backend session id'));
    }

    const backendName = BackendSchema.parse(parent.meta.backend);
    const runtime = this.runtimes.get(backendName);
    if (!runtime) return wrapErr(orchestratorError('BACKEND_NOT_FOUND', `Backend not found: ${backendName}`));
    // OD2 = B (locked 2026-05-05): direct-mode-only override. send_followup
    // must reject codex_network whenever the *originating* start_run was a
    // profile-mode call, not just when the immediate parent was. metadata
    // strips worker_profile on every follow-up step (intentionally — child
    // runs are not themselves profile aliases), so checking only
    // parent.meta.metadata would miss `start_run(profile) -> send_followup
    // -> send_followup(codex_network)` chains. Walk back through
    // parent_run_id until we hit the chain root and check the root's
    // metadata.worker_profile flag.
    const chainOriginIsProfileMode = await this.chainOriginatedFromProfileMode(parent.meta);
    if (parsed.data.codex_network !== undefined && chainOriginIsProfileMode) {
      return wrapErr(orchestratorError('INVALID_INPUT', 'Profile-mode follow-ups cannot override codex_network; edit the profile or run a direct-mode follow-up instead'));
    }
    if (parsed.data.codex_network !== undefined && backendName !== 'codex') {
      return wrapErr(orchestratorError('INVALID_INPUT', `codex_network is only supported on the codex backend; got backend ${backendName}`));
    }
    const idleTimeout = this.resolveIdleTimeout(parsed.data.idle_timeout_seconds);
    if (!idleTimeout.ok) return wrapErr(idleTimeout.error);
    const executionTimeout = this.resolveExecutionTimeout(parsed.data.execution_timeout_seconds);
    if (!executionTimeout.ok) return wrapErr(executionTimeout.error);
    const model = parsed.data.model ?? parent.meta.model;
    const metadata = stampOrchestratorIdInMetadata(
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
    const settings = hasModelSettingsInput(parsed.data)
      ? modelSettingsForBackend(backendName, model, parsed.data.reasoning_effort, parsed.data.service_tier, inheritedCodexNetwork)
      : parsed.data.codex_network !== undefined
        ? patchCodexNetwork(parent.meta.model_settings, parsed.data.codex_network)
        : parsed.data.model || backendName === 'cursor'
          ? validateInheritedModelSettingsForBackend(backendName, model, parent.meta.model_settings)
          : { ok: true as const, value: parent.meta.model_settings };
    if (!settings.ok) return wrapErr(settings.error);
    // B2 (issue #31): normalize legacy parent records before persisting the
    // child. A legacy codex parent has model_settings.codex_network === null;
    // sandboxArgs() defensively treats that as 'isolated', but the child run
    // record must reflect the *effective* posture (plan invariant: "effective
    // codex_network lands in run_summary.model_settings"). Only normalize for
    // the codex backend; non-codex follow-ups must keep codex_network: null.
    const persistedSettings = backendName === 'codex' && settings.value.codex_network === null
      ? { ...settings.value, codex_network: 'isolated' as CodexNetwork, mode: 'normal' as const }
      : settings.value;

    const meta = await this.store.createRun({
      backend: backendName,
      cwd: parent.meta.cwd,
      prompt: parsed.data.prompt,
      parent_run_id: parent.meta.run_id,
      session_id: resumeSessionId,
      requested_session_id: resumeSessionId,
      model,
      model_source: modelSource,
      model_settings: persistedSettings,
      display: displayMetadata(parsed.data.metadata, parsed.data.prompt, parent.meta.display),
      metadata,
      idle_timeout_seconds: idleTimeout.value,
      execution_timeout_seconds: executionTimeout.value,
    });
    await this.captureAndPersistGitSnapshot(meta.run_id, parent.meta.cwd);

    await this.startManagedRun(meta.run_id, runtime, parsed.data.prompt, parent.meta.cwd, idleTimeout.value, executionTimeout.value, persistedSettings, model, resumeSessionId);
    return wrapOk({ run_id: meta.run_id });
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
  ): Promise<void> {
    try {
      await access(cwd, constants.R_OK | constants.W_OK);
    } catch (error) {
      await this.failPreSpawn(runId, runtime.name, 'cwd is not readable and writable', { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const startInput = { runId, prompt, cwd, model, modelSettings };
    const result = sessionId
      ? await runtime.resume(sessionId, startInput)
      : await runtime.start(startInput);
    if (!result.ok) {
      const failure = result.failure;
      await this.failPreSpawn(runId, runtime.name, failure.message, { ...failure.details, code: failure.code });
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
  }

  private async failPreSpawn(runId: string, backend: Backend, message: string, context: Record<string, unknown>): Promise<void> {
    const latestError = preSpawnError(backend, message, context);
    const result: WorkerResult = {
      status: 'failed',
      summary: message,
      files_changed: [],
      commands_run: [],
      artifacts: this.store.defaultArtifacts(runId),
      errors: [latestError],
    };
    await this.store.markTerminal(runId, 'failed', result.errors, result, {
      reason: 'pre_spawn_failed',
      latest_error: latestError,
      context,
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
  if (input.description !== undefined) profile.description = input.description;
  if (input.metadata !== undefined) profile.metadata = input.metadata;
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
    description: profile.description ?? null,
    metadata: profile.metadata ?? {},
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

function patchCodexNetwork(settings: RunModelSettings, codexNetwork: CodexNetwork): { ok: true; value: RunModelSettings } {
  // Preserve reasoning_effort/service_tier from the parent; only patch
  // codex_network (and re-derive the mode breadcrumb).
  return {
    ok: true,
    value: {
      ...settings,
      mode: codexNetwork === 'isolated' ? 'normal' : null,
      codex_network: codexNetwork,
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
): { ok: true; reasoningEffort: ReasoningEffort | undefined; serviceTier: ServiceTier | undefined; codexNetwork: CodexNetwork | undefined } | { ok: false; error: OrchestratorError } {
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

  return {
    ok: true,
    reasoningEffort: reasoningEffort?.data,
    serviceTier: serviceTier?.data,
    codexNetwork: codexNetwork?.data,
  };
}

function metadataForFollowup(
  parentMetadata: Record<string, unknown>,
  childMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const { worker_profile: _workerProfile, ...inheritedMetadata } = parentMetadata;
  return { ...inheritedMetadata, ...childMetadata };
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
): { ok: true; value: RunModelSettings } | { ok: false; error: OrchestratorError } {
  if (backend === 'codex') {
    if (reasoningEffort === 'max') {
      return { ok: false, error: orchestratorError('INVALID_INPUT', 'Codex reasoning_effort must be one of none, minimal, low, medium, high, or xhigh') };
    }
    // Per OD1 = B (issue #31, locked 2026-05-05): the codex backend's network
    // posture is now driven exclusively by codex_network. service_tier no
    // longer derives mode='normal' (and therefore no longer derives
    // --ignore-user-config). When codex_network is unset we default to
    // 'isolated', matching the locked OD1 = B uniform default. The internal
    // `mode` field is retained as a derived breadcrumb (now derived from
    // codex_network rather than service_tier) so observability and
    // run-record back-compat keep working. service_tier='normal' continues
    // to be suppressed in serialization because codex's CLI default is
    // 'normal'; explicit re-emission of the default would add no behavior
    // and would churn the codex argv shape.
    const resolvedCodexNetwork: CodexNetwork = codexNetwork ?? 'isolated';
    return {
      ok: true,
      value: {
        reasoning_effort: reasoningEffort ?? null,
        service_tier: serviceTier && serviceTier !== 'normal' ? serviceTier : null,
        mode: resolvedCodexNetwork === 'isolated' ? 'normal' : null,
        codex_network: resolvedCodexNetwork,
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
