import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { RunError, RunLatestError, RunStatus, RunTerminalReason, RunTimeoutReason, WorkerEvent } from './contract.js';
import { WorkerResultSchema, type RunMeta, type WorkerResult } from './contract.js';
import type { BackendResultEvent, EarlyEventInterceptor, WorkerBackend, WorkerInvocation, WorkerInvocationEnvPolicy } from './backend/WorkerBackend.js';
import { classifyBackendError } from './backend/common.js';
import { RunStore } from './runStore.js';
import { changedFilesSinceSnapshot } from './gitSnapshot.js';

const activityPersistThrottleMs = 5_000;

export interface RunTerminalOverride {
  reason?: RunTerminalReason;
  timeout_reason?: RunTimeoutReason | null;
  context?: Record<string, unknown>;
  latest_error?: RunLatestError;
}

export interface ManagedRun {
  runId: string;
  child: ChildProcessWithoutNullStreams;
  completion: Promise<RunMeta>;
  cancel(status: Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out'>, terminal?: RunTerminalOverride): void;
  lastActivityMs(): number;
}

export type ProcessKill = (pid: number, signal: NodeJS.Signals) => void;
export type TaskkillSpawn = (command: string, args: string[], options: { stdio: 'ignore'; windowsHide: true }) => ChildProcess;

export interface PreparedWorkerSpawn {
  command: string;
  args: string[];
}

interface AttemptHandle {
  child: ChildProcessWithoutNullStreams;
  outcome: Promise<AttemptOutcome>;
}

type AttemptOutcome =
  | { kind: 'finalize'; meta: RunMeta }
  | {
      kind: 'retry';
      retryInvocation: WorkerInvocation;
      killedPid: number | null;
      durationMs: number;
      observedEvents: number;
      onRetryFired?: () => Promise<void>;
    };

interface SharedManagedHandle {
  activeCancel: ((status: Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out'>, terminal?: RunTerminalOverride) => void) | null;
  activeLastActivityMs: () => number;
}

/**
 * Terminal-multiplexer / pane-correlation env vars stripped from worker
 * subprocesses (issue #40, Decision 8). Limited to multiplexer surface so
 * unrelated tooling that depends on the daemon's env keeps working. The
 * supervisor's tmux/status display is owned by daemon-emitted hooks; workers
 * have no business seeing or addressing it.
 */
export const WORKER_STRIPPED_TERMINAL_ENV_VARS = [
  'TMUX',
  'TMUX_PANE',
  'STY',
  'WEZTERM_PANE',
  'KITTY_WINDOW_ID',
  'ITERM_SESSION_ID',
  'WT_SESSION',
] as const;

export function stripTerminalMultiplexerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of WORKER_STRIPPED_TERMINAL_ENV_VARS) delete next[key];
  return next;
}

export class ProcessManager {
  constructor(private readonly store: RunStore) {}

  private async parentOrchestratorIdForRun(runId: string): Promise<string | null> {
    try {
      const meta = await this.store.loadMeta(runId);
      const value = meta.metadata?.orchestrator_id;
      return typeof value === 'string' && value.trim() ? value : null;
    } catch {
      return null;
    }
  }

  async start(runId: string, backend: WorkerBackend, invocation: WorkerInvocation): Promise<ManagedRun> {
    const sharedHandle: SharedManagedHandle = {
      activeCancel: null,
      activeLastActivityMs: () => Date.now(),
    };
    const cancel = (status: Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out'>, terminal?: RunTerminalOverride): void => {
      sharedHandle.activeCancel?.(status, terminal);
    };
    const lastActivityMs = (): number => sharedHandle.activeLastActivityMs();

    const first = await this.executeAttempt(runId, backend, invocation, sharedHandle);
    const completion = (async (): Promise<RunMeta> => {
      let outcome = await first.outcome;
      while (outcome.kind === 'retry') {
        await this.store.appendEvent(runId, {
          type: 'lifecycle',
          payload: {
            subtype: 'session_not_found_in_run_retry',
            killed_pid: outcome.killedPid,
            resume_attempt_duration_ms: outcome.durationMs,
            observed_events: outcome.observedEvents,
          },
        });
        // Reviewer fix #2b: invoke the caller-supplied retry hook AFTER the
        // lifecycle marker is appended and BEFORE the retry attempt is
        // spawned, so the run's terminal_context is downgraded to the
        // post-retry shape synchronously — closing the window where a
        // reader could observe `kind: "resumed_after_rotation"` after the
        // actual outcome will be `fresh_chat_after_rotation`.
        if (outcome.onRetryFired) {
          try {
            await outcome.onRetryFired();
          } catch {
            // Best-effort — the rotation context fallback in startManagedRun
            // will still re-merge after completion.
          }
        }
        // Single-shot enforcement: never re-attach an interceptor to the retry.
        const retryInvocation: WorkerInvocation = { ...outcome.retryInvocation, earlyEventInterceptor: undefined };
        const next = await this.executeAttempt(runId, backend, retryInvocation, sharedHandle);
        outcome = await next.outcome;
      }
      return outcome.meta;
    })();

    return { runId, child: first.child, completion, cancel, lastActivityMs };
  }

