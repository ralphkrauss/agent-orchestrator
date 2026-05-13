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
      model_settings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null, worker_posture: null },
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
    assert.deepStrictEqual(childRun?.settings, { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null, worker_posture: null });
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
    assert.deepStrictEqual(childSession?.settings, [{ reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null, worker_posture: null }]);
    assert.deepStrictEqual(childSession?.prompts[0]?.settings, { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null, worker_posture: null });
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

  it('bounds prompts, response summaries, and recent event payloads for watch-sized snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-observe-large-'));
    const store = new RunStore(root);
    const largeText = 'large output '.repeat(10_000);
    const run = await store.createRun({
      backend: 'claude',
      cwd: root,
      prompt: `Review this output:\n${largeText}`,
    });
    await store.appendEvent(run.run_id, { type: 'assistant_message', payload: { text: largeText } });
    await store.appendEvent(run.run_id, {
      type: 'tool_result',
      payload: {
        name: 'Bash',
        status: 'success',
        output: largeText,
      },
    });
    await store.markTerminal(run.run_id, 'completed', [], {
      status: 'completed',
      summary: largeText,
      files_changed: [],
      commands_run: [],
      artifacts: store.defaultArtifacts(run.run_id),
      errors: [],
    });

    const snapshot = await buildObservabilitySnapshot(store, {
      limit: 200,
      includePrompts: true,
      recentEventLimit: 200,
      daemonPid: null,
      backendStatus: null,
    });

    const observed = snapshot.runs[0];
    assert.ok(observed);
    assert.ok((observed.prompt.text?.length ?? 0) < largeText.length);
    assert.ok((observed.response.summary?.length ?? 0) < largeText.length);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') < 100_000);

    const assistant = observed.activity.recent_events.find((event) => event.type === 'assistant_message');
    assert.ok(assistant);
    assert.equal(assistant?.payload.truncated, true);
    assert.ok(typeof assistant?.payload.text === 'string');
    assert.ok((assistant.payload.text as string).length < largeText.length);

    const toolResult = observed.activity.recent_events.find((event) => event.type === 'tool_result');
    assert.ok(toolResult);
    assert.equal(toolResult?.payload.truncated, true);
    assert.ok(typeof toolResult?.payload.text === 'string');
    assert.ok((toolResult.payload.text as string).length < largeText.length);
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
    assert.deepStrictEqual(snapshot.runs[0]?.settings, { reasoning_effort: null, service_tier: null, mode: null, codex_network: null, worker_posture: null });
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

  it('groups workers by live orchestrator id and archives historical orchestrators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-observe-'));
    const store = new RunStore(root);
    await store.createRun({
      backend: 'codex',
      cwd: root,
      prompt: 'Implement the live watch pane.',
      metadata: { orchestrator_id: 'orch-live' },
      display: { session_title: 'Live watch', session_summary: null, prompt_title: 'Live worker', prompt_summary: null },
    });
    const completed = await store.createRun({
      backend: 'codex',
      cwd: root,
      prompt: 'Write tests for live watch.',
      metadata: { orchestrator_id: 'orch-live' },
      display: { session_title: 'Live watch', session_summary: null, prompt_title: 'Completed worker', prompt_summary: null },
    });
    await store.markTerminal(completed.run_id, 'completed');
    const archived = await store.createRun({
      backend: 'claude',
      cwd: root,
      prompt: 'Old worker prompt.',
      metadata: { orchestrator_id: 'orch-archived' },
      display: { session_title: 'Archived watch', session_summary: null, prompt_title: 'Archived worker', prompt_summary: null },
    });
    await store.markTerminal(archived.run_id, 'completed');

    const snapshot = await buildObservabilitySnapshot(store, {
      limit: 50,
      includePrompts: true,
      recentEventLimit: 5,
      daemonPid: null,
      backendStatus: null,
      liveOrchestrators: [{
        record: {
          id: 'orch-live',
          client: 'claude',
          label: 'Live watch',
          cwd: root,
          display: { tmux_pane: '%1', tmux_window_id: '@1', base_title: 'Live watch', host: 'host' },
          registered_at: '2026-05-02T00:00:00.000Z',
          last_supervisor_event_at: '2026-05-02T00:00:01.000Z',
        },
        status: {
          state: 'in_progress',
          supervisor_turn_active: true,
          waiting_for_user: false,
          running_child_count: 1,
          failed_unacked_count: 0,
        },
      }],
    });

    const liveGroup = snapshot.orchestrators.find((group) => group.orchestrator_id === 'orch-live');
    assert.ok(liveGroup);
    assert.equal(liveGroup?.live, true);
    assert.equal(liveGroup?.status?.state, 'in_progress');
    assert.equal(liveGroup?.worker_count, 2);
    assert.equal(liveGroup?.running_count, 1);
    assert.deepStrictEqual(liveGroup?.workers.map((worker) => worker.title), ['Live worker', 'Completed worker']);
    assert.equal(liveGroup?.workers.find((worker) => worker.run_id === completed.run_id)?.status, 'completed');

    const archivedGroup = snapshot.orchestrators.find((group) => group.orchestrator_id === 'orch-archived');
    assert.ok(archivedGroup);
    assert.equal(archivedGroup?.live, false);
    assert.equal(archivedGroup?.status, null);
    assert.equal(archivedGroup?.label, 'Archived watch');
    assert.equal(archivedGroup?.workers[0]?.title, 'Archived worker');

    assert.equal(snapshot.orchestrators[0]?.orchestrator_id, 'orch-live');
  });
});
