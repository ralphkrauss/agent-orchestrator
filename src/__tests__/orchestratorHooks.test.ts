import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrchestratorHookExecutor } from '../daemon/orchestratorHooks.js';
import { OrchestratorStatusPayloadSchema, type OrchestratorStatusPayload } from '../contract.js';

function makePayload(overrides: Partial<OrchestratorStatusPayload> = {}): OrchestratorStatusPayload {
  return OrchestratorStatusPayloadSchema.parse({
    version: 1,
    event: 'orchestrator_status_changed',
    event_id: '01EVENT0000000000000000ZZZ',
    previous_status: null,
    emitted_at: new Date().toISOString(),
    orchestrator: { id: '01ARCH0000000000000000000Z', client: 'claude', label: 'demo', cwd: '/tmp/repo' },
    status: { state: 'in_progress', supervisor_turn_active: true, waiting_for_user: false, running_child_count: 1, failed_unacked_count: 0 },
    display: { tmux_pane: null, tmux_window_id: null, base_title: 'demo', host: 'host' },
    ...overrides,
  });
}

async function makeStoreRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orch-hook-'));
  await mkdir(dir, { recursive: true });
  return dir;
}

async function waitForCounter(executor: OrchestratorHookExecutor, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`hook counter did not satisfy predicate: ${JSON.stringify(executor.counters)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('OrchestratorHookExecutor', () => {
  it('returns null when the hooks file is missing (no warnings raised, no hooks fired)', async () => {
    const storeRoot = await makeStoreRoot();
    try {
      const executor = new OrchestratorHookExecutor({
        hooksFilePath: join(storeRoot, 'missing-hooks.json'),
        storeRoot,
      });
      const file = await executor.loadHooks();
      assert.equal(file, null);
      executor.emit(makePayload());
      // No async work scheduled; counters stay at zero.
      assert.equal(executor.counters.emitted, 0);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('runs the user shell command and captures stdout/stderr to the per-event log file', async () => {
    const storeRoot = await makeStoreRoot();
    const hooksFile = join(storeRoot, 'hooks.json');
    try {
      // Use a sentinel via the per-entry env so we can verify the daemon
      // forwards env without leaking arbitrary values, AND the JSON payload
      // arrives via stdin (not via command interpolation).
      const config = {
        version: 1,
        hooks: {
          orchestrator_status_changed: [{
            type: 'command' as const,
            command: 'cat - >> "$AO_TEST_OUTFILE"; printf "%s\\n" "$AGENT_ORCHESTRATOR_EVENT" >> "$AO_TEST_OUTFILE"',
            env: { AO_TEST_OUTFILE: join(storeRoot, 'out.txt') },
          }],
        },
      };
      await writeFile(hooksFile, JSON.stringify(config), { mode: 0o600 });
      const executor = new OrchestratorHookExecutor({ hooksFilePath: hooksFile, storeRoot });
      const payload = makePayload();
      executor.emit(payload);
      await waitForCounter(executor, () => executor.counters.successes >= 1);
      const written = await readFile(join(storeRoot, 'out.txt'), 'utf8');
      assert.match(written, /orchestrator_status_changed/);
      assert.match(written, /"state":"in_progress"/);
      assert.equal(executor.counters.failures, 0);

      const logPath = join(storeRoot, 'hooks', payload.orchestrator.id, `${payload.event}-${payload.event_id}.log`);
      const log = await readFile(logPath, 'utf8').catch(() => null);
      assert.ok(log !== null, 'expected per-event hook log to exist');
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('SIGKILLs hooks that exceed timeout_ms', async () => {
    const storeRoot = await makeStoreRoot();
    const hooksFile = join(storeRoot, 'hooks.json');
    try {
      const config = {
        version: 1,
        hooks: {
          orchestrator_status_changed: [{
            type: 'command' as const,
            command: 'sleep 5',
            timeout_ms: 200,
          }],
        },
      };
      await writeFile(hooksFile, JSON.stringify(config), { mode: 0o600 });
      const executor = new OrchestratorHookExecutor({ hooksFilePath: hooksFile, storeRoot });
      executor.emit(makePayload());
      await waitForCounter(executor, () => executor.counters.timeouts >= 1);
      assert.equal(executor.counters.successes, 0);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('timeout SIGKILLs grandchildren too (process-group kill, F2 invariant)', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX-only process-group kill semantics');
      return;
    }
    const storeRoot = await makeStoreRoot();
    const hooksFile = join(storeRoot, 'hooks.json');
    try {
      const pidFile = join(storeRoot, 'grandchild.pid');
      // Spawn a grandchild `sleep` that survives only via the process group.
      // The shell records the grandchild's pid, then waits on it.
      const config = {
        version: 1,
        hooks: {
          orchestrator_status_changed: [{
            type: 'command' as const,
            command: `sh -c 'sleep 30 & echo $! > "${pidFile}"; wait'`,
            timeout_ms: 200,
          }],
        },
      };
      await writeFile(hooksFile, JSON.stringify(config), { mode: 0o600 });
      const executor = new OrchestratorHookExecutor({ hooksFilePath: hooksFile, storeRoot });
      executor.emit(makePayload());
      await waitForCounter(executor, () => executor.counters.timeouts >= 1);
      // Wait for the grandchild's pid to be recorded, then for it to die.
      const deadline = Date.now() + 4_000;
      let pid: number | null = null;
      while (Date.now() < deadline) {
        try {
          const text = (await readFile(pidFile, 'utf8')).trim();
          const parsed = Number.parseInt(text, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            pid = parsed;
            break;
          }
        } catch {
          // not written yet
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(pid, 'grandchild pid was never recorded by the shell');
      // After the timeout fires, the grandchild must be gone.
      let alive = true;
      const killDeadline = Date.now() + 2_000;
      while (Date.now() < killDeadline) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          alive = false;
          break;
        }
      }
      if (alive) {
        // Best-effort cleanup so we don't leak the process if the assertion fails.
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
      }
      assert.equal(alive, false, `grandchild pid=${pid} should be dead after hook timeout SIGKILLs the process group`);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('hook log file is created with mode 0o600', async () => {
    const storeRoot = await makeStoreRoot();
    const hooksFile = join(storeRoot, 'hooks.json');
    try {
      const config = {
        version: 1,
        hooks: {
          orchestrator_status_changed: [{
            type: 'command' as const,
            command: 'true',
          }],
        },
      };
      await writeFile(hooksFile, JSON.stringify(config), { mode: 0o600 });
      const executor = new OrchestratorHookExecutor({ hooksFilePath: hooksFile, storeRoot });
      const payload = makePayload();
      executor.emit(payload);
      await waitForCounter(executor, () => executor.counters.successes >= 1);
      const { stat } = await import('node:fs/promises');
      const logPath = join(storeRoot, 'hooks', payload.orchestrator.id, `${payload.event}-${payload.event_id}.log`);
      const info = await stat(logPath);
      assert.equal(info.mode & 0o777, 0o600, 'log file must be created with mode 0o600');
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('restricted env passthrough drops unrelated daemon env (only the documented set + per-entry env survives)', async () => {
    const storeRoot = await makeStoreRoot();
    const hooksFile = join(storeRoot, 'hooks.json');
    try {
      // The hook prints all env vars it sees. We then assert that
      // unrelated daemon-side keys (e.g. AGENT_ORCHESTRATOR_HOME) do NOT
      // appear, while the documented passthrough keys do.
      const envDump = join(storeRoot, 'env-dump.txt');
      const config = {
        version: 1,
        hooks: {
          orchestrator_status_changed: [{
            type: 'command' as const,
            command: `env > "${envDump}"`,
            env: { CUSTOM_PER_ENTRY: 'preserved' },
          }],
        },
      };
      await writeFile(hooksFile, JSON.stringify(config), { mode: 0o600 });
      // Inject a sentinel into the daemon env that should NOT leak.
      const original = process.env.AGENT_ORCHESTRATOR_HOOK_LEAK_PROBE;
      process.env.AGENT_ORCHESTRATOR_HOOK_LEAK_PROBE = 'must-not-leak';
      try {
        const executor = new OrchestratorHookExecutor({ hooksFilePath: hooksFile, storeRoot });
        executor.emit(makePayload());
        await waitForCounter(executor, () => executor.counters.successes >= 1);
        const dumped = await readFile(envDump, 'utf8');
        assert.equal(dumped.includes('AGENT_ORCHESTRATOR_HOOK_LEAK_PROBE'), false, 'unrelated daemon env must not pass through to hooks');
        assert.match(dumped, /AGENT_ORCHESTRATOR_ORCH_ID=01ARCH0000000000000000000Z/);
        assert.match(dumped, /AGENT_ORCHESTRATOR_EVENT=orchestrator_status_changed/);
        assert.match(dumped, /CUSTOM_PER_ENTRY=preserved/);
      } finally {
        if (original === undefined) delete process.env.AGENT_ORCHESTRATOR_HOOK_LEAK_PROBE;
        else process.env.AGENT_ORCHESTRATOR_HOOK_LEAK_PROBE = original;
      }
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('counters expose log_capture_failed when the log dir cannot be created', async () => {
    const storeRoot = await makeStoreRoot();
    const hooksFile = join(storeRoot, 'hooks.json');
    try {
      // Inject a malformed orchestrator_id so the path-sanitization branch
      // refuses to create a log dir under store_root and bumps the counter.
      // The hook must still execute (timeout/exit semantics still hold), so
      // we assert the success counter goes up too.
      const config = {
        version: 1,
        hooks: { orchestrator_status_changed: [{ type: 'command' as const, command: 'true' }] },
      };
      await writeFile(hooksFile, JSON.stringify(config), { mode: 0o600 });
      const executor = new OrchestratorHookExecutor({ hooksFilePath: hooksFile, storeRoot });
      const payload = makePayload({ orchestrator: { id: '../escape-attempt', client: 'claude', label: 'demo', cwd: '/tmp/repo' } as never });
      executor.emit(payload);
      await waitForCounter(executor, () => executor.counters.successes >= 1 || executor.counters.log_capture_failed >= 1);
      assert.ok(executor.counters.log_capture_failed >= 1, 'malformed orchestrator id must trip the log_capture_failed counter');
      assert.ok(executor.counters.successes >= 1, 'hook must still execute when log capture is skipped');
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('skips emission when the hooks file fails schema validation (closed-schema rejection)', async () => {
    const storeRoot = await makeStoreRoot();
    const hooksFile = join(storeRoot, 'hooks.json');
    try {
      // `args` is rejected by the v1 schema (.strict()).
      await writeFile(hooksFile, JSON.stringify({
        version: 1,
        hooks: { orchestrator_status_changed: [{ type: 'command', command: 'tmux', args: ['rename-pane'] }] },
      }), { mode: 0o600 });
      const messages: string[] = [];
      const executor = new OrchestratorHookExecutor({
        hooksFilePath: hooksFile,
        storeRoot,
        log: (m) => messages.push(m),
      });
      const file = await executor.loadHooks();
      assert.equal(file, null);
      assert.ok(messages.some((m) => m.includes('schema validation')));
      executor.emit(makePayload());
      assert.equal(executor.counters.emitted, 0);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});
