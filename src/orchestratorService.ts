import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  BackendSchema,
  CancelRunInputSchema,
  GetObservabilitySnapshotInputSchema,
  GetRunEventsInputSchema,
  isTerminalStatus,
  orchestratorError,
  PruneRunsInputSchema,
  ReasoningEffortSchema,
  RunIdInputSchema,
  SendFollowupInputSchema,
  ShutdownInputSchema,
  StartRunInputSchema,
  WaitForRunInputSchema,
  wrapErr,
  wrapOk,
  type Backend,
  type RunDisplayMetadata,
  type ReasoningEffort,
  type ModelSource,
  type OrchestratorError,
  type RunStatus,
  type RunModelSettings,
  type ServiceTier,
  type ToolResponse,
  type WorkerResult,
} from './contract.js';
import type { WorkerBackend } from './backend/WorkerBackend.js';
import { resolveBinary } from './backend/common.js';
import { getBackendStatus } from './diagnostics.js';
import { captureGitSnapshot } from './gitSnapshot.js';
import { buildObservabilitySnapshot } from './observability.js';
import { getPackageVersion } from './packageMetadata.js';
import { ProcessManager, type ManagedRun } from './processManager.js';
import { RunStore } from './runStore.js';

interface OrchestratorConfig {
  default_execution_timeout_seconds: number;
  max_execution_timeout_seconds: number;
}

const defaultConfig: OrchestratorConfig = {
  default_execution_timeout_seconds: 30 * 60,
  max_execution_timeout_seconds: 4 * 60 * 60,
};

type ToolResult = ToolResponse<object>;
type OrchestratorLogger = (message: string) => void;

export interface OrchestratorDispatchContext {
  frontend_version?: string | null;
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
    const backend = this.backends.get(input.backend);
    if (!backend) return wrapErr(orchestratorError('BACKEND_NOT_FOUND', `Backend not found: ${input.backend}`));
    const timeout = this.resolveExecutionTimeout(input.execution_timeout_seconds);
    if (!timeout.ok) return wrapErr(timeout.error);
    const settings = modelSettingsForBackend(input.backend, input.model ?? null, input.reasoning_effort, input.service_tier);
    if (!settings.ok) return wrapErr(settings.error);

    const meta = await this.store.createRun({
      backend: input.backend,
      cwd: input.cwd,
      prompt: input.prompt,
      model: input.model ?? null,
      model_source: input.model ? 'explicit' : 'backend_default',
      model_settings: settings.value,
      display: displayMetadata(input.metadata, input.prompt),
      metadata: input.metadata,
      execution_timeout_seconds: timeout.value,
    });
    await this.captureAndPersistGitSnapshot(meta.run_id, input.cwd);

