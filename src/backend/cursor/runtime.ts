import type {
  Backend,
  RunError,
  RunMeta,
  RunStatus,
  WorkerResult,
} from '../../contract.js';
import { WorkerResultSchema } from '../../contract.js';
import type { RunStore } from '../../runStore.js';
import type { RunTerminalOverride } from '../../processManager.js';
import type {
  BackendResultEvent,
  FinalizeContext,
  FinalizedWorkerResult,
  ParsedBackendEvent,
} from '../WorkerBackend.js';
import { classifyBackendError, finalizeFromObserved } from '../common.js';
import { changedFilesSinceSnapshot } from '../../gitSnapshot.js';
import { normalizeCursorSdkError, type NormalizedCursorError } from './errors.js';
import type {
  CancelStatus,
  RuntimeRunHandle,
  RuntimeStartInput,
  RuntimeStartResult,
  WorkerRuntime,
} from '../runtime.js';
import { parseCursorEvent } from './cursorEvents.js';
import type {
  CursorAgent,
  CursorAgentApi,
  CursorAgentSendOptions,
  CursorRun,
  CursorRunResult,
  CursorRunStatus,
  CursorSdkAdapter,
  CursorSdkMessage,
} from './sdk.js';
import { CURSOR_BACKEND_NAME, CURSOR_SDK_PACKAGE } from './sdk.js';

const CURSOR_BACKEND: Backend = CURSOR_BACKEND_NAME;
const DEFAULT_CANCEL_DRAIN_MS = 5_000;

export interface CursorSdkRuntimeOptions {
  /** Run store reference; the runtime is the single writer for cursor runs. */
  store: RunStore;
  /** Override the cancel-drain timeout (ms). Default 5_000 (RQ2). */
  cancelDrainMs?: number;
  /** Inject `process.env`. Used by tests to control `CURSOR_API_KEY`. */
  env?: NodeJS.ProcessEnv;
}

/** A runtime-level pre-spawn failure that cannot be recovered without user action. */
export interface CursorPreSpawnFailure {
  code: 'WORKER_BINARY_MISSING' | 'SPAWN_FAILED';
  message: string;
  details: Record<string, unknown>;
}

export class CursorSdkRuntime implements WorkerRuntime {
  readonly name: Backend = CURSOR_BACKEND;

  constructor(
    private readonly adapter: CursorSdkAdapter,
    private readonly options: CursorSdkRuntimeOptions,
  ) {}

  async start(input: RuntimeStartInput): Promise<RuntimeStartResult> {
    return this.spawn(input, undefined);
  }

  async resume(sessionId: string, input: RuntimeStartInput): Promise<RuntimeStartResult> {
    return this.spawn(input, sessionId);
  }

