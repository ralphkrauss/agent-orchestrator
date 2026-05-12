import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilitySnapshotSchema } from '../contract.js';
import { formatSnapshot, type SnapshotEnvelope } from '../daemon/observabilityFormat.js';

describe('observability non-TTY formatting', () => {
  it('preserves generated time and live/archive orchestrator summaries', () => {
    const formatted = formatSnapshot(sampleEnvelope());

    assert.match(formatted, /agent-orchestrator daemon: running pid=42/);
    assert.match(formatted, /generated: 2026-05-02T00:00:00.000Z/);
    assert.match(formatted, /live_orchestrators: 1 archived_orchestrators: 1 sessions: 0 runs: 0/);
    assert.match(formatted, /Live orchestrators/);
    assert.match(formatted, /Watch polish \[in_progress\]/);
    assert.match(formatted, /Archived orchestrators/);
    assert.match(formatted, /Stale session \[stale\]/);
  });

  it('prints daemon read errors without requiring an interactive TUI', () => {
    const formatted = formatSnapshot({ ...sampleEnvelope(), running: false, error: 'daemon unavailable' });

    assert.match(formatted, /agent-orchestrator daemon: stopped/);
    assert.match(formatted, /error: daemon unavailable/);
  });
});

function sampleEnvelope(): SnapshotEnvelope {
  const now = '2026-05-02T00:00:00.000Z';
  return {
    running: true,
    snapshot: ObservabilitySnapshotSchema.parse({
      generated_at: now,
      daemon_pid: 42,
      store_root: '/tmp/agent-store',
      backend_status: null,
      sessions: [],
      runs: [],
      orchestrators: [
        orchestrator('orch-live', 'Watch polish', 'in_progress', true),
        orchestrator('orch-stale', 'Stale session', 'stale', true),
      ],
    }),
  };
}

function orchestrator(orchestratorId: string, label: string, state: 'in_progress' | 'stale', live: boolean) {
  const now = '2026-05-02T00:00:00.000Z';
  return {
    orchestrator_id: orchestratorId,
    live,
    client: 'claude',
    label,
    cwd: '/tmp/repo',
    display: null,
    status: {
      state,
      supervisor_turn_active: state === 'in_progress',
      waiting_for_user: false,
      running_child_count: state === 'in_progress' ? 1 : 0,
      failed_unacked_count: 0,
    },
    registered_at: now,
    last_supervisor_event_at: now,
    created_at: now,
    updated_at: now,
    worker_count: state === 'in_progress' ? 1 : 0,
    running_count: state === 'in_progress' ? 1 : 0,
    workers: [],
  };
}