  private async executeAttempt(
    runId: string,
    backend: WorkerBackend,
    invocation: WorkerInvocation,
    sharedHandle: SharedManagedHandle,
  ): Promise<AttemptHandle> {
    const inherited = applyEnvPolicy(process.env, invocation.envPolicy);
    const parentEnv = stripTerminalMultiplexerEnv(inherited);
    const parentOrchestratorId = await this.parentOrchestratorIdForRun(runId);
    const env: NodeJS.ProcessEnv = {
      ...parentEnv,
      ...invocation.env,
      NO_COLOR: '1',
      TERM: 'dumb',
      AGENT_ORCHESTRATOR_WORKER: '1',
      AGENT_ORCHESTRATOR_WORKER_RUN_ID: runId,
      AGENT_ORCHESTRATOR_PARENT_ORCHESTRATOR_ID: parentOrchestratorId ?? '',
    };
    const preparedSpawn = prepareWorkerSpawn(invocation.command, invocation.args);
    let lastActivityMs = Date.now();
    let lastPersistedActivityMs = 0;
    const persistenceTasks: Promise<void>[] = [];
    let persistenceFailed = false;
    let persistenceError: unknown;
    const trackPersistence = (task: Promise<unknown>) => {
      persistenceTasks.push(task.then(
        () => undefined,
        (error) => {
          if (!persistenceFailed) {
            persistenceFailed = true;
            persistenceError = error;
          }
        },
      ));
    };
    const recordActivity = (source: Parameters<RunStore['recordActivity']>[1], options: { force?: boolean } = {}) => {
      const now = new Date();
      lastActivityMs = now.getTime();
      if (!options.force && lastActivityMs - lastPersistedActivityMs < activityPersistThrottleMs) return;
      lastPersistedActivityMs = lastActivityMs;
      trackPersistence(this.store.recordActivity(runId, source, now));
    };

    // D-COR-Resume-Layer: per-attempt interceptor state. When `interceptor` is
    // undefined, the interceptor branch is fully bypassed and behaviour matches
    // the pre-existing implementation byte-for-byte.
    const interceptor: EarlyEventInterceptor | undefined = invocation.earlyEventInterceptor;
    const spawnedAt = Date.now();
    let eventsObserved = 0;
    let interceptorDisengaged = !interceptor;
    let cancelledByInterceptor = false;
    let retryDetails: { retryInvocation: WorkerInvocation; killedPid: number | null; durationMs: number; observedEvents: number; onRetryFired?: () => Promise<void> } | null = null;
    const eventBuffer: Omit<WorkerEvent, 'seq' | 'ts'>[] = [];

    const child = spawn(preparedSpawn.command, preparedSpawn.args, {
      cwd: invocation.cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    sharedHandle.activeLastActivityMs = () => lastActivityMs;

    const workerPid = child.pid ?? null;
    const workerPgid = process.platform === 'win32' ? null : workerPid;
    await this.store.updateMeta(runId, (meta) => ({
      ...meta,
      started_at: meta.started_at ?? new Date().toISOString(),
      worker_pid: workerPid,
      worker_pgid: workerPgid,
      daemon_pid_at_spawn: process.pid,
      last_activity_at: new Date(lastActivityMs).toISOString(),
      last_activity_source: 'started',
      worker_invocation: {
        command: invocation.command,
        args: invocation.args,
      },
    }));

    /**
     * D-COR-Resume-Layer: while the interceptor is engaged, every event that
     * would normally be appended to `events.jsonl` is buffered. On
     * `retry_with_start` the buffer is dropped (so the cancelled attempt's
     * stream never lands on disk). Once the interceptor disengages, the
     * buffer is flushed in arrival order and subsequent events are appended
     * directly. When `interceptor` is undefined this helper short-circuits to
     * the direct `store.appendEvent` call — identical to the original code path.
     */
    const appendEventBuffered = (event: Omit<WorkerEvent, 'seq' | 'ts'>): Promise<unknown> => {
      if (interceptor && !interceptorDisengaged && !cancelledByInterceptor) {
        eventBuffer.push(event);
        return Promise.resolve();
      }
      return this.store.appendEvent(runId, event);
    };

    // Issue #58: flush backend-supplied initial lifecycle events (e.g. the
    // `worker_posture` event from Claude and Codex backends) BEFORE the
    // `status: started` marker so operators see them at the head of the run
    // event stream. Routed through `appendEventBuffered` so the D-COR-Resume
    // interceptor still buffers them on a retry-eligible attempt.
    if (invocation.initialEvents && invocation.initialEvents.length > 0) {
      for (const initialEvent of invocation.initialEvents) {
        trackPersistence(appendEventBuffered(initialEvent));
      }
    }

    trackPersistence(appendEventBuffered({
      type: 'lifecycle',
      payload: { status: 'started', pid: workerPid, pgid: workerPgid },
    }));
    lastPersistedActivityMs = lastActivityMs;

    child.stdin.end(invocation.stdinPayload);

    const stdoutStream = createWriteStream(this.store.stdoutPath(runId), { flags: 'a', mode: 0o600 });
    const stderrStream = createWriteStream(this.store.stderrPath(runId), { flags: 'a', mode: 0o600 });
    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);
    child.stdout.on('data', () => {
      recordActivity('stdout');
    });

    let resultEvent: BackendResultEvent | null = null;
    let sessionId: string | undefined;
    let lastAssistantMessage: string | undefined;
    const filesFromEvents = new Set<string>();
    const commandsRun: string[] = [];
    const observedErrors: RunError[] = [];
    let terminalOverride: Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out'> | undefined;
    let terminalOverrideDetails: RunTerminalOverride | undefined;
    let killTimer: NodeJS.Timeout | null = null;
    const parseTasks: Promise<void>[] = [];

    const cancel = (status: Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out'>, terminal?: RunTerminalOverride): void => {
      if (terminalOverride) return;
      terminalOverride = status;
      terminalOverrideDetails = terminal;
      const pid = child.pid;
      if (pid) {
        terminateProcessTree(pid, false);
        killTimer = setTimeout(() => {
          terminateProcessTree(pid, true);
        }, 5_000);
      }
    };
    sharedHandle.activeCancel = cancel;

    const recordObservedError = (error: RunError): void => {
      observedErrors.push(error);
      recordActivity('error', { force: true });
      trackPersistence(this.store.updateMeta(runId, (meta) => ({
        ...meta,
        latest_error: error,
      })));
      if (error.fatal) {
        trackPersistence(this.store.appendFatalErrorNotificationIfNew(runId, 'running', error));
        cancel('failed', {
          reason: 'backend_fatal_error',
          latest_error: error,
          context: {
            category: error.category,
            source: error.source,
            retryable: error.retryable,
            fatal: error.fatal,
            ...(error.context ?? {}),
          },
        });
      }
    };

    /**
     * D-COR-Resume-Layer: classify each parsed event before any side effects.
     * Returns `true` when the caller should abort further processing of the
     * current line (i.e. the interceptor triggered a retry and the worker has
     * been killed). This is invoked for every parsed event in stream order so
     * a single line carrying multiple events still triggers on the first
     * `retry_with_start` outcome.
     */
    const interceptorAborted = (events: Omit<WorkerEvent, 'seq' | 'ts'>[]): boolean => {
      if (!interceptor || interceptorDisengaged || cancelledByInterceptor) return false;
      for (const event of events) {
        const within = eventsObserved < interceptor.thresholdEvents
          && (Date.now() - spawnedAt) < interceptor.thresholdMs;
        if (!within) {
          // Disengage and flush the buffer before the side-effects in this
          // line execute, so buffered events land on disk in arrival order.
          for (const buffered of eventBuffer) {
            trackPersistence(this.store.appendEvent(runId, buffered));
          }
          eventBuffer.length = 0;
          interceptorDisengaged = true;
          return false;
        }
        const outcome = interceptor.classify({ type: event.type, payload: event.payload as Record<string, unknown> });
        eventsObserved += 1;
        if (outcome === 'retry_with_start') {
          cancelledByInterceptor = true;
          retryDetails = {
            retryInvocation: interceptor.retryInvocation,
            killedPid: child.pid ?? null,
            durationMs: Date.now() - spawnedAt,
            observedEvents: eventsObserved,
            onRetryFired: interceptor.onRetryFired?.bind(interceptor),
          };
          // Drop the cancelled attempt's buffered events; they must not land
          // in events.jsonl.
          eventBuffer.length = 0;
          if (child.pid) {
            const pid = child.pid;
            terminateProcessTree(pid, false);
            // Reviewer note: arm a forced-kill fallback so a worker that
            // ignores SIGTERM cannot hang the retry. Mirrors the cancel
            // path's 5s SIGKILL escalation.
            killTimer = setTimeout(() => {
              terminateProcessTree(pid, true);
            }, 5_000);
          }
          return true;
        }
      }
      return false;
    };

    const stdoutLines = createInterface({ input: child.stdout });
    const stdoutClosed = new Promise<void>((resolve) => {
      stdoutLines.on('close', resolve);
    });
    stdoutLines.on('line', (line) => {
      if (cancelledByInterceptor) return;
      parseTasks.push(this.handleJsonLine(runId, backend, line, {
        setSessionId: (id) => { sessionId = id; },
        setResultEvent: (event) => { resultEvent = event; },
        setLastAssistantMessage: (text) => { lastAssistantMessage = text; },
        addFile: (path) => filesFromEvents.add(path),
        addCommand: (command) => commandsRun.push(command),
        addError: (error) => recordObservedError(error),
      }, () => recordActivity('backend_event'), {
        interceptorAborted,
        appendEvent: appendEventBuffered,
        isCancelledByInterceptor: () => cancelledByInterceptor,
      }));
    });

    const stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
    const stderrClosed = new Promise<void>((resolve) => {
      stderrLines.on('close', resolve);
    });
    child.stderr.on('data', () => {
      recordActivity('stderr');
    });
    stderrLines.on('line', (line) => {
      if (cancelledByInterceptor) return;
      const text = line.trim();
      if (!text) return;
      const error = classifyBackendError({
        backend: backend.name,
        source: 'stderr',
        message: text,
        context: { stream: 'stderr' },
      });
      if (!shouldSurfaceStderrError(text, error)) return;
      recordObservedError(error);
      trackPersistence(appendEventBuffered({ type: 'error', payload: { stream: 'stderr', text, error } }));
    });

    const outcome = new Promise<AttemptOutcome>((resolve, reject) => {
      child.on('close', (exitCode, signal) => {
        // Skip the 'terminal' activity write on the cancelled attempt so the
        // retry attempt's first activity isn't overwritten by a stale stamp.
        if (!(cancelledByInterceptor && retryDetails)) {
          recordActivity('terminal', { force: true });
        }
        if (killTimer) clearTimeout(killTimer);
        stdoutStream.end();
        stderrStream.end();
        void (async () => {
          await stdoutClosed;
          await stderrClosed;
          await Promise.allSettled(parseTasks);
          await Promise.allSettled(persistenceTasks);
          if (cancelledByInterceptor && retryDetails) {
            return { kind: 'retry' as const, ...retryDetails };
          }
          // Reviewer fix: when the interceptor was engaged but the worker
          // closed cleanly within the threshold (i.e. no `retry_with_start`
          // and no threshold expiry), the buffer was never flushed by the
          // disengage path. Flush it here before finalization so the
          // run's `events.jsonl` carries the started + assistant + result
          // events the worker actually emitted.
          if (interceptor && !interceptorDisengaged && eventBuffer.length > 0) {
            interceptorDisengaged = true;
            for (const buffered of eventBuffer) {
              try {
                await this.store.appendEvent(runId, buffered);
              } catch (error) {
                if (!persistenceFailed) {
                  persistenceFailed = true;
                  persistenceError = error;
                }
              }
            }
            eventBuffer.length = 0;
          }
          try {
            if (persistenceFailed) throw persistenceError;
            const meta = await this.finalizeRun(
              runId,
              backend,
              exitCode,
              signal,
              resultEvent,
              sessionId,
              lastAssistantMessage,
              Array.from(filesFromEvents),
              commandsRun,
              observedErrors,
              terminalOverride,
              terminalOverrideDetails,
            );
            return { kind: 'finalize' as const, meta };
          } catch (error) {
            const meta = await this.failFinalization(runId, error, Array.from(filesFromEvents), commandsRun);
            return { kind: 'finalize' as const, meta };
          }
        })().then(resolve, reject);
      });
    });

    return { child, outcome };
  }

  private async handleJsonLine(
    runId: string,
    backend: WorkerBackend,
    line: string,
    sinks: {
      setSessionId(id: string): void;
      setResultEvent(event: BackendResultEvent): void;
      setLastAssistantMessage(text: string): void;
      addFile(path: string): void;
      addCommand(command: string): void;
      addError(error: RunError): void;
    },
    markActivity: () => void,
    interceptorHooks?: {
      /** Returns true when the interceptor triggered a retry and processing
       *  of the current line must abort before any side-effects fire. */
      interceptorAborted(events: Omit<WorkerEvent, 'seq' | 'ts'>[]): boolean;
      /** Buffered or direct append; semantics chosen by the caller. */
      appendEvent(event: Omit<WorkerEvent, 'seq' | 'ts'>): Promise<unknown>;
      /** Predicate to short-circuit further side-effects after the line abort. */
      isCancelledByInterceptor(): boolean;
    },
  ): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return;
    }

