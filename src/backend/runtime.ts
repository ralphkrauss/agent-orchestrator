import type { Backend, RunMeta, RunStatus } from '../contract.js';
import type { ProcessManager, RunTerminalOverride, ManagedRun } from '../processManager.js';
import { resolveBinary } from './common.js';
import type { BackendStartInput, EarlyEventInterceptor, WorkerBackend, WorkerEnvPolicy, WorkerInvocation } from './WorkerBackend.js';

/**
 * Account-bound env contribution threaded from `OrchestratorService` into the
 * runtime layer. Only set when the resolved spawn must be bound to a specific
 * Claude account (D13). For non-`claude` backends and for unbound `claude`
 * runs `accountSpawn` is undefined and the spawn pipeline behaves exactly as
 * before.
 */
export interface AccountSpawnContribution {
  /** Per-account env to inject (e.g. `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`). */
  env: Record<string, string>;
  /** Env-scrub policy (D12 deny list) honoured by `ProcessManager.start()`. */
  envPolicy: WorkerEnvPolicy;
}

export interface RuntimeStartInput extends BackendStartInput {
  runId: string;
  accountSpawn?: AccountSpawnContribution;
  /**
   * D-COR-Resume-Layer: optional pre-terminal stream interceptor for in-run
   * retry on `session_not_found`. Threaded into `WorkerInvocation` by
   * `CliRuntime.spawn`. Undefined for every non-rotation run; backward
   * compatible.
   */
  earlyEventInterceptor?: EarlyEventInterceptor;
}

export type PreSpawnFailureCode = 'WORKER_BINARY_MISSING' | 'SPAWN_FAILED';

export interface PreSpawnFailure {
  code: PreSpawnFailureCode;
  message: string;
  details: Record<string, unknown>;
}

export type RuntimeStartResult =
  | { ok: true; handle: RuntimeRunHandle }
  | { ok: false; failure: PreSpawnFailure };

export type RuntimeBuildInvocationResult =
  | { ok: true; invocation: WorkerInvocation }
  | { ok: false; failure: PreSpawnFailure };

export type CancelStatus = Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out'>;

export interface RuntimeRunHandle {
  readonly runId: string;
  cancel(status: CancelStatus, terminal?: RunTerminalOverride): void;
  lastActivityMs(): number;
  readonly completion: Promise<RunMeta>;
}

export interface WorkerRuntime {
  readonly name: Backend;
  start(input: RuntimeStartInput): Promise<RuntimeStartResult>;
  resume(sessionId: string, input: RuntimeStartInput): Promise<RuntimeStartResult>;
  /**
   * Pre-bake a start-shape `WorkerInvocation` without spawning a process. Used
   * by `OrchestratorService` to construct `earlyEventInterceptor.retryInvocation`
   * for the in-run `session_not_found` retry (D-COR-Resume-Layer Step 2).
   *
   * Returns the same `WorkerInvocation` shape that `start()` would produce,
   * including command resolution and `accountSpawn` env merge, but does NOT
   * call `processManager.start`.
   */
  buildStartInvocation(input: RuntimeStartInput): Promise<RuntimeBuildInvocationResult>;
}

export class CliRuntime implements WorkerRuntime {
  readonly name: Backend;
  constructor(
    private readonly backend: WorkerBackend,
    private readonly processManager: ProcessManager,
  ) {
    this.name = backend.name;
  }

  start(input: RuntimeStartInput): Promise<RuntimeStartResult> {
    return this.spawn(input, () => this.backend.start(toBackendInput(input)));
  }

  resume(sessionId: string, input: RuntimeStartInput): Promise<RuntimeStartResult> {
    return this.spawn(input, () => this.backend.resume(sessionId, toBackendInput(input)));
  }

  async buildStartInvocation(input: RuntimeStartInput): Promise<RuntimeBuildInvocationResult> {
    const binary = await resolveBinary(this.backend.binary);
    if (!binary) {
      return {
        ok: false,
        failure: {
          code: 'WORKER_BINARY_MISSING',
          message: `Worker binary not found: ${this.backend.binary}`,
          details: { binary: this.backend.binary },
        },
      };
    }
    try {
      const invocation = await this.backend.start(toBackendInput(input));
      invocation.command = binary;
      if (input.accountSpawn) {
        invocation.env = { ...(invocation.env ?? {}), ...input.accountSpawn.env };
        invocation.envPolicy = input.accountSpawn.envPolicy;
      }
      // Single-shot enforcement (D-COR-Resume-Layer): the retry invocation
      // itself never carries an interceptor, regardless of caller intent.
      invocation.earlyEventInterceptor = undefined;
      return { ok: true, invocation };
    } catch (error) {
      return {
        ok: false,
        failure: {
          code: 'SPAWN_FAILED',
          message: 'Failed to build worker invocation',
          details: { error: error instanceof Error ? error.message : String(error) },
        },
      };
    }
  }

  private async spawn(
    input: RuntimeStartInput,
    makeInvocation: () => Promise<WorkerInvocation>,
  ): Promise<RuntimeStartResult> {
    const binary = await resolveBinary(this.backend.binary);
    if (!binary) {
      return {
        ok: false,
        failure: {
          code: 'WORKER_BINARY_MISSING',
          message: `Worker binary not found: ${this.backend.binary}`,
          details: { binary: this.backend.binary },
        },
      };
    }

    try {
      const invocation = await makeInvocation();
      invocation.command = binary;
      if (input.accountSpawn) {
        invocation.env = { ...(invocation.env ?? {}), ...input.accountSpawn.env };
        invocation.envPolicy = input.accountSpawn.envPolicy;
      }
      if (input.earlyEventInterceptor) {
        invocation.earlyEventInterceptor = input.earlyEventInterceptor;
      }
      const managed = await this.processManager.start(input.runId, this.backend, invocation);
      return { ok: true, handle: cliRuntimeHandle(managed) };
    } catch (error) {
      return {
        ok: false,
        failure: {
          code: 'SPAWN_FAILED',
          message: 'Failed to spawn worker process',
          details: { error: error instanceof Error ? error.message : String(error) },
        },
      };
    }
  }
}

function toBackendInput(input: RuntimeStartInput): BackendStartInput {
  return {
    prompt: input.prompt,
    cwd: input.cwd,
    model: input.model,
    modelSettings: input.modelSettings,
    runId: input.runId,
  };
}

function cliRuntimeHandle(managed: ManagedRun): RuntimeRunHandle {
  return {
    runId: managed.runId,
    cancel: (status, terminal) => managed.cancel(status, terminal),
    lastActivityMs: () => managed.lastActivityMs(),
    completion: managed.completion,
  };
}
