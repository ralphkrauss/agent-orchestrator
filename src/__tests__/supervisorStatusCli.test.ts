import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../mcpTools.js';
import {
  SUPERVISOR_SIGNAL_EXIT_INVALID_EVENT,
  SUPERVISOR_SIGNAL_EXIT_OK,
  runSupervisorCli,
} from '../supervisorCli.js';

class MemStream implements NodeJS.WritableStream {
  data = '';
  writable = true;
  write(chunk: string | Uint8Array, _encoding?: BufferEncoding | ((error?: Error | null) => void), cb?: (error?: Error | null) => void): boolean {
    this.data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (typeof cb === 'function') cb();
    return true;
  }
  end(): this { this.writable = false; return this; }
  on(): this { return this; }
  once(): this { return this; }
  emit(): boolean { return true; }
  removeListener(): this { return this; }
  removeAllListeners(): this { return this; }
  setMaxListeners(): this { return this; }
  getMaxListeners(): number { return 10; }
  listeners(): never[] { return []; }
  rawListeners(): never[] { return []; }
  listenerCount(): number { return 0; }
  prependListener(): this { return this; }
  prependOnceListener(): this { return this; }
  eventNames(): never[] { return []; }
  off(): this { return this; }
  addListener(): this { return this; }
  pipe<T extends NodeJS.WritableStream>(destination: T): T { return destination; }
  cork(): void { /* no-op */ }
  uncork(): void { /* no-op */ }
  destroy(): this { return this; }
  setDefaultEncoding(): this { return this; }
}

