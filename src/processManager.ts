import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { RunError, RunLatestError, RunStatus, RunTerminalReason, RunTimeoutReason } from './contract.js';
import { WorkerResultSchema, type RunMeta, type WorkerResult } from './contract.js';
import type { BackendResultEvent, WorkerBackend, WorkerInvocation } from './backend/WorkerBackend.js';
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

export class ProcessManager {
  constructor(private readonly store: RunStore) {}

  async start(runId: string, backend: WorkerBackend, invocation: WorkerInvocation): Promise<ManagedRun> {
    const env = {
      ...process.env,
      ...invocation.env,
      NO_COLOR: '1',
      TERM: 'dumb',
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
    const child = spawn(preparedSpawn.command, preparedSpawn.args, {
      cwd: invocation.cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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
    await this.store.appendEvent(runId, {
      type: 'lifecycle',
      payload: { status: 'started', pid: workerPid, pgid: workerPgid },
    });
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
    const filesFromEvents = new Set<string>();
    const commandsRun: string[] = [];
    const observedErrors: RunError[] = [];
    let terminalOverride: Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out'> | undefined;
    let terminalOverrideDetails: RunTerminalOverride | undefined;
    let killTimer: NodeJS.Timeout | null = null;
    const parseTasks: Promise<void>[] = [];

    const recordObservedError = (error: RunError): void => {
      observedErrors.push(error);
      recordActivity('error', { force: true });
      trackPersistence(this.store.updateMeta(runId, (meta) => ({
        ...meta,
        latest_error: error,
      })));
      if (error.fatal) {
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

    const stdoutLines = createInterface({ input: child.stdout });
    const stdoutClosed = new Promise<void>((resolve) => {
      stdoutLines.on('close', resolve);
    });
    stdoutLines.on('line', (line) => {
      parseTasks.push(this.handleJsonLine(runId, backend, line, {
        setSessionId: (id) => { sessionId = id; },
        setResultEvent: (event) => { resultEvent = event; },
        addFile: (path) => filesFromEvents.add(path),
        addCommand: (command) => commandsRun.push(command),
        addError: (error) => recordObservedError(error),
      }, () => recordActivity('backend_event')));
    });

    const stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
    const stderrClosed = new Promise<void>((resolve) => {
      stderrLines.on('close', resolve);
    });
    child.stderr.on('data', () => {
      recordActivity('stderr');
    });
    stderrLines.on('line', (line) => {
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
      trackPersistence(this.store.appendEvent(runId, { type: 'error', payload: { stream: 'stderr', text, error } }));
    });

    function cancel(status: Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out'>, terminal?: RunTerminalOverride): void {
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
    }

    const completion = new Promise<RunMeta>((resolve, reject) => {
      child.on('close', (exitCode, signal) => {
        recordActivity('terminal', { force: true });
        if (killTimer) clearTimeout(killTimer);
        stdoutStream.end();
        stderrStream.end();
        void (async () => {
          await stdoutClosed;
          await stderrClosed;
          await Promise.allSettled(parseTasks);
          await Promise.allSettled(persistenceTasks);
          try {
            if (persistenceFailed) throw persistenceError;
            return await this.finalizeRun(
              runId,
              backend,
              exitCode,
              signal,
              resultEvent,
              sessionId,
              Array.from(filesFromEvents),
              commandsRun,
              observedErrors,
              terminalOverride,
              terminalOverrideDetails,
            );
          } catch (error) {
            return this.failFinalization(runId, error, Array.from(filesFromEvents), commandsRun);
          }
        })().then(resolve, reject);
      });
    });

    return { runId, child, completion, cancel, lastActivityMs: () => lastActivityMs };
  }

  private async handleJsonLine(
    runId: string,
    backend: WorkerBackend,
    line: string,
    sinks: {
      setSessionId(id: string): void;
      setResultEvent(event: BackendResultEvent): void;
      addFile(path: string): void;
      addCommand(command: string): void;
      addError(error: RunError): void;
    },
    markActivity: () => void,
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
        observed_model: observedModel ?? meta.observed_model,
        model: meta.model ?? observedModel,
        model_source: !meta.model && observedModel && meta.model_source === 'legacy_unknown' ? 'backend_default' : meta.model_source,
      }));
    }
    if (parsed.resultEvent) sinks.setResultEvent(parsed.resultEvent);
    for (const file of parsed.filesChanged) sinks.addFile(file);
    for (const command of parsed.commandsRun) sinks.addCommand(command);
    for (const error of parsed.errors) sinks.addError(error);
    for (const event of parsed.events) {
      await this.store.appendEvent(runId, event);
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
        : [
            ...(exitCode === 0 ? [] : [processExitError(backend, exitCode, signal)]),
            ...dedupeErrors(observedErrors),
          ];

    let finalized = backend.finalizeResult({
      runStatusOverride: terminalOverride,
      exitCode,
      signal,
      resultEvent,
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
  return Object.keys(modelUsage)[0] ?? null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
