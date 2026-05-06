import type {
  Backend,
  RunError,
  RunModelSettings,
  RunStatus,
  WorkerEvent,
  WorkerResult,
} from '../contract.js';

export interface WorkerEnvPolicy {
  /** Exact env-var names to remove from the inherited env before merging. */
  scrub: string[];
  /** Glob-style patterns (anchored, with `*` only) to remove from the inherited env. */
  scrubGlobs?: string[];
}

/**
 * Either a structured deny-list policy (used for account-bound `claude` runs)
 * or the literal `"default"` value, which preserves today's behaviour
 * (no scrubbing) for non-`claude` backends and for unbound `claude` runs.
 */
export type WorkerInvocationEnvPolicy = WorkerEnvPolicy | 'default';

export interface WorkerInvocation {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Optional env-policy threaded from the runtime layer. When omitted or
   * `"default"`, inherited env is preserved (today's behaviour). When a
   * structured policy is supplied, matching keys/globs are stripped from
   * `process.env` BEFORE merging `invocation.env` and the daemon-injected
   * `NO_COLOR` / `TERM` overrides.
   */
  envPolicy?: WorkerInvocationEnvPolicy;
  stdinPayload: string;
  /**
   * D-COR-Resume-Layer: optional pre-terminal stream interceptor. When set,
   * `ProcessManager.start` watches the first
   * `min(thresholdEvents, thresholdMs)` of the worker's events and, on a
   * `retry_with_start` classifier outcome, kills the worker, discards its
   * buffered events, appends a single lifecycle marker, and re-spawns
   * against `retryInvocation` within the same managed run. Single-shot:
   * `retryInvocation.earlyEventInterceptor` MUST be undefined.
   *
   * When undefined (every existing caller, every non-rotation run),
   * `ProcessManager.start` behaves exactly as today.
   */
  earlyEventInterceptor?: EarlyEventInterceptor;
}

export type EarlyEventInterceptorOutcome = 'continue' | 'retry_with_start';

export interface EarlyEventInterceptor {
  /** Maximum parsed-events observed before the interceptor disengages. */
  thresholdEvents: number;
  /** Maximum wall-clock ms since spawn before the interceptor disengages. */
  thresholdMs: number;
  /**
   * Called for every parsed `WorkerEvent` while the interceptor is active.
   * `"retry_with_start"` triggers the in-run retry; `"continue"` is a no-op.
   */
  classify(event: { type: string; payload: Record<string, unknown> }): EarlyEventInterceptorOutcome;
  /**
   * Invocation used to spawn the retry worker. MUST NOT carry an
   * `earlyEventInterceptor` itself (single-shot enforcement at construction
   * time, in addition to the runtime check inside `ProcessManager.start`).
   */
  retryInvocation: WorkerInvocation;
  /**
   * Optional hook invoked once between the lifecycle marker append and the
   * retry attempt's spawn. Used by `OrchestratorService` to write the
   * `fresh_chat_after_rotation` / `resume_attempted: true` /
   * `resume_failure_reason: "session_not_found"` terminal_context to the
   * run's meta synchronously, BEFORE `markTerminal` runs. This closes the
   * race where a reader could observe `kind: "resumed_after_rotation"`
   * after the actual outcome was the post-retry fresh-chat shape.
   */
  onRetryFired?(): Promise<void>;
}

export interface BackendStartInput {
  prompt: string;
  cwd: string;
  model?: string | null;
  modelSettings: RunModelSettings;
  /**
   * Worker run id. Optional for backwards compatibility; the Claude backend
   * uses it to write per-run worker isolation settings (issue #40, T5).
   */
  runId?: string;
}

export interface ParsedBackendEvent {
  events: Omit<WorkerEvent, 'seq' | 'ts'>[];
  sessionId?: string;
  resultEvent?: BackendResultEvent;
  filesChanged: string[];
  commandsRun: string[];
  errors: RunError[];
}

export interface BackendResultEvent {
  summary: string;
  stopReason: string | null;
  raw: unknown;
}

export interface FinalizeContext {
  runStatusOverride?: Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out' | 'orphaned'>;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  resultEvent: BackendResultEvent | null;
  filesChangedFromEvents: string[];
  filesChangedFromGit: string[];
  commandsRun: string[];
  artifacts: { name: string; path: string }[];
  errors: RunError[];
  lastAssistantMessage?: string;
}

export interface FinalizedWorkerResult {
  runStatus: RunStatus;
  result: WorkerResult;
}

export interface WorkerBackend {
  readonly name: Backend;
  readonly binary: string;
  start(input: BackendStartInput): Promise<WorkerInvocation>;
  resume(sessionId: string, input: BackendStartInput): Promise<WorkerInvocation>;
  parseEvent(raw: unknown): ParsedBackendEvent;
  finalizeResult(context: FinalizeContext): FinalizedWorkerResult;
}
