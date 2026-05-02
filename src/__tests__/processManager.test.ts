import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeBackend } from '../backend/claude.js';
import { CodexBackend } from '../backend/codex.js';
import { prepareWorkerSpawn, ProcessManager, terminateProcessTree } from '../processManager.js';
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
  it('wraps Windows cmd shims with the command processor', () => {
    assert.deepStrictEqual(
      prepareWorkerSpawn('C:\\Tools\\codex.cmd', ['exec', '--model', 'gpt-5.2', '-'], 'win32', 'cmd.exe'),
      {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', 'C:\\Tools\\codex.cmd exec --model gpt-5.2 -'],
      },
    );
    assert.deepStrictEqual(
      prepareWorkerSpawn('/usr/bin/codex', ['exec', '-'], 'linux'),
      { command: '/usr/bin/codex', args: ['exec', '-'] },
    );
  });

  it('terminates POSIX process groups with escalating signals', () => {
    const calls: { pid: number; signal: NodeJS.Signals }[] = [];

    terminateProcessTree(1234, false, 'linux', (pid, signal) => {
      calls.push({ pid, signal });
    });
    terminateProcessTree(1234, true, 'linux', (pid, signal) => {
      calls.push({ pid, signal });
    });

    assert.deepStrictEqual(calls, [
      { pid: -1234, signal: 'SIGTERM' },
      { pid: -1234, signal: 'SIGKILL' },
    ]);
  });

  it('terminates Windows process trees with taskkill', () => {
    const calls: { command: string; args: string[]; options: { stdio: 'ignore'; windowsHide: true } }[] = [];
    const child = {
      on() {
        return child;
      },
      unref() {
        return child;
      },
    } as unknown as ChildProcess;

    terminateProcessTree(4321, false, 'win32', () => {
      throw new Error('process.kill should not be used on Windows');
    }, (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    });
    terminateProcessTree(4321, true, 'win32', () => {
      throw new Error('process.kill should not be used on Windows');
    }, (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    });

    assert.deepStrictEqual(calls, [
      { command: 'taskkill', args: ['/PID', '4321', '/T'], options: { stdio: 'ignore', windowsHide: true } },
      { command: 'taskkill', args: ['/PID', '4321', '/T', '/F'], options: { stdio: 'ignore', windowsHide: true } },
    ]);
  });

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

  it('does not promote benign stderr error text when a worker succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-process-'));
    const cli = join(root, 'worker.js');
    await writeFile(cli, `#!/usr/bin/env node
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.error('0 errors found during validation');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: 'session-1' }));
  process.exit(0);
});
`);
    await chmod(cli, 0o755);

    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    const manager = new ProcessManager(store);
    const managed = await manager.start(run.run_id, new CodexBackend(), {
      command: cli,
      args: [],
      cwd: root,
      stdinPayload: 'finish',
    });

    await managed.completion;
    const result = await store.loadResult(run.run_id);
    assert.equal(result?.status, 'completed');
    assert.equal(result?.summary, 'done');
    assert.deepStrictEqual(result?.errors, []);
  });

  it('does not persist parsed worker error events when a worker later succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-process-'));
    const cli = join(root, 'worker.js');
    await writeFile(cli, `#!/usr/bin/env node
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));
  console.log(JSON.stringify({
    type: 'error',
    status: 429,
    error: {
      type: 'rate_limit_error',
      message: 'recoverable rate limit warning'
    }
  }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done after retry', session_id: 'session-1' }));
  process.exit(0);
});
`);
    await chmod(cli, 0o755);

    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    const manager = new ProcessManager(store);
    const managed = await manager.start(run.run_id, new CodexBackend(), {
      command: cli,
      args: [],
      cwd: root,
      stdinPayload: 'finish',
    });

    await managed.completion;
    const result = await store.loadResult(run.run_id);
    assert.equal(result?.status, 'completed');
    assert.equal(result?.summary, 'done after retry');
    assert.deepStrictEqual(result?.errors, []);
  });

  it('keeps parsed worker error events for exit-zero runs without result events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-process-'));
    const cli = join(root, 'worker.js');
    await writeFile(cli, `#!/usr/bin/env node
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));
  console.log(JSON.stringify({
    type: 'error',
    status: 400,
    error: {
      type: 'invalid_request_error',
      message: "The 'openai/gpt-5.5' model is not supported when using Codex with a ChatGPT account."
    }
  }));
  process.exit(0);
});
`);
    await chmod(cli, 0o755);

    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    const manager = new ProcessManager(store);
    const managed = await manager.start(run.run_id, new CodexBackend(), {
      command: cli,
      args: [],
      cwd: root,
      stdinPayload: 'finish',
    });

    await managed.completion;
    const result = await store.loadResult(run.run_id);
    assert.equal(result?.status, 'failed');
    assert.equal(result?.summary, "The 'openai/gpt-5.5' model is not supported when using Codex with a ChatGPT account.");
    assert.ok(result?.errors.some((error) => error.message.includes('not supported when using Codex with a ChatGPT account')));
    assert.ok(result?.errors.some((error) => error.message === 'worker result event missing'));
    assert.equal(result?.errors.some((error) => error.message === 'worker process exited unsuccessfully'), false);
  });

  it('includes parsed worker error events in failed results without final result events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-process-'));
    const cli = join(root, 'worker.js');
    await writeFile(cli, `#!/usr/bin/env node
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));
  console.log(JSON.stringify({
    type: 'error',
    status: 400,
    error: {
      type: 'invalid_request_error',
      message: "The 'openai/gpt-5.5' model is not supported when using Codex with a ChatGPT account."
    }
  }));
  process.exit(1);
});
`);
    await chmod(cli, 0o755);

    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    const manager = new ProcessManager(store);
    const managed = await manager.start(run.run_id, new CodexBackend(), {
      command: cli,
      args: [],
      cwd: root,
      stdinPayload: 'finish',
    });

    await managed.completion;
    const result = await store.loadResult(run.run_id);
    assert.equal(result?.status, 'failed');
    assert.equal(result?.summary, "The 'openai/gpt-5.5' model is not supported when using Codex with a ChatGPT account.");
    assert.ok(result?.errors.some((error) => error.message.includes('not supported when using Codex with a ChatGPT account')));
    assert.ok(result?.errors.some((error) => error.message === 'worker result event missing'));
  });
});