  private async spawn(input: RuntimeStartInput, sessionId: string | undefined): Promise<RuntimeStartResult> {
    const availability = await this.adapter.available();
    if (!availability.ok) {
      const resolvedPath = availability.modulePath ?? null;
      const installed = resolvedPath !== null;
      const message = installed
        ? `${CURSOR_SDK_PACKAGE} is installed at ${resolvedPath} but failed to load: ${availability.reason}`
        : `${CURSOR_SDK_PACKAGE} module is not installed: ${availability.reason}`;
      const installHint = installed
        ? `${CURSOR_SDK_PACKAGE} resolves at ${resolvedPath} but failed to import — usually a native dependency or Node version mismatch. Try \`pnpm rebuild ${CURSOR_SDK_PACKAGE}\` or reinstalling with native rebuilds (e.g. \`npm install --build-from-source ${CURSOR_SDK_PACKAGE}\`).`
        : `npm install ${CURSOR_SDK_PACKAGE}`;
      const details: Record<string, unknown> = {
        binary: CURSOR_SDK_PACKAGE,
        install_hint: installHint,
        reason: availability.reason,
      };
      if (resolvedPath) details.resolved_path = resolvedPath;
      return {
        ok: false,
        failure: {
          code: 'WORKER_BINARY_MISSING',
          message,
          details,
        },
      };
    }

    const env = this.options.env ?? process.env;
    const apiKey = env.CURSOR_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        failure: {
          code: 'SPAWN_FAILED',
          message: 'CURSOR_API_KEY is not set; the cursor backend cannot authenticate',
          details: {
            binary: CURSOR_SDK_PACKAGE,
            auth_env: 'CURSOR_API_KEY',
            category: 'auth',
            retryable: false,
            install_hint: 'Set CURSOR_API_KEY in the daemon environment (Cursor Dashboard → Integrations).',
          },
        },
      };
    }

    let agentApi: CursorAgentApi;
    try {
      agentApi = await this.adapter.loadAgentApi();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const cached = await this.adapter.available().catch(() => null);
      const resolvedPath = cached && !cached.ok ? cached.modulePath ?? null : null;
      const installed = resolvedPath !== null;
      const installHint = installed
        ? `${CURSOR_SDK_PACKAGE} resolves at ${resolvedPath} but failed to import — usually a native dependency or Node version mismatch. Try \`pnpm rebuild ${CURSOR_SDK_PACKAGE}\` or reinstalling with native rebuilds (e.g. \`npm install --build-from-source ${CURSOR_SDK_PACKAGE}\`).`
        : `npm install ${CURSOR_SDK_PACKAGE}`;
      const details: Record<string, unknown> = {
        binary: CURSOR_SDK_PACKAGE,
        install_hint: installHint,
        reason,
      };
      if (resolvedPath) details.resolved_path = resolvedPath;
      return {
        ok: false,
        failure: {
          code: 'WORKER_BINARY_MISSING',
          message: `Failed to load ${CURSOR_SDK_PACKAGE}: ${reason}`,
          details,
        },
      };
    }

    let agent: CursorAgent;
    try {
      agent = sessionId
        ? await agentApi.resume(sessionId, {
            apiKey,
            local: { cwd: input.cwd },
          })
        : await agentApi.create({
            apiKey,
            model: input.model ? { id: input.model } : undefined,
            local: { cwd: input.cwd },
          });
    } catch (error) {
      return {
        ok: false,
        failure: cursorSpawnFailure(
          `Failed to ${sessionId ? 'resume' : 'create'} cursor agent`,
          error,
          { phase: sessionId ? 'resume' : 'create' },
        ),
      };
    }

    const sendOptions: CursorAgentSendOptions | undefined = sessionId && input.model
      ? { model: { id: input.model } }
      : undefined;

    let run: CursorRun;
    try {
      run = await agent.send(input.prompt, sendOptions);
    } catch (error) {
      await disposeAgentSafely(agent);
      return {
        ok: false,
        failure: cursorSpawnFailure('Failed to send prompt to cursor agent', error, { phase: 'send' }),
      };
    }

    return {
      ok: true,
      handle: createCursorHandle(input.runId, agent, run, this.options.cancelDrainMs ?? DEFAULT_CANCEL_DRAIN_MS, this.options.store),
    };
  }
}

interface CursorRunState {
  agent: CursorAgent;
  run: CursorRun;
  agentId: string;
  cancelDrainMs: number;
  store: RunStore;
  filesFromEvents: Set<string>;
  commandsRun: string[];
  observedErrors: RunError[];
  resultEvent: BackendResultEvent | null;
  cancelStatus?: CancelStatus;
  cancelTerminal?: RunTerminalOverride;
  cancelRequested: Promise<void>;
  resolveCancelRequested: () => void;
  lastActivityMs: number;
  completion: Promise<RunMeta>;
}

