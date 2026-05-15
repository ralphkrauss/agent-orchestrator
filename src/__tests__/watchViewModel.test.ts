import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'ink';
import { ObservabilitySnapshotSchema } from '../contract.js';
import type { SnapshotEnvelope } from '../daemon/observabilityFormat.js';
import { WatchApp, watchOrchestratorStatusLabel } from '../daemon/watchApp.js';
import {
  applyWatchInput,
  applyWatchRawInput,
  buildWatchViewModel,
  clampWatchDashboardState,
  createWatchDashboardState,
  normalizeWatchEvent,
  renderMarkdownToAnsi,
  scrollWatchTranscript,
  selectWatchSidebarItemAt,
  selectWatchSidebarItem,
  selectedWatchTranscriptBlocks,
  selectedWatchTranscriptLines,
  watchMouseClickPosition,
  watchMouseScrollDelta,
  watchSidebarItems,
} from '../daemon/watchViewModel.js';

describe('watch view model', () => {
  it('groups follow-up child runs into one worker conversation', () => {
    const model = buildWatchViewModel(sampleEnvelope());

    assert.equal(model.live.length, 1);
    assert.equal(model.archive.length, 1);
    const live = model.live[0]!;
    assert.equal(live.conversations.length, 1);
    assert.deepEqual(live.conversations[0]?.runIds, ['run-parent', 'run-child']);
    assert.equal(live.conversations[0]?.status, 'running');
    assert.equal(watchSidebarItems(model, createWatchDashboardState()).filter((item) => item.kind === 'conversation').length, 1);
  });

  it('uses backend session ids to group follow-ups when parents are outside the watch limit', () => {
    const envelope = sampleEnvelope();
    const live = envelope.snapshot.orchestrators[0]!;
    const snapshot = ObservabilitySnapshotSchema.parse({
      ...envelope.snapshot,
      orchestrators: [{
        ...live,
        workers: [
          worker('run-missing-a', 'missing-parent-a', 'completed', 'Follow-up A', 'First follow-up.'),
          worker('run-missing-b', 'missing-parent-b', 'running', 'Follow-up B', 'Second follow-up.'),
        ],
      }],
      runs: [
        run('run-missing-a', 'missing-parent-a', 'completed', 'Follow-up A', 'First follow-up.', 'orch-live', [], 'Done.'),
        run('run-missing-b', 'missing-parent-b', 'running', 'Follow-up B', 'Second follow-up.', 'orch-live', [], null),
      ],
    });
    const model = buildWatchViewModel({ running: true, snapshot });

    assert.equal(model.live[0]?.conversations.length, 1);
    assert.deepEqual(model.live[0]?.conversations[0]?.runIds, ['run-missing-a', 'run-missing-b']);
  });

  it('renders actor-labeled supervisor follow-ups inside one readable transcript', () => {
    const model = buildWatchViewModel(sampleEnvelope());
    let state = clampWatchDashboardState(createWatchDashboardState(), model);
    state = selectWatchSidebarItem(state, model, 1);

    const blocks = selectedWatchTranscriptBlocks(model, state);
    assert.deepEqual(blocks.map((block) => block.label), [
      'Worker Chat',
      'Run 1',
      'Supervisor -> Worker',
      'Worker message',
      'Tool call',
      'Tool result',
      'Worker activity',
      'Final response',
      'Run 1',
      'Run 2',
      'Supervisor -> Worker',
      'Worker message',
    ]);

    const plain = stripAnsi(selectedWatchTranscriptLines(model, state, 100).join('\n'));
    assert.match(plain, /Supervisor -> Worker Supervisor prompt/);
    assert.match(plain, /Supervisor -> Worker Supervisor follow-up/);
    assert.match(plain, /Fix the failing watch refresh/);
    assert.doesNotMatch(plain, /"type":"tool_use"/);
    assert.doesNotMatch(plain, />>>/);
    assert.doesNotMatch(plain, /Supervisor prompt \[completed\]/);
    assert.doesNotMatch(plain, /Worker final message \[completed\]/);
  });

  it('hydrates selected timeline prompt text without requiring full prompts in the snapshot', () => {
    const envelope = sampleEnvelope();
    const child = envelope.snapshot.runs.find((item) => item.run.run_id === 'run-child')!;
    child.prompt.preview = 'The resolution-map reviewer answered the three Rev...';
    child.prompt.text = null;

    const model = buildWatchViewModel(envelope);
    let state = clampWatchDashboardState(createWatchDashboardState(), model);
    state = selectWatchSidebarItem(state, model, 1);

    const promptTextByRunId = new Map([[
      'run-child',
      [
        'The resolution-map reviewer answered the three review questions.',
        '',
        'This tail is beyond the preview and must remain visible in watch.',
      ].join('\n'),
    ]]);
    const plain = stripAnsi(selectedWatchTranscriptLines(model, state, 80, promptTextByRunId).join('\n'));
    assert.match(plain, /This tail is beyond the preview/);
    assert.doesNotMatch(plain, /three Rev\.\.\./);
  });

  it('gives workers stable names and renders the orchestrator selection as an overview', () => {
    const model = buildWatchViewModel(sampleEnvelope());
    const conversation = model.live[0]?.conversations[0];
    assert.equal(conversation?.workerName, 'Worker 1');
    assert.match(conversation?.purpose ?? '', /Build the \*\*watch\*\* TUI/);

    const overviewState = clampWatchDashboardState(createWatchDashboardState(), model);
    const blocks = selectedWatchTranscriptBlocks(model, overviewState);
    assert.equal(blocks[0]?.label, 'Session');
    assert.match(blocks[0]?.body ?? '', /Workers: 1 running \/ 2 total/);
    assert.match(blocks[0]?.body ?? '', /Open:/);
    assert.equal(blocks[1]?.label, 'Worker 1');
    assert.match(blocks[1]?.title ?? '', /running for/);
    assert.match(blocks[1]?.body ?? '', /Task: Build the watch TUI/);
    assert.match(blocks[1]?.body ?? '', /Latest: Removed the once-per-second timestamp churn/);

    const archiveState = clampWatchDashboardState({ ...createWatchDashboardState(), mode: 'archive' }, model);
    const archiveBlocks = selectedWatchTranscriptBlocks(model, archiveState);
    assert.equal(watchOrchestratorStatusLabel('stale'), '[stale]');
    assert.equal(archiveBlocks[0]?.status, 'stale');
    assert.equal(archiveBlocks[0]?.tone, 'status');
    assert.match(archiveBlocks[1]?.title ?? '', /done after/);
  });

  it('uses only the latest worker run for overview duration labels', () => {
    const envelope = sampleEnvelope();
    const child = envelope.snapshot.runs.find((item) => item.run.run_id === 'run-child')!;
    child.run.status = 'completed';
    child.run.finished_at = '2026-05-02T00:00:06.000Z';
    child.activity.last_event_at = '2026-05-02T00:00:06.000Z';
    child.activity.last_activity_at = '2026-05-02T00:00:06.000Z';
    child.response.status = 'completed';
    child.response.summary = 'Child run complete.';

    const model = buildWatchViewModel(envelope);
    const overviewState = clampWatchDashboardState(createWatchDashboardState(), model);
    const blocks = selectedWatchTranscriptBlocks(model, overviewState);

    assert.match(blocks[1]?.title ?? '', /done after 2s/);
    assert.doesNotMatch(blocks[1]?.title ?? '', /done after 6s/);
  });

  it('uses real terminal Markdown rendering for common Markdown blocks', () => {
    const rendered = stripAnsi(renderMarkdownToAnsi([
      '# Heading',
      '',
      '- one',
      '- `two`',
      '',
      '```ts',
      'const value = 1;',
      '```',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n'), 100).join('\n'));

    assert.match(rendered, /Heading/);
    assert.match(rendered, /one/);
    assert.match(rendered, /two/);
    assert.match(rendered, /const value = 1/);
    assert.match(rendered, /A/);
    assert.match(rendered, /B/);
    assert.doesNotMatch(rendered, /```/);
  });

  it('normalizes Claude and Codex tool events without raw payload dumps', () => {
    const run = sampleEnvelope().snapshot.runs[0]!;
    const codex = normalizeWatchEvent(run, {
      seq: 10,
      ts: '2026-05-02T00:00:04.000Z',
      type: 'tool_use',
      payload: { type: 'command_execution', command: 'pnpm build', duration_ms: 1250 },
    });
    const claude = normalizeWatchEvent(run, {
      seq: 11,
      ts: '2026-05-02T00:00:05.000Z',
      type: 'tool_result',
      payload: { name: 'Bash', status: 'success', text: '3 tests passed' },
    });
    const unknownLifecycle = normalizeWatchEvent(run, {
      seq: 12,
      ts: '2026-05-02T00:00:06.000Z',
      type: 'lifecycle',
      payload: { index: 42 },
    });
    const resultEvent = normalizeWatchEvent(run, {
      seq: 13,
      ts: '2026-05-02T00:00:07.000Z',
      type: 'lifecycle',
      payload: {
        state: 'result_event',
        raw: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 3191,
          num_turns: 1,
          result: 'c5\nSicilian Defense.',
          stop_reason: 'end_turn',
          session_id: 'session-with-a-very-long-id',
        },
      },
    });

    assert.match(codex?.title ?? '', /command_execution/);
    assert.equal(codex?.body, 'pnpm build');
    assert.match(claude?.title ?? '', /Bash result \[success\]/);
    assert.equal(claude?.body, '3 tests passed');
    assert.equal(unknownLifecycle?.title, 'Event');
    assert.match(unknownLifecycle?.body ?? '', /"index":42/);
    assert.equal(resultEvent?.title, 'Result event');
    assert.match(resultEvent?.body ?? '', /status success/);
    assert.match(resultEvent?.body ?? '', /duration 3\.2s/);
    assert.doesNotMatch(resultEvent?.body ?? '', /Sicilian|session-with|\.{3}/);
  });

  it('filters empty lifecycle noise and does not duplicate status headings', () => {
    const model = buildWatchViewModel(sampleEnvelope());
    let state = clampWatchDashboardState(createWatchDashboardState(), model);
    state = selectWatchSidebarItem(state, model, 1);

    const plain = stripAnsi(selectedWatchTranscriptLines(model, state, 100).join('\n'));
    assert.doesNotMatch(plain, /\(empty\)/);
    assert.doesNotMatch(plain, /started/);
    assert.doesNotMatch(plain, /Worker activity: reasoning reasoning/);
    assert.match(plain, /Worker activity Reasoning/);
    assert.match(plain, /input_tokens/);
  });

  it('labels duplicate worker summary as the final response once', () => {
    const envelope = sampleEnvelope();
    const parent = envelope.snapshot.runs[0]!;
    parent.activity.recent_events = [
      { seq: 1, ts: '2026-05-02T00:00:01.000Z', type: 'assistant_message', payload: { text: 'Initial TUI complete.' } },
    ];
    parent.response.summary = 'Initial TUI complete.';

    const model = buildWatchViewModel(envelope);
    let state = clampWatchDashboardState(createWatchDashboardState(), model);
    state = selectWatchSidebarItem(state, model, 1);

    const blocks = selectedWatchTranscriptBlocks(model, state);
    assert.equal(blocks.filter((block) => block.label === 'Final response' && block.body === 'Initial TUI complete.').length, 1);
    assert.equal(blocks.filter((block) => block.label === 'Worker message' && block.body === 'Initial TUI complete.').length, 0);
  });

  it('preserves final response markdown lines without compacting chess ellipses', () => {
    const envelope = sampleEnvelope();
    const parent = envelope.snapshot.runs[0]!;
    parent.activity.recent_events = [];
    parent.response.summary = 'Qb8\nSidestepping the Nc6 fork threat, queen safe on b8, planning ...Qb7 if knight invades.';

    const model = buildWatchViewModel(envelope);
    let state = clampWatchDashboardState(createWatchDashboardState(), model);
    state = selectWatchSidebarItem(state, model, 1);

    const plain = stripAnsi(selectedWatchTranscriptLines(model, state, 100).join('\n'));
    assert.match(plain, /^  Qb8$/m);
    assert.match(plain, /^  Sidestepping the Nc6 fork threat, queen safe on b8, planning \.\.\.Qb7 if knight invades\.$/m);
  });

  it('preserves scroll state on refresh while auto-follow can be restored', () => {
    const model = buildWatchViewModel(sampleEnvelope());
    let state = clampWatchDashboardState(createWatchDashboardState(), model);
    state = selectWatchSidebarItem(state, model, 1);

    const scrolled = scrollWatchTranscript(state, model, 90, 2, 5);
    assert.equal(scrolled.follow, false);
    assert.ok(scrolled.scrollOffset > 0);

    const refreshed = buildWatchViewModel({
      ...sampleEnvelope(),
      snapshot: {
        ...sampleEnvelope().snapshot,
        generated_at: '2026-05-02T00:00:59.000Z',
      },
    });
    const clamped = clampWatchDashboardState(scrolled, refreshed);
    assert.equal(clamped.follow, false);
    assert.equal(clamped.scrollOffset, scrolled.scrollOffset);
  });

  it('supports top/latest keys and mouse wheel transcript scrolling', () => {
    const model = buildWatchViewModel(sampleEnvelope());
    let state = clampWatchDashboardState(createWatchDashboardState(), model);
    state = selectWatchSidebarItem(state, model, 1);

    const wheelUp = applyWatchInput(state, model, '\x1b[<64;1;1M', {}, 90, 3).state;
    assert.equal(wheelUp.follow, false);
    assert.ok(wheelUp.scrollOffset > 0);
    const arrowUp = applyWatchInput(state, model, '', { upArrow: true }, 90, 3).state;
    assert.notEqual(arrowUp.selectedId, state.selectedId);
    assert.equal(arrowUp.follow, true);
    const rawArrowUp = applyWatchRawInput(state, model, '\x1b[A', 90, 3).state;
    assert.equal(rawArrowUp.selectedId, arrowUp.selectedId);
    const rawApplicationArrowUp = applyWatchRawInput(state, model, '\x1bOA', 90, 3).state;
    assert.equal(rawApplicationArrowUp.selectedId, arrowUp.selectedId);
    const rawArrowDown = applyWatchRawInput(rawArrowUp, model, '\x1b[B', 90, 3).state;
    assert.equal(rawArrowDown.selectedId, state.selectedId);
    assert.equal(rawArrowDown.follow, true);
    assert.equal(applyWatchInput(state, model, 'm', {}, 90, 3).toggleMouseCapture, true);
    assert.equal(applyWatchRawInput(state, model, 'm', 90, 3).toggleMouseCapture, true);
    assert.equal(applyWatchRawInput(state, model, 'q', 90, 3).quit, true);
    assert.equal(applyWatchRawInput(state, model, '\u0003', 90, 3).quit, true);
    assert.equal(watchMouseScrollDelta('\x1b[<64;1;1M', 9), 1);
    assert.equal(watchMouseScrollDelta('\x1b[<65;1;1M', 9), -1);
    assert.equal(watchMouseScrollDelta('\x1b[<64;1;1M\x1b[<64;1;1M', 9), 2);
    assert.equal(watchMouseScrollDelta(`\x1b[M${String.fromCharCode(96)}!!`, 9), 1);
    assert.deepEqual(watchMouseClickPosition('\x1b[<0;3;4M'), { x: 3, y: 4 });
    assert.equal(watchMouseClickPosition('\x1b[<64;3;4M'), null);
    assert.equal(selectWatchSidebarItemAt(state, model, 0).selectedId, 'orchestrator:orch-live');
    assert.equal(selectWatchSidebarItemAt(state, model, 1).selectedId, state.selectedId);

    const top = applyWatchInput(state, model, 'g', {}, 90, 3).state;
    assert.equal(top.follow, false);
    assert.ok(top.scrollOffset >= wheelUp.scrollOffset);

    const latest = applyWatchInput(top, model, 'G', {}, 90, 3).state;
    assert.equal(latest.follow, true);
    assert.equal(latest.scrollOffset, 0);

    const enter = applyWatchInput(top, model, '', { return: true }, 90, 3).state;
    assert.equal(enter.follow, true);
    assert.equal(enter.scrollOffset, 0);
  });

  it('renders the Ink watch app shell with the conversation sidebar', () => {
    const output = stripAnsi(renderToString(React.createElement(WatchApp, {
      initialEnvelope: sampleEnvelope(),
      readSnapshot: async () => sampleEnvelope(),
      intervalMs: 1000,
    })));

    assert.match(output, /agent-orchestrator watch/);
    assert.match(output, /Live orchestrators/);
    assert.match(output, /Worker 1/);
    assert.match(output, /Build the watch TUI/);
    assert.match(output, /Overview/);
  });
});

function sampleEnvelope(): SnapshotEnvelope {
  const now = '2026-05-02T00:00:00.000Z';
  const snapshot = ObservabilitySnapshotSchema.parse({
    generated_at: now,
    daemon_pid: 42,
    store_root: '/tmp/agent-store',
    backend_status: null,
    sessions: [],
    orchestrators: [
      {
        orchestrator_id: 'orch-live',
        live: true,
        client: 'claude',
        label: 'Watch polish',
        cwd: '/tmp/repo',
        display: { tmux_pane: '%1', tmux_window_id: '@1', base_title: 'Watch polish', host: 'host' },
        status: {
          state: 'in_progress',
          supervisor_turn_active: true,
          waiting_for_user: false,
          running_child_count: 1,
          failed_unacked_count: 0,
        },
        registered_at: now,
        last_supervisor_event_at: '2026-05-02T00:00:04.000Z',
        created_at: now,
        updated_at: '2026-05-02T00:00:04.000Z',
        worker_count: 2,
        running_count: 1,
        workers: [
          worker('run-parent', null, 'completed', 'Build TUI', 'Build the **watch** TUI.'),
          worker('run-child', 'run-parent', 'running', 'Fix refresh', 'Fix the failing watch refresh.'),
        ],
      },
      {
        orchestrator_id: 'orch-stale',
        live: true,
        client: 'claude',
        label: 'Stale session',
        cwd: '/tmp/repo',
        display: null,
        status: {
          state: 'stale',
          supervisor_turn_active: false,
          waiting_for_user: false,
          running_child_count: 0,
          failed_unacked_count: 0,
        },
        registered_at: now,
        last_supervisor_event_at: now,
        created_at: now,
        updated_at: now,
        worker_count: 1,
        running_count: 0,
        workers: [
          worker('run-archive', null, 'completed', 'Archived', 'Past worker.'),
        ],
      },
    ],
    runs: [
      run('run-parent', null, 'completed', 'Build TUI', 'Build the **watch** TUI.\n\n- grouped sessions\n- Markdown', 'orch-live', [
        { seq: 1, ts: '2026-05-02T00:00:01.000Z', type: 'assistant_message', payload: { text: 'Implemented the **sidebar**.' } },
        { seq: 2, ts: '2026-05-02T00:00:02.000Z', type: 'tool_use', payload: { name: 'Bash', input: { command: 'pnpm test' } } },
        { seq: 3, ts: '2026-05-02T00:00:03.000Z', type: 'tool_result', payload: { name: 'Bash', status: 'success', text: '3 tests passed' } },
        { seq: 4, ts: '2026-05-02T00:00:03.500Z', type: 'lifecycle', payload: { status: 'started' } },
        { seq: 5, ts: '2026-05-02T00:00:03.750Z', type: 'lifecycle', payload: { status: 'reasoning', usage: { input_tokens: 10, output_tokens: 2 } } },
      ], 'Initial TUI complete.'),
      run('run-child', 'run-parent', 'running', 'Fix refresh', 'Fix the failing watch refresh.\n\n```ts\nrender();\n```', 'orch-live', [
        { seq: 1, ts: '2026-05-02T00:00:04.000Z', type: 'assistant_message', payload: { text: 'Removed the once-per-second timestamp churn.' } },
      ], null),
      run('run-archive', null, 'completed', 'Archived', 'Past worker.', 'orch-stale', [], 'Done.'),
    ],
  });

  return { running: true, snapshot };
}

function worker(runId: string, parentRunId: string | null, status: string, title: string, preview: string) {
  return {
    run_id: runId,
    parent_run_id: parentRunId,
    backend: 'codex',
    status,
    title,
    summary: null,
    preview,
    model: { name: 'gpt-5.2', source: 'explicit' },
    settings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null },
    created_at: '2026-05-02T00:00:00.000Z',
    last_activity_at: '2026-05-02T00:00:04.000Z',
  };
}

function run(runId: string, parentRunId: string | null, status: string, title: string, prompt: string, orchestratorId: string, recentEvents: unknown[], responseSummary: string | null) {
  return {
    run: {
      run_id: runId,
      backend: 'codex',
      status,
      parent_run_id: parentRunId,
      session_id: 'session-1',
      model: 'gpt-5.2',
      model_source: 'explicit',
      requested_session_id: parentRunId ? 'session-1' : null,
      observed_session_id: 'session-1',
      observed_model: null,
      display: {
        session_title: 'Watch polish',
        session_summary: 'Polish the watch TUI',
        prompt_title: title,
        prompt_summary: null,
      },
      cwd: '/tmp/repo',
      created_at: parentRunId ? '2026-05-02T00:00:04.000Z' : '2026-05-02T00:00:00.000Z',
      started_at: parentRunId ? '2026-05-02T00:00:04.000Z' : '2026-05-02T00:00:00.000Z',
      finished_at: status === 'running' ? null : '2026-05-02T00:00:05.000Z',
      last_activity_at: '2026-05-02T00:00:04.000Z',
      last_activity_source: 'backend_event',
      worker_pid: 123,
      worker_pgid: 123,
      daemon_pid_at_spawn: 42,
      worker_invocation: { command: '/usr/local/bin/codex', args: ['exec', '--model', 'gpt-5.2', '-'] },
      git_snapshot_status: 'captured',
      git_snapshot: null,
      git_snapshot_at_start: null,
      model_settings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null },
      idle_timeout_seconds: 1200,
      execution_timeout_seconds: null,
      timeout_reason: null,
      terminal_reason: null,
      terminal_context: null,
      latest_error: null,
      metadata: { orchestrator_id: orchestratorId },
    },
    prompt: {
      title,
      summary: null,
      preview: prompt.replace(/\s+/g, ' ').trim(),
      text: prompt,
      path: `/tmp/agent-store/runs/${runId}/prompt.txt`,
      bytes: prompt.length,
    },
    response: {
      status: responseSummary ? 'completed' : null,
      summary: responseSummary,
      path: responseSummary ? `/tmp/agent-store/runs/${runId}/result.json` : null,
      bytes: responseSummary?.length ?? null,
    },
    model: { name: 'gpt-5.2', source: 'explicit' },
    settings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null },
    session: {
      requested_session_id: parentRunId ? 'session-1' : null,
      observed_session_id: 'session-1',
      effective_session_id: 'session-1',
      status: parentRunId ? 'resumed' : 'new_session',
      warnings: [],
    },
    activity: {
      last_event_sequence: recentEvents.length,
      last_event_at: recentEvents.length > 0 ? '2026-05-02T00:00:04.000Z' : null,
      last_event_type: recentEvents.length > 0 ? 'assistant_message' : null,
      last_activity_at: '2026-05-02T00:00:04.000Z',
      last_activity_source: 'backend_event',
      idle_seconds: status === 'running' ? 1 : null,
      last_interaction_preview: null,
      event_count: recentEvents.length,
      recent_errors: [],
      recent_events: recentEvents,
      latest_error: null,
    },
    artifacts: [],
    duration_seconds: 4,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}