describe('agent-orchestrator supervisor CLI (issue #40, T3 / T10)', () => {
  it('signal: returns exit 1 for unknown event names (never 2)', async () => {
    const stdout = new MemStream();
    const stderr = new MemStream();
    const exit = await runSupervisorCli(['signal', 'NotARealEvent'], { stdout, stderr, env: {} });
    assert.equal(exit, SUPERVISOR_SIGNAL_EXIT_INVALID_EVENT);
    assert.notEqual(exit, 2, 'signal must never return exit code 2 (Decision 22)');
    assert.equal(stdout.data, '', 'signal must not write to stdout (Decision 3, R12)');
  });

  it('signal: with no AGENT_ORCHESTRATOR_ORCH_ID set, returns 0 silently (transient/no-op)', async () => {
    const stdout = new MemStream();
    const stderr = new MemStream();
    const exit = await runSupervisorCli(['signal', 'UserPromptSubmit'], { stdout, stderr, env: {} });
    assert.equal(exit, SUPERVISOR_SIGNAL_EXIT_OK);
    assert.equal(stdout.data, '', 'stdout must remain empty');
  });

  it('signal: known event names UserPromptSubmit | Notification | Stop | SessionStart | SessionEnd are accepted', async () => {
    for (const name of ['UserPromptSubmit', 'Notification', 'Stop', 'SessionStart', 'SessionEnd']) {
      const stdout = new MemStream();
      const stderr = new MemStream();
      const exit = await runSupervisorCli(['signal', name], { stdout, stderr, env: {} });
      // No daemon available in this test, so exit 0 (transient) per D22.
      assert.equal(exit, SUPERVISOR_SIGNAL_EXIT_OK, `${name} should be accepted by the CLI`);
      assert.equal(stdout.data, '', 'stdout stays empty');
    }
  });

  it('status: requires --orchestrator-id or AGENT_ORCHESTRATOR_ORCH_ID', async () => {
    const stdout = new MemStream();
    const stderr = new MemStream();
    const exit = await runSupervisorCli(['status'], { stdout, stderr, env: {} });
    assert.equal(exit, 1);
    assert.match(stderr.data, /requires --orchestrator-id/);
    assert.notEqual(exit, 2);
  });

  it('status: happy path prints v1-shaped JSON for a registered orchestrator', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { IpcServer } = await import('../ipc/server.js');
    const { daemonPaths } = await import('../daemon/paths.js');
    const root = await mkdtemp(join(tmpdir(), 'cli-status-ok-'));
    const previousHome = process.env.AGENT_ORCHESTRATOR_HOME;
    process.env.AGENT_ORCHESTRATOR_HOME = root;
    try {
      const orchestratorId = '01STATUSORCHESTRATOR000001Z';
      const server = new IpcServer(daemonPaths().ipc.path, async (method) => {
        if (method !== 'get_orchestrator_status') return { ok: false, error: { code: 'INVALID_INPUT', message: 'unsupported' } };
        return {
          ok: true,
          orchestrator: {
            id: orchestratorId,
            client: 'claude',
            label: 'demo',
            cwd: root,
            display: { tmux_pane: null, tmux_window_id: null, base_title: 'demo', host: 'host' },
            registered_at: new Date().toISOString(),
            last_supervisor_event_at: null,
          },
          status: { state: 'idle', supervisor_turn_active: false, waiting_for_user: false, running_child_count: 0, failed_unacked_count: 0 },
          display: { tmux_pane: null, tmux_window_id: null, base_title: 'demo', host: 'host' },
        };
      });
      await server.listen();
      try {
        const stdout = new MemStream();
        const stderr = new MemStream();
        const exit = await runSupervisorCli(['status', '--orchestrator-id', orchestratorId], {
          stdout, stderr, env: { AGENT_ORCHESTRATOR_HOME: root },
        });
        assert.equal(exit, 0, stderr.data);
        const parsed = JSON.parse(stdout.data) as { orchestrator: { id: string; label: string }; status: { state: string }; display: { base_title: string } };
        assert.equal(parsed.orchestrator.id, orchestratorId);
        assert.equal(parsed.orchestrator.label, 'demo');
        assert.equal(parsed.status.state, 'idle');
        assert.equal(parsed.display.base_title, 'demo');
      } finally {
        await server.close();
      }
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_ORCHESTRATOR_HOME;
      else process.env.AGENT_ORCHESTRATOR_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('status: unknown orchestrator id returns exit 1 with stderr message (never 2)', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { IpcServer } = await import('../ipc/server.js');
    const { daemonPaths } = await import('../daemon/paths.js');
    const root = await mkdtemp(join(tmpdir(), 'cli-status-bad-'));
    const previousHome = process.env.AGENT_ORCHESTRATOR_HOME;
    process.env.AGENT_ORCHESTRATOR_HOME = root;
    try {
      const server = new IpcServer(daemonPaths().ipc.path, async () => ({
        ok: false,
        error: { code: 'INVALID_INPUT', message: 'Unknown orchestrator id: nope' },
      }));
      await server.listen();
      try {
        const stdout = new MemStream();
        const stderr = new MemStream();
        const exit = await runSupervisorCli(['status', '--orchestrator-id', 'nope'], {
          stdout, stderr, env: { AGENT_ORCHESTRATOR_HOME: root },
        });
        assert.equal(exit, 1);
        assert.notEqual(exit, 2);
        assert.match(stderr.data, /Unknown orchestrator id/i);
      } finally {
        await server.close();
      }
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_ORCHESTRATOR_HOME;
      else process.env.AGENT_ORCHESTRATOR_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('no orchestrator status MCP tool is registered (Decision 24)', () => {
    const names: string[] = tools.map((tool) => tool.name);
    assert.equal(names.includes('get_orchestrator_status'), false);
    assert.equal(names.includes('register_supervisor'), false);
    assert.equal(names.includes('signal_supervisor_event'), false);
    assert.equal(names.includes('unregister_supervisor'), false);
  });
});

describe('supervisor signal CLI re-register from sidecar (issue #40, F5 / A7)', () => {
  it('on unknown_orchestrator the CLI re-registers from <store_root>/orchestrators/<id>.json and retries the signal', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { writeOrchestratorSidecar } = await import('../daemon/orchestratorSidecar.js');
    const { OrchestratorRecordSchema } = await import('../contract.js');
    const { runSupervisorCli } = await import('../supervisorCli.js');
    const { IpcServer } = await import('../ipc/server.js');
    const { daemonPaths } = await import('../daemon/paths.js');

    const root = await mkdtemp(join(tmpdir(), 'reregister-'));
    const previousHome = process.env.AGENT_ORCHESTRATOR_HOME;
    process.env.AGENT_ORCHESTRATOR_HOME = root;
    try {
      const orchestratorId = '01HX0000000000000000000000';
      const record = OrchestratorRecordSchema.parse({
        id: orchestratorId,
        client: 'claude',
        label: 'reregister-test',
        cwd: root,
        display: { tmux_pane: null, tmux_window_id: null, base_title: 'reregister-test', host: 'host' },
        registered_at: new Date().toISOString(),
        last_supervisor_event_at: null,
      });
      await writeOrchestratorSidecar(root, record);

      // Set up a fake IPC server at the path the CLI's daemonPaths() will
      // resolve to. The fake daemon has no orchestrator registered, so the
      // first signal returns INVALID_INPUT/Unknown orchestrator id. After
      // the CLI re-registers from the sidecar, the second signal succeeds.
      const calls: { method: string; params: Record<string, unknown> }[] = [];
      let registered = false;
      const expectedSocket = daemonPaths().ipc.path;
      const server = new IpcServer(expectedSocket, async (method, params) => {
        const recordedParams = (params ?? {}) as Record<string, unknown>;
        calls.push({ method, params: recordedParams });
        if (method === 'register_supervisor') {
          registered = true;
          return { ok: true, orchestrator: record };
        }
        if (method === 'signal_supervisor_event') {
          if (!registered) {
            return { ok: false, error: { code: 'INVALID_INPUT', message: 'Unknown orchestrator id: ' + recordedParams.orchestrator_id } };
          }
          return { ok: true };
        }
        return { ok: true };
      });
      await server.listen();
      try {
        const env: NodeJS.ProcessEnv = {
          AGENT_ORCHESTRATOR_HOME: root,
          AGENT_ORCHESTRATOR_ORCH_ID: orchestratorId,
        };
        const stdout = new MemStream();
        const stderr = new MemStream();
        const exit = await runSupervisorCli(['signal', 'UserPromptSubmit'], { stdout, stderr, env });
        // Per Decision 22: signal must return 0 on success or transient.
        assert.equal(exit, 0);

        // CLI flow: signal → unknown id → register_supervisor → signal again.
        const methods = calls.map((c) => c.method);
        assert.deepStrictEqual(methods, ['signal_supervisor_event', 'register_supervisor', 'signal_supervisor_event'], `unexpected call sequence: ${JSON.stringify(methods)}`);
        assert.equal(calls[1]!.params.orchestrator_id, orchestratorId);
        assert.equal(calls[1]!.params.label, 'reregister-test');
        assert.equal(calls[1]!.params.cwd, root);
      } finally {
        await server.close();
      }
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_ORCHESTRATOR_HOME;
      else process.env.AGENT_ORCHESTRATOR_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});
