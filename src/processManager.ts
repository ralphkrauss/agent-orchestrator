import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { RunStatus } from './contract.js';
import { WorkerResultSchema, type RunMeta, type WorkerResult } from './contract.js';
import type { BackendResultEvent, WorkerBackend, WorkerInvocation } from './backend/WorkerBackend.js';
import { RunStore } from './runStore.js';
import { changedFilesSinceSnapshot } from './gitSnapshot.js';

export interface ManagedRun {
  runId: string;
  child: ChildProcessWithoutNullStreams;
  completion: Promise<RunMeta>;
  cancel(status: Extract<RunStatus, 'cancelled' | 'timed_out'>): void;
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
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const workerPid = child.pid ?? null;
    const workerPgid = workerPid;
    await this.store.updateMeta(runId, (meta) => ({
      ...meta,
      started_at: meta.started_at ?? new Date().toISOString(),
      worker_pid: workerPid,
      worker_pgid: workerPgid,
      daemon_pid_at_spawn: process.pid,
      worker_invocation: {
        command: invocation.command,
        args: invocation.args,
      },
    }));
    await this.store.appendEvent(runId, {
      type: 'lifecycle',
      payload: { status: 'started', pid: workerPid, pgid: workerPgid },
    });

    child.stdin.end(invocation.stdinPayload);

    const stdoutStream = createWriteStream(this.store.stdoutPath(runId), { flags: 'a', mode: 0o600 });
    const stderrStream = createWriteStream(this.store.stderrPath(runId), { flags: 'a', mode: 0o600 });
    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);

    let resultEvent: BackendResultEvent | null = null;
    let sessionId: string | undefined;
    const filesFromEvents = new Set<string>();
    const commandsRun: string[] = [];
    let terminalOverride: Extract<RunStatus, 'cancelled' | 'timed_out'> | undefined;
    let killTimer: NodeJS.Timeout | null = null;
    const parseTasks: Promise<void>[] = [];

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
      }));
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text.toLowerCase().includes('error')) {
        void this.store.appendEvent(runId, { type: 'error', payload: { stream: 'stderr', text } });
      }
    });

    const cancel = (status: Extract<RunStatus, 'cancelled' | 'timed_out'>) => {
      if (terminalOverride) return;
      terminalOverride = status;
      const pgid = child.pid ? -child.pid : null;
      if (pgid !== null) {
        try {
          process.kill(pgid, 'SIGTERM');
        } catch {
          // The process may already have exited.
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(pgid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }, 5_000);
      }
    };

    const completion = new Promise<RunMeta>((resolve, reject) => {
      child.on('close', (exitCode, signal) => {
        if (killTimer) clearTimeout(killTimer);
        stdoutStream.end();
        stderrStream.end();
        void (async () => {
          await stdoutClosed;
          await Promise.allSettled(parseTasks);
          try {
            return await this.finalizeRun(
              runId,
              backend,
              exitCode,
              signal,
              resultEvent,
              sessionId,
              Array.from(filesFromEvents),
              commandsRun,
              terminalOverride,
            );
          } catch (error) {
            return this.failFinalization(runId, error, Array.from(filesFromEvents), commandsRun);
          }
        })().then(resolve, reject);
      });
    });

    return { runId, child, completion, cancel };
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
    const result: WorkerResult = WorkerResultSchema.parse({
      status: 'failed',
      summary: '',
      files_changed: Array.from(new Set(filesFromEvents)).sort(),
      commands_run: commandsRun,
      artifacts: this.store.defaultArtifacts(runId),
      errors: [{
        message: 'run finalization failed',
        context: { error: error instanceof Error ? error.message : String(error) },
      }],
    });

    try {
      return await this.store.markTerminal(runId, 'failed', result.errors, result);
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
    terminalOverride: Extract<RunStatus, 'cancelled' | 'timed_out'> | undefined,
  ): Promise<RunMeta> {
    const meta = await this.store.loadMeta(runId);
    const normalizedFilesFromEvents = await normalizeFilesChangedFromEvents(meta.cwd, filesFromEvents);
    const filesFromGit = meta.git_snapshot_status === 'captured'
      ? await changedFilesSinceSnapshot(meta.cwd, meta.git_snapshot)
      : [];
    const errors = terminalOverride
      ? [{ message: terminalOverride === 'timed_out' ? 'execution timeout exceeded' : 'cancelled by user' }]
      : exitCode === 0 ? [] : [{ message: 'worker process exited unsuccessfully', context: { exit_code: exitCode, signal } }];

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

    try {
      finalized = {
        runStatus: finalized.runStatus,
        result: WorkerResultSchema.parse(finalized.result),
      };
    } catch (error) {
      const failed: WorkerResult = WorkerResultSchema.parse({
        status: 'failed',
        summary: '',
        files_changed: Array.from(new Set([...filesFromGit, ...normalizedFilesFromEvents])).sort(),
        commands_run: commandsRun,
        artifacts: this.store.defaultArtifacts(runId),
        errors: [{ message: 'worker result validation failed', context: { error: error instanceof Error ? error.message : String(error) } }],
      });
      finalized = { runStatus: 'failed', result: failed };
    }

    if (sessionId) {
      await this.store.updateMeta(runId, (current) => ({ ...current, session_id: current.session_id ?? sessionId }));
    }

    return this.store.markTerminal(runId, finalized.runStatus === 'running' ? 'failed' : finalized.runStatus, finalized.result.errors, finalized.result);
  }
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
