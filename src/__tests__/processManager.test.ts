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
import type { RunActivitySource, RunMeta, TerminalRunStatus, WorkerResult } from '../contract.js';

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

class ThrowingStreamActivityStore extends RunStore {
  private failed = false;

  override async recordActivity(runId: string, source: RunActivitySource, at = new Date()): Promise<RunMeta> {
    if (!this.failed && source === 'error') {
      this.failed = true;
      throw new Error('stream activity persistence failed');
    }
    return super.recordActivity(runId, source, at);
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
    assert.equal(meta.last_activity_source, 'terminal');
    assert.ok(meta.last_activity_at);
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

  it('routes stream-side persistence failures through finalization failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-process-'));
    const cli = join(root, 'worker.js');
    await writeFile(cli, `#!/usr/bin/env node
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.error('nonfatal worker error count: 1');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: 'session-1' }));
  process.exit(0);
});
`);
    await chmod(cli, 0o755);

    const store = new ThrowingStreamActivityStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    const manager = new ProcessManager(store);
    const managed = await manager.start(run.run_id, new CodexBackend(), {
      command: cli,
      args: [],
      cwd: root,
      stdinPayload: 'finish',
    });

    const meta = await managed.completion;
    const result = await store.loadResult(run.run_id);
    assert.equal(meta.status, 'failed');
    assert.equal(meta.terminal_reason, 'finalization_failed');
    assert.equal(meta.latest_error?.source, 'finalization');
    assert.equal(meta.latest_error?.message, 'run finalization failed');
    assert.match(String(meta.latest_error?.context?.error), /stream activity persistence failed/);
    assert.equal(result?.status, 'failed');
    assert.equal(result?.summary, 'run finalization failed');
    assert.equal(result?.errors[0]?.message, 'run finalization failed');
  });

  it('persists timeout latest_error from terminal overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-process-'));
    const cli = join(root, 'worker.js');
    await writeFile(cli, `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000);
`);
    await chmod(cli, 0o755);

    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    const manager = new ProcessManager(store);
    const managed = await manager.start(run.run_id, new CodexBackend(), {
      command: cli,
      args: [],
      cwd: root,
      stdinPayload: 'wait',
    });

    managed.cancel('timed_out', { reason: 'idle_timeout', timeout_reason: 'idle_timeout' });

    const meta = await Promise.race([
      managed.completion,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for idle-timeout completion')), 3_000);
      }),
    ]);
    const result = await store.loadResult(run.run_id);
    assert.equal(meta.status, 'timed_out');
    assert.equal(meta.timeout_reason, 'idle_timeout');
    assert.equal(meta.terminal_reason, 'idle_timeout');
    assert.equal(meta.latest_error?.category, 'timeout');
    assert.equal(meta.latest_error?.source, 'watchdog');
    assert.equal(result?.status, 'failed');
    assert.equal(result?.errors[0]?.message, 'idle timeout exceeded');
  });

  it('fails fast on parsed fatal worker errors even if a result event follows', async () => {
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

    const meta = await managed.completion;
    const result = await store.loadResult(run.run_id);
    assert.equal(meta.status, 'failed');
    assert.equal(meta.terminal_reason, 'backend_fatal_error');
    assert.equal(meta.latest_error?.category, 'rate_limit');
    assert.equal(meta.latest_error?.retryable, true);
    assert.equal(meta.latest_error?.fatal, true);
    assert.equal(result?.status, 'failed');
    assert.equal(result?.summary, 'recoverable rate limit warning');
    assert.ok(result?.errors.some((error) => error.message === 'recoverable rate limit warning'));
  });

  it('fails fast for parsed fatal worker errors without adding generic missing-result errors', async () => {
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

    const meta = await managed.completion;
    const result = await store.loadResult(run.run_id);
    assert.equal(meta.status, 'failed');
    assert.equal(meta.terminal_reason, 'backend_fatal_error');
    assert.equal(meta.latest_error?.category, 'invalid_model');
    assert.equal(meta.latest_error?.fatal, true);
    assert.equal(result?.status, 'failed');
    assert.equal(result?.summary, "The 'openai/gpt-5.5' model is not supported when using Codex with a ChatGPT account.");
    assert.ok(result?.errors.some((error) => error.message.includes('not supported when using Codex with a ChatGPT account')));
    assert.equal(result?.errors.some((error) => error.message === 'worker result event missing'), false);
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

    const meta = await managed.completion;
    const result = await store.loadResult(run.run_id);
    assert.equal(meta.status, 'failed');
    assert.equal(meta.terminal_reason, 'backend_fatal_error');
    assert.equal(meta.latest_error?.category, 'invalid_model');
    assert.equal(meta.latest_error?.fatal, true);
    assert.equal(result?.status, 'failed');
    assert.equal(result?.summary, "The 'openai/gpt-5.5' model is not supported when using Codex with a ChatGPT account.");
    assert.ok(result?.errors.some((error) => error.message.includes('not supported when using Codex with a ChatGPT account')));
    assert.equal(result?.errors.some((error) => error.message === 'worker result event missing'), false);
  });

  it('fails fast when split stderr chunks contain a fatal backend error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-process-'));
    const cli = join(root, 'worker.js');
    await writeFile(cli, `#!/usr/bin/env node
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stderr.write('Authentication failed:');
  setTimeout(() => {
    process.stderr.write(' invalid API key\\n');
  }, 10);
  setInterval(() => {}, 1000);
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

    const meta = await Promise.race([
      managed.completion,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('timed out waiting for fatal stderr')), 3_000)),
    ]);
    const result = await store.loadResult(run.run_id);
    const events = await store.readEvents(run.run_id);
    assert.equal(meta.status, 'failed');
    assert.equal(meta.terminal_reason, 'backend_fatal_error');
    assert.equal(meta.latest_error?.category, 'auth');
    assert.equal(meta.latest_error?.source, 'stderr');
    assert.equal(result?.summary, 'Authentication failed: invalid API key');
    assert.ok(events.events.some((event) => event.type === 'error' && event.payload.text === 'Authentication failed: invalid API key'));
  });
});
