import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../runStore.js';

describe('RunStore', () => {
  it('creates, reloads, lists, paginates events, and marks terminal atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-'));
    const store = new RunStore(root);
    const run = await store.createRun({
      backend: 'codex',
      cwd: root,
      prompt: 'raw prompt text',
      metadata: { task: 'T2' },
      idle_timeout_seconds: 1200,
    });
    assert.equal(run.last_activity_source, 'created');
    assert.equal(run.idle_timeout_seconds, 1200);

    const activityAt = new Date(Date.now() + 1000);
    const active = await store.recordActivity(run.run_id, 'stdout', activityAt);
    assert.equal(active.last_activity_at, activityAt.toISOString());
    assert.equal(active.last_activity_source, 'stdout');

    await store.appendEvent(run.run_id, { type: 'lifecycle', payload: { status: 'one' } });
    await store.appendEvent(run.run_id, { type: 'assistant_message', payload: { text: 'hello' } });

    const loaded = await store.loadRun(run.run_id);
    assert.equal(loaded?.meta.metadata.task, 'T2');
    assert.deepStrictEqual(loaded?.meta.model_settings, { reasoning_effort: null, service_tier: null, mode: null, codex_network: null, worker_posture: null });
    assert.equal(loaded?.meta.worker_invocation, null);
    assert.equal(loaded?.events.length, 2);
    assert.equal(await store.readPrompt(run.run_id), 'raw prompt text');
    assert.ok(store.defaultArtifacts(run.run_id).some((artifact) => artifact.name === 'prompt.txt'));

    const page = await store.readEvents(run.run_id, 1, 1);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.seq, 2);
    assert.equal(page.has_more, false);

    const terminal = await store.markTerminal(run.run_id, 'completed', [], undefined, {
      reason: 'completed',
      context: { checked: true },
    });
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.last_activity_source, 'terminal');
    assert.equal(terminal.terminal_reason, 'completed');
    assert.deepStrictEqual(terminal.terminal_context, { checked: true });
    const again = await store.markTerminal(run.run_id, 'orphaned');
    assert.equal(again.status, 'completed');
    const withFinal = await store.loadRun(run.run_id);
    assert.equal(withFinal?.events.at(-1)?.payload.status, 'completed');
    assert.equal(withFinal?.result?.status, 'completed');

    const listed = await store.listRuns();
    assert.equal(listed[0]?.run_id, run.run_id);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
  });

  it('does not publish a run if initial prompt persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-'));
    const store = new RunStore(root);
    store.promptPath = () => join(root, 'missing-directory', 'prompt.txt');

    await assert.rejects(() => store.createRun({ backend: 'codex', cwd: root, prompt: 'must be durable' }));
    assert.deepStrictEqual(await store.listRuns(), []);
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

  it('summarizes oversized event lines without parsing their full payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-'));
    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root });
    await store.appendEvent(run.run_id, { type: 'assistant_message', payload: { text: 'x'.repeat(90_000) } });

    const page = await store.readEvents(run.run_id, 0, 10);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.seq, 1);
    assert.equal(page.events[0]?.type, 'assistant_message');
    assert.equal((page.events[0]?.payload as Record<string, unknown>).truncated, true);

    const summary = await store.readEventSummary(run.run_id, 1);
    assert.equal(summary.event_count, 1);
    assert.equal(summary.last_event?.seq, 1);
    assert.equal((summary.recent_events[0]?.payload as Record<string, unknown>).truncated, true);
  });

  it('recovers terminal worker results from the bounded stdout tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-'));
    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    await writeFile(
      store.stdoutPath(run.run_id),
      `${'noise\n'.repeat(120_000)}${JSON.stringify({ type: 'result', terminal_reason: 'completed', result: 'finished from stdout' })}\n`,
    );

    const result = await store.recoverTerminalResultFromStdout(run.run_id);
    assert.equal(result?.status, 'completed');
    assert.equal(result?.summary, 'finished from stdout');
    assert.ok(result?.artifacts.some((artifact) => artifact.name === 'stdout.log'));
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
    const summary = await store.readEventSummary(run.run_id, 5);
    assert.equal(summary.event_count, 150);
    assert.equal(summary.last_event?.seq, 150);
    assert.deepStrictEqual(summary.recent_events.map((event) => event.seq), [146, 147, 148, 149, 150]);

    const cursorSummary = await store.readEventSummary(run.run_id, 0);
    assert.equal(cursorSummary.event_count, 150);
    assert.equal(cursorSummary.recent_events.length, 0);
    assert.equal(cursorSummary.last_event?.seq, 150, 'last_event must be derived independently of recentLimit');
    assert.match(cursorSummary.last_event?.ts ?? '', /\d{4}-\d{2}-\d{2}T/);

    const largeRun = await store.createRun({ backend: 'codex', cwd: root });
    await store.appendEvent(largeRun.run_id, { type: 'assistant_message', payload: { text: 'x'.repeat(80_000) } });
    for (let index = 0; index < 20; index += 1) {
      await store.appendEvent(largeRun.run_id, { type: 'lifecycle', payload: { index } });
    }
    const eventLog = await readFile(store.eventsPath(largeRun.run_id), 'utf8');
    const firstNewline = eventLog.indexOf('\n');
    await writeFile(store.eventsPath(largeRun.run_id), `not-json ${'x'.repeat(80_000)}${eventLog.slice(firstNewline)}`);
    const tailSummary = await store.readEventSummary(largeRun.run_id, 3);
    assert.equal(tailSummary.event_count, 21);
    assert.deepStrictEqual(tailSummary.recent_events.map((event) => event.seq), [19, 20, 21]);

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

  it('persists observability metadata with backward-compatible defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-store-'));
    const store = new RunStore(root);
    const run = await store.createRun({
      backend: 'codex',
      cwd: root,
      model: 'gpt-5.2',
      model_source: 'explicit',
      model_settings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null, worker_posture: null },
      requested_session_id: 'session-1',
      observed_session_id: 'session-1',
      display: {
        session_title: 'Session title',
        session_summary: 'Session summary',
        prompt_title: 'Prompt title',
        prompt_summary: 'Prompt summary',
      },
    });

    const loaded = await store.loadMeta(run.run_id);
    assert.equal(loaded.model_source, 'explicit');
    // Schema applies the codex_network: null default when the field was not
    // present on the persisted record (legacy back-compat).
    assert.deepStrictEqual(loaded.model_settings, { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null, worker_posture: null });
    assert.equal(loaded.requested_session_id, 'session-1');
    assert.equal(loaded.observed_session_id, 'session-1');
    assert.equal(loaded.display.session_title, 'Session title');
    assert.equal(loaded.display.prompt_title, 'Prompt title');
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
