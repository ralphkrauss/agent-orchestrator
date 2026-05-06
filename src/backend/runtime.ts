import type { Backend, RunMeta, RunStatus } from '../contract.js';
import type { ProcessManager, RunTerminalOverride, ManagedRun } from '../processManager.js';
import { resolveBinary } from './common.js';
import type { BackendStartInput, WorkerBackend, WorkerInvocation } from './WorkerBackend.js';

export interface RuntimeStartInput extends BackendStartInput {
  runId: string;
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