    const parsed = backend.parseEvent(raw);

    // D-COR-Resume-Layer: run the interceptor BEFORE any side-effects so a
    // `retry_with_start` outcome can suppress meta updates, sink writes, and
    // appendEvent for the cancelled attempt. When no interceptor hook is
    // wired (every existing caller / non-rotation run), this is a no-op.
    if (interceptorHooks?.interceptorAborted(parsed.events)) return;

    // Capture the latest assistant_message text in stream order *before* any
    // awaited persistence work below. Each handleJsonLine() call runs
    // concurrently, so awaiting first would let an older line overwrite the
    // fallback summary with stale text after a newer line has already
    // updated it. If a single parsed line contains multiple assistant events,
    // use the last one in that line.
    let latestAssistantText: string | undefined;
    for (const event of parsed.events) {
      if (event.type === 'assistant_message') {
        const text = assistantMessageText(event.payload);
        if (text) latestAssistantText = text;
      }
    }
    if (latestAssistantText) sinks.setLastAssistantMessage(latestAssistantText);

    if (parsed.sessionId || parsed.resultEvent || parsed.filesChanged.length > 0 || parsed.commandsRun.length > 0 || parsed.errors.length > 0 || parsed.events.length > 0) {
      markActivity();
    }
    const observedModel = extractObservedModel(raw);
    if (parsed.sessionId || observedModel) {
      if (parsed.sessionId) sinks.setSessionId(parsed.sessionId);
      await this.store.updateMeta(runId, (meta) => ({
        ...meta,
        session_id: parsed.sessionId ? meta.session_id ?? parsed.sessionId : meta.session_id,
        observed_session_id: parsed.sessionId ?? meta.observed_session_id,
        observed_model: chooseObservedModel(meta.observed_model, observedModel),
        model: chooseRunModel(meta.model, meta.model_source, observedModel),
        model_source: !meta.model && observedModel && meta.model_source === 'legacy_unknown' ? 'backend_default' : meta.model_source,
      }));
    }
    if (interceptorHooks?.isCancelledByInterceptor()) return;
    if (parsed.resultEvent) sinks.setResultEvent(parsed.resultEvent);
    for (const file of parsed.filesChanged) sinks.addFile(file);
    for (const command of parsed.commandsRun) sinks.addCommand(command);
    for (const error of parsed.errors) sinks.addError(error);
    const append = interceptorHooks?.appendEvent ?? ((event: Omit<WorkerEvent, 'seq' | 'ts'>) => this.store.appendEvent(runId, event));
    for (const event of parsed.events) {
      if (interceptorHooks?.isCancelledByInterceptor()) return;
      await append(event);
    }
  }

