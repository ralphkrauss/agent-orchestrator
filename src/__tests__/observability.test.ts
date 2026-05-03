import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildObservabilitySnapshot } from '../observability.js';
import { RunStore } from '../runStore.js';

describe('observability snapshot builder', () => {
  it('derives sessions, prompt metadata, artifact sizes, and activity from the run store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-observe-'));
    const store = new RunStore(root);
    const parent = await store.createRun({
      backend: 'codex',
      cwd: root,
      prompt: 'Build the dashboard\nwith a terminal view.',
      model: 'gpt-5.2',
      model_source: 'explicit',
      observed_session_id: 'session-1',
      session_id: 'session-1',
      display: {
        session_title: 'Observability work',
        session_summary: 'Build dashboard visibility',
        prompt_title: 'Start dashboard',
        prompt_summary: 'Initial implementation',
      },
    });
    await store.appendEvent(parent.run_id, { type: 'assistant_message', payload: { text: 'I am implementing the dashboard.' } });
    await store.markTerminal(parent.run_id, 'completed', [], {
      status: 'completed',
      summary: 'Dashboard implementation complete.',
      files_changed: [],
      commands_run: [],
      artifacts: store.defaultArtifacts(parent.run_id),
      errors: [],
    });

    const childActivityAt = new Date(Date.now() - 60_000).toISOString();
    const child = await store.createRun({
      backend: 'codex',
      cwd: root,
      prompt: 'Add an interactive detail view.',
      parent_run_id: parent.run_id,
      session_id: 'session-1',
      requested_session_id: 'session-1',
      observed_session_id: 'session-2',
      model: 'gpt-5.2',
      model_source: 'inherited',
      model_settings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null },
      display: {
        session_title: 'Observability work',
        session_summary: 'Build dashboard visibility',
        prompt_title: 'Add details',
        prompt_summary: 'Interactive detail view',
      },
      last_activity_at: childActivityAt,
      last_activity_source: 'backend_event',
      idle_timeout_seconds: 1200,
      latest_error: {
        message: '429 rate limit exceeded',
        category: 'rate_limit',
        source: 'backend_event',
        backend: 'codex',
        retryable: true,
        fatal: true,
      },
    });
    for (let index = 0; index < 25; index += 1) {
      await store.appendEvent(child.run_id, { type: 'lifecycle', payload: { index } });
    }
    await store.appendEvent(child.run_id, { type: 'tool_use', payload: { name: 'Bash', input: { command: 'pnpm build' } } });

    const snapshot = await buildObservabilitySnapshot(store, {
      limit: 50,
      includePrompts: true,
      recentEventLimit: 3,
      daemonPid: 123,
      backendStatus: null,
    });

    assert.equal(snapshot.daemon_pid, 123);
    assert.equal(snapshot.runs.length, 2);
    assert.equal(snapshot.sessions.length, 2);
    const childRun = snapshot.runs.find((run) => run.run.run_id === child.run_id);
    assert.equal(childRun?.prompt.title, 'Add details');
    assert.equal(childRun?.prompt.text, 'Add an interactive detail view.');
    assert.deepStrictEqual(childRun?.settings, { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null });
    assert.equal(childRun?.session.status, 'mismatch');
    assert.ok(childRun?.session.warnings[0]?.includes('session-1'));
    assert.equal(childRun?.activity.event_count, 26);
    assert.equal(childRun?.activity.recent_events.length, 3);
    assert.equal(childRun?.activity.recent_events.at(-1)?.seq, 26);
    assert.equal(childRun?.activity.last_interaction_preview, 'Bash: pnpm build');
    assert.equal(childRun?.activity.last_activity_at, childActivityAt);
    assert.equal(childRun?.activity.last_activity_source, 'backend_event');
    assert.equal(childRun?.activity.latest_error?.category, 'rate_limit');
    assert.equal(childRun?.run.idle_timeout_seconds, 1200);
    assert.equal(typeof childRun?.activity.idle_seconds, 'number');
    assert.ok(childRun?.artifacts.some((artifact) => artifact.name === 'prompt.txt' && artifact.exists && artifact.bytes));
    const latestChildEventAt = childRun?.activity.last_event_at ?? null;
    assert.ok(latestChildEventAt);
    assert.notEqual(latestChildEventAt, childActivityAt);

    const parentRun = snapshot.runs.find((run) => run.run.run_id === parent.run_id);
    assert.equal(parentRun?.response.status, 'completed');
    assert.equal(parentRun?.response.summary, 'Dashboard implementation complete.');

    const parentSession = snapshot.sessions.find((session) => session.session_id === 'session-1');
    assert.equal(parentSession?.title, 'Observability work');
    assert.equal(parentSession?.prompts[0]?.title, 'Start dashboard');
    assert.equal(parentSession?.workspace.cwd, root);
    assert.equal(parentSession?.workspace.repository_root, null);

    const childSession = snapshot.sessions.find((session) => session.session_id === 'session-2');
    assert.deepStrictEqual(childSession?.settings, [{ reasoning_effort: 'xhigh', service_tier: 'fast', mode: null }]);
    assert.deepStrictEqual(childSession?.prompts[0]?.settings, { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null });
    assert.equal(childSession?.updated_at, latestChildEventAt);
    assert.equal(childSession?.prompts[0]?.last_activity_at, latestChildEventAt);
  });

  it('uses the last assistant message as the final response when result summaries are empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-observe-'));
    const store = new RunStore(root);
    const run = await store.createRun({ backend: 'codex', cwd: root, prompt: 'Run a smoke test.' });
    await store.appendEvent(run.run_id, { type: 'assistant_message', payload: { text: 'Smoke test complete; no files were changed.' } });
    await store.markTerminal(run.run_id, 'completed');
    await writeFile(store.eventSeqPath(run.run_id), '1\n');

    const snapshot = await buildObservabilitySnapshot(store, {
      limit: 10,
      includePrompts: true,
      recentEventLimit: 5,
      daemonPid: null,
      backendStatus: null,
    });

    assert.equal(snapshot.runs[0]?.response.status, 'completed');
    assert.equal(snapshot.runs[0]?.response.summary, 'Smoke test complete; no files were changed.');
    assert.equal(snapshot.runs[0]?.activity.event_count, 2);
  });

  it('omits full prompt text unless requested but keeps a preview and title fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-observe-'));
    const store = new RunStore(root);
    const run = await store.createRun({
      backend: 'claude',
      cwd: root,
      prompt: 'Summarize this session for a human operator.',
      metadata: { requested_reasoning_effort: 'xhigh', requested_service_tier: 'fast' },
    });

    const snapshot = await buildObservabilitySnapshot(store, {
      limit: 10,
      includePrompts: false,
      recentEventLimit: 0,
      daemonPid: null,
      backendStatus: null,
    });

    assert.equal(snapshot.runs[0]?.prompt.text, null);
    assert.equal(snapshot.runs[0]?.prompt.preview, 'Summarize this session for a human operator.');
    assert.equal(snapshot.runs[0]?.prompt.title, 'Summarize this session for a human operator.');
    assert.deepStrictEqual(snapshot.runs[0]?.settings, { reasoning_effort: null, service_tier: null, mode: null });
  });

  it('counts full session history even when detailed runs are limited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-observe-'));
    const store = new RunStore(root);
    for (let index = 1; index <= 3; index += 1) {
      await store.createRun({
        backend: 'codex',
        cwd: root,
        prompt: `Prompt ${index}`,
        session_id: 'session-limited',
        observed_session_id: 'session-limited',
        display: {
          session_title: 'Limited history chat',
          session_summary: null,
          prompt_title: `Prompt ${index}`,
          prompt_summary: null,
        },
      });
    }

    const snapshot = await buildObservabilitySnapshot(store, {
      limit: 1,
      includePrompts: false,
      recentEventLimit: 0,
      daemonPid: null,
      backendStatus: null,
    });

    assert.equal(snapshot.runs.length, 1);
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0]?.run_count, 3);
    assert.equal(snapshot.sessions[0]?.prompts.length, 1);
  });

  it('shows observed backend model and warns when it differs from the requested model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-observe-'));
    const store = new RunStore(root);
    await store.createRun({
      backend: 'claude',
      cwd: root,
      prompt: 'Use the requested model.',
      model: 'claude-sonnet-4-6',
      model_source: 'explicit',
      observed_model: 'claude-opus-4-7',
      session_id: 'session-model',
      observed_session_id: 'session-model',
    });

    const snapshot = await buildObservabilitySnapshot(store, {
      limit: 10,
      includePrompts: false,
      recentEventLimit: 0,
      daemonPid: null,
      backendStatus: null,
    });

    assert.equal(snapshot.runs[0]?.model.name, 'claude-opus-4-7');
    assert.equal(snapshot.runs[0]?.model.requested_name, 'claude-sonnet-4-6');
    assert.equal(snapshot.runs[0]?.model.observed_name, 'claude-opus-4-7');
    assert.ok(snapshot.sessions[0]?.warnings.some((warning) => warning.includes('requested model claude-sonnet-4-6')));
  });

  it('derives readable workspace labels for repo worktrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-observe-'));
    const store = new RunStore(root);
    await store.createRun({
      backend: 'codex',
      cwd: '/tmp/worktrees-agent-orchestrator/4-add-observability',
      prompt: 'Show the workspace label.',
      git_snapshot_status: 'captured',
      git_snapshot: {
        sha: '0123456789abcdef0123456789abcdef01234567',
        root: '/tmp/worktrees-agent-orchestrator/4-add-observability',
        branch: '4-add-observability',
        dirty_count: 2,
        dirty: ['src/observability.ts', 'src/daemon/observabilityFormat.ts'],
        dirty_fingerprints: {},
      },
    });

    const snapshot = await buildObservabilitySnapshot(store, {
      limit: 10,
      includePrompts: false,
      recentEventLimit: 0,
      daemonPid: null,
      backendStatus: null,
    });

    assert.equal(snapshot.sessions[0]?.workspace.repository_name, 'agent-orchestrator');
    assert.equal(snapshot.sessions[0]?.workspace.label, 'agent-orchestrator:4-add-observability*');
  });
});
