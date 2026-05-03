import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OrchestratorService } from '../orchestratorService.js';
import { RunStore } from '../runStore.js';
import type { RunNotification } from '../contract.js';

function createService(store: RunStore): OrchestratorService {
  return new OrchestratorService(store, new Map(), () => undefined);
}

interface WaitOk {
  ok: true;
  notifications: RunNotification[];
  wait_exceeded: boolean;
}

function asWaitOk(result: unknown): WaitOk {
  if (typeof result !== 'object' || result === null) throw new Error('expected object');
  const r = result as WaitOk;
  if (r.ok !== true) throw new Error('expected ok response');
  return r;
}

describe('OrchestratorService.waitForAnyRun', () => {
  it('returns immediately when a notification already exists for the supplied run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-svc-wait-'));
    const store = new RunStore(root);
    const service = createService(store);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    await store.appendNotification({ run_id: run.run_id, kind: 'terminal', status: 'completed', terminal_reason: 'completed' });

    const start = Date.now();
    const result = asWaitOk(await service.waitForAnyRun({ run_ids: [run.run_id], wait_seconds: 30 }));
    const elapsed = Date.now() - start;
    assert.equal(result.notifications.length, 1);
    assert.equal(result.notifications[0]?.kind, 'terminal');
    assert.equal(result.wait_exceeded, false);
    assert.ok(elapsed < 1_000, `expected immediate return, took ${elapsed}ms`);
  });

  it('blocks and wakes when a fatal_error notification appears before terminal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-svc-wait-'));
    const store = new RunStore(root);
    const service = createService(store);
    const run = await store.createRun({ backend: 'codex', cwd: root });

    const waitPromise = service.waitForAnyRun({ run_ids: [run.run_id], wait_seconds: 5 });
    setTimeout(() => {
      void store.appendNotification({
        run_id: run.run_id,
        kind: 'fatal_error',
        status: 'running',
        latest_error: { message: 'boom', category: 'unknown', source: 'backend_event', retryable: false, fatal: true },
      });
    }, 300);
    const result = asWaitOk(await waitPromise);
    assert.equal(result.notifications.length, 1);
    assert.equal(result.notifications[0]?.kind, 'fatal_error');
    assert.equal(result.wait_exceeded, false);
  });

  it('honours after_notification_id so the same record does not wake the supervisor twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-svc-wait-'));
    const store = new RunStore(root);
    const service = createService(store);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    const first = await store.appendNotification({ run_id: run.run_id, kind: 'terminal', status: 'completed' });

    const result = asWaitOk(await service.waitForAnyRun({
      run_ids: [run.run_id],
      wait_seconds: 1,
      after_notification_id: first.notification_id,
    }));
    assert.equal(result.notifications.length, 0);
    assert.equal(result.wait_exceeded, true);
  });

  it('only wakes on the kinds filter when supplied (terminal-only ignores fatal_error)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-svc-wait-'));
    const store = new RunStore(root);
    const service = createService(store);
    const run = await store.createRun({ backend: 'codex', cwd: root });

    const waitPromise = service.waitForAnyRun({ run_ids: [run.run_id], wait_seconds: 1, kinds: ['terminal'] });
    setTimeout(() => {
      void store.appendNotification({
        run_id: run.run_id,
        kind: 'fatal_error',
        status: 'running',
        latest_error: { message: 'boom', category: 'unknown', source: 'backend_event', retryable: false, fatal: true },
      });
    }, 200);
    const result = asWaitOk(await waitPromise);
    // Only fatal_error happened; the terminal-only filter must wait until the deadline.
    assert.equal(result.wait_exceeded, true);
    assert.equal(result.notifications.length, 0);
  });

  it('aggregates notifications across multiple supplied run ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-svc-wait-'));
    const store = new RunStore(root);
    const service = createService(store);
    const runA = await store.createRun({ backend: 'codex', cwd: root });
    const runB = await store.createRun({ backend: 'claude', cwd: root });

    await store.appendNotification({ run_id: runB.run_id, kind: 'terminal', status: 'completed' });
    const result = asWaitOk(await service.waitForAnyRun({ run_ids: [runA.run_id, runB.run_id], wait_seconds: 30 }));
    assert.equal(result.notifications.length, 1);
    assert.equal(result.notifications[0]?.run_id, runB.run_id);
  });
});
