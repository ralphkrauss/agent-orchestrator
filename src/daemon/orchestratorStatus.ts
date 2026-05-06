import { ulid } from 'ulid';
import {
  OrchestratorStatusPayloadSchema,
  type OrchestratorStatusPayload,
  type OrchestratorStatusSnapshot,
  type OrchestratorStatusState,
} from '../contract.js';
import type { OrchestratorState } from './orchestratorRegistry.js';

/**
 * Stale threshold for the supervisor's last lifecycle event (Decision 17).
 * Not tunable via `hooks.json` v1; adjustable in code only.
 */
export const STALE_AFTER_SECONDS = 600;

/** Per-orchestrator hook-emission debounce (Decision 16). */
export const HOOK_EMISSION_DEBOUNCE_MS = 250;

export interface OwnedRunSnapshot {
  running: number;
  failed_unacked: number;
}

export interface ComputeStatusInput {
  state: OrchestratorState;
  ownedRuns: OwnedRunSnapshot;
  /** Override timestamp for tests; defaults to Date.now(). */
  nowMs?: number;
}

/**
 * Compute the 5-state aggregate status from the supervisor event log + the
 * owned-run snapshot using the 5-rule live-state precedence (Decision 3b),
 * with `stale` overriding when SessionEnd has fired or
 * `last_supervisor_event_at` is older than `STALE_AFTER_SECONDS` and no owned
 * runs remain.
 */
export function computeOrchestratorStatusSnapshot(
  state: OrchestratorState,
  ownedRuns: OwnedRunSnapshot,
  nowMs: number = Date.now(),
): OrchestratorStatusSnapshot {
  const liveState = computeLiveState(state, ownedRuns);
  const stateValue = applyStaleOverride(liveState, state, ownedRuns, nowMs);
  return {
    state: stateValue,
    supervisor_turn_active: state.supervisor_turn_active,
    waiting_for_user: state.waiting_for_user,
    running_child_count: ownedRuns.running,
    failed_unacked_count: ownedRuns.failed_unacked,
  };
}

function computeLiveState(state: OrchestratorState, ownedRuns: OwnedRunSnapshot): OrchestratorStatusState {
  // Rule 1: attention.
  if (ownedRuns.failed_unacked > 0) return 'attention';
  // Rule 2: in_progress because running_child_count > 0. AC8 invariant: this
  // dominates a sticky waiting_for_user flag while children run.
  if (ownedRuns.running > 0) return 'in_progress';
  // Rule 3: waiting_for_user.
  if (state.waiting_for_user) return 'waiting_for_user';
  // Rule 4: in_progress because supervisor mid-turn.
  if (state.supervisor_turn_active) return 'in_progress';
  // Rule 5: idle.
  return 'idle';
}

function applyStaleOverride(
  liveState: OrchestratorStatusState,
  state: OrchestratorState,
  ownedRuns: OwnedRunSnapshot,
  nowMs: number,
): OrchestratorStatusState {
  if (state.session_ended) return 'stale';
  if (ownedRuns.running > 0 || ownedRuns.failed_unacked > 0) return liveState;
  const lastEvent = state.record.last_supervisor_event_at;
  if (!lastEvent) return liveState;
  const lastMs = Date.parse(lastEvent);
  if (!Number.isFinite(lastMs)) return liveState;
  if (nowMs - lastMs >= STALE_AFTER_SECONDS * 1000) return 'stale';
  return liveState;
}

/** Build a v1 hook payload from the current state + status snapshot. */
export function buildOrchestratorStatusPayload(input: {
  state: OrchestratorState;
  status: OrchestratorStatusSnapshot;
  previousStatus: OrchestratorStatusState | null;
  emittedAtMs?: number;
}): OrchestratorStatusPayload {
  const emittedAt = new Date(input.emittedAtMs ?? Date.now()).toISOString();
  return OrchestratorStatusPayloadSchema.parse({
    version: 1,
    event: 'orchestrator_status_changed',
    event_id: ulid(),
    previous_status: input.previousStatus,
    emitted_at: emittedAt,
    orchestrator: {
      id: input.state.record.id,
      client: input.state.record.client,
      label: input.state.record.label,
      cwd: input.state.record.cwd,
    },
    status: input.status,
    display: input.state.record.display,
  });
}

