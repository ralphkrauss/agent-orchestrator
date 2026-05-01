import type { Backend } from '../contract.js';
import type { WorkerBackend } from './WorkerBackend.js';
import { ClaudeBackend } from './claude.js';
import { CodexBackend } from './codex.js';

export function createBackendRegistry(): Map<Backend, WorkerBackend> {
  const backends: WorkerBackend[] = [
    new CodexBackend(),
    new ClaudeBackend(),
  ];
  return new Map(backends.map((backend) => [backend.name, backend]));
}
