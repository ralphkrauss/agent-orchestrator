import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  AckRunNotificationInputSchema,
  BackendSchema,
  CancelRunInputSchema,
  GetObservabilitySnapshotInputSchema,
  GetRunEventsInputSchema,
  GetRunProgressInputSchema,
  isTerminalStatus,
  ListRunNotificationsInputSchema,
  ListWorkerProfilesInputSchema,
  orchestratorError,
  PruneRunsInputSchema,
  ReasoningEffortSchema,
  RunIdInputSchema,
  SendFollowupInputSchema,
  ShutdownInputSchema,
  StartRunInputSchema,
  ServiceTierSchema,
  UpsertWorkerProfileInputSchema,
  WaitForAnyRunInputSchema,
  WaitForRunInputSchema,
  wrapErr,
  wrapOk,
  type Backend,
  type RunDisplayMetadata,
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
  type ToolResponse,
  type UpsertWorkerProfile,
  type WorkerEvent,
  type WorkerResult,
} from './contract.js';
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
  metadata: Record<string, unknown>;
}

export class OrchestratorService {
  private readonly activeRuns = new Map<string, RuntimeRunHandle>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly profileUpdateLocks = new Map<string, Promise<void>>();
  private config: OrchestratorConfig = defaultConfig;
  private shuttingDown = false;

  constructor(
    readonly store: RunStore,
    private readonly runtimes: Map<Backend, WorkerRuntime>,
    private readonly logger: OrchestratorLogger = defaultLogger,
  ) {}

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
        return this.startRun(params);
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
        return this.sendFollowup(params);
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
      default:
        return wrapErr(orchestratorError('INVALID_INPUT', `Unknown method: ${method}`));
    }
  }

  async startRun(params: unknown): Promise<ToolResult> {
    const parsed = StartRunInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const input = parsed.data;
    const resolved = await this.resolveStartRunTarget(input);
    if (!resolved.ok) return wrapErr(resolved.error);
    const { backendName, runtime, model, reasoningEffort, serviceTier, metadata } = resolved.value;
    const idleTimeout = this.resolveIdleTimeout(input.idle_timeout_seconds);
    if (!idleTimeout.ok) return wrapErr(idleTimeout.error);
    const executionTimeout = this.resolveExecutionTimeout(input.execution_timeout_seconds);
    if (!executionTimeout.ok) return wrapErr(executionTimeout.error);
    const settings = modelSettingsForBackend(backendName, model, reasoningEffort, serviceTier);
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

    await this.startManagedRun(meta.run_id, runtime, input.prompt, input.cwd, idleTimeout.value, executionTimeout.value, settings.value, model, undefined);
    return wrapOk({ run_id: meta.run_id });
  }

  private async resolveStartRunTarget(input: StartRun): Promise<{ ok: true; value: ResolvedStartRunTarget } | { ok: false; error: OrchestratorError }> {
    if (!input.profile) {
      if (!input.backend) {
        return { ok: false, error: orchestratorError('INVALID_INPUT', 'Direct worker starts require backend') };
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
          metadata: input.metadata,
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
        metadata: {
          ...input.metadata,
          worker_profile: {
            mode: 'profile',
            profile: profile.id,
            profiles_file: profilesFile,
          },
        },
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

  async sendFollowup(params: unknown): Promise<ToolResult> {
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
    const idleTimeout = this.resolveIdleTimeout(parsed.data.idle_timeout_seconds);
    if (!idleTimeout.ok) return wrapErr(idleTimeout.error);
    const executionTimeout = this.resolveExecutionTimeout(parsed.data.execution_timeout_seconds);
    if (!executionTimeout.ok) return wrapErr(executionTimeout.error);
    const model = parsed.data.model ?? parent.meta.model;
    const metadata = metadataForFollowup(parent.meta.metadata, parsed.data.metadata);
    const modelSource: ModelSource = parsed.data.model ? 'explicit' : parent.meta.model ? 'inherited' : 'backend_default';
    const settings = hasModelSettingsInput(parsed.data)
      ? modelSettingsForBackend(backendName, model, parsed.data.reasoning_effort, parsed.data.service_tier)
      : parsed.data.model || backendName === 'cursor'
        ? validateInheritedModelSettingsForBackend(backendName, model, parent.meta.model_settings)
        : { ok: true as const, value: parent.meta.model_settings };
    if (!settings.ok) return wrapErr(settings.error);

    const meta = await this.store.createRun({
      backend: backendName,
      cwd: parent.meta.cwd,
      prompt: parsed.data.prompt,
      parent_run_id: parent.meta.run_id,
      session_id: resumeSessionId,
      requested_session_id: resumeSessionId,
      model,
      model_source: modelSource,
      model_settings: settings.value,
      display: displayMetadata(parsed.data.metadata, parsed.data.prompt, parent.meta.display),
      metadata,
      idle_timeout_seconds: idleTimeout.value,
      execution_timeout_seconds: executionTimeout.value,
    });
    await this.captureAndPersistGitSnapshot(meta.run_id, parent.meta.cwd);

    await this.startManagedRun(meta.run_id, runtime, parsed.data.prompt, parent.meta.cwd, idleTimeout.value, executionTimeout.value, settings.value, model, resumeSessionId);
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
    handle.completion.finally(() => {
      this.clearRunTimer(runId);
      this.activeRuns.delete(runId);
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

function hasModelSettingsInput(input: { reasoning_effort?: ReasoningEffort; service_tier?: ServiceTier }): boolean {
  return input.reasoning_effort !== undefined || input.service_tier !== undefined;
}

function parseProfileModelSettings(
  profile: ValidatedWorkerProfile,
  profilesFile: string,
): { ok: true; reasoningEffort: ReasoningEffort | undefined; serviceTier: ServiceTier | undefined } | { ok: false; error: OrchestratorError } {
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

  return {
    ok: true,
    reasoningEffort: reasoningEffort?.data,
    serviceTier: serviceTier?.data,
  };
}

function metadataForFollowup(
  parentMetadata: Record<string, unknown>,
  childMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const { worker_profile: _workerProfile, ...inheritedMetadata } = parentMetadata;
  return { ...inheritedMetadata, ...childMetadata };
}

function modelSettingsForBackend(
  backend: Backend,
  model: string | null | undefined,
  reasoningEffort: ReasoningEffort | undefined,
  serviceTier: ServiceTier | undefined,
): { ok: true; value: RunModelSettings } | { ok: false; error: OrchestratorError } {
  if (backend === 'codex') {
    if (reasoningEffort === 'max') {
      return { ok: false, error: orchestratorError('INVALID_INPUT', 'Codex reasoning_effort must be one of none, minimal, low, medium, high, or xhigh') };
    }
    return {
      ok: true,
      value: {
        reasoning_effort: reasoningEffort ?? null,
        service_tier: serviceTier && serviceTier !== 'normal' ? serviceTier : null,
        mode: serviceTier === 'normal' ? 'normal' : null,
      },
    };
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
