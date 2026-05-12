import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeBackend } from '../backend/claude.js';
import { CodexBackend } from '../backend/codex.js';
import { applyEnvPolicy, prepareWorkerSpawn, ProcessManager, terminateProcessTree } from '../processManager.js';
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

  it('does not let Claude result.modelUsage sidecar models clobber the first observed model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-process-'));
    const cli = join(root, 'worker.js');
    await writeFile(cli, `#!/usr/bin/env node
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'session-1',
    model: 'claude-opus-4-7[1m]'
  }));
  console.log(JSON.stringify({
    type: 'assistant',
    session_id: 'session-1',
    message: {
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'Running and ready.' }]
    }
  }));
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'Running and ready.',
    session_id: 'session-1',
    modelUsage: {
      'claude-haiku-4-5-20251001': { inputTokens: 357, outputTokens: 11, costUSD: 0.0004 },
      'claude-opus-4-7[1m]': { inputTokens: 6, outputTokens: 10, costUSD: 0.0838 }
    }
  }));
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
    assert.equal(meta.observed_model, 'claude-opus-4-7[1m]');
    assert.equal(meta.model, 'claude-opus-4-7[1m]');
  });

  it('uses the highest-cost Claude modelUsage entry when no explicit model is emitted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-process-'));
    const cli = join(root, 'worker.js');
    await writeFile(cli, `#!/usr/bin/env node
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'done',
    session_id: 'session-1',
    modelUsage: {
      'claude-haiku-4-5-20251001': { inputTokens: 357, outputTokens: 11, costUSD: 0.0004 },
      'claude-opus-4-7[1m]': { inputTokens: 6, outputTokens: 10, costUSD: 0.0838 }
    }
  }));
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
    assert.equal(meta.observed_model, 'claude-opus-4-7[1m]');
    assert.equal(meta.model, 'claude-opus-4-7[1m]');
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

  it('uses the last assistant message when a successful Codex result event has an empty summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-process-'));
    const cli = join(root, 'worker.js');
    await writeFile(cli, `#!/usr/bin/env node
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Final worker answer.' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 4 } }));
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
    assert.equal(result?.summary, 'Final worker answer.');
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

  it('preserves stream order for the fallback assistant message even when an earlier line awaits longer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-process-stream-order-'));
    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    const manager = new ProcessManager(store);
    const backend = new ClaudeBackend();

    // Block the *first* updateMeta call so the older line stays suspended at
    // its awaited persistence step until after the newer line has fully run.
    // Subsequent updateMeta calls flow through to the real implementation.
    let blockerCount = 0;
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const realUpdateMeta = store.updateMeta.bind(store);
    (store as { updateMeta: RunStore['updateMeta'] }).updateMeta = async (runId, updater) => {
      blockerCount += 1;
      if (blockerCount === 1) await blocker;
      return realUpdateMeta(runId, updater);
    };

    let observed: string | undefined;
    interface Sinks {
      setSessionId(id: string): void;
      setResultEvent(event: unknown): void;
      setLastAssistantMessage(text: string): void;
      addFile(path: string): void;
      addCommand(command: string): void;
      addError(error: unknown): void;
    }
    const sinks: Sinks = {
      setSessionId: () => {},
      setResultEvent: () => {},
      setLastAssistantMessage: (text: string) => { observed = text; },
      addFile: () => {},
      addCommand: () => {},
      addError: () => {},
    };
    const handleJsonLine = (manager as unknown as {
      handleJsonLine(
        runId: string,
        backend: ClaudeBackend,
        line: string,
        sinks: Sinks,
        markActivity: () => void,
      ): Promise<void>;
    }).handleJsonLine.bind(manager);

    // Both lines carry a session_id so the original code reaches the
    // `await this.store.updateMeta(...)` suspension before the assistant-message
    // sink is updated.
    const olderLine = JSON.stringify({
      type: 'assistant',
      session_id: 'session-1',
      message: { model: 'claude-opus-4-7', content: [{ type: 'text', text: 'OLD' }] },
    });
    const newerLine = JSON.stringify({
      type: 'assistant',
      session_id: 'session-1',
      message: { model: 'claude-opus-4-7', content: [{ type: 'text', text: 'NEW' }] },
    });

    const olderTask = handleJsonLine(run.run_id, backend, olderLine, sinks, () => {});
    const newerTask = handleJsonLine(run.run_id, backend, newerLine, sinks, () => {});

    await newerTask;
    release();
    await olderTask;

    assert.equal(
      observed,
      'NEW',
      'fallback assistant message must reflect the latest line in stream order, not a stale earlier one',
    );
  });
});

describe("applyEnvPolicy", () => {
  it("returns a shallow copy when the policy is undefined or default", () => {
    const env = { HOME: "/home/x", ANTHROPIC_API_KEY: "secret", PATH: "/usr/bin" };
    const noPolicy = applyEnvPolicy(env, undefined);
    assert.deepStrictEqual(noPolicy, env);
    const defaultPolicy = applyEnvPolicy(env, "default");
    assert.deepStrictEqual(defaultPolicy, env);
  });

  it("strips explicit deny-list keys but keeps unrelated keys", () => {
    const env = {
      HOME: "/home/x",
      PATH: "/usr/bin",
      EDITOR: "vim",
      LANG: "en_US.UTF-8",
      GH_TOKEN: "gh-allowed",
      ANTHROPIC_API_KEY: "remove me",
      ANTHROPIC_AUTH_TOKEN: "remove me",
      ANTHROPIC_BASE_URL: "remove me",
      ANTHROPIC_MODEL: "remove me",
      CLAUDE_CONFIG_DIR: "remove me",
      CLAUDECODE: "remove me",
    };
    const result = applyEnvPolicy(env, {
      scrub: [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "CLAUDE_CONFIG_DIR",
        "CLAUDECODE",
      ],
    });
    assert.equal(result.HOME, "/home/x");
    assert.equal(result.PATH, "/usr/bin");
    assert.equal(result.EDITOR, "vim");
    assert.equal(result.LANG, "en_US.UTF-8");
    assert.equal(result.GH_TOKEN, "gh-allowed");
    assert.equal(result.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(result.ANTHROPIC_BASE_URL, undefined);
    assert.equal(result.ANTHROPIC_MODEL, undefined);
    assert.equal(result.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(result.CLAUDECODE, undefined);
  });

  it("strips glob-matched keys (ANTHROPIC_*, *_API_KEY, *_AUTH_TOKEN)", () => {
    const env = {
      HOME: "/home/x",
      PATH: "/usr/bin",
      ANTHROPIC_FOO: "remove",
      ANTHROPIC_BAR: "remove",
      OPENAI_API_KEY: "remove",
      VENDOR_AUTH_TOKEN: "remove",
      CURSOR_API_KEY: "remove",
      INERT_VAR: "keep",
    };
    const result = applyEnvPolicy(env, {
      scrub: [],
      scrubGlobs: ["ANTHROPIC_*", "*_API_KEY", "*_AUTH_TOKEN"],
    });
    assert.equal(result.HOME, "/home/x");
    assert.equal(result.INERT_VAR, "keep");
    assert.equal(result.ANTHROPIC_FOO, undefined);
    assert.equal(result.OPENAI_API_KEY, undefined);
    assert.equal(result.VENDOR_AUTH_TOKEN, undefined);
    assert.equal(result.CURSOR_API_KEY, undefined);
  });
});


describe('ProcessManager initialEvents flush (issue #58 Decision 10 / T-Telemetry)', () => {
  it('flushes WorkerInvocation.initialEvents before the status:started lifecycle marker on actual spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-initialevents-'));
    const cli = join(root, 'worker.js');
    await writeFile(cli, `#!/usr/bin/env node
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: 'session-1' }));
  process.exit(0);
});
`);
    await chmod(cli, 0o755);

    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    const manager = new ProcessManager(store);
    const managed = await manager.start(run.run_id, new ClaudeBackend(), {
      command: cli,
      args: [],
      cwd: root,
      stdinPayload: 'finish',
      initialEvents: [{
        type: 'lifecycle',
        payload: { state: 'worker_posture', backend: 'claude', worker_posture: 'trusted' },
      }],
    });

    await managed.completion;
    const loaded = await store.loadRun(run.run_id);
    const lifecycleEvents = (loaded?.events ?? []).filter((event) => event.type === 'lifecycle');
    const posture = lifecycleEvents.find((event) => (event.payload as { state?: string }).state === 'worker_posture');
    const started = lifecycleEvents.find((event) => (event.payload as { status?: string }).status === 'started');
    assert.ok(posture, 'worker_posture event must reach the run event stream');
    assert.ok(started, 'status:started lifecycle marker must follow');
    assert.ok(posture.seq < started.seq, 'worker_posture must precede status:started');
  });
});

describe('CliRuntime.buildStartInvocation (issue #58 review follow-up Medium 3)', () => {
  it('preserves initialEvents on the retry invocation so a real retry spawn still emits exactly one worker_posture event', async () => {
    // The retry invocation may never spawn (pre-bake) OR may spawn (retry
    // fires). When it spawns, its initialEvents are what carry the
    // worker_posture telemetry — the first attempt's posture event was
    // dropped along with the cancelled-attempt event buffer. Stripping
    // initialEvents here would leave the retry with zero posture telemetry.
    const { CliRuntime } = await import('../backend/runtime.js');
    const root = await mkdtemp(join(tmpdir(), 'agent-prebake-'));
    const cli = join(root, 'worker.js');
    await writeFile(cli, `#!/usr/bin/env node\n`);
    await chmod(cli, 0o755);

    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    const manager = new ProcessManager(store);
    const runtime = new CliRuntime(new ClaudeBackend(store), manager);

    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${root}:${originalPath}`;
    try {
      const result = await runtime.buildStartInvocation({
        runId: run.run_id,
        cwd: root,
        prompt: 'hi',
        modelSettings: { reasoning_effort: null, service_tier: null, mode: null, codex_network: null, worker_posture: 'trusted' },
      });
      if (result.ok) {
        assert.ok(result.invocation.initialEvents, 'retry invocation must keep initialEvents so a real retry spawn emits posture telemetry');
        assert.equal(result.invocation.initialEvents!.length, 1);
        assert.equal((result.invocation.initialEvents![0]!.payload as { state?: string }).state, 'worker_posture');
        assert.equal(result.invocation.earlyEventInterceptor, undefined, 'single-shot enforcement still holds');
      }
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