  private async failFinalization(
    runId: string,
    error: unknown,
    filesFromEvents: string[],
    commandsRun: string[],
  ): Promise<RunMeta> {
    const latestError = finalizationError(error);
    const result: WorkerResult = WorkerResultSchema.parse({
      status: 'failed',
      summary: latestError.message,
      files_changed: Array.from(new Set(filesFromEvents)).sort(),
      commands_run: commandsRun,
      artifacts: this.store.defaultArtifacts(runId),
      errors: [latestError],
    });

    try {
      return await this.store.markTerminal(runId, 'failed', result.errors, result, {
        reason: 'finalization_failed',
        latest_error: latestError,
        context: latestError.context,
      });
    } catch {
      return this.store.loadMeta(runId);
    }
  }

  private async finalizeRun(
    runId: string,
    backend: WorkerBackend,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    resultEvent: BackendResultEvent | null,
    sessionId: string | undefined,
    lastAssistantMessage: string | undefined,
    filesFromEvents: string[],
    commandsRun: string[],
    observedErrors: RunError[],
    terminalOverride: Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out'> | undefined,
    terminalOverrideDetails: RunTerminalOverride | undefined,
  ): Promise<RunMeta> {
    const meta = await this.store.loadMeta(runId);
    const normalizedFilesFromEvents = await normalizeFilesChangedFromEvents(meta.cwd, filesFromEvents);
    const filesFromGit = meta.git_snapshot_status === 'captured'
      ? await changedFilesSinceSnapshot(meta.cwd, meta.git_snapshot)
      : [];
    const errors: RunError[] = terminalOverride
      ? [terminalOverrideError(backend, terminalOverride, terminalOverrideDetails)]
      : exitCode === 0 && resultEvent
        ? []
        : buildTerminalErrorList(backend, exitCode, signal, observedErrors);

    let finalized = backend.finalizeResult({
      runStatusOverride: terminalOverride,
      exitCode,
      signal,
      resultEvent,
      lastAssistantMessage,
      filesChangedFromEvents: normalizedFilesFromEvents,
      filesChangedFromGit: filesFromGit,
      commandsRun,
      artifacts: this.store.defaultArtifacts(runId),
      errors,
    });
    let validationLatestError: RunError | null = null;

    try {
      finalized = {
        runStatus: finalized.runStatus,
        result: WorkerResultSchema.parse(finalized.result),
      };
    } catch (error) {
      validationLatestError = resultValidationError(error);
      const failed: WorkerResult = WorkerResultSchema.parse({
        status: 'failed',
        summary: validationLatestError.message,
        files_changed: Array.from(new Set([...filesFromGit, ...normalizedFilesFromEvents])).sort(),
        commands_run: commandsRun,
        artifacts: this.store.defaultArtifacts(runId),
        errors: [validationLatestError],
      });
      finalized = { runStatus: 'failed', result: failed };
    }

    if (sessionId) {
      await this.store.updateMeta(runId, (current) => ({ ...current, session_id: current.session_id ?? sessionId }));
    }

    const runStatus = finalized.runStatus === 'running' ? 'failed' : finalized.runStatus;
    const resultLatestError = runStatus === 'failed' && !validationLatestError && !errors[0] && finalized.result.errors[0]
      ? workerResultError(backend, finalized.result.errors[0])
      : null;
    const latestError = validationLatestError ?? errors[0] ?? resultLatestError;
    const terminalDetails = terminalOverrideDetails
      ? {
          ...terminalOverrideDetails,
          latest_error: terminalOverrideDetails.latest_error ?? (runStatus === 'timed_out' ? latestError : undefined),
        }
      : runStatus === 'failed' && latestError
        ? { reason: validationLatestError ? 'finalization_failed' as const : 'worker_failed' as const, latest_error: latestError, context: latestError.context }
        : undefined;
    return this.store.markTerminal(runId, runStatus, finalized.result.errors, finalized.result, terminalDetails);
  }
}

