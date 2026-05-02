import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  BackendSchema,
  CancelRunInputSchema,
  GetObservabilitySnapshotInputSchema,
  GetRunEventsInputSchema,
  isTerminalStatus,
  ListWorkerProfilesInputSchema,
  orchestratorError,
  PruneRunsInputSchema,
  ReasoningEffortSchema,
  RunIdInputSchema,
  SendFollowupInputSchema,
  ShutdownInputSchema,
  StartRunInputSchema,
  ServiceTierSchema,
  WaitForRunInputSchema,
  wrapErr,
  wrapOk,
  type Backend,
  type RunDisplayMetadata,
  type ReasoningEffort,
  type ModelSource,
  type OrchestratorError,
  type StartRun,
  type RunStatus,
  type RunModelSettings,
  type RunError,
  type ServiceTier,
  type ToolResponse,
  type WorkerResult,
} from './contract.js';
import type { WorkerBackend } from './backend/WorkerBackend.js';
import { validateClaudeModelAndEffort } from './backend/claudeValidation.js';
import { resolveBinary } from './backend/common.js';
import { getBackendStatus } from './diagnostics.js';
import { captureGitSnapshot } from './gitSnapshot.js';
import { buildObservabilitySnapshot } from './observability.js';
import { createWorkerCapabilityCatalog, type ValidatedWorkerProfile } from './opencode/capabilities.js';
import { getPackageVersion } from './packageMetadata.js';
import { ProcessManager, type ManagedRun } from './processManager.js';
import { RunStore } from './runStore.js';
import { loadValidatedWorkerProfilesFromFile, resolveWorkerProfilesFile } from './workerRouting.js';

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
}

interface ResolvedStartRunTarget {
  backendName: Backend;
  backend: WorkerBackend;
  model: string | null;
  reasoningEffort: ReasoningEffort | undefined;
  serviceTier: ServiceTier | undefined;
  metadata: Record<string, unknown>;
}

export class OrchestratorService {
  private readonly processManager: ProcessManager;
  private readonly activeRuns = new Map<string, ManagedRun>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private config: OrchestratorConfig = defaultConfig;
  private shuttingDown = false;

  constructor(
    readonly store: RunStore,
    private readonly backends: Map<Backend, WorkerBackend>,
    private readonly logger: OrchestratorLogger = defaultLogger,
  ) {
    this.processManager = new ProcessManager(store);
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
        return this.startRun(params);
      case 'list_worker_profiles':
        return this.listWorkerProfiles(params);
      case 'list_runs':
        return wrapOk({ runs: await this.store.listRuns() });
      case 'get_run_status':
        return this.getRunStatus(params);
      case 'get_run_events':
        return this.getRunEvents(params);
      case 'wait_for_run':
        return this.waitForRun(params);
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
    const { backendName, backend, model, reasoningEffort, serviceTier, metadata } = resolved.value;
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

    await this.startManagedRun(meta.run_id, backend, input.prompt, input.cwd, idleTimeout.value, executionTimeout.value, settings.value, undefined, model ?? undefined);
    return wrapOk({ run_id: meta.run_id });
  }

