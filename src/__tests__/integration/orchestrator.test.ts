import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBackendRegistry } from '../../backend/registry.js';
import { OrchestratorService } from '../../orchestratorService.js';
import { RunStore } from '../../runStore.js';

const execFileAsync = promisify(execFile);
let originalPath = process.env.PATH;

describe('agent orchestrator integration with mock CLIs', () => {
  beforeEach(() => {
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('runs Codex with git-based files_changed and captures session/result', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const start = await service.startRun({ backend: 'codex', prompt: 'edit files', cwd: repo });
    assert.equal(start.ok, true);
    const runId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    const waited = await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    assert.equal(waited.ok, true);
    assert.equal(waited.ok && (waited as unknown as { status: string }).status, 'completed');
    const result = await service.getRunResult({ run_id: runId });
    assert.equal(result.ok, true);
    const payload = result.ok ? (result as unknown as { result: { files_changed: string[]; summary: string } }).result : null;
    assert.ok(payload?.files_changed.includes('existing.txt'));
    assert.ok(payload?.files_changed.includes('new.txt'));
    assert.equal((result.ok ? (result as unknown as { run_summary: { session_id: string } }).run_summary : null)?.session_id, 'codex-session-1');
  });

  it('runs Claude in a non-git cwd with event-derived files_changed fallback', async () => {
    const fixture = await createFixture();
    const cwd = await mkdtemp(join(tmpdir(), 'agent-non-git-'));
    const service = await createService(fixture.home);

    const start = await service.startRun({ backend: 'claude', prompt: 'event-file', cwd });
    const runId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    assert.equal(result.ok, true);
    const summary = result.ok ? (result as unknown as { run_summary: { git_snapshot_status: string } }).run_summary : null;
    const worker = result.ok ? (result as unknown as { result: { files_changed: string[] } }).result : null;
    assert.equal(summary?.git_snapshot_status, 'not_a_repo');
    assert.ok(worker?.files_changed.includes('event.txt'));
  });

  it('links follow-up runs and reuses captured session id', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const start = await service.startRun({ backend: 'claude', prompt: 'hello', cwd: repo });
    const parentId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: parentId, wait_seconds: 5 });
    const follow = await service.sendFollowup({ run_id: parentId, prompt: 'follow up' });
    assert.equal(follow.ok, true);
    const childId = follow.ok ? (follow as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: childId, wait_seconds: 5 });
    const child = await service.getRunStatus({ run_id: childId });
    assert.equal(child.ok, true);
    const summary = child.ok ? (child as unknown as { run_summary: { parent_run_id: string; session_id: string } }).run_summary : null;
    assert.equal(summary?.parent_run_id, parentId);
    assert.equal(summary?.session_id, 'claude-session-1');
  });

  it('passes model selections to workers and inherits parent models for follow-ups', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const start = await service.startRun({ backend: 'codex', prompt: 'hello', cwd: repo, model: 'gpt-5.2' });
    const parentId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: parentId, wait_seconds: 5 });

    const inherited = await service.sendFollowup({ run_id: parentId, prompt: 'follow up' });
    const inheritedId = inherited.ok ? (inherited as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: inheritedId, wait_seconds: 5 });

    const overridden = await service.sendFollowup({ run_id: parentId, prompt: 'follow up override', model: 'gpt-5.4' });
    const overriddenId = overridden.ok ? (overridden as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: overriddenId, wait_seconds: 5 });

    const parent = await service.getRunStatus({ run_id: parentId });
    const childInherited = await service.getRunStatus({ run_id: inheritedId });
    const childOverridden = await service.getRunStatus({ run_id: overriddenId });
    assert.equal(parent.ok && (parent as unknown as { run_summary: { model: string } }).run_summary.model, 'gpt-5.2');
    assert.equal(childInherited.ok && (childInherited as unknown as { run_summary: { model: string } }).run_summary.model, 'gpt-5.2');
    assert.equal(childOverridden.ok && (childOverridden as unknown as { run_summary: { model: string } }).run_summary.model, 'gpt-5.4');

    const args = await readJsonLines<string[]>(join(repo, 'codex-args.jsonl'));
    assert.deepStrictEqual(args[0], ['exec', '--json', '--skip-git-repo-check', '--cd', repo, '--model', 'gpt-5.2', '-']);
    assert.deepStrictEqual(args[1], ['exec', 'resume', '--json', '--skip-git-repo-check', '--model', 'gpt-5.2', 'codex-session-1', '-']);
    assert.deepStrictEqual(args[2], ['exec', 'resume', '--json', '--skip-git-repo-check', '--model', 'gpt-5.4', 'codex-session-1', '-']);
  });

  it('normalizes event-derived absolute files under cwd before unioning with git files', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const start = await service.startRun({ backend: 'claude', prompt: 'absolute-event-file', cwd: repo });
    const runId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    assert.equal(result.ok, true);
    const files = result.ok ? (result as unknown as { result: { files_changed: string[] } }).result.files_changed : [];
    assert.deepStrictEqual(files.filter((file) => file.endsWith('absolute-event.txt')), ['absolute-event.txt']);
  });

  it('cancels and times out running processes through the terminal state machine', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const cancelStart = await service.startRun({ backend: 'codex', prompt: 'slow-grandchild', cwd: repo, execution_timeout_seconds: 30 });
    const cancelId = cancelStart.ok ? (cancelStart as unknown as { run_id: string }).run_id : '';
    await waitForFile(join(repo, 'grandchild.pid'));
    const cancel = await service.cancelRun({ run_id: cancelId });
    assert.equal(cancel.ok, true);
    await service.waitForRun({ run_id: cancelId, wait_seconds: 10 });
    const cancelled = await service.getRunStatus({ run_id: cancelId });
    assert.equal(cancelled.ok && ((cancelled as unknown as { run_summary: { status: string } }).run_summary).status, 'cancelled');
    const grandchildPid = Number.parseInt(await readFile(join(repo, 'grandchild.pid'), 'utf8'), 10);
    assert.equal(isPidAlive(grandchildPid), false);

    const timeoutStart = await service.startRun({ backend: 'codex', prompt: 'slow', cwd: repo, execution_timeout_seconds: 1 });
    const timeoutId = timeoutStart.ok ? (timeoutStart as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: timeoutId, wait_seconds: 5 });
    const timedOut = await service.getRunStatus({ run_id: timeoutId });
    assert.equal(timedOut.ok && ((timedOut as unknown as { run_summary: { status: string } }).run_summary).status, 'timed_out');
    const cancelAfterTimeout = await service.cancelRun({ run_id: timeoutId });
    assert.equal(cancelAfterTimeout.ok, false);
    const stillTimedOut = await service.getRunStatus({ run_id: timeoutId });
    assert.equal(stillTimedOut.ok && ((stillTimedOut as unknown as { run_summary: { status: string } }).run_summary).status, 'timed_out');
  });

  it('records missing binary as a failed run and sweeps running runs as orphaned', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    process.env.PATH = join(fixture.root, 'missing-bin');

    const start = await service.startRun({ backend: 'codex', prompt: 'hello', cwd: repo });
    assert.equal(start.ok, true);
    const runId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    assert.equal(result.ok, true);
    const worker = result.ok ? (result as unknown as { result: { errors: { context?: { code?: string } }[] } }).result : null;
    assert.equal(worker?.errors[0]?.context?.code, 'WORKER_BINARY_MISSING');

    process.env.PATH = originalPath;
    const store = new RunStore(fixture.home);
    const running = await store.createRun({ backend: 'codex', cwd: repo });
    await store.updateMeta(running.run_id, (meta) => ({ ...meta, started_at: new Date().toISOString(), worker_pid: 12345, daemon_pid_at_spawn: 99999 }));
    await writeFile(join(store.runDir(running.run_id), '.lock'), `${JSON.stringify({ pid: 999_999_999, acquired_at: new Date(0).toISOString() })}\n`);
    const logMessages: string[] = [];
    const restarted = new OrchestratorService(store, createBackendRegistry(), (message) => logMessages.push(message));
    await restarted.initialize();
    const swept = await store.loadRun(running.run_id);
    assert.equal(swept?.meta.status, 'orphaned');
    assert.equal(swept?.events.at(-1)?.payload.status, 'orphaned');
    assert.ok(logMessages.some((message) => message.includes(`orphaned run ${running.run_id}`)));
  });
});