function assistantMessageText(payload: Record<string, unknown>): string | null {
  const text = payload.text;
  return typeof text === 'string' && text.trim() ? text : null;
}

function terminalOverrideMessage(
  status: Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out'>,
  details: RunTerminalOverride | undefined,
): string {
  if (status === 'cancelled') return 'cancelled by user';
  if (status === 'failed') return details?.latest_error?.message ?? 'worker failed';
  if (details?.timeout_reason === 'idle_timeout') return 'idle timeout exceeded';
  return 'execution timeout exceeded';
}

function terminalOverrideError(
  backend: WorkerBackend,
  status: Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out'>,
  details: RunTerminalOverride | undefined,
): RunError {
  if (details?.latest_error) return details.latest_error;
  return {
    message: terminalOverrideMessage(status, details),
    category: status === 'timed_out' ? 'timeout' : 'unknown',
    source: status === 'timed_out' ? 'watchdog' : 'process_exit',
    backend: backend.name,
    retryable: false,
    fatal: status !== 'cancelled',
    context: details?.context,
  };
}

/**
 * T-COR-Classifier: when a non-zero exit happened but the stream produced a
 * structured (non-`process_exit`) classified error, drop the synthetic
 * `process_exit` error so the terminal `latest_error.category` reflects the
 * structured cause (e.g. `session_not_found`) instead of `process_exit`.
 */
