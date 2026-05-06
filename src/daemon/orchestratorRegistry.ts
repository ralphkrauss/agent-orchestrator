import { ulid } from 'ulid';
import {
  type OrchestratorClient,
  type OrchestratorDisplay,
  type OrchestratorRecord,
  type SupervisorEvent,
} from '../contract.js';

/**
 * In-memory orchestrator registry (issue #40, T6 / Decision 2).
 *
 * Persistence across daemon restarts is deferred to #24 (assumption A7); the
 * supervisor's next harness-generated hook signal will trigger a transparent
 * re-register if the supervisor outlives the daemon.
 */

export interface RegisterInput {
  client: OrchestratorClient;
  label: string;
  cwd: string;
  display?: OrchestratorDisplay;
  /** Pre-generated id from the launcher; the launcher pins this into the
   * supervisor's MCP env before spawning, so the model never authors it. */
  orchestrator_id?: string;
}

export interface OrchestratorState {
  record: OrchestratorRecord;
  /** Sticky waiting_for_user flag, cleared on the next turn boundary. */
  waiting_for_user: boolean;
  /** True while the supervisor is mid-turn. */
  supervisor_turn_active: boolean;
  /** True after SessionEnd until the orchestrator is unregistered. */
  session_ended: boolean;
}

export class OrchestratorRegistry {
  private readonly entries = new Map<string, OrchestratorState>();

  register(input: RegisterInput): OrchestratorRecord {
    const id = input.orchestrator_id ?? ulid();
    const record: OrchestratorRecord = {
      id,
      client: input.client,
      label: input.label,
      cwd: input.cwd,
      display: input.display ?? { tmux_pane: null, tmux_window_id: null, base_title: null, host: null },
      registered_at: new Date().toISOString(),
      last_supervisor_event_at: null,
    };
    const previous = this.entries.get(id);
    this.entries.set(id, {
      record,
      waiting_for_user: previous?.waiting_for_user ?? false,
      supervisor_turn_active: previous?.supervisor_turn_active ?? false,
      session_ended: false,
    });
    return record;
  }

  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): OrchestratorState | undefined {
    return this.entries.get(id);
  }

  list(): OrchestratorState[] {
    return Array.from(this.entries.values());
  }

  /**
   * Apply a supervisor event from a Claude lifecycle hook (issue #40,
   * Decision 3b). Returns true if the orchestrator id is known and the state
   * was updated; false otherwise.
   */
  applyEvent(id: string, event: SupervisorEvent): OrchestratorState | null {
    const state = this.entries.get(id);
    if (!state) return null;
    const now = new Date().toISOString();
    state.record = { ...state.record, last_supervisor_event_at: now };
    switch (event) {
      case 'turn_started':
        state.supervisor_turn_active = true;
        state.waiting_for_user = false;
        break;
      case 'turn_stopped':
        state.supervisor_turn_active = false;
        state.waiting_for_user = false;
        break;
      case 'waiting_for_user':
        state.waiting_for_user = true;
        break;
      case 'session_active':
        state.session_ended = false;
        break;
      case 'session_ended':
        state.session_ended = true;
        state.supervisor_turn_active = false;
        break;
    }
    return state;
  }
}
