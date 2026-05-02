import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeBackend } from '../backend/claude.js';
import { CodexBackend } from '../backend/codex.js';
import { ProcessManager } from '../processManager.js';
import { RunStore } from '../runStore.js';
import type { RunMeta, TerminalRunStatus, WorkerResult } from '../contract.js';

class ThrowingTerminalStore extends RunStore {
  override async markTerminal(
    runId: string,
    status: TerminalRunStatus,
    errors: { message: string; context?: Record<string, unknown> }[] = [],
    result?: WorkerResult,
  ): Promise<RunMeta> {
    void runId;
    void status;
    void errors;
    void result;
    throw new Error('terminal write failed');
  }
}

describe('ProcessManager', () => {
  it('settles completion even when terminal finalization throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-process-'));
    const cli = join(root, 'worker.js');
    await writeFile(cli, `#!/usr/bin/env node
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: 'session-1' }));
  process.exit(0);
});
`);
    await chmod(cli, 0o755);

    const store = new ThrowingTerminalStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    const manager = new ProcessManager(store);
    const managed = await manager.start(run.run_id, new CodexBackend(), {
      command: cli,
      args: [],
      cwd: root,
      stdinPayload: 'finish',
    });

    const outcome = await Promise.race([
      managed.completion.then(() => 'settled', () => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 2_000)),
    ]);
    assert.equal(outcome, 'settled');
  });

  it('records observed backend-default model names from worker events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-process-'));
    const cli = join(root, 'worker.js');
    await writeFile(cli, `#!/usr/bin/env node
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'system', session_id: 'session-1' }));
  console.log(JSON.stringify({
    type: 'assistant',
    session_id: 'session-1',
    message: {
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'done' }]
    }
  }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: 'session-1' }));
  process.exit(0);
});
`);
    await chmod(cli, 0o755);

    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root, model_source: 'backend_default' });
    const manager = new ProcessManager(store);
    const managed = await manager.start(run.run_id, new ClaudeBackend(), {
      command: cli,
      args: [],
      cwd: root,
      stdinPayload: 'finish',
    });

    await managed.completion;
    const meta = await store.loadMeta(run.run_id);
    assert.equal(meta.model, 'claude-opus-4-7');
    assert.equal(meta.observed_model, 'claude-opus-4-7');
    assert.equal(meta.model_source, 'backend_default');
    assert.deepStrictEqual(meta.worker_invocation, { command: cli, args: [] });
  });
});