function buildTerminalErrorList(
  backend: WorkerBackend,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  observedErrors: RunError[],
): RunError[] {
  const deduped = dedupeErrors(observedErrors);
  const hasStructured = deduped.some((error) => error.category !== 'process_exit');
  if (exitCode === 0 || hasStructured) return deduped;
  return [processExitError(backend, exitCode, signal), ...deduped];
}

function processExitError(backend: WorkerBackend, exitCode: number | null, signal: NodeJS.Signals | null): RunError {
  return {
    message: 'worker process exited unsuccessfully',
    category: 'process_exit',
    source: 'process_exit',
    backend: backend.name,
    retryable: false,
    fatal: true,
    context: { exit_code: exitCode, signal },
  };
}

function finalizationError(error: unknown): RunError {
  return {
    message: 'run finalization failed',
    category: 'unknown',
    source: 'finalization',
    retryable: false,
    fatal: true,
    context: { error: error instanceof Error ? error.message : String(error) },
  };
}

function resultValidationError(error: unknown): RunError {
  return {
    message: 'worker result validation failed',
    category: 'protocol',
    source: 'finalization',
    retryable: false,
    fatal: true,
    context: { error: error instanceof Error ? error.message : String(error) },
  };
}

function workerResultError(
  backend: WorkerBackend,
  error: { message: string; context?: Record<string, unknown> },
): RunError {
  return {
    message: error.message,
    category: error.message === 'worker result event missing' ? 'protocol' : 'unknown',
    source: 'finalization',
    backend: backend.name,
    retryable: false,
    fatal: true,
    context: error.context,
  };
}

