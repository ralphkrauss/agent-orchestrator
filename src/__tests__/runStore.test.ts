import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../runStore.js';

describe('RunStore', () => {
  it('creates, reloads, lists, paginates events, and marks terminal atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-'));
    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root, metadata: { task: 'T2' } });
    await store.appendEvent(run.run_id, { type: 'lifecycle', payload: { status: 'one' } });
    await store.appendEvent(run.run_id, { type: 'assistant_message', payload: { text: 'hello' } });

    const loaded = await store.loadRun(run.run_id);
    assert.equal(loaded?.meta.metadata.task, 'T2');
    assert.equal(loaded?.events.length, 2);

    const page = await store.readEvents(run.run_id, 1, 1);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.seq, 2);
    assert.equal(page.has_more, false);

    const terminal = await store.markTerminal(run.run_id, 'completed');
    assert.equal(terminal.status, 'completed');
    const again = await store.markTerminal(run.run_id, 'orphaned');
    assert.equal(again.status, 'completed');
    const withFinal = await store.loadRun(run.run_id);
    assert.equal(withFinal?.events.at(-1)?.payload.status, 'completed');

    const listed = await store.listRuns();
    assert.equal(listed[0]?.run_id, run.run_id);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
  });

  it('serializes concurrent event appends without sequence collisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-'));
    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    await Promise.all(Array.from({ length: 25 }, (_, index) =>
      store.appendEvent(run.run_id, { type: 'lifecycle', payload: { index } })));

    const events = (await store.loadRun(run.run_id))!.events;
    assert.equal(events.length, 25);
    assert.deepStrictEqual(events.map((event) => event.seq), Array.from({ length: 25 }, (_, index) => index + 1));
  });

  it('paginates larger event logs and prunes only old terminal runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-'));
    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root, model: 'gpt-5.2' });
    for (let index = 0; index < 150; index += 1) {
      await store.appendEvent(run.run_id, { type: 'lifecycle', payload: { index } });
    }

    const page = await store.readEvents(run.run_id, 100, 10);
    assert.equal(page.events.length, 10);
    assert.equal(page.events[0]?.seq, 101);
    assert.equal(page.next_sequence, 110);
    assert.equal(page.has_more, true);

    const oldTerminal = await store.createRun({ backend: 'codex', cwd: root });
    await store.markTerminal(oldTerminal.run_id, 'completed');
    await store.updateMeta(oldTerminal.run_id, (meta) => ({
      ...meta,
      finished_at: new Date(Date.now() - (40 * 24 * 60 * 60 * 1000)).toISOString(),
    }));
    const freshTerminal = await store.createRun({ backend: 'claude', cwd: root });
    await store.markTerminal(freshTerminal.run_id, 'completed');
    const running = await store.createRun({ backend: 'codex', cwd: root });

    const dryRun = await store.pruneTerminalRuns(30, true);
    assert.deepStrictEqual(dryRun.matched.map((item) => item.run_id), [oldTerminal.run_id]);
    assert.equal(await store.loadRun(oldTerminal.run_id) !== null, true);

    const pruned = await store.pruneTerminalRuns(30, false);
    assert.deepStrictEqual(pruned.deleted_run_ids, [oldTerminal.run_id]);
    assert.equal(await store.loadRun(oldTerminal.run_id), null);
    assert.equal((await store.loadRun(freshTerminal.run_id))?.meta.status, 'completed');
    assert.equal((await store.loadRun(running.run_id))?.meta.status, 'running');
  });

  it('reclaims a stale per-run lock left by a dead process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-'));
    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    await writeFile(join(store.runDir(run.run_id), '.lock'), `${JSON.stringify({ pid: 999_999_999, acquired_at: new Date(0).toISOString() })}\n`);

    const terminal = await store.markTerminal(run.run_id, 'orphaned');
    assert.equal(terminal.status, 'orphaned');

    const legacy = await store.createRun({ backend: 'claude', cwd: root });
    const legacyLock = join(store.runDir(legacy.run_id), '.lock');
    await writeFile(legacyLock, '');
    await utimes(legacyLock, new Date(0), new Date(0));
    const legacyTerminal = await store.markTerminal(legacy.run_id, 'orphaned');
    assert.equal(legacyTerminal.status, 'orphaned');
  });
});