export type RunLifecycleEventKind = 'started' | 'activity' | 'terminal' | 'notification';

export interface RunLifecycleEvent {
  kind: RunLifecycleEventKind;
  run_id: string;
  orchestrator_id: string | null;
}

export type RunLifecycleListener = (event: RunLifecycleEvent) => void;

interface PerOrchestratorEmissionState {
  lastPayloadKey: string | null;
  pendingTimer: NodeJS.Timeout | null;
  pendingResolve: (() => void) | null;
  /**
   * One-shot stale timer (F4). Scheduled on every recompute / activity and
   * cancelled when a new event arrives. On fire it triggers a recompute, so
   * an orchestrator that goes silent transitions to `stale` after
   * `STALE_AFTER_SECONDS` even when no other event would have woken the
   * engine.
   */
  staleTimer: NodeJS.Timeout | null;
}

export interface OrchestratorStatusEngineOptions {
  /** Returns the current owned-run snapshot for an orchestrator id. */
  getOwnedRunSnapshot(orchestratorId: string): Promise<OwnedRunSnapshot>;
  /** Fetch the registry state for an orchestrator id. */
  getOrchestratorState(orchestratorId: string): OrchestratorState | undefined;
  /**
   * Emit one v1 hook payload to all configured user hooks. Implementations
   * fire-and-forget; the engine never awaits hook completion.
   */
  emitHook(payload: OrchestratorStatusPayload): void;
  /** Logger for non-fatal status engine warnings. */
  log?(message: string): void;
  /**
   * Test seam: override the stale timer scheduler so unit tests can use fake
   * timers. Defaults to `setTimeout` / `clearTimeout` from `globalThis`.
   */
  scheduleTimer?(callback: () => void, delayMs: number): NodeJS.Timeout;
  cancelTimer?(handle: NodeJS.Timeout): void;
}

/**
 * Aggregate-status engine (issue #40, T8). Subscribes to run lifecycle events
 * and supervisor events, recomputes the 5-state aggregate, debounces
 * 250 ms / orchestrator, and emits v1 hook payloads to user hooks. The hook
 * executor is fire-and-forget; engine work never blocks orchestration.
 */
export class OrchestratorStatusEngine {
  private readonly perOrchestrator = new Map<string, PerOrchestratorEmissionState>();
  private readonly schedule: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly cancel: (handle: NodeJS.Timeout) => void;

  constructor(private readonly options: OrchestratorStatusEngineOptions) {
    this.schedule = options.scheduleTimer ?? ((cb, delay) => setTimeout(cb, delay));
    this.cancel = options.cancelTimer ?? ((handle) => clearTimeout(handle));
  }

  /** Notify the engine that a relevant input changed. */
  scheduleRecompute(orchestratorId: string): void {
    const slot = this.perOrchestrator.get(orchestratorId) ?? this.makeSlot();
    this.perOrchestrator.set(orchestratorId, slot);
    if (slot.pendingTimer) return;
    slot.pendingTimer = this.schedule(() => {
      slot.pendingTimer = null;
      void this.runRecompute(orchestratorId, slot);
    }, HOOK_EMISSION_DEBOUNCE_MS);
    if (typeof slot.pendingTimer.unref === 'function') slot.pendingTimer.unref();
  }

  /** Drop the in-memory de-dup state for an orchestrator (e.g. on unregister). */
  forget(orchestratorId: string): void {
    const slot = this.perOrchestrator.get(orchestratorId);
    if (slot?.pendingTimer) this.cancel(slot.pendingTimer);
    if (slot?.staleTimer) this.cancel(slot.staleTimer);
    this.perOrchestrator.delete(orchestratorId);
  }

  private makeSlot(): PerOrchestratorEmissionState {
    return { lastPayloadKey: null, pendingTimer: null, pendingResolve: null, staleTimer: null };
  }