function createCursorHandle(
  runId: string,
  agent: CursorAgent,
  run: CursorRun,
  cancelDrainMs: number,
  store: RunStore,
): RuntimeRunHandle {
  let resolveCancelRequested!: () => void;
  const cancelRequested = new Promise<void>((resolve) => {
    resolveCancelRequested = resolve;
  });

  const state: CursorRunState = {
    agent,
    run,
    agentId: agent.agentId,
    cancelDrainMs,
    store,
    filesFromEvents: new Set<string>(),
    commandsRun: [],
    observedErrors: [],
    resultEvent: null,
    cancelRequested,
    resolveCancelRequested,
    lastActivityMs: Date.now(),
    completion: undefined as unknown as Promise<RunMeta>,
  };

  const completion = drainAndFinalize(runId, state);
  state.completion = completion;

  return {
    runId,
    cancel(status, terminal) {
      if (state.cancelStatus) return;
      state.cancelStatus = status;
      state.cancelTerminal = terminal;
      state.resolveCancelRequested();
      void state.run.cancel().catch(() => undefined);
    },
    lastActivityMs() {
      return state.lastActivityMs;
    },
    completion,
  };
}

async function drainAndFinalize(runId: string, state: CursorRunState): Promise<RunMeta> {
  const store = state.store;
  await store.updateMeta(runId, (meta) => ({
    ...meta,
    started_at: meta.started_at ?? new Date().toISOString(),
    daemon_pid_at_spawn: process.pid,
    last_activity_at: new Date(state.lastActivityMs).toISOString(),
    last_activity_source: 'started',
    session_id: meta.session_id ?? state.agentId,
    observed_session_id: meta.observed_session_id ?? state.agentId,
  }));
  await store.appendEvent(runId, {
    type: 'lifecycle',
    payload: { status: 'started', backend: 'cursor', agent_id: state.agentId, run_id: state.run.id },
  });

  const drainPromise = (async () => {
    try {
      for await (const message of state.run.stream() as AsyncIterable<CursorSdkMessage>) {
        await processCursorMessage(runId, store, state, message);
      }
    } catch (error) {
      const classified = cursorRunError(error);
      state.observedErrors.push(classified);
      await store.appendEvent(runId, { type: 'error', payload: { source: 'cursor.stream', message: classified.message, context: classified.context } });
    }
  })();

  let runResult: CursorRunResult | null = null;
  try {
    await Promise.race([drainPromise, state.cancelRequested]);
    if (state.cancelStatus) {
      await Promise.race([
        drainPromise,
        new Promise<void>((resolve) => setTimeout(resolve, state.cancelDrainMs)),
      ]);
    }

    const waitPromise = state.run.wait();
    await Promise.race([waitPromise, state.cancelRequested]);
    if (state.cancelStatus) {
      runResult = await Promise.race([
        waitPromise,
        new Promise<CursorRunResult>((resolve) => setTimeout(() => resolve({ status: state.run.status }), state.cancelDrainMs)),
      ]);
    } else {
      runResult = await waitPromise;
    }
  } catch (error) {
    state.observedErrors.push(cursorRunError(error));
  } finally {
    await disposeAgentSafely(state.agent);
  }

  return finalizeCursorRun(runId, store, state, runResult);
}

async function processCursorMessage(runId: string, store: RunStore, state: CursorRunState, message: CursorSdkMessage): Promise<void> {
  state.lastActivityMs = Date.now();
  const parsed = parseCursorEvent(message);
  if (parsed.resultEvent) state.resultEvent = parsed.resultEvent;
  for (const file of parsed.filesChanged) state.filesFromEvents.add(file);
  for (const command of parsed.commandsRun) state.commandsRun.push(command);
  for (const error of parsed.errors) state.observedErrors.push(error);
  if (parsed.sessionId && parsed.sessionId !== state.agentId) {
    // `agentId` is always set by the runtime; treat the SDK-side value as
    // authoritative for `observed_session_id` when it diverges (it should
    // not, but the abstraction allows it).
    await store.updateMeta(runId, (meta) => ({
      ...meta,
      observed_session_id: parsed.sessionId ?? meta.observed_session_id,
    }));
  }
  for (const event of parsed.events) {
    await store.appendEvent(runId, event);
  }
  await store.recordActivity(runId, 'backend_event');
}