function shouldSurfaceStderrError(message: string, error: RunError): boolean {
  return error.category !== 'unknown'
    || /\b(error|failed|failure|fatal|denied|invalid|unauthorized|unauthorised|quota|rate.?limit|not supported)\b/i.test(message);
}

export async function normalizeFilesChangedFromEvents(cwd: string, files: string[]): Promise<string[]> {
  const resolvedCwd = resolve(cwd);
  const realCwd = await realpath(cwd).catch(() => resolvedCwd);
  const normalized = new Set<string>();
  for (const file of files) {
    normalized.add(await normalizeFileChangedFromEvent(resolvedCwd, realCwd, file));
  }
  return Array.from(normalized).sort();
}

async function normalizeFileChangedFromEvent(resolvedCwd: string, realCwd: string, file: string): Promise<string> {
  if (!isAbsolute(file)) return file;

  const resolvedFile = resolve(file);
  const lexical = relativeInside(resolvedCwd, resolvedFile);
  if (lexical) return lexical;

  const realFile = await realpath(file).catch(() => resolvedFile);
  return relativeInside(realCwd, realFile) ?? file;
}

function relativeInside(cwd: string, file: string): string | null {
  const relativePath = relative(cwd, file);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null;
  return relativePath;
}

function extractObservedModel(raw: unknown): string | null {
  const rec = record(raw);
  if (!rec) return null;

  return stringValue(rec.model)
    ?? stringValue(record(rec.message)?.model)
    ?? stringValue(record(rec.response)?.model)
    ?? firstModelUsageKey(record(rec.modelUsage));
}

