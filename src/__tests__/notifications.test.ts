import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../runStore.js';
import {
  AckRunNotificationInputSchema,
  ListRunNotificationsInputSchema,
  RunNotificationKindSchema,
  RunNotificationPushPayloadSchema,
  RunNotificationSchema,
  WaitForAnyRunInputSchema,
} from '../contract.js';

describe('RunStore notifications', () => {
  it('appends, lists, and persists notifications across instances with global ordering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-notif-'));
    const store = new RunStore(root);
    const runA = await store.createRun({ backend: 'codex', cwd: root });
    const runB = await store.createRun({ backend: 'claude', cwd: root });

    const a1 = await store.appendNotification({ run_id: runA.run_id, kind: 'fatal_error', status: 'running' });
    const b1 = await store.appendNotification({ run_id: runB.run_id, kind: 'terminal', status: 'completed', terminal_reason: 'completed' });
    const a2 = await store.appendNotification({ run_id: runA.run_id, kind: 'terminal', status: 'failed', terminal_reason: 'worker_failed' });

    assert.equal(a1.seq, 1);
    assert.equal(b1.seq, 2);
    assert.equal(a2.seq, 3);
    assert.ok(a1.notification_id < b1.notification_id);
    assert.ok(b1.notification_id < a2.notification_id);
    assert.match(a1.notification_id, /^00000000000000000001-[0-9A-HJKMNP-TV-Z]{26}$/);

    const all = await store.listNotifications();
    assert.deepStrictEqual(all.map((entry) => entry.seq), [1, 2, 3]);

    const sinceA1 = await store.listNotifications({ sinceNotificationId: a1.notification_id });
    assert.deepStrictEqual(sinceA1.map((entry) => entry.seq), [2, 3]);

    const filteredKinds = await store.listNotifications({ kinds: ['fatal_error'] });
    assert.deepStrictEqual(filteredKinds.map((entry) => entry.seq), [1]);

    const filteredRuns = await store.listNotifications({ runIds: [runA.run_id] });
    assert.deepStrictEqual(filteredRuns.map((entry) => entry.seq), [1, 3]);

    const reopened = new RunStore(root);
    const after = await reopened.appendNotification({ run_id: runA.run_id, kind: 'terminal', status: 'completed' });
    assert.equal(after.seq, 4);
  });

  it('recovers the sequence from the journal when notifications.seq is missing or corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-notif-'));
    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    await store.appendNotification({ run_id: run.run_id, kind: 'terminal', status: 'completed' });
    await store.appendNotification({ run_id: run.run_id, kind: 'terminal', status: 'failed' });
    await rm(store.notificationsSeqPath(), { force: true });
    const recovered = new RunStore(root);
    const next = await recovered.appendNotification({ run_id: run.run_id, kind: 'terminal', status: 'completed' });
    assert.equal(next.seq, 3);

    await writeFile(store.notificationsSeqPath(), 'corrupt\n');
    const recovered2 = new RunStore(root);
    const next2 = await recovered2.appendNotification({ run_id: run.run_id, kind: 'terminal', status: 'completed' });
    assert.equal(next2.seq, 4);
  });

  it('recovers monotonically when notifications.seq is stale (lower than the journal max), simulating a crash between journal append and counter write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-notif-'));
    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    const a = await store.appendNotification({ run_id: run.run_id, kind: 'terminal', status: 'completed' });
    const b = await store.appendNotification({ run_id: run.run_id, kind: 'terminal', status: 'failed' });
    const c = await store.appendNotification({ run_id: run.run_id, kind: 'terminal', status: 'cancelled' });
    assert.deepStrictEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
    // Simulate a crash where the journal already advanced to seq 3 but notifications.seq still says 1.
    await writeFile(store.notificationsSeqPath(), '1\n');
    const recovered = new RunStore(root);
    const next = await recovered.appendNotification({ run_id: run.run_id, kind: 'terminal', status: 'completed' });
    assert.equal(next.seq, 4, 'next id must strictly exceed the journal max even when the counter is stale');

    // Listing remains lexicographically sorted with no duplicates.
    const all = await recovered.listNotifications({ includeAcked: true });
    assert.deepStrictEqual(all.map((entry) => entry.seq), [1, 2, 3, 4]);
    const ids = new Set(all.map((entry) => entry.notification_id));
    assert.equal(ids.size, all.length, 'notification ids must be unique');
  });

  it('marks notifications acked and filters them by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-notif-'));
    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    const record = await store.appendNotification({ run_id: run.run_id, kind: 'terminal', status: 'completed' });
    const ack = await store.markNotificationAcked(record.notification_id);
    assert.equal(ack.acked, true);
    const second = await store.markNotificationAcked(record.notification_id);
    assert.equal(second.acked, false);

    const defaultList = await store.listNotifications();
    assert.equal(defaultList.length, 0);

    const includeAcked = await store.listNotifications({ includeAcked: true });
    assert.equal(includeAcked.length, 1);
  });

  it('emits a terminal notification on markTerminal and a fatal_error notification when meta has fatal latest_error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-notif-'));
    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    await store.markTerminal(run.run_id, 'failed', [], undefined, {
      reason: 'pre_spawn_failed',
      latest_error: {
        message: 'auth failed',
        category: 'auth',
        source: 'pre_spawn',
        retryable: false,
        fatal: true,
      },
    });
    const records = await store.listNotifications({ includeAcked: true });
    assert.deepStrictEqual(records.map((entry) => entry.kind), ['fatal_error', 'terminal']);
    assert.equal(records[0]?.run_id, run.run_id);
    assert.equal(records[1]?.status, 'failed');

    // Idempotent: a second markTerminal must not produce a duplicate terminal notification.
    await store.markTerminal(run.run_id, 'failed');
    const after = await store.listNotifications({ includeAcked: true });
    assert.equal(after.length, 2);
  });

  it('dedupes fatal_error notifications via the per-run sentinel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-notif-'));
    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    const error = { message: 'boom', category: 'unknown' as const, source: 'backend_event' as const, retryable: false, fatal: true };
    const first = await store.appendFatalErrorNotificationIfNew(run.run_id, 'running', error);
    const second = await store.appendFatalErrorNotificationIfNew(run.run_id, 'running', error);
    assert.notEqual(first, null);
    assert.equal(second, null);
    const all = await store.listNotifications({ kinds: ['fatal_error'], includeAcked: true });
    assert.equal(all.length, 1);
  });

  it('prunes notifications and acks for pruned runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-notif-'));
    const store = new RunStore(root);
    const runA = await store.createRun({ backend: 'codex', cwd: root });
    const runB = await store.createRun({ backend: 'claude', cwd: root });
    const aTerminal = await store.appendNotification({ run_id: runA.run_id, kind: 'terminal', status: 'completed' });
    await store.appendNotification({ run_id: runB.run_id, kind: 'terminal', status: 'completed' });
    await store.markNotificationAcked(aTerminal.notification_id);
    const removed = await store.pruneNotificationsForRuns([runA.run_id]);
    assert.equal(removed, 1);
    const after = await store.listNotifications({ includeAcked: true });
    assert.equal(after.length, 1);
    assert.equal(after[0]?.run_id, runB.run_id);
    const acks = await readFile(store.notificationsAcksPath(), 'utf8').catch(() => '');
    assert.equal(acks.trim(), '');
  });

  it('parses notification contract schemas additively', () => {
    assert.equal(RunNotificationKindSchema.parse('terminal'), 'terminal');
    assert.equal(RunNotificationKindSchema.parse('fatal_error'), 'fatal_error');
    const record = RunNotificationSchema.parse({
      notification_id: '00000000000000000001-01H00000000000000000000000',
      seq: 1,
      run_id: 'run-1',
      kind: 'terminal',
      status: 'completed',
      terminal_reason: 'completed',
      latest_error: null,
      created_at: new Date().toISOString(),
    });
    assert.equal(record.kind, 'terminal');

    const wait = WaitForAnyRunInputSchema.parse({ run_ids: ['r1'], wait_seconds: 5 });
    assert.equal(wait.wait_seconds, 5);
    assert.equal(wait.kinds, undefined);

    const list = ListRunNotificationsInputSchema.parse({});
    assert.equal(list.limit, 100);
    assert.equal(list.include_acked, false);

    const ack = AckRunNotificationInputSchema.parse({ notification_id: 'x' });
    assert.equal(ack.notification_id, 'x');

    const push = RunNotificationPushPayloadSchema.parse({
      run_id: 'r1',
      notification_id: 'n1',
      kind: 'terminal',
      status: 'completed',
    });
    assert.deepStrictEqual(Object.keys(push).sort(), ['kind', 'notification_id', 'run_id', 'status']);
  });
});
