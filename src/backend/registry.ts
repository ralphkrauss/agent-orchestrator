import type { Backend } from '../contract.js';
import { ProcessManager } from '../processManager.js';
import { RunStore } from '../runStore.js';
import type { WorkerBackend } from './WorkerBackend.js';
import { ClaudeBackend } from './claude.js';
import { CodexBackend } from './codex.js';
import { CliRuntime, type WorkerRuntime } from './runtime.js';
import { CursorSdkRuntime } from './cursor/runtime.js';
import { defaultCursorSdkAdapter, type CursorSdkAdapter } from './cursor/sdk.js';

export interface BackendRegistryOptions {
  cursorRuntime?: WorkerRuntime;
  cursorAdapter?: CursorSdkAdapter;
}

export function createBackendRegistry(
  store: RunStore,
  options: BackendRegistryOptions = {},
): Map<Backend, WorkerRuntime> {
  const processManager = new ProcessManager(store);
  const cliBackends: WorkerBackend[] = [
    new CodexBackend(),
    new ClaudeBackend(store),
  ];
  const runtimes = new Map<Backend, WorkerRuntime>(
    cliBackends.map((backend) => [backend.name, new CliRuntime(backend, processManager)]),
  );
  // Cursor runtime is always registered, even when @cursor/sdk is not
  // installed. The runtime probes its SDK adapter on start/resume and
  // surfaces a WORKER_BINARY_MISSING pre-spawn failure when the SDK is
  // absent (D17 in the SDK-first plan).
  runtimes.set(
    'cursor',
    options.cursorRuntime ?? new CursorSdkRuntime(options.cursorAdapter ?? defaultCursorSdkAdapter(), { store }),
  );
  return runtimes;
}
