import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_AFTER_SECONDS,
  computeOrchestratorStatusSnapshot,
} from '../daemon/orchestratorStatus.js';
import type { OrchestratorState } from '../daemon/orchestratorRegistry.js';
import type { OwnedRunSnapshot } from '../daemon/orchestratorStatus.js';

const LIVE_NOW_MS = Date.parse('2026-05-06T12:05:00.000Z');

function makeState(overrides: Partial<OrchestratorState['record']> = {}, flags: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    record: {
      id: '01TESTORCH00000000000000ZZ',
      client: 'claude',
      label: 'demo',
      cwd: '/tmp/repo',
      display: { tmux_pane: null, tmux_window_id: null, base_title: 'demo', host: 'host' },
      registered_at: '2026-05-06T12:00:00.000Z',
      last_supervisor_event_at: '2026-05-06T12:00:00.000Z',
      ...overrides,
    },
    waiting_for_user: false,
    supervisor_turn_active: false,
    session_ended: false,
    ...flags,
  };
}

function computeStatus(state: OrchestratorState, ownedRuns: OwnedRunSnapshot) {
  return computeOrchestratorStatusSnapshot(state, ownedRuns, LIVE_NOW_MS);
}

describe('computeOrchestratorStatusSnapshot — 5-rule live-state precedence', () => {
  it('rule 1: attention dominates everything else', () => {
    const state = makeState({}, { supervisor_turn_active: true, waiting_for_user: true });
    const status = computeStatus(state, { running: 3, failed_unacked: 1 });
    assert.equal(status.state, 'attention');
  });

  it('rule 2 (AC8): in_progress because running children dominates a sticky waiting_for_user flag', () => {
    const state = makeState({}, { waiting_for_user: true, supervisor_turn_active: false });
    const status = computeStatus(state, { running: 2, failed_unacked: 0 });
    assert.equal(status.state, 'in_progress');
    assert.equal(status.running_child_count, 2);
    assert.equal(status.waiting_for_user, true, 'sticky flag stays set on the snapshot');
  });

  it('AC8 symmetric: with supervisor_turn_active=false but running children, aggregate is still in_progress', () => {
    const state = makeState({}, { supervisor_turn_active: false, waiting_for_user: false });
    const status = computeStatus(state, { running: 1, failed_unacked: 0 });
    assert.equal(status.state, 'in_progress');
  });

  it('AC8 transition: when running children clear and waiting_for_user is sticky, aggregate transitions to waiting_for_user', () => {
    const state = makeState({}, { waiting_for_user: true });
    const before = computeStatus(state, { running: 1, failed_unacked: 0 });
    assert.equal(before.state, 'in_progress');
    const after = computeStatus(state, { running: 0, failed_unacked: 0 });
    assert.equal(after.state, 'waiting_for_user');
  });

  it('rule 3: waiting_for_user when no children and rules 1/2 do not match', () => {
    const state = makeState({}, { waiting_for_user: true });
    const status = computeStatus(state, { running: 0, failed_unacked: 0 });
    assert.equal(status.state, 'waiting_for_user');
  });

  it('rule 4: in_progress because supervisor mid-turn when no children and no waiting flag', () => {
    const state = makeState({}, { supervisor_turn_active: true });
    const status = computeStatus(state, { running: 0, failed_unacked: 0 });
    assert.equal(status.state, 'in_progress');
  });

  it('rule 5: idle when nothing else applies', () => {
    const state = makeState();
    const status = computeStatus(state, { running: 0, failed_unacked: 0 });
    assert.equal(status.state, 'idle');
  });

  it('stale overrides on session_ended', () => {
    const state = makeState({}, { session_ended: true, supervisor_turn_active: true });
    const status = computeStatus(state, { running: 0, failed_unacked: 0 });
    assert.equal(status.state, 'stale');
  });

  it('stale overrides when last_supervisor_event_at is older than STALE_AFTER_SECONDS and no owned runs remain', () => {
    const lastEvent = new Date(LIVE_NOW_MS - (STALE_AFTER_SECONDS + 60) * 1000).toISOString();
    const state = makeState({ last_supervisor_event_at: lastEvent });
    const status = computeStatus(state, { running: 0, failed_unacked: 0 });
    assert.equal(status.state, 'stale');
  });

  it('stale does NOT override while children are still running (Decision 4 intersection)', () => {
    const lastEvent = new Date(LIVE_NOW_MS - (STALE_AFTER_SECONDS + 60) * 1000).toISOString();
    const state = makeState({ last_supervisor_event_at: lastEvent });
    const status = computeStatus(state, { running: 1, failed_unacked: 0 });
    assert.equal(status.state, 'in_progress');
  });
});

