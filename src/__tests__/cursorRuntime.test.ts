import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorSdkRuntime } from '../backend/cursor/runtime.js';
import { createBackendRegistry } from '../backend/registry.js';
import { OrchestratorService } from '../orchestratorService.js';
import { RunStore } from '../runStore.js';
import { defaultCursorSdkAdapter } from '../backend/cursor/sdk.js';
import type {
  CursorAgent,
  CursorAgentApi,
  CursorRun,
  CursorRunResult,
  CursorRunStatus,
  CursorSdkAdapter,
  CursorSdkMessage,
} from '../backend/cursor/sdk.js';

interface FakeRunOptions {
  agentId: string;
  status: CursorRunStatus;
  result?: string;
  events?: CursorSdkMessage[];
  cancelHook?: () => void;
}

function fakeRun(options: FakeRunOptions): CursorRun {
  const events = options.events ?? [];
  let cancelled = false;
  return {
    id: 'run-1',
    agentId: options.agentId,
    get status() {
      return cancelled ? 'cancelled' : options.status;
    },
    result: options.result,
    async *stream() {
      for (const event of events) {
        if (cancelled) break;
        yield event;
      }
    },
    async wait(): Promise<CursorRunResult> {
      if (cancelled) return { status: 'cancelled' };
      return { status: options.status, result: options.result };
    },
    async cancel() {
      cancelled = true;
      options.cancelHook?.();
    },
  } as CursorRun;
}

function fakeAgent(agentId: string, run: CursorRun): CursorAgent {
  return {
    agentId,
    async send() {
      return run;
    },
    async [Symbol.asyncDispose]() {
      // no-op
    },
  } as CursorAgent;
}

function fakeAdapter(api: CursorAgentApi, modulePath = '/tmp/fake/sdk'): CursorSdkAdapter {
  return {
    async available() {
      return { ok: true, modulePath };
    },
    async loadAgentApi() {
      return api;
    },
  };
}