async function finalizeCursorRun(
  runId: string,
  store: RunStore,
  state: CursorRunState,
  runResult: CursorRunResult | null,
): Promise<RunMeta> {
  const meta = await store.loadMeta(runId);
  const filesFromGit = meta.git_snapshot_status === 'captured'
    ? await changedFilesSinceSnapshot(meta.cwd, meta.git_snapshot)
    : [];
  const status = state.cancelStatus
    ? mapCancelStatusToRunStatus(state.cancelStatus)
    : runResult ? mapCursorStatusToRunStatus(runResult.status) : 'failed';
  const overrideError = state.cancelStatus
    ? state.cancelTerminal?.latest_error ?? cursorTerminalOverrideError(state.cancelStatus, state.cancelTerminal)
    : null;
  const finalizeContext = buildFinalizeContext(runId, store, state, runResult, filesFromGit, status, overrideError);
  const finalized = finalizeForCursor(finalizeContext);
  const validatedResult: WorkerResult = WorkerResultSchema.parse(finalized.result);
  const errors = validatedResult.errors;
  const terminalDetails = state.cancelStatus
    ? {
        ...(state.cancelTerminal ?? {}),
        latest_error: state.cancelTerminal?.latest_error ?? overrideError ?? undefined,
        context: state.cancelTerminal?.context ?? overrideError?.context,
      }
    : finalized.runStatus === 'failed' && errors[0]
      ? { reason: 'worker_failed' as const, latest_error: cursorError(errors[0]) }
      : undefined;

  return store.markTerminal(runId, finalized.runStatus === 'running' ? 'failed' : finalized.runStatus, errors, validatedResult, terminalDetails);
}

function cursorTerminalOverrideError(status: CancelStatus, details: { context?: Record<string, unknown>; timeout_reason?: 'idle_timeout' | 'execution_timeout' | null } | undefined): RunError {
  const message = status === 'cancelled'
    ? 'cancelled by user'
    : status === 'timed_out'
      ? details?.timeout_reason === 'idle_timeout' ? 'idle timeout exceeded' : 'execution timeout exceeded'
      : 'cursor run failed';
  return {
    message,
    category: status === 'timed_out' ? 'timeout' : 'unknown',
    source: status === 'timed_out' ? 'watchdog' : 'process_exit',
    backend: CURSOR_BACKEND,
    retryable: false,
    fatal: status !== 'cancelled',
    context: details?.context,
  };
}

