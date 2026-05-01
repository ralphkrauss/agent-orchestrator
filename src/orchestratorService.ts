import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  BackendSchema,
  CancelRunInputSchema,
  GetRunEventsInputSchema,
  isTerminalStatus,
  orchestratorError,
  PruneRunsInputSchema,
  RunIdInputSchema,
  SendFollowupInputSchema,
  ShutdownInputSchema,
  StartRunInputSchema,
  WaitForRunInputSchema,
  wrapErr,
  wrapOk,
  type Backend,
  type OrchestratorError,
  type RunStatus,
  type ToolResponse,
  type WorkerResult,
} from './contract.js';
import type { WorkerBackend } from './backend/WorkerBackend.js';
import { resolveBinary } from './backend/common.js';
import { getBackendStatus } from './diagnostics.js';
import { captureGitSnapshot } from './gitSnapshot.js';
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

  async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'ping':
        return wrapOk({ pong: true, daemon_pid: process.pid });
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
        return wrapOk({ status: await getBackendStatus() });
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

    const meta = await this.store.createRun({
      backend: input.backend,
      cwd: input.cwd,
      model: input.model ?? null,
      metadata: input.metadata,
      execution_timeout_seconds: timeout.value,
    });
    await this.captureAndPersistGitSnapshot(meta.run_id, input.cwd);

    await this.startManagedRun(meta.run_id, backend, input.prompt, input.cwd, timeout.value, undefined, input.model);
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
    if (!parent.meta.session_id) {
      return wrapErr(orchestratorError('INVALID_STATE', 'Cannot send follow-up because parent run has no backend session id'));
    }

    const backendName = BackendSchema.parse(parent.meta.backend);
    const backend = this.backends.get(backendName);
    if (!backend) return wrapErr(orchestratorError('BACKEND_NOT_FOUND', `Backend not found: ${backendName}`));
    const timeout = this.resolveExecutionTimeout(parsed.data.execution_timeout_seconds);
    if (!timeout.ok) return wrapErr(timeout.error);
    const model = parsed.data.model ?? parent.meta.model;

    const meta = await this.store.createRun({
      backend: backendName,
      cwd: parent.meta.cwd,
      parent_run_id: parent.meta.run_id,
      session_id: parent.meta.session_id,
      model,
      metadata: parent.meta.metadata,
      execution_timeout_seconds: timeout.value,
    });
    await this.captureAndPersistGitSnapshot(meta.run_id, parent.meta.cwd);

    await this.startManagedRun(meta.run_id, backend, parsed.data.prompt, parent.meta.cwd, timeout.value, parent.meta.session_id, model);
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

  private async startManagedRun(
    runId: string,
    backend: WorkerBackend,
    prompt: string,
    cwd: string,
    timeoutSeconds: number,
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
        ? await backend.resume(sessionId, { prompt, cwd, model })
        : await backend.start({ prompt, cwd, model });
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

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function scheduleProcessExit(): void {
  setTimeout(() => process.exit(0), 100);
}