async function waitForActiveHandle(service: OrchestratorService, runId: string, timeoutMs = 2_000): Promise<void> {
  const activeRuns = (service as unknown as { activeRuns: Map<string, unknown> }).activeRuns;
  const start = Date.now();
  while (!activeRuns.has(runId)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`active run handle for ${runId} did not appear within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function unavailableAdapter(reason = 'Cannot find module @cursor/sdk'): CursorSdkAdapter {
  return {
    async available() {
      return { ok: false, reason };
    },
    async loadAgentApi() {
      throw new Error(reason);
    },
  };
}

async function createServiceWith(adapter: CursorSdkAdapter, env: NodeJS.ProcessEnv = { CURSOR_API_KEY: 'test-key' }): Promise<{ service: OrchestratorService; store: RunStore; home: string }> {
  const home = await mkdtemp(join(tmpdir(), 'cursor-runtime-'));
  const store = new RunStore(home);
  const cursorRuntime = new CursorSdkRuntime(adapter, { store, env, cancelDrainMs: 25 });
  const runtimes = createBackendRegistry(store, { cursorRuntime });
  const service = new OrchestratorService(store, runtimes);
  await service.initialize();
  return { service, store, home };
}

describe('defaultCursorSdkAdapter contract', () => {
  it('returns ok: false from available() when @cursor/sdk lacks the expected Agent factory', async () => {
    const adapter = defaultCursorSdkAdapter({
      importer: async () => ({ NotAgent: {} }),
      resolveModulePath: () => null,
    });
    const result = await adapter.available();
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; reason: string }).reason, /Agent factory/i);
  });

  it('rejects loadAgentApi() when @cursor/sdk lacks the expected Agent factory but caches the failure', async () => {
    const adapter = defaultCursorSdkAdapter({
      importer: async () => ({ NotAgent: {} }),
      resolveModulePath: () => null,
    });
    await assert.rejects(adapter.loadAgentApi(), /Agent factory/i);
    const cached = await adapter.available();
    assert.equal(cached.ok, false);
  });

  it('reports modulePath in failure when the SDK is resolvable but import throws (installed-but-broken)', async () => {
    const adapter = defaultCursorSdkAdapter({
      importer: async () => { throw new Error('Cannot find module sqlite3 native binding'); },
      resolveModulePath: () => '/fake/node_modules/@cursor/sdk/dist/index.js',
    });
    const result = await adapter.available();
    assert.equal(result.ok, false);
    const failure = result as { ok: false; reason: string; modulePath: string | null };
    assert.equal(failure.modulePath, '/fake/node_modules/@cursor/sdk/dist/index.js');
    assert.match(failure.reason, /sqlite3/i);
  });

  it('reports modulePath null when the SDK cannot be resolved at all (missing package)', async () => {
    const adapter = defaultCursorSdkAdapter({
      importer: async () => { throw new Error('Cannot find module @cursor/sdk'); },
      resolveModulePath: () => null,
    });
    const result = await adapter.available();
    assert.equal(result.ok, false);
    const failure = result as { ok: false; reason: string; modulePath: string | null };
    assert.equal(failure.modulePath, null);
  });
});

describe('CursorSdkRuntime install hint differentiates missing vs installed-but-broken', () => {
  function brokenSdkAdapter(modulePath: string | null, reason: string): CursorSdkAdapter {
    return {
      async available() {
        return { ok: false, reason, modulePath };
      },
      async loadAgentApi() {
        throw new Error(reason);
      },
    };
  }

  it('uses the missing-package install hint when modulePath is null', async () => {
    const { service } = await createServiceWith(brokenSdkAdapter(null, 'Cannot find module @cursor/sdk'));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-missing-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'p', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    const payload = result as { ok: true; result: { errors: { context?: { install_hint?: string; resolved_path?: string } }[] } };
    const hint = payload.result.errors[0]?.context?.install_hint ?? '';
    assert.equal(hint, 'npm install @cursor/sdk');
    assert.equal(payload.result.errors[0]?.context?.resolved_path, undefined);
  });

  it('uses the rebuild install hint when modulePath is set (installed-but-broken)', async () => {
    const path = '/fake/node_modules/@cursor/sdk/dist/index.js';
    const { service } = await createServiceWith(brokenSdkAdapter(path, 'sqlite3 native binding missing'));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-broken-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'p', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    const payload = result as { ok: true; result: { errors: { message: string; context?: { install_hint?: string; resolved_path?: string; reason?: string } }[] } };
    const error = payload.result.errors[0];
    assert.equal(error?.context?.resolved_path, path);
    assert.match(error?.context?.install_hint ?? '', /pnpm rebuild @cursor\/sdk/);
    assert.match(error?.context?.install_hint ?? '', new RegExp(path.replace(/\//g, '\\/')));
    assert.match(error?.context?.reason ?? '', /sqlite3/i);
  });
});

describe('CursorSdkRuntime missing-SDK behavior', () => {
  it('produces a durable failed run with WORKER_BINARY_MISSING when @cursor/sdk is not installed', async () => {
    const { service } = await createServiceWith(unavailableAdapter('Cannot find module @cursor/sdk'));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-cwd-'));

    const start = await service.startRun({ backend: 'cursor', prompt: 'hello', cwd, model: 'composer-2' });
    assert.equal(start.ok, true);
    const runId = (start as { ok: true; run_id: string }).run_id;
    const waited = await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    assert.equal(waited.ok, true);
    assert.equal((waited as { ok: true; status: string }).status, 'failed');

    const result = await service.getRunResult({ run_id: runId });
    assert.equal(result.ok, true);
    const payload = result as { ok: true; result: { errors: { context?: { code?: string; binary?: string; install_hint?: string } }[] }; run_summary: { status: string; latest_error: { category: string } | null } };
    const error = payload.result.errors[0];
    assert.equal(error?.context?.code, 'WORKER_BINARY_MISSING');
    assert.equal(error?.context?.binary, '@cursor/sdk');
    assert.equal(error?.context?.install_hint, 'npm install @cursor/sdk');
    assert.equal(payload.run_summary.status, 'failed');
    assert.equal(payload.run_summary.latest_error?.category, 'worker_binary_missing');
  });

  it('keeps cursor in the runtime registry even when the SDK is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cursor-registry-'));
    const store = new RunStore(home);
    const runtimes = createBackendRegistry(store, { cursorAdapter: unavailableAdapter() });
    assert.ok(runtimes.has('cursor'));
  });
});

describe('CursorSdkRuntime success and cancellation paths', () => {
  it('synthesizes exitCode 0 for finished runs and surfaces the run result summary', async () => {
    const events: CursorSdkMessage[] = [
      { type: 'system', agent_id: 'bc-success', run_id: 'run-1' },
      {
        type: 'assistant',
        agent_id: 'bc-success',
        run_id: 'run-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] },
      },
    ];
    const run = fakeRun({ agentId: 'bc-success', status: 'finished', result: 'all done', events });
    const agent = fakeAgent('bc-success', run);
    const api: CursorAgentApi = {
      async create() { return agent; },
      async resume() { return agent; },
    };

    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-success-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'go', cwd, model: 'composer-2' });
    assert.equal(start.ok, true);
    const runId = (start as { ok: true; run_id: string }).run_id;
    const waited = await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    assert.equal(waited.ok, true);
    assert.equal((waited as { ok: true; status: string }).status, 'completed');
    const result = await service.getRunResult({ run_id: runId });
    const payload = result as { ok: true; result: { status: string; summary: string }; run_summary: { session_id: string | null; observed_session_id: string | null; status: string } };
    assert.equal(payload.run_summary.status, 'completed');
    assert.equal(payload.run_summary.session_id, 'bc-success');
    assert.equal(payload.result.status, 'completed');
    assert.equal(payload.result.summary, 'all done');
  });

  it('marks errored SDK runs as failed', async () => {
    const events: CursorSdkMessage[] = [
      { type: 'status', status: 'ERROR', message: 'authentication failed' },
    ];
    const run = fakeRun({ agentId: 'bc-error', status: 'error', events });
    const agent = fakeAgent('bc-error', run);
    const api: CursorAgentApi = {
      async create() { return agent; },
      async resume() { return agent; },
    };

    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-error-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'go', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    const payload = result as { ok: true; result: { status: string; errors: { message: string }[] }; run_summary: { status: string } };
    assert.equal(payload.run_summary.status, 'failed');
    assert.equal(payload.result.status, 'failed');
    assert.ok(payload.result.errors.some((error) => error.message.includes('authentication failed')));
  });

  it('synthesizes a cursor RunError when wait() returns terminal status with no result and no events', async () => {
    // Worst-case shape for Comment 10: stream() yields nothing, wait() returns
    // { status: 'error' } with no result and no error events. Without the
    // synthesized RunError the run would be marked failed but with empty
    // summary/errors and a null latest_error.
    const run: CursorRun = {
      id: 'sdk-run-empty',
      agentId: 'bc-empty-error',
      get status() { return 'error' as CursorRunStatus; },
      result: undefined,
      // eslint-disable-next-line require-yield
      async *stream() {
        // intentionally yields nothing
      },
      async wait() {
        return { id: 'sdk-run-empty', status: 'error' as CursorRunStatus };
      },
      async cancel() { /* no-op */ },
    } as CursorRun;
    const agent = fakeAgent('bc-empty-error', run);
    const api: CursorAgentApi = {
      async create() { return agent; },
      async resume() { return agent; },
    };
    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-empty-error-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'go', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    const payload = result as { ok: true; result: { status: string; summary: string; errors: { message: string; context?: Record<string, unknown> }[] }; run_summary: { status: string; latest_error: { message: string } | null } };
    assert.equal(payload.run_summary.status, 'failed');
    assert.equal(payload.result.status, 'failed');
    assert.equal(payload.result.errors.length, 1);
    const synthesized = payload.result.errors[0]!;
    assert.match(synthesized.message, /no error details/i);
    assert.equal(synthesized.context?.sdk_run_status, 'error');
    assert.equal(synthesized.context?.sdk_run_id, 'sdk-run-empty');
    assert.equal(payload.result.summary, synthesized.message);
    assert.equal(payload.run_summary.latest_error?.message, synthesized.message);
  });

  it('treats cooperatively cancelled runs as cancelled, not completed', async () => {
    let cancelCalled = false;
    let releaseStream: (() => void) | null = null;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const cancelHook = () => {
      cancelCalled = true;
      releaseStream?.();
    };
    let currentStatus: CursorRunStatus = 'running';
    const run: CursorRun = {
      id: 'run-1',
      agentId: 'bc-cancel',
      get status() { return currentStatus; },
      result: undefined,
      async *stream() {
        yield { type: 'system', agent_id: 'bc-cancel', run_id: 'run-1' } as CursorSdkMessage;
        await streamGate;
      },
      async wait() {
        await streamGate;
        return { status: currentStatus };
      },
      async cancel() {
        currentStatus = 'cancelled';
        cancelHook();
      },
    } as CursorRun;
    const agent = fakeAgent('bc-cancel', run);
    const api: CursorAgentApi = {
      async create() { return agent; },
      async resume() { return agent; },
    };
    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-cancel-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'go', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    // Allow the start path to register the active run.
    await waitForActiveHandle(service, runId);
    await service.cancelRun({ run_id: runId });
    const waited = await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    assert.equal(waited.ok, true);
    assert.equal((waited as { ok: true; status: string }).status, 'cancelled');
    assert.ok(cancelCalled);
  });

  it('bounds drain when a late cancel arrives against an SDK that ignores run.cancel()', async () => {
    // Fake run whose stream() and wait() never resolve and whose cancel() is a no-op.
    // This is the worst-case shape D12 must protect against: the SDK ignores cancel()
    // and the orchestrator must still enforce cancelDrainMs.
    const run: CursorRun = {
      id: 'run-1',
      agentId: 'bc-late-cancel',
      get status() { return 'running' as CursorRunStatus; },
      result: undefined,
      async *stream() {
        yield { type: 'system', agent_id: 'bc-late-cancel', run_id: 'run-1' } as CursorSdkMessage;
        await new Promise(() => {});
      },
      async wait() {
        await new Promise(() => {});
        return { status: 'running' as CursorRunStatus };
      },
      async cancel() {
        // intentional no-op: simulate an SDK that ignores cancel.
      },
    } as CursorRun;
    const agent = fakeAgent('bc-late-cancel', run);
    const api: CursorAgentApi = {
      async create() { return agent; },
      async resume() { return agent; },
    };
    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-late-cancel-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'go', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await waitForActiveHandle(service, runId);
    const startedAt = Date.now();
    await service.cancelRun({ run_id: runId });
    const waited = await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const elapsed = Date.now() - startedAt;
    assert.equal(waited.ok, true);
    assert.equal((waited as { ok: true; status: string }).status, 'cancelled');
    // cancelDrainMs is 25ms in tests; allow generous slack for CI scheduling.
    assert.ok(elapsed < 2_000, `expected finalization within bound, took ${elapsed}ms`);
  });
});

describe('CursorSdkRuntime end-to-end orchestration with a fake SDK adapter', () => {
  it('drives start_run → wait_for_run → get_run_result → send_followup using the persisted agent id', async () => {
    let createCalls = 0;
    let resumeCalls = 0;
    let lastResumeAgentId: string | null = null;
    const api: CursorAgentApi = {
      async create() {
        createCalls += 1;
        const events: CursorSdkMessage[] = [
          { type: 'system', agent_id: 'bc-int', run_id: 'run-create' },
          {
            type: 'assistant',
            agent_id: 'bc-int',
            run_id: 'run-create',
            message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
          },
        ];
        return fakeAgent('bc-int', fakeRun({ agentId: 'bc-int', status: 'finished', result: 'first', events }));
      },
      async resume(agentId) {
        resumeCalls += 1;
        lastResumeAgentId = agentId;
        const events: CursorSdkMessage[] = [
          { type: 'system', agent_id: agentId, run_id: 'run-resume' },
          {
            type: 'assistant',
            agent_id: agentId,
            run_id: 'run-resume',
            message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
          },
        ];
        return fakeAgent(agentId, fakeRun({ agentId, status: 'finished', result: 'second', events }));
      },
    };

    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-int-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'first turn', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const firstResult = await service.getRunResult({ run_id: runId });
    const firstPayload = firstResult as { ok: true; run_summary: { session_id: string | null }; result: { summary: string } };
    assert.equal(firstPayload.run_summary.session_id, 'bc-int');
    assert.equal(firstPayload.result.summary, 'first');

    const followup = await service.sendFollowup({ run_id: runId, prompt: 'second turn' });
    assert.equal(followup.ok, true);
    const followupId = (followup as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: followupId, wait_seconds: 5 });
    const followupResult = await service.getRunResult({ run_id: followupId });
    const followupPayload = followupResult as { ok: true; run_summary: { parent_run_id: string | null; session_id: string | null }; result: { summary: string } };
    assert.equal(followupPayload.run_summary.parent_run_id, runId);
    assert.equal(followupPayload.run_summary.session_id, 'bc-int');
    assert.equal(followupPayload.result.summary, 'second');
    assert.equal(createCalls, 1);
    assert.equal(resumeCalls, 1);
    assert.equal(lastResumeAgentId, 'bc-int');
  });
});

describe('cursor backend service-level validation', () => {
  it('rejects reasoning_effort and service_tier for cursor in start_run', async () => {
    const { service } = await createServiceWith(unavailableAdapter());
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-validation-'));
    const rejectEffort = await service.startRun({ backend: 'cursor', prompt: 'p', cwd, model: 'composer-2', reasoning_effort: 'high' });
    assert.equal(rejectEffort.ok, false);
    assert.equal((rejectEffort as { ok: false; error: { code: string } }).error.code, 'INVALID_INPUT');

    const rejectTier = await service.startRun({ backend: 'cursor', prompt: 'p', cwd, model: 'composer-2', service_tier: 'fast' });
    assert.equal(rejectTier.ok, false);
    assert.equal((rejectTier as { ok: false; error: { code: string } }).error.code, 'INVALID_INPUT');
  });

  it('rejects direct cursor start_run when model is missing', async () => {
    const { service } = await createServiceWith(unavailableAdapter());
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-no-model-'));
    const result = await service.startRun({ backend: 'cursor', prompt: 'p', cwd });
    assert.equal(result.ok, false);
    const error = (result as { ok: false; error: { code: string; message: string } }).error;
    assert.equal(error.code, 'INVALID_INPUT');
    assert.match(error.message, /requires an explicit model/i);
  });

  it('lets cursor follow-ups inherit the parent model and accepts a valid override', async () => {
    let lastSendModel: string | undefined;
    const events: CursorSdkMessage[] = [
      { type: 'system', agent_id: 'bc-followup', run_id: 'run-1' },
    ];
    const makeAgent = (agentId: string) => {
      const run = fakeRun({ agentId, status: 'finished', result: 'next', events: [{ type: 'system', agent_id: agentId, run_id: 'run-resume' }] });
      const agent = fakeAgent(agentId, run);
      // Capture the model passed to send for assertion.
      const send = agent.send.bind(agent);
      agent.send = async (message, options) => {
        lastSendModel = options?.model?.id;
        return send(message, options);
      };
      return agent;
    };
    const api: CursorAgentApi = {
      async create() {
        return fakeAgent('bc-followup', fakeRun({ agentId: 'bc-followup', status: 'finished', result: 'done', events }));
      },
      async resume(agentId) { return makeAgent(agentId); },
    };
    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-followup-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'first', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });

    // Inherit parent's model — must succeed.
    const inherit = await service.sendFollowup({ run_id: runId, prompt: 'second' });
    assert.equal(inherit.ok, true);
    const inheritId = (inherit as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: inheritId, wait_seconds: 5 });

    // Explicit override goes through SendOptions.model on resume.
    const override = await service.sendFollowup({ run_id: inheritId, prompt: 'third', model: 'composer-3' });
    assert.equal(override.ok, true);
    const overrideId = (override as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: overrideId, wait_seconds: 5 });
    assert.equal(lastSendModel, 'composer-3');
  });
});

describe('CursorSdkRuntime missing CURSOR_API_KEY', () => {
  it('classifies a missing CURSOR_API_KEY as a non-retryable auth failure', async () => {
    const api: CursorAgentApi = {
      async create() { throw new Error('should not call create'); },
      async resume() { throw new Error('should not call resume'); },
    };
    // Use an empty env so apiKey is undefined.
    const home = await mkdtemp(join(tmpdir(), 'cursor-noauth-'));
    const store = new RunStore(home);
    const cursorRuntime = new CursorSdkRuntime(fakeAdapter(api), { store, env: {}, cancelDrainMs: 25 });
    const runtimes = createBackendRegistry(store, { cursorRuntime });
    const service = new OrchestratorService(store, runtimes);
    await service.initialize();
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-noauth-cwd-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'p', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    const payload = result as { ok: true; result: { errors: { context?: { category?: string; retryable?: boolean } }[] }; run_summary: { latest_error: { category: string; retryable: boolean } | null } };
    assert.equal(payload.run_summary.latest_error?.category, 'auth');
    assert.equal(payload.run_summary.latest_error?.retryable, false);
    assert.equal(payload.result.errors[0]?.context?.category, 'auth');
  });
});

describe('CursorSdkRuntime SDK error normalization', () => {
  function adapterThatThrowsOnCreate(error: Error): CursorSdkAdapter {
    const api: CursorAgentApi = {
      async create() { throw error; },
      async resume() { throw error; },
    };
    return fakeAdapter(api);
  }

  async function runFailedStart(adapter: CursorSdkAdapter): Promise<{ summary: { latest_error: { category: string; message: string; context?: Record<string, unknown> } | null }; result: { errors: { context?: Record<string, unknown> }[] } }> {
    const { service } = await createServiceWith(adapter);
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-err-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'p', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    const payload = result as { ok: true; result: { errors: { context?: Record<string, unknown> }[] }; run_summary: { latest_error: { category: string; message: string; context?: Record<string, unknown> } | null } };
    return { summary: payload.run_summary, result: payload.result };
  }

  it('maps AuthenticationError to category auth and preserves status/class', async () => {
    const error = Object.assign(new Error('Invalid API key'), { name: 'AuthenticationError', status: 401, code: 'unauthorized' });
    const { summary, result } = await runFailedStart(adapterThatThrowsOnCreate(error));
    assert.equal(summary.latest_error?.category, 'auth');
    assert.equal(result.errors[0]?.context?.error_class, 'AuthenticationError');
    assert.equal(result.errors[0]?.context?.status, 401);
    assert.equal(result.errors[0]?.context?.error_code, 'unauthorized');
  });

  it('maps ConfigurationError with invalid-model message to invalid_model category', async () => {
    const error = Object.assign(new Error('Invalid model: composer-99 not found'), { name: 'ConfigurationError', status: 400 });
    const { summary } = await runFailedStart(adapterThatThrowsOnCreate(error));
    assert.equal(summary.latest_error?.category, 'invalid_model');
  });

  it('maps ConfigurationError with bad-API-key message to auth category', async () => {
    const error = Object.assign(new Error('Bad API key supplied'), { name: 'ConfigurationError', status: 400 });
    const { summary } = await runFailedStart(adapterThatThrowsOnCreate(error));
    assert.equal(summary.latest_error?.category, 'auth');
  });

  it('maps ConfigurationError with invalid-request-parameter message to protocol category', async () => {
    const error = Object.assign(new Error('Invalid request parameter: foo'), { name: 'ConfigurationError', status: 400 });
    const { summary } = await runFailedStart(adapterThatThrowsOnCreate(error));
    assert.equal(summary.latest_error?.category, 'protocol');
  });

  it('maps RateLimitError to rate_limit and marks retryable', async () => {
    const error = Object.assign(new Error('rate limit exceeded'), { name: 'RateLimitError', status: 429 });
    const { summary, result } = await runFailedStart(adapterThatThrowsOnCreate(error));
    assert.equal(summary.latest_error?.category, 'rate_limit');
    assert.equal(result.errors[0]?.context?.retryable, true);
  });

  it('preserves SDK error class/category when the run.stream() throws mid-flight', async () => {
    const streamError = Object.assign(new Error('connection reset'), { name: 'NetworkError', status: 503, isRetryable: true });
    const run: CursorRun = {
      id: 'run-stream-err',
      agentId: 'bc-streamerr',
      get status() { return 'error' as CursorRunStatus; },
      result: undefined,
      // eslint-disable-next-line require-yield
      async *stream() {
        throw streamError;
      },
      async wait() {
        return { status: 'error' };
      },
      async cancel() { /* no-op */ },
    } as CursorRun;
    const api: CursorAgentApi = {
      async create() { return fakeAgent('bc-streamerr', run); },
      async resume() { throw new Error('not used'); },
    };
    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-stream-err-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'p', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    const payload = result as { ok: true; result: { errors: { message: string; context?: Record<string, unknown> }[] }; run_summary: { latest_error: { category: string } | null } };
    const streamObservedError = payload.result.errors.find((error) => error.message.includes('connection reset'));
    assert.ok(streamObservedError, 'expected the stream-time error to surface in result.errors');
    assert.equal(streamObservedError.context?.error_class, 'NetworkError');
    assert.equal(streamObservedError.context?.category, 'backend_unavailable');
    assert.equal(streamObservedError.context?.retryable, true);
  });

  it('maps stale Agent.resume failures to protocol category', async () => {
    const error = Object.assign(new Error('agent bc-stale not found'), { name: 'ConfigurationError', status: 404 });
    const api: CursorAgentApi = {
      async create() { throw new Error('should not call create'); },
      async resume() { throw error; },
    };
    const events: CursorSdkMessage[] = [
      { type: 'system', agent_id: 'bc-parent', run_id: 'parent-run' },
    ];
    const parentApi: CursorAgentApi = {
      async create() { return fakeAgent('bc-parent', fakeRun({ agentId: 'bc-parent', status: 'finished', result: 'first', events })); },
      async resume() { throw error; },
    };
    const { service } = await createServiceWith(fakeAdapter(parentApi));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-stale-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'first', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const followup = await service.sendFollowup({ run_id: runId, prompt: 'second' });
    const followupId = (followup as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: followupId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: followupId });
    const payload = result as { ok: true; result: { errors: { context?: Record<string, unknown> }[] }; run_summary: { latest_error: { category: string } | null } };
    assert.equal(payload.run_summary.latest_error?.category, 'protocol');
    // The api parameter scope is referenced to keep the sample SDK in scope for reviewers.
    void api;
  });
});

describe('CursorSdkRuntime finalize artifacts and timeout/cancel error synthesis', () => {
  it('records the standard run artifacts on cursor finalize (parity with CLI)', async () => {
    const events: CursorSdkMessage[] = [
      { type: 'system', agent_id: 'bc-art', run_id: 'run-art' },
    ];
    const api: CursorAgentApi = {
      async create() { return fakeAgent('bc-art', fakeRun({ agentId: 'bc-art', status: 'finished', result: 'ok', events })); },
      async resume() { throw new Error('not used'); },
    };
    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-art-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'p', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    const payload = result as { ok: true; result: { artifacts: { name: string }[] } };
    const names = payload.result.artifacts.map((art) => art.name).sort();
    assert.deepStrictEqual(names, ['events.jsonl', 'prompt.txt', 'result.json', 'stderr.log', 'stdout.log']);
  });

  it('synthesizes a timeout RunError when the orchestrator cancels with timed_out + idle_timeout reason', async () => {
    let releaseStream: (() => void) | null = null;
    const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
    let runStatus: CursorRunStatus = 'running';
    const run: CursorRun = {
      id: 'run-1',
      agentId: 'bc-timeout',
      get status() { return runStatus; },
      result: undefined,
      async *stream() {
        yield { type: 'system', agent_id: 'bc-timeout', run_id: 'run-1' } as CursorSdkMessage;
        await streamGate;
      },
      async wait() {
        await streamGate;
        return { status: runStatus };
      },
      async cancel() {
        runStatus = 'cancelled';
        releaseStream?.();
      },
    } as CursorRun;
    const api: CursorAgentApi = {
      async create() { return fakeAgent('bc-timeout', run); },
      async resume() { throw new Error('not used'); },
    };
    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-timeout-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'p', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    // Wait until orchestrator registers the active run.
    await waitForActiveHandle(service, runId);
    const handle = (service as unknown as { activeRuns: Map<string, { cancel(status: 'failed' | 'cancelled' | 'timed_out', terminal?: { reason?: string; timeout_reason?: string | null; context?: Record<string, unknown> }): void }> }).activeRuns.get(runId);
    assert.ok(handle, 'expected an active run handle');
    handle.cancel('timed_out', {
      reason: 'idle_timeout',
      timeout_reason: 'idle_timeout',
      context: { idle_timeout_seconds: 1, idle_seconds: 2 },
    });
    const waited = await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    assert.equal((waited as { ok: true; status: string }).status, 'timed_out');
    const result = await service.getRunResult({ run_id: runId });
    const payload = result as { ok: true; result: { errors: { message: string; category?: string }[] }; run_summary: { latest_error: { message: string; category: string } | null; timeout_reason: string | null } };
    assert.equal(payload.run_summary.timeout_reason, 'idle_timeout');
    assert.equal(payload.run_summary.latest_error?.category, 'timeout');
    assert.match(payload.run_summary.latest_error?.message ?? '', /idle timeout/i);
    assert.ok(payload.result.errors.some((error) => /idle timeout/i.test(error.message)));
  });

  it('synthesizes a cancel RunError for user-initiated cancel even when no terminal context is supplied', async () => {
    let releaseStream: (() => void) | null = null;
    const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
    let runStatus: CursorRunStatus = 'running';
    const run: CursorRun = {
      id: 'run-1',
      agentId: 'bc-usercancel',
      get status() { return runStatus; },
      result: undefined,
      async *stream() {
        yield { type: 'system', agent_id: 'bc-usercancel', run_id: 'run-1' } as CursorSdkMessage;
        await streamGate;
      },
      async wait() {
        await streamGate;
        return { status: runStatus };
      },
      async cancel() {
        runStatus = 'cancelled';
        releaseStream?.();
      },
    } as CursorRun;
    const api: CursorAgentApi = {
      async create() { return fakeAgent('bc-usercancel', run); },
      async resume() { throw new Error('not used'); },
    };
    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-usercancel-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'p', cwd, model: 'composer-2' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await waitForActiveHandle(service, runId);
    await service.cancelRun({ run_id: runId });
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    const payload = result as { ok: true; result: { errors: { message: string }[] }; run_summary: { latest_error: { message: string; category: string } | null; status: string } };
    assert.equal(payload.run_summary.status, 'cancelled');
    assert.equal(payload.run_summary.latest_error?.category, 'unknown');
    assert.match(payload.run_summary.latest_error?.message ?? '', /cancelled by user/i);
  });
});

describe('CursorSdkRuntime worker posture (issue #58 Decisions 7, 18)', () => {
  it('trusted posture passes local.settingSources: ["all"] to Agent.create and emits a worker_posture lifecycle event', async () => {
    const events: CursorSdkMessage[] = [
      { type: 'system', agent_id: 'bc-trusted', run_id: 'run-1' },
    ];
    const run = fakeRun({ agentId: 'bc-trusted', status: 'finished', result: 'ok', events });
    const agent = fakeAgent('bc-trusted', run);
    let capturedLocal: { cwd?: string; settingSources?: string[] } | undefined;
    const api: CursorAgentApi = {
      async create(options) {
        capturedLocal = options.local as { cwd?: string; settingSources?: string[] } | undefined;
        return agent;
      },
      async resume() { return agent; },
    };

    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-trusted-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'go', cwd, model: 'composer-2', worker_posture: 'trusted' });
    assert.equal(start.ok, true);
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });

    assert.ok(capturedLocal, 'Agent.create must receive local options');
    assert.deepStrictEqual(capturedLocal!.settingSources, ['all'], 'trusted posture must request all ambient SettingSource layers');

    const eventsResp = await service.getRunEvents({ run_id: runId });
    const stream = (eventsResp as { ok: true; events: { type: string; payload: Record<string, unknown> }[] }).events;
    const posture = stream.find((event) => event.type === 'lifecycle' && event.payload.state === 'worker_posture');
    assert.ok(posture, 'cursor worker must emit a worker_posture lifecycle event');
    assert.equal(posture!.payload.backend, 'cursor');
    assert.equal(posture!.payload.worker_posture, 'trusted');
    const cursorPayload = posture!.payload.cursor as Record<string, unknown>;
    assert.deepStrictEqual(cursorPayload.setting_sources, ['all']);
    // Issue #58 Decision 18: posture event lands before the first SDK stream
    // event ('system' from cursor) so operators can correlate the spawn-time
    // posture with subsequent worker output.
    const sdkSystemIdx = stream.findIndex((event) => event.type === 'lifecycle' && (event.payload as { state?: string }).state !== 'worker_posture' && (event.payload as { agent_id?: string }).agent_id === 'bc-trusted');
    if (sdkSystemIdx >= 0) {
      const postureIdx = stream.indexOf(posture!);
      assert.ok(postureIdx < sdkSystemIdx, 'worker_posture event must precede the first SDK system event');
    }
  });

  it('restricted posture omits local.settingSources and emits the restricted posture event', async () => {
    const events: CursorSdkMessage[] = [
      { type: 'system', agent_id: 'bc-restricted', run_id: 'run-1' },
    ];
    const run = fakeRun({ agentId: 'bc-restricted', status: 'finished', result: 'ok', events });
    const agent = fakeAgent('bc-restricted', run);
    let capturedLocal: { cwd?: string; settingSources?: string[] } | undefined;
    const api: CursorAgentApi = {
      async create(options) {
        capturedLocal = options.local as { cwd?: string; settingSources?: string[] } | undefined;
        return agent;
      },
      async resume() { return agent; },
    };

    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-restricted-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'go', cwd, model: 'composer-2', worker_posture: 'restricted' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });

    assert.ok(capturedLocal, 'Agent.create must still receive local options for cwd');
    assert.equal(capturedLocal!.settingSources, undefined, 'restricted posture must NOT request ambient SettingSource layers');

    const eventsResp = await service.getRunEvents({ run_id: runId });
    const stream = (eventsResp as { ok: true; events: { type: string; payload: Record<string, unknown> }[] }).events;
    const posture = stream.find((event) => event.type === 'lifecycle' && event.payload.state === 'worker_posture');
    assert.ok(posture);
    assert.equal(posture!.payload.worker_posture, 'restricted');
    const cursorPayload = posture!.payload.cursor as Record<string, unknown>;
    assert.equal(cursorPayload.setting_sources, null);
  });

  it('pre-spawn failure (WORKER_BINARY_MISSING) does NOT emit a worker_posture event', async () => {
    // Decision 18 invariant: the event lands only after Agent.create / resume
    // succeed. A missing SDK fails before that, so the run's event stream must
    // contain zero worker_posture events.
    const { service } = await createServiceWith(unavailableAdapter('Cannot find module @cursor/sdk'));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-prespawn-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'go', cwd, model: 'composer-2', worker_posture: 'trusted' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });

    const eventsResp = await service.getRunEvents({ run_id: runId });
    const stream = (eventsResp as { ok: true; events: { type: string; payload: Record<string, unknown> }[] }).events;
    const postureCount = stream.filter((event) => event.type === 'lifecycle' && event.payload.state === 'worker_posture').length;
    assert.equal(postureCount, 0, 'pre-spawn failures must not emit worker_posture telemetry');
  });

  it('issue #58 (review Medium 2): agent.send() failure does NOT emit a worker_posture event', async () => {
    // Regression: previously the runtime appended worker_posture immediately
    // after Agent.create() succeeded, before calling agent.send(). A send()
    // failure then returned SPAWN_FAILED to the orchestrator but the run's
    // event stream already contained a worker_posture event — false telemetry
    // for a worker that never accepted a prompt. The fix moves the append to
    // after agent.send() returns successfully.
    const sendError = new Error('send refused');
    const agent: CursorAgent = {
      agentId: 'bc-send-fails',
      async send() {
        throw sendError;
      },
      async [Symbol.asyncDispose]() { /* no-op */ },
    } as CursorAgent;
    const api: CursorAgentApi = {
      async create() { return agent; },
      async resume() { return agent; },
    };

    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-send-failure-'));
    const start = await service.startRun({ backend: 'cursor', prompt: 'go', cwd, model: 'composer-2', worker_posture: 'trusted' });
    const runId = (start as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });

    const eventsResp = await service.getRunEvents({ run_id: runId });
    const stream = (eventsResp as { ok: true; events: { type: string; payload: Record<string, unknown> }[] }).events;
    const postureCount = stream.filter((event) => event.type === 'lifecycle' && event.payload.state === 'worker_posture').length;
    assert.equal(postureCount, 0, 'agent.send() failure must NOT leave a worker_posture event in the run stream');
  });

  it('Agent.resume receives the same settingSources value as Agent.create (resume parity)', async () => {
    // SDK docs note inline mcpServers are not persisted across resume; we
    // pass settingSources on resume so file-backed ambient settings reload.
    const events: CursorSdkMessage[] = [
      { type: 'system', agent_id: 'bc-resume', run_id: 'run-1' },
    ];
    const run = fakeRun({ agentId: 'bc-resume', status: 'finished', result: 'ok', events });
    const agent = fakeAgent('bc-resume', run);
    let resumeLocal: { settingSources?: string[] } | undefined;
    const api: CursorAgentApi = {
      async create() { return agent; },
      async resume(_sessionId, options) {
        resumeLocal = options?.local as { settingSources?: string[] } | undefined;
        return agent;
      },
    };

    const { service } = await createServiceWith(fakeAdapter(api));
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-resume-trusted-'));
    const parent = await service.startRun({ backend: 'cursor', prompt: 'go', cwd, model: 'composer-2', worker_posture: 'trusted' });
    const parentId = (parent as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: parentId, wait_seconds: 5 });

    const followup = await service.sendFollowup({ run_id: parentId, prompt: 'continue' });
    const followupId = (followup as { ok: true; run_id: string }).run_id;
    await service.waitForRun({ run_id: followupId, wait_seconds: 5 });

    assert.ok(resumeLocal, 'Agent.resume must receive local options');
    assert.deepStrictEqual(resumeLocal!.settingSources, ['all'], 'resume must inherit trusted settingSources from the parent');
  });
});