async function createFixture(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-orch-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  await writeFile(join(root, 'placeholder'), '');
  await mkMockCli(bin, 'codex', 'codex-session-1');
  await mkMockCli(bin, 'claude', 'claude-session-1');
  process.env.PATH = prependPath(bin, originalPath);
  return { root, home };
}

async function createService(home: string): Promise<OrchestratorService> {
  const service = new OrchestratorService(new RunStore(home), createBackendRegistry());
  await service.initialize();
  return service;
}

async function createGitRepo(root: string): Promise<string> {
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await execFileAsync('git', ['init'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await writeFile(join(repo, 'existing.txt'), 'foo\n');
  await execFileAsync('git', ['add', 'existing.txt'], { cwd: repo });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
  return repo;
}

async function mkMockCli(binDir: string, name: string, sessionId: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  process.on('SIGTERM', () => process.exit(0));
  const cwd = process.cwd();
  fs.appendFileSync(path.join(cwd, '${name}-args.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: '${sessionId}' }));
  if (prompt.includes('event-file') && !prompt.includes('absolute-event-file')) {
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'event.txt' } }] } }));
  }
  if (prompt.includes('edit')) {
    fs.writeFileSync(path.join(cwd, 'new.txt'), 'hi\\n');
    fs.writeFileSync(path.join(cwd, 'existing.txt'), 'bar\\n');
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'write files' } }] } }));
  }
  if (prompt.includes('absolute-event-file')) {
    const target = path.join(cwd, 'absolute-event.txt');
    fs.writeFileSync(target, 'absolute\\n');
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: target } }] } }));
  }
  if (prompt.includes('slow-grandchild')) {
    process.removeAllListeners('SIGTERM');
    process.on('SIGTERM', () => {});
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(cwd, 'grandchild.pid'), String(grandchild.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes('slow')) {
    setTimeout(() => {
      console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'slow done', session_id: '${sessionId}' }));
      process.exit(0);
    }, 10000);
    return;
  }
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: '${sessionId}' }));
});
`;

  if (process.platform === 'win32') {
    const scriptPath = join(binDir, `${name}.js`);
    await writeFile(scriptPath, script);
    await writeFile(join(binDir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`);
    return;
  }

  const path = join(binDir, name);
  await writeFile(path, script);
  await chmod(path, 0o755);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, 'utf8');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function prependPath(entry: string, current: string | undefined): string {
  return current ? `${entry}${delimiter}${current}` : entry;
}