describe('OrchestratorStatusEngine — stale timer (F4 + iteration #2 hardening)', () => {
  // Hand-rolled timer driver so we can advance time synchronously without
  // sleeping for STALE_AFTER_SECONDS. Each entry keeps its `delayMs` AND
  // captures the wall-clock at scheduling time so the test can compute the
  // absolute deadline the engine intended.
  type Pending = { fire: () => void; delayMs: number; scheduledAtMs: number };
  function buildTimerSeam(): {
    pending: Pending[];
    schedule: (cb: () => void, delayMs: number) => NodeJS.Timeout;
    cancel: (handle: NodeJS.Timeout) => void;
    fireFirstWithDelay: (delayMs: number) => Promise<boolean>;
    findStaleTimer: (predicate?: (p: Pending) => boolean) => Pending | undefined;
  } {
    const pending: Pending[] = [];
    const schedule = (cb: () => void, delayMs: number) => {
      const entry: Pending = { fire: cb, delayMs, scheduledAtMs: Date.now() };
      pending.push(entry);
      return entry as unknown as NodeJS.Timeout;
    };
    const cancel = (handle: NodeJS.Timeout) => {
      const idx = pending.findIndex((p) => (p as unknown) === handle);
      if (idx >= 0) pending.splice(idx, 1);
    };
    const fireFirstWithDelay = async (delayMs: number): Promise<boolean> => {
      const idx = pending.findIndex((p) => p.delayMs === delayMs);
      if (idx < 0) return false;
      const [entry] = pending.splice(idx, 1);
      entry!.fire();
      // Flush microtasks twice so awaited fetches inside runRecompute settle.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      return true;
    };
    const findStaleTimer = (predicate?: (p: Pending) => boolean) => {
      // Stale timers are anything other than the 250 ms debounce.
      const candidates = pending.filter((p) => p.delayMs !== HOOK_EMISSION_DEBOUNCE_MS);
      return predicate ? candidates.find(predicate) : candidates[0];
    };
    return { pending, schedule, cancel, fireFirstWithDelay, findStaleTimer };
  }

  const HOOK_EMISSION_DEBOUNCE_MS = 250;

  it('arms the stale timer at last_supervisor_event_at + STALE_AFTER_SECONDS, NOT now() + STALE_AFTER_SECONDS', async () => {
    const { OrchestratorStatusEngine } = await import('../daemon/orchestratorStatus.js');
    const seam = buildTimerSeam();

    // last_supervisor_event_at was 590s ago. The stale deadline must be
    // ~10s away, not ~600s.
    const lastEventMs = Date.now() - 590 * 1000;
    const state = makeState({ last_supervisor_event_at: new Date(lastEventMs).toISOString() });
    const orchestratorId = state.record.id;

    const engine = new OrchestratorStatusEngine({
      getOrchestratorState: (id) => id === orchestratorId ? state : undefined,
      getOwnedRunSnapshot: async () => ({ running: 0, failed_unacked: 0 }),
      emitHook: () => undefined,
      scheduleTimer: seam.schedule,
      cancelTimer: seam.cancel,
    });

    engine.scheduleRecompute(orchestratorId);
    assert.equal(await seam.fireFirstWithDelay(HOOK_EMISSION_DEBOUNCE_MS), true);

    const staleTimer = seam.findStaleTimer();
    assert.ok(staleTimer, 'stale timer must be armed');
    // 10s ± 100ms tolerance (the engine reads Date.now() during arming).
    assert.ok(
      staleTimer!.delayMs >= 9_500 && staleTimer!.delayMs <= 10_500,
      `stale timer delay must be ~10s (deadline = last_event + ${STALE_AFTER_SECONDS}s); got ${staleTimer!.delayMs}ms`,
    );
    assert.notEqual(staleTimer!.delayMs, STALE_AFTER_SECONDS * 1000, 'must NOT use the full STALE_AFTER_SECONDS from now()');

    engine.forget(orchestratorId);
  });

  it('non-supervisor recomputes do NOT postpone the stale deadline (deadline stays anchored to last_supervisor_event_at)', async () => {
    const { OrchestratorStatusEngine } = await import('../daemon/orchestratorStatus.js');
    const seam = buildTimerSeam();

    const lastEventMs = Date.now();
    const state = makeState({ last_supervisor_event_at: new Date(lastEventMs).toISOString() });
    const orchestratorId = state.record.id;

    const engine = new OrchestratorStatusEngine({
      getOrchestratorState: (id) => id === orchestratorId ? state : undefined,
      getOwnedRunSnapshot: async () => ({ running: 0, failed_unacked: 0 }),
      emitHook: () => undefined,
      scheduleTimer: seam.schedule,
      cancelTimer: seam.cancel,
    });

    // Initial recompute → stale timer at lastEventMs + STALE_AFTER_SECONDS.
    engine.scheduleRecompute(orchestratorId);
    assert.equal(await seam.fireFirstWithDelay(HOOK_EMISSION_DEBOUNCE_MS), true);
    const initialStale = seam.findStaleTimer();
    assert.ok(initialStale, 'initial stale timer must be armed');
    const expectedDeadlineMs = lastEventMs + STALE_AFTER_SECONDS * 1000;
    const initialDeadlineMs = initialStale!.scheduledAtMs + initialStale!.delayMs;
    assert.ok(
      Math.abs(initialDeadlineMs - expectedDeadlineMs) < 200,
      `initial deadline drift > 200ms: expected ~${expectedDeadlineMs}, got ${initialDeadlineMs}`,
    );

    // A non-supervisor recompute fires (e.g. owned worker run completed).
    // last_supervisor_event_at is unchanged. The deadline must still target
    // the same absolute moment, not a fresh STALE_AFTER_SECONDS-from-now.
    engine.scheduleRecompute(orchestratorId);
    assert.equal(await seam.fireFirstWithDelay(HOOK_EMISSION_DEBOUNCE_MS), true);
    const reArmed = seam.findStaleTimer();
    assert.ok(reArmed, 'stale timer must be re-armed');
    const reArmedDeadlineMs = reArmed!.scheduledAtMs + reArmed!.delayMs;
    assert.ok(
      Math.abs(reArmedDeadlineMs - expectedDeadlineMs) < 200,
      `non-supervisor recompute postponed deadline by ${reArmedDeadlineMs - expectedDeadlineMs}ms; must be < 200ms`,
    );

    engine.forget(orchestratorId);
  });

  it('after a stale recompute fires, no periodic stale timer is re-armed; only a new supervisor event re-arms', async () => {
    const { OrchestratorStatusEngine } = await import('../daemon/orchestratorStatus.js');
    const seam = buildTimerSeam();

    // last_supervisor_event_at is already past the stale threshold.
    const lastEventMs = Date.now() - (STALE_AFTER_SECONDS + 60) * 1000;
    const state = makeState({ last_supervisor_event_at: new Date(lastEventMs).toISOString() });
    const orchestratorId = state.record.id;

    const emissions: { state: string }[] = [];
    const engine = new OrchestratorStatusEngine({
      getOrchestratorState: (id) => id === orchestratorId ? state : undefined,
      getOwnedRunSnapshot: async () => ({ running: 0, failed_unacked: 0 }),
      emitHook: (p) => emissions.push({ state: p.status.state }),
      scheduleTimer: seam.schedule,
      cancelTimer: seam.cancel,
    });

    // First recompute: aggregate already resolves to `stale`, so the engine
    // skips arming a stale timer entirely.
    engine.scheduleRecompute(orchestratorId);
    assert.equal(await seam.fireFirstWithDelay(HOOK_EMISSION_DEBOUNCE_MS), true);
    assert.equal(emissions.at(-1)?.state, 'stale', 'aggregate must resolve to stale on first recompute');
    assert.equal(seam.findStaleTimer(), undefined, 'no stale timer should be armed once aggregate is stale');

    // A non-supervisor recompute (e.g. owned-run terminal) fires. last_supervisor_event_at
    // is unchanged → still stale → still no stale timer.
    engine.scheduleRecompute(orchestratorId);
    assert.equal(await seam.fireFirstWithDelay(HOOK_EMISSION_DEBOUNCE_MS), true);
    assert.equal(seam.findStaleTimer(), undefined, 'subsequent non-supervisor recompute must NOT re-arm a stale timer');
    // De-dup: still only one stale emission.
    assert.equal(emissions.filter((e) => e.state === 'stale').length, 1, 'only one stale emission expected from this run');

    // Now simulate a fresh supervisor event: registry would update
    // last_supervisor_event_at and trigger a recompute. The engine should
    // re-arm a fresh stale timer relative to the new timestamp.
    const refreshedMs = Date.now();
    state.record = { ...state.record, last_supervisor_event_at: new Date(refreshedMs).toISOString() };
    engine.scheduleRecompute(orchestratorId);
    assert.equal(await seam.fireFirstWithDelay(HOOK_EMISSION_DEBOUNCE_MS), true);
    const reArmed = seam.findStaleTimer();
    assert.ok(reArmed, 'a fresh supervisor event must re-arm a stale timer');
    // Deadline anchored to the refreshed timestamp.
    const expectedDeadlineMs = refreshedMs + STALE_AFTER_SECONDS * 1000;
    const reArmedDeadlineMs = reArmed!.scheduledAtMs + reArmed!.delayMs;
    assert.ok(
      Math.abs(reArmedDeadlineMs - expectedDeadlineMs) < 200,
      `re-armed deadline must be anchored to the refreshed last_supervisor_event_at; drift=${reArmedDeadlineMs - expectedDeadlineMs}ms`,
    );

    engine.forget(orchestratorId);
  });

  it('does NOT arm a stale timer while owned-run suppressors hold the aggregate above stale (running > 0; iteration #3 busy-loop guard)', async () => {
    const { OrchestratorStatusEngine } = await import('../daemon/orchestratorStatus.js');
    const seam = buildTimerSeam();

    // Deadline is already past: last_supervisor_event_at is older than
    // STALE_AFTER_SECONDS. Without the iteration #3 guard, the engine would
    // arm a zero-delay timer, fire it, recompute (still suppressed by
    // running > 0), and busy-loop.
    const lastEventMs = Date.now() - (STALE_AFTER_SECONDS + 60) * 1000;
    const state = makeState({ last_supervisor_event_at: new Date(lastEventMs).toISOString() });
    const orchestratorId = state.record.id;
    let snapshot: OwnedRunSnapshot = { running: 1, failed_unacked: 0 };

    const emissions: { state: string }[] = [];
    const engine = new OrchestratorStatusEngine({
      getOrchestratorState: (id) => id === orchestratorId ? state : undefined,
      getOwnedRunSnapshot: async () => snapshot,
      emitHook: (p) => emissions.push({ state: p.status.state }),
      scheduleTimer: seam.schedule,
      cancelTimer: seam.cancel,
    });

    // Trigger a recompute (e.g. lifecycle activity).
    engine.scheduleRecompute(orchestratorId);
    assert.equal(await seam.fireFirstWithDelay(HOOK_EMISSION_DEBOUNCE_MS), true);

    // Aggregate is `in_progress` because the running child suppresses stale.
    assert.equal(emissions.length, 1, `expected one emission, got ${JSON.stringify(emissions)}`);
    assert.equal(emissions[0]!.state, 'in_progress');
    // No stale timer must be armed while running > 0.
    assert.equal(seam.findStaleTimer(), undefined, 'no stale timer should be armed while running > 0');

    // Clear the running child and recompute. last_supervisor_event_at is
    // still past the threshold, so the next recompute resolves to `stale`
    // immediately (no stale timer needed because the live state already
    // computes stale).
    snapshot = { running: 0, failed_unacked: 0 };
    engine.scheduleRecompute(orchestratorId);
    assert.equal(await seam.fireFirstWithDelay(HOOK_EMISSION_DEBOUNCE_MS), true);
    assert.equal(emissions.length, 2);
    assert.equal(emissions[1]!.state, 'stale');
    // Once stale, no re-arm.
    assert.equal(seam.findStaleTimer(), undefined, 'no stale timer should be armed once aggregate is stale');

    engine.forget(orchestratorId);
  });

  it('does NOT arm a stale timer while owned-run suppressors hold the aggregate above stale (failed_unacked > 0; iteration #3 busy-loop guard)', async () => {
    const { OrchestratorStatusEngine } = await import('../daemon/orchestratorStatus.js');
    const seam = buildTimerSeam();

    const lastEventMs = Date.now() - (STALE_AFTER_SECONDS + 60) * 1000;
    const state = makeState({ last_supervisor_event_at: new Date(lastEventMs).toISOString() });
    const orchestratorId = state.record.id;
    let snapshot: OwnedRunSnapshot = { running: 0, failed_unacked: 1 };

    const emissions: { state: string }[] = [];
    const engine = new OrchestratorStatusEngine({
      getOrchestratorState: (id) => id === orchestratorId ? state : undefined,
      getOwnedRunSnapshot: async () => snapshot,
      emitHook: (p) => emissions.push({ state: p.status.state }),
      scheduleTimer: seam.schedule,
      cancelTimer: seam.cancel,
    });

    engine.scheduleRecompute(orchestratorId);
    assert.equal(await seam.fireFirstWithDelay(HOOK_EMISSION_DEBOUNCE_MS), true);

    // Aggregate is `attention` because the unacked fatal suppresses stale.
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0]!.state, 'attention');
    // No stale timer must be armed while failed_unacked > 0.
    assert.equal(seam.findStaleTimer(), undefined, 'no stale timer should be armed while failed_unacked > 0');

    // Simulate ack clearing the fatal: ackRunNotification triggers a
    // recompute. With last_supervisor_event_at still past threshold and
    // suppressors cleared, the aggregate transitions to `stale` immediately.
    snapshot = { running: 0, failed_unacked: 0 };
    engine.scheduleRecompute(orchestratorId);
    assert.equal(await seam.fireFirstWithDelay(HOOK_EMISSION_DEBOUNCE_MS), true);
    assert.equal(emissions.length, 2);
    assert.equal(emissions[1]!.state, 'stale');
    assert.equal(seam.findStaleTimer(), undefined);

    engine.forget(orchestratorId);
  });

  it('after a session_active recompute, firing the stale timer transitions the aggregate to `stale`', async () => {
    const { OrchestratorStatusEngine } = await import('../daemon/orchestratorStatus.js');
    const seam = buildTimerSeam();

    const state = makeState({ last_supervisor_event_at: new Date().toISOString() }, { supervisor_turn_active: false, waiting_for_user: false });
    const orchestratorId = state.record.id;

    const emissions: { state: string; previous_status: string | null }[] = [];
    const engine = new OrchestratorStatusEngine({
      getOrchestratorState: (id) => id === orchestratorId ? state : undefined,
      getOwnedRunSnapshot: async () => ({ running: 0, failed_unacked: 0 }),
      emitHook: (payload) => emissions.push({ state: payload.status.state, previous_status: payload.previous_status }),
      scheduleTimer: seam.schedule,
      cancelTimer: seam.cancel,
    });

    // Initial recompute → idle, stale timer armed.
    engine.scheduleRecompute(orchestratorId);
    assert.equal(await seam.fireFirstWithDelay(HOOK_EMISSION_DEBOUNCE_MS), true);
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0]!.state, 'idle');
    const initial = seam.findStaleTimer();
    assert.ok(initial, 'stale timer must be armed after the idle recompute');

    // Make the orchestrator stale-eligible by mutating last_supervisor_event_at,
    // then fire the stale timer.
    state.record = {
      ...state.record,
      last_supervisor_event_at: new Date(Date.now() - (STALE_AFTER_SECONDS + 60) * 1000).toISOString(),
    };
    assert.equal(await seam.fireFirstWithDelay(initial!.delayMs), true, 'stale timer must fire');
    assert.equal(emissions.length, 2);
    assert.equal(emissions[1]!.state, 'stale');
    assert.equal(emissions[1]!.previous_status, 'idle');
    // Once stale, the engine MUST NOT re-arm.
    assert.equal(seam.findStaleTimer(), undefined, 'stale recompute must not re-arm a stale timer');

    engine.forget(orchestratorId);
  });
});