function mapCursorStatusToRunStatus(status: CursorRunStatus): RunStatus {
  if (status === 'finished') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

function mapCancelStatusToRunStatus(status: CancelStatus): RunStatus {
  return status;
}

function buildFinalizeContext(
  runId: string,
  store: RunStore,
  state: CursorRunState,
  runResult: CursorRunResult | null,
  filesFromGit: string[],
  status: RunStatus,
  overrideError: RunError | null,
): FinalizeContext {
  const isOverride = status === 'cancelled' || status === 'timed_out';
  const baseErrors = isOverride && overrideError
    ? [overrideError]
    : state.observedErrors.slice();

  // When the SDK reports a terminal error status (e.g. status === 'error') without
  // emitting any parseable error events, baseErrors would otherwise be empty and
  // the present `resultEvent` would suppress the generic "worker result event
  // missing" fallback in finalizeFromObserved — leaving the run marked failed but
  // with no diagnostic for operators. Synthesize a cursor-specific RunError so
  // WorkerResult.summary, WorkerResult.errors, and RunSummary.latest_error all
  // surface the failure.
  const synthesizedMissingError = (
    !isOverride
    && status === 'failed'
    && runResult
    && baseErrors.length === 0
    && overrideError === null
  )
    ? cursorMissingErrorRunError(runResult, runId)
    : null;
  if (synthesizedMissingError) baseErrors.push(synthesizedMissingError);

  const stopReasonForResult: BackendResultEvent | null = runResult
    ? {
        summary: runResult.result ?? state.resultEvent?.summary ?? synthesizedMissingError?.message ?? '',
        stopReason: stopReasonFor(runResult.status),
        raw: runResult,
      }
    : state.resultEvent;

  const baseContext = {
    filesChangedFromEvents: Array.from(state.filesFromEvents).sort(),
    filesChangedFromGit: filesFromGit,
    commandsRun: Array.from(new Set(state.commandsRun)),
    artifacts: store.defaultArtifacts(runId),
    errors: baseErrors,
  };

  if (status === 'cancelled') {
    return {
      ...baseContext,
      runStatusOverride: 'cancelled',
      exitCode: null,
      signal: null,
      resultEvent: stopReasonForResult,
    };
  }
  if (status === 'timed_out') {
    return {
      ...baseContext,
      runStatusOverride: 'timed_out',
      exitCode: null,
      signal: null,
      resultEvent: stopReasonForResult,
    };
  }
  if (status === 'completed' && runResult?.status === 'finished') {
    return {
      ...baseContext,
      exitCode: 0,
      signal: null,
      resultEvent: stopReasonForResult,
    };
  }
  // failed / error path.
  return {
    ...baseContext,
    exitCode: 1,
    signal: null,
    resultEvent: stopReasonForResult,
  };
}

function stopReasonFor(status: CursorRunStatus): string {
  if (status === 'finished') return 'complete';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'error') return 'error';
  return 'running';
}

function finalizeForCursor(context: FinalizeContext): FinalizedWorkerResult {
  return finalizeFromObserved(context);
}

function cursorError(error: { message: string; context?: Record<string, unknown> }): RunError {
  return classifyBackendError({
    backend: CURSOR_BACKEND,
    source: 'backend_event',
    message: error.message,
    context: error.context,
  });
}

function cursorMissingErrorRunError(runResult: CursorRunResult, runId: string): RunError {
  return {
    message: `cursor run finished with status "${runResult.status}" but the SDK reported no error details`,
    category: 'protocol',
    source: 'backend_event',
    backend: CURSOR_BACKEND,
    retryable: false,
    fatal: true,
    context: {
      sdk_run_id: runResult.id,
      sdk_run_status: runResult.status,
      sdk_run_result: runResult.result,
      cursor_run_id: runId,
    },
  };
}

function cursorRunError(error: unknown): RunError {
  const normalized = normalizeCursorSdkError(error);
  return {
    message: normalized.message,
    category: normalized.category,
    source: 'backend_event',
    backend: CURSOR_BACKEND,
    retryable: normalized.retryable,
    fatal: normalized.category !== 'unknown',
    context: cursorErrorDetails(normalized, {}),
  };
}

function cursorSpawnFailure(
  prefix: string,
  error: unknown,
  extra: Record<string, unknown>,
): { code: 'SPAWN_FAILED'; message: string; details: Record<string, unknown> } {
  const normalized = normalizeCursorSdkError(error);
  return {
    code: 'SPAWN_FAILED',
    message: `${prefix}: ${normalized.message}`,
    details: cursorErrorDetails(normalized, extra),
  };
}

function cursorErrorDetails(error: NormalizedCursorError, extra: Record<string, unknown>): Record<string, unknown> {
  const details: Record<string, unknown> = {
    ...extra,
    error_class: error.errorClass,
    error_message: error.message,
    category: error.category,
    retryable: error.retryable,
  };
  if (error.code) details.error_code = error.code;
  if (typeof error.status === 'number') details.status = error.status;
  return details;
}

async function disposeAgentSafely(agent: CursorAgent): Promise<void> {
  const disposer = agent[Symbol.asyncDispose];
  try {
    if (typeof disposer === 'function') {
      await disposer.call(agent);
      return;
    }
    if (typeof agent.close === 'function') {
      agent.close();
    }
  } catch {
    // disposal is best-effort.
  }
}