    await this.startManagedRun(meta.run_id, backend, input.prompt, input.cwd, timeout.value, settings.value, undefined, input.model);
    return wrapOk({ run_id: meta.run_id });
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
    const timeout = this.resolveExecutionTimeout(parsed.data.execution_timeout_seconds);
    if (!timeout.ok) return wrapErr(timeout.error);
    const model = parsed.data.model ?? parent.meta.model;
    const metadata = { ...parent.meta.metadata, ...parsed.data.metadata };
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
      execution_timeout_seconds: timeout.value,
    });
    await this.captureAndPersistGitSnapshot(meta.run_id, parent.meta.cwd);

    await this.startManagedRun(meta.run_id, backend, parsed.data.prompt, parent.meta.cwd, timeout.value, settings.value, resumeSessionId, model);
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
    timeoutSeconds: number,
    modelSettings: RunModelSettings,
    sessionId?: string,
    model?: string | null,
  ): Promise<void> {
    try {
      await access(cwd, constants.R_OK | constants.W_OK);
    } catch (error) {
      await this.failPreSpawn(runId, 'cwd is not readable and writable', { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const binary = await resolveBinary(backend.binary);
    if (!binary) {
      await this.failPreSpawn(runId, `Worker binary not found: ${backend.binary}`, { code: 'WORKER_BINARY_MISSING', binary: backend.binary });
      return;
    }

    try {
      const invocation = sessionId
        ? await backend.resume(sessionId, { prompt, cwd, model, modelSettings })
        : await backend.start({ prompt, cwd, model, modelSettings });
      invocation.command = binary;
      const managed = await this.processManager.start(runId, backend, invocation);
      this.activeRuns.set(runId, managed);
      this.armRunTimer(runId, timeoutSeconds, managed);
      managed.completion.finally(() => {
        this.clearRunTimer(runId);
        this.activeRuns.delete(runId);
        if (this.shuttingDown && this.activeRuns.size === 0) {
          scheduleProcessExit();
        }
      }).catch(() => undefined);
    } catch (error) {
      await this.failPreSpawn(runId, 'Failed to spawn worker process', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async failPreSpawn(runId: string, message: string, context: Record<string, unknown>): Promise<void> {
    const result: WorkerResult = {
      status: 'failed',
      summary: '',
      files_changed: [],
      commands_run: [],
      artifacts: this.store.defaultArtifacts(runId),
      errors: [{ message, context }],
    };
    await this.store.markTerminal(runId, 'failed', result.errors, result);
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

  private armRunTimer(runId: string, timeoutSeconds: number, managed: ManagedRun): void {
    const timer = setTimeout(() => {
      managed.cancel('timed_out');
    }, timeoutSeconds * 1000);
    this.timers.set(runId, timer);
  }

  private clearRunTimer(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer) clearTimeout(timer);
    this.timers.delete(runId);
  }

  private resolveExecutionTimeout(value: number | undefined): { ok: true; value: number } | { ok: false; error: OrchestratorError } {
    const timeout = value ?? this.config.default_execution_timeout_seconds;
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
      const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Partial<OrchestratorConfig>;
      this.config = {
        default_execution_timeout_seconds: positiveInt(parsed.default_execution_timeout_seconds) ?? defaultConfig.default_execution_timeout_seconds,
        max_execution_timeout_seconds: positiveInt(parsed.max_execution_timeout_seconds) ?? defaultConfig.max_execution_timeout_seconds,
      };
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

function hasModelSettingsInput(input: { reasoning_effort?: ReasoningEffort; service_tier?: ServiceTier }): boolean {
  return input.reasoning_effort !== undefined || input.service_tier !== undefined;
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

  if (reasoningEffort === 'none' || reasoningEffort === 'minimal') {
    return { ok: false, error: orchestratorError('INVALID_INPUT', 'Claude reasoning_effort must be one of low, medium, high, xhigh, or max') };
  }
  if (serviceTier !== undefined) {
    return { ok: false, error: orchestratorError('INVALID_INPUT', 'Claude does not support service_tier; set reasoning_effort and model only') };
  }
  const claudeModelError = validateClaudeModelAndEffort(model, reasoningEffort);
  if (claudeModelError) return { ok: false, error: claudeModelError };
  return {
    ok: true,
    value: {
      reasoning_effort: reasoningEffort ?? null,
      service_tier: null,
      mode: null,
    },
  };
}

function validateClaudeModelAndEffort(model: string | null | undefined, reasoningEffort: ReasoningEffort | undefined): OrchestratorError | null {
  const normalized = normalizeClaudeModel(model);
  if (normalized && isClaudeAlias(normalized)) {
    return orchestratorError('INVALID_INPUT', 'Claude model must be a direct model id such as claude-opus-4-7 or claude-opus-4-7[1m]; aliases like opus and sonnet can drift');
  }
  if (reasoningEffort && !normalized) {
    return orchestratorError('INVALID_INPUT', 'Claude reasoning_effort requires an explicit direct model id such as claude-opus-4-7 so fallback behavior is visible');
  }
  if (reasoningEffort === 'xhigh' && normalized && !isClaudeOpus47(normalized)) {
    return orchestratorError('INVALID_INPUT', 'Claude xhigh effort requires claude-opus-4-7 or claude-opus-4-7[1m]; other Claude models can fall back to high');
  }
  if (reasoningEffort && normalized && isAnthropicClaudeModelId(normalized) && !isKnownClaudeEffortModel(normalized)) {
    return orchestratorError('INVALID_INPUT', 'Claude effort levels are documented for Opus 4.7, Opus 4.6, and Sonnet 4.6; use one of those direct model ids');
  }
  return null;
}

function validateInheritedModelSettingsForBackend(
  backend: Backend,
  model: string | null | undefined,
  settings: RunModelSettings,
): { ok: true; value: RunModelSettings } | { ok: false; error: OrchestratorError } {
  if (backend !== 'claude') return { ok: true, value: settings };
  const reasoningEffort = parseReasoningEffort(settings.reasoning_effort);
  const error = validateClaudeModelAndEffort(model, reasoningEffort);
  return error ? { ok: false, error } : { ok: true, value: settings };
}

function parseReasoningEffort(value: string | null | undefined): ReasoningEffort | undefined {
  const parsed = value ? ReasoningEffortSchema.safeParse(value) : null;
  return parsed?.success ? parsed.data : undefined;
}

function normalizeClaudeModel(model: string | null | undefined): string | null {
  const value = model?.trim().toLowerCase();
  return value ? value.replace(/\[1m\]$/, '') : null;
}

function isClaudeAlias(model: string): boolean {
  return model === 'default'
    || model === 'best'
    || model === 'opus'
    || model === 'sonnet'
    || model === 'haiku'
    || model === 'opusplan';
}

function isClaudeOpus47(model: string): boolean {
  return model.includes('claude-opus-4-7');
}

function isKnownClaudeEffortModel(model: string): boolean {
  return model.includes('claude-opus-4-7')
    || model.includes('claude-opus-4-6')
    || model.includes('claude-sonnet-4-6');
}

function isAnthropicClaudeModelId(model: string): boolean {
  return model.startsWith('claude-') || model.includes('.claude-');
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
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