  /**
   * Re-arm the stale timer relative to `last_supervisor_event_at`, not
   * `now()` (issue #40, reviewer iteration #2). The deadline is fixed at
   * `last_supervisor_event_at + STALE_AFTER_SECONDS`; non-supervisor
   * recomputes between t and t+STALE_AFTER_SECONDS must NOT push that
   * deadline forward. Once the computed status is already `stale` we skip
   * re-arming, so a stale orchestrator does not generate periodic stale
   * timers — only the next genuine supervisor event (which updates
   * `last_supervisor_event_at`) re-arms the timer.
   *
   * Iteration #3 hardening: also skip re-arming while the stale state is
   * actively suppressed by owned-run conditions (`running > 0` or
   * `failed_unacked > 0`). Without this guard, when the deadline has
   * already passed, `delayMs` clamps to 0, the timer fires immediately,
   * recomputes (still suppressed), and re-arms another zero-delay timer —
   * a busy-loop. Lifecycle/ack recomputes already wake the engine when
   * those suppressors clear, and stale is recomputed correctly at that
   * point because `last_supervisor_event_at` is already past the threshold.
   */
  private resetStaleTimer(
    orchestratorId: string,
    slot: PerOrchestratorEmissionState,
    state: OrchestratorState,
    currentState: OrchestratorStatusState,
    snapshot: OwnedRunSnapshot,
  ): void {
    if (slot.staleTimer) {
      this.cancel(slot.staleTimer);
      slot.staleTimer = null;
    }
    if (currentState === 'stale') return;
    if (snapshot.running > 0 || snapshot.failed_unacked > 0) return;
    const lastEventIso = state.record.last_supervisor_event_at;
    if (!lastEventIso) return;
    const lastEventMs = Date.parse(lastEventIso);
    if (!Number.isFinite(lastEventMs)) return;
    const deadlineMs = lastEventMs + STALE_AFTER_SECONDS * 1000;
    const delayMs = Math.max(0, deadlineMs - Date.now());
    slot.staleTimer = this.schedule(() => {
      slot.staleTimer = null;
      // Recompute on stale tick; if the orchestrator is still inactive and
      // the owned-run set is empty, computeOrchestratorStatusSnapshot will
      // resolve to `stale` and emit.
      void this.runRecompute(orchestratorId, slot);
    }, delayMs);
    if (typeof slot.staleTimer.unref === 'function') slot.staleTimer.unref();
  }

  private async runRecompute(orchestratorId: string, slot: PerOrchestratorEmissionState): Promise<void> {
    let state: OrchestratorState | undefined;
    let snapshot: OwnedRunSnapshot;
    try {
      state = this.options.getOrchestratorState(orchestratorId);
      if (!state) return;
      snapshot = await this.options.getOwnedRunSnapshot(orchestratorId);
    } catch (error) {
      this.options.log?.(`orchestrator status compute failed for ${orchestratorId}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const status = computeOrchestratorStatusSnapshot(state, snapshot);
    // Re-arm the stale timer relative to last_supervisor_event_at so a
    // non-supervisor recompute does not push the stale deadline forward.
    // Skip arming while owned-run suppressors hold the aggregate above
    // `stale` (iteration #3) so we don't busy-loop on past deadlines.
    this.resetStaleTimer(orchestratorId, slot, state, status.state, snapshot);
    const payloadKey = JSON.stringify({ state: status.state, running: status.running_child_count, failed: status.failed_unacked_count });
    if (payloadKey === slot.lastPayloadKey) return;
    const previousStatus = slot.lastPayloadKey ? (JSON.parse(slot.lastPayloadKey) as { state: OrchestratorStatusState }).state : null;
    slot.lastPayloadKey = payloadKey;
    const payload = buildOrchestratorStatusPayload({ state, status, previousStatus });
    try {
      this.options.emitHook(payload);
    } catch (error) {
      this.options.log?.(`orchestrator status emit failed for ${orchestratorId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