function firstModelUsageKey(modelUsage: Record<string, unknown> | null): string | null {
  if (!modelUsage) return null;
  let best: { model: string; score: number } | null = null;
  for (const [model, usage] of Object.entries(modelUsage)) {
    const score = modelUsageScore(usage);
    if (!best || score > best.score) best = { model, score };
  }
  return best?.model ?? Object.keys(modelUsage)[0] ?? null;
}

function modelUsageScore(usage: unknown): number {
  const rec = record(usage);
  if (!rec) return 0;
  const cost = numberValue(rec.costUSD ?? rec.costUsd ?? rec.cost_usd);
  if (cost !== null) return cost;
  const inputTokens = numberValue(rec.inputTokens ?? rec.input_tokens) ?? 0;
  const outputTokens = numberValue(rec.outputTokens ?? rec.output_tokens) ?? 0;
  return inputTokens + outputTokens;
}

function chooseRunModel(current: string | null, source: RunMeta['model_source'], incoming: string | null): string | null {
  if (!incoming) return current;
  if (!current) return incoming;
  return source === 'backend_default' ? chooseObservedModel(current, incoming) : current;
}

function chooseObservedModel(current: string | null, incoming: string | null): string | null {
  if (!incoming) return current;
  if (!current) return incoming;
  return isMoreSpecificModelName(current, incoming) ? incoming : current;
}

function isMoreSpecificModelName(current: string, incoming: string): boolean {
  if (current === incoming) return false;
  const currentBase = current.replace(/\[[^\]]+\]$/, '');
  const incomingBase = incoming.replace(/\[[^\]]+\]$/, '');
  return currentBase === incomingBase
    && !/\[[^\]]+\]$/.test(current)
    && /\[[^\]]+\]$/.test(incoming);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function terminateProcessTree(
  pid: number,
  force: boolean,
  platform: NodeJS.Platform = process.platform,
  killProcess: ProcessKill = process.kill,
  spawnTaskkill: TaskkillSpawn = spawnTaskkillProcess,
): void {
  if (pid <= 0) return;

  if (platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    const child = spawnTaskkill('taskkill', args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      // The process may already have exited, or taskkill may be unavailable.
    });
    child.unref();
    return;
  }

  try {
    killProcess(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // The process may already have exited.
  }
}

function spawnTaskkillProcess(command: string, args: string[], options: { stdio: 'ignore'; windowsHide: true }): ChildProcess {
  return spawn(command, args, options);
}

function dedupeErrors(errors: RunError[]): RunError[] {
  const seen = new Set<string>();
  const unique: RunError[] = [];
  for (const error of errors) {
    const key = `${error.message}\0${JSON.stringify(error.context ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(error);
  }
  return unique;
}

/**
 * Strip env keys per `WorkerInvocation.envPolicy` (D12). The default policy
 * preserves today's behaviour (no scrub) so non-`claude` and unbound-`claude`
 * runs are byte-identical to before this change.
 *
 * Globs use `*` (zero-or-more characters) only and are anchored at both ends.
 */
export function applyEnvPolicy(
  env: NodeJS.ProcessEnv,
  policy: WorkerInvocationEnvPolicy | undefined,
): NodeJS.ProcessEnv {
  if (!policy || policy === 'default') return { ...env };
  const explicit = new Set(policy.scrub);
  const globPatterns = (policy.scrubGlobs ?? []).map((glob) => globToRegExp(glob));
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (explicit.has(key)) continue;
    if (globPatterns.some((pattern) => pattern.test(key))) continue;
    next[key] = value;
  }
  return next;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function prepareWorkerSpawn(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  commandProcessor = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
): PreparedWorkerSpawn {
  if (platform === 'win32' && /\.(?:bat|cmd)$/i.test(command)) {
    return {
      command: commandProcessor,
      args: ['/d', '/s', '/c', quoteCmdCommand([command, ...args])],
    };
  }

  return { command, args };
}

function quoteCmdCommand(args: string[]): string {
  return args.map(quoteCmdArg).join(' ');
}

function quoteCmdArg(arg: string): string {
  const escaped = arg.replaceAll('%', '%%').replace(/(["^&|<>()])/g, '^$1');
  return escaped.length === 0 || /[\s]/.test(escaped) ? `"${escaped}"` : escaped;
}