  private async resolveStartRunTarget(input: StartRun): Promise<{ ok: true; value: ResolvedStartRunTarget } | { ok: false; error: OrchestratorError }> {
    if (!input.profile) {
      if (!input.backend) {
        return { ok: false, error: orchestratorError('INVALID_INPUT', 'Direct worker starts require backend') };
      }
      const backend = this.backends.get(input.backend);
      if (!backend) return { ok: false, error: orchestratorError('BACKEND_NOT_FOUND', `Backend not found: ${input.backend}`) };
      return {
        ok: true,
        value: {
          backendName: input.backend,
          backend,
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
    const backend = this.backends.get(backendName.data);
    if (!backend) {
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
        backend,
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
        .map((profile) => ({
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
        })),
    });
  }

  private async loadLiveWorkerProfiles(profilesFile: string): ReturnType<typeof loadValidatedWorkerProfilesFromFile> {
    const status = await getBackendStatus();
    return loadValidatedWorkerProfilesFromFile(profilesFile, createWorkerCapabilityCatalog(status));
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
    const backend = this.backends.get(backendName);
    if (!backend) return wrapErr(orchestratorError('BACKEND_NOT_FOUND', `Backend not found: ${backendName}`));
    const idleTimeout = this.resolveIdleTimeout(parsed.data.idle_timeout_seconds);
    if (!idleTimeout.ok) return wrapErr(idleTimeout.error);
    const executionTimeout = this.resolveExecutionTimeout(parsed.data.execution_timeout_seconds);
    if (!executionTimeout.ok) return wrapErr(executionTimeout.error);
    const model = parsed.data.model ?? parent.meta.model;
    const metadata = metadataForFollowup(parent.meta.metadata, parsed.data.metadata);
    const modelSource: ModelSource = parsed.data.model ? 'explicit' : parent.meta.model ? 'inherited' : 'backend_default';
    const settings = hasModelSettingsInput(parsed.data)
      ? modelSettingsForBackend(backendName, model, parsed.data.reasoning_effort, parsed.data.service_tier)
      : parsed.data.model
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

    await this.startManagedRun(meta.run_id, backend, parsed.data.prompt, parent.meta.cwd, idleTimeout.value, executionTimeout.value, settings.value, resumeSessionId, model);
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

  async getRunResult(params: unknown): Promise<ToolResult> {
    const parsed = RunIdInputSchema.safeParse(params);
    if (!parsed.success) return invalidInput(parsed.error.message);
    const run = await this.store.loadRun(parsed.data.run_id);
    if (!run) return unknownRun(parsed.data.run_id);
    return wrapOk({ run_summary: run.meta, result: run.result });
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
    backend: WorkerBackend,
    prompt: string,
    cwd: string,
    idleTimeoutSeconds: number,
    executionTimeoutSeconds: number | null,
    modelSettings: RunModelSettings,
    sessionId?: string,
    model?: string | null,
  ): Promise<void> {
    try {
      await access(cwd, constants.R_OK | constants.W_OK);
    } catch (error) {
      await this.failPreSpawn(runId, backendNameFor(backend), 'cwd is not readable and writable', { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const binary = await resolveBinary(backend.binary);
    if (!binary) {
      await this.failPreSpawn(runId, backendNameFor(backend), `Worker binary not found: ${backend.binary}`, { code: 'WORKER_BINARY_MISSING', binary: backend.binary });
      return;
    }

    try {
      const invocation = sessionId
        ? await backend.resume(sessionId, { prompt, cwd, model, modelSettings })
        : await backend.start({ prompt, cwd, model, modelSettings });
      invocation.command = binary;
      const managed = await this.processManager.start(runId, backend, invocation);
      this.activeRuns.set(runId, managed);
      this.armRunTimer(runId, idleTimeoutSeconds, executionTimeoutSeconds, managed);
      managed.completion.finally(() => {
        this.clearRunTimer(runId);
        this.activeRuns.delete(runId);
        if (this.shuttingDown && this.activeRuns.size === 0) {
          scheduleProcessExit();
        }
      }).catch(() => undefined);
    } catch (error) {
      await this.failPreSpawn(runId, backendNameFor(backend), 'Failed to spawn worker process', { error: error instanceof Error ? error.message : String(error) });
    }
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

  private armRunTimer(runId: string, idleTimeoutSeconds: number, executionTimeoutSeconds: number | null, managed: ManagedRun): void {
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

function backendNameFor(backend: WorkerBackend): Backend {
  return BackendSchema.parse(backend.name);
}

function preSpawnError(backend: Backend, message: string, context: Record<string, unknown>): RunError {
  const code = typeof context.code === 'string' ? context.code : null;
  return {
    message,
    category: code === 'WORKER_BINARY_MISSING'
      ? 'worker_binary_missing'
      : message.toLowerCase().includes('cwd')
        ? 'permission'
        : 'backend_unavailable',
    source: 'pre_spawn',
    backend,
    retryable: code !== 'WORKER_BINARY_MISSING',
    fatal: true,
    context,
  };
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
