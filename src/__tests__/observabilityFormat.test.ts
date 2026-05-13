import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilitySnapshotSchema } from '../contract.js';
import {
  clampDashboardState,
  formatSnapshot,
  renderDashboard,
  type SnapshotEnvelope,
} from '../daemon/observabilityFormat.js';

describe('observability CLI formatting', () => {
  it('renders session, model, run, and raw prompt metadata', () => {
    const envelope = sampleEnvelope();

    const formatted = formatSnapshot(envelope);
    assert.match(formatted, /Terminal dashboard \[running\]/);
    assert.match(formatted, /model=gpt-5\.2 \(explicit\)/);
    assert.match(formatted, /effort=xhigh tier=fast/);
    assert.match(formatted, /prompts=1 workspace=repo:main/);
    assert.match(formatted, /session=session-1/);

    const detail = renderDashboard(envelope, { view: 'detail', selectedSession: 0, selectedPrompt: 0 }, 120, 40);
    assert.match(detail, /\x1b\[[0-9;]*m/);
    const plain = stripAnsi(detail);
    assert.match(plain, /View: Detail > Terminal dashboard > Open dashboard \| Prompt 1\/1/);
    assert.match(plain, /Keys: Up\/Down switches prompt in Terminal dashboard/);
    assert.match(plain, /Title: Open dashboard/);
    assert.match(plain, /Model: gpt-5\.2 \(explicit\)/);
    assert.match(plain, /Reasoning: xhigh/);
    assert.match(plain, /Service Tier: fast/);
    assert.match(plain, /Invocation: \/usr\/local\/bin\/codex exec --model gpt-5\.2 -/);
    assert.match(plain, /Git: repo:main clean/);
    assert.match(plain, /Activity: last=2026-05-02 00:00:01 source=backend_event idle=\d+s/);
    assert.match(plain, /Timeouts: idle=1200s hard=none timeout_reason=none terminal_reason=none/);
    assert.match(plain, /Latest Error: 429 rate limit exceeded \(category=rate_limit source=backend_event fatal=true retryable=true\)/);
    assert.match(plain, /User Prompt/);
    assert.match(plain, /Raw prompt body with details/);
    assert.match(plain, /Final Response \[completed\]/);
    assert.match(plain, /Final response body with outcome/);
    assert.match(plain, /#1 2026-05-02 00:00:01 assistant_message/);
  });

  it('keeps dashboard list screens to one row per item', () => {
    const envelope = sampleEnvelope();

    const sessions = stripAnsi(renderDashboard(envelope, { view: 'sessions', selectedSession: 0, selectedPrompt: 0 }, 160, 40));
    assert.match(sessions, /View: Sessions 1\/1/);
    assert.match(sessions, /Keys: Up\/Down choose chat, Enter opens prompts/);
    assert.match(sessions, /AGENT\s+STATUS\s+PROMPTS\s+MODEL\s+EFFORT\s+TIER\s+WORKSPACE\s+CHAT/);
    assert.match(sessions, /> codex\s+running\s+1\s+gpt-5\.2\s+xhigh\s+fast\s+repo:main\s+Terminal dashboard/);
    assert.doesNotMatch(sessions, /^  Inspect live worker prompts$/m);
    assert.doesNotMatch(sessions, /^  session=session-1$/m);

    const prompts = stripAnsi(renderDashboard(envelope, { view: 'prompts', selectedSession: 0, selectedPrompt: 0 }, 120, 40));
    assert.match(prompts, /View: Sessions > Terminal dashboard \| Prompt 1\/1/);
    assert.match(prompts, /Keys: Up\/Down choose prompt, Enter opens detail/);
    assert.match(prompts, /STATUS\s+MODEL\s+EFFORT\s+TIER\s+LAST\s+PROMPT/);
    assert.match(prompts, /> running\s+gpt-5\.2\s+xhigh\s+fast\s+2026-05-02 00:00:01 Open dashboard/);
    assert.doesNotMatch(prompts, /^  Show the prompt detail view$/m);
    assert.doesNotMatch(prompts, /^  Raw prompt body with details$/m);
  });

  it('shows latest prompt model and compacts worktree workspace labels', () => {
    const envelope = sampleEnvelope();
    const session = envelope.snapshot.sessions[0]!;
    session.run_count = 2;
    session.models = [
      { name: 'gpt-5.2', source: 'explicit', requested_name: 'gpt-5.2', observed_name: null },
      { name: 'gpt-5.5', source: 'explicit', requested_name: 'gpt-5.5', observed_name: null },
    ];
    session.settings = [
      { reasoning_effort: 'low', service_tier: 'normal', mode: null, codex_network: null, worker_posture: null },
      { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null, worker_posture: null },
    ];
    session.workspace = {
      cwd: '/tmp/worktrees-agent-orchestrator/4-add-observability',
      repository_root: '/tmp/worktrees-agent-orchestrator/4-add-observability',
      repository_name: 'agent-orchestrator',
      branch: '4-add-observability',
      dirty_count: 3,
      label: 'agent-orchestrator:4-add-observability*',
    };
    session.prompts.push({
      run_id: 'run-2',
      status: 'completed',
      title: 'Second prompt',
      summary: null,
      preview: 'Second raw prompt',
      model: { name: 'gpt-5.5', source: 'explicit', requested_name: 'gpt-5.5', observed_name: null },
      settings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null, worker_posture: null },
      created_at: '2026-05-02T00:00:02.000Z',
      last_activity_at: '2026-05-02T00:00:03.000Z',
    });

    const sessions = stripAnsi(renderDashboard(envelope, { view: 'sessions', selectedSession: 0, selectedPrompt: 0 }, 160, 40));
    assert.match(sessions, /> codex\s+running\s+2\s+gpt-5\.5\s+xhigh\s+fast\s+a-orchestrator:4-add-observabi\.\*\s+Terminal dashboard/);
    assert.doesNotMatch(sessions, /gpt-5\.2 \+1/);

    const prompts = stripAnsi(renderDashboard(envelope, { view: 'prompts', selectedSession: 0, selectedPrompt: 0 }, 160, 40));
    assert.match(prompts, /prompts=2/);
    assert.doesNotMatch(prompts, /shown=/);
  });

  it('renders limited prompt lists and observed model mismatches clearly', () => {
    const envelope = sampleEnvelope();
    const session = envelope.snapshot.sessions[0]!;
    const run = envelope.snapshot.runs[0]!;
    session.run_count = 3;
    session.warnings = ['requested model gpt-5.2 but backend reported gpt-5.5'];
    session.models = [{ name: 'gpt-5.5', source: 'explicit', requested_name: 'gpt-5.2', observed_name: 'gpt-5.5' }];
    session.prompts[0]!.model = { name: 'gpt-5.5', source: 'explicit', requested_name: 'gpt-5.2', observed_name: 'gpt-5.5' };
    run.model = { name: 'gpt-5.5', source: 'explicit', requested_name: 'gpt-5.2', observed_name: 'gpt-5.5' };

    const prompts = stripAnsi(renderDashboard(envelope, { view: 'prompts', selectedSession: 0, selectedPrompt: 0 }, 160, 40));
    assert.match(prompts, /prompts=3 shown=1/);
    assert.match(prompts, /Warning: requested model gpt-5\.2 but backend reported gpt-5\.5/);

    const detail = stripAnsi(renderDashboard(envelope, { view: 'detail', selectedSession: 0, selectedPrompt: 0 }, 160, 40));
    assert.match(detail, /Model: gpt-5\.5 \(explicit, requested gpt-5\.2\)/);
  });

  it('clamps stale dashboard selections', () => {
    const envelope = sampleEnvelope();
    assert.deepStrictEqual(
      clampDashboardState({ view: 'detail', selectedSession: 99, selectedPrompt: 99 }, envelope.snapshot),
      { view: 'detail', selectedSession: 0, selectedPrompt: 0 },
    );
    assert.deepStrictEqual(
      clampDashboardState({ view: 'prompts', selectedSession: 0, selectedPrompt: 0 }, {
        ...envelope.snapshot,
        sessions: [],
      }),
      { view: 'sessions', selectedSession: 0, selectedPrompt: 0 },
    );
  });
});

function sampleEnvelope(): SnapshotEnvelope {
  const now = '2026-05-02T00:00:00.000Z';
  const snapshot = ObservabilitySnapshotSchema.parse({
    generated_at: now,
    daemon_pid: 42,
    store_root: '/tmp/agent-store',
    backend_status: null,
    sessions: [{
      session_key: 'codex:session-1',
      session_id: 'session-1',
      root_run_id: 'run-1',
      backend: 'codex',
      cwd: '/tmp/repo',
      workspace: {
        cwd: '/tmp/repo',
        repository_root: '/tmp/repo',
        repository_name: 'repo',
        branch: 'main',
        dirty_count: 0,
        label: 'repo:main',
      },
      title: 'Terminal dashboard',
      summary: 'Inspect live worker prompts',
      status: 'running',
      created_at: now,
      updated_at: '2026-05-02T00:00:01.000Z',
      run_count: 1,
      running_count: 1,
      models: [{ name: 'gpt-5.2', source: 'explicit' }],
      settings: [{ reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null, worker_posture: null }],
      warnings: [],
      prompts: [{
        run_id: 'run-1',
        status: 'running',
        title: 'Open dashboard',
        summary: 'Show the prompt detail view',
        preview: 'Raw prompt body with details',
        model: { name: 'gpt-5.2', source: 'explicit' },
        settings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null, worker_posture: null },
        created_at: now,
        last_activity_at: '2026-05-02T00:00:01.000Z',
      }],
    }],
    runs: [{
      run: {
        run_id: 'run-1',
        backend: 'codex',
        status: 'running',
        parent_run_id: null,
        session_id: 'session-1',
        model: 'gpt-5.2',
        model_source: 'explicit',
        requested_session_id: null,
        observed_session_id: 'session-1',
        display: {
          session_title: 'Terminal dashboard',
          session_summary: 'Inspect live worker prompts',
          prompt_title: 'Open dashboard',
          prompt_summary: 'Show the prompt detail view',
        },
        cwd: '/tmp/repo',
        created_at: now,
        started_at: now,
        finished_at: null,
        last_activity_at: '2026-05-02T00:00:01.000Z',
        last_activity_source: 'backend_event',
        worker_pid: 123,
        worker_pgid: 123,
        daemon_pid_at_spawn: 42,
        worker_invocation: {
          command: '/usr/local/bin/codex',
          args: ['exec', '--model', 'gpt-5.2', '-'],
        },
        git_snapshot_status: 'captured',
        git_snapshot: {
          sha: '0123456789abcdef0123456789abcdef01234567',
          root: '/tmp/repo',
          branch: 'main',
          dirty_count: 0,
          dirty: [],
          dirty_fingerprints: {},
        },
        model_settings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null, worker_posture: null },
        idle_timeout_seconds: 1200,
        execution_timeout_seconds: null,
        timeout_reason: null,
        terminal_reason: null,
        terminal_context: null,
        latest_error: {
          message: '429 rate limit exceeded',
          category: 'rate_limit',
          source: 'backend_event',
          backend: 'codex',
          retryable: true,
          fatal: true,
        },
        metadata: {},
      },
      prompt: {
        title: 'Open dashboard',
        summary: 'Show the prompt detail view',
        preview: 'Raw prompt body with details',
        text: 'Raw prompt body with details and enough context to inspect.',
        path: '/tmp/agent-store/runs/run-1/prompt.txt',
        bytes: 56,
      },
      response: {
        status: 'completed',
        summary: 'Final response body with outcome.',
        path: '/tmp/agent-store/runs/run-1/result.json',
        bytes: 128,
      },
      model: { name: 'gpt-5.2', source: 'explicit' },
      settings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null, codex_network: null, worker_posture: null },
      session: {
        requested_session_id: null,
        observed_session_id: 'session-1',
        effective_session_id: 'session-1',
        status: 'new_session',
        warnings: [],
      },
      activity: {
        last_event_sequence: 1,
        last_event_at: '2026-05-02T00:00:01.000Z',
        last_event_type: 'assistant_message',
        last_activity_at: '2026-05-02T00:00:01.000Z',
        last_activity_source: 'backend_event',
        idle_seconds: 1,
        last_interaction_preview: 'Working on it.',
        event_count: 1,
        recent_errors: [],
        recent_events: [{
          seq: 1,
          ts: '2026-05-02T00:00:01.000Z',
          type: 'assistant_message',
          payload: { text: 'Working on it.' },
        }],
        latest_error: {
          message: '429 rate limit exceeded',
          category: 'rate_limit',
          source: 'backend_event',
          backend: 'codex',
          retryable: true,
          fatal: true,
        },
      },
      artifacts: [{
        name: 'prompt.txt',
        path: '/tmp/agent-store/runs/run-1/prompt.txt',
        exists: true,
        bytes: 56,
      }],
      duration_seconds: 1,
    }],
  });

  return { running: true, snapshot };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}
