import { appendFile, chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { ulid } from 'ulid';
import {
  type Backend,
  type GitSnapshot,
  type GitSnapshotStatus,
  isTerminalStatus,
  type ModelSource,
  type RunDisplayMetadata,
  type RunMeta,
  type RunModelSettings,
  RunMetaSchema,
  type RunStatus,
  type TerminalRunStatus,
  type WorkerEvent,
  WorkerEventSchema,
  type WorkerResult,
  WorkerResultSchema,
} from './contract.js';

const rootMode = 0o700;
const fileMode = 0o600;
const maxLockAttempts = 200;

interface LockMetadata {
  pid: number;
  acquired_at: string;
}

export interface CreateRunInput {
  backend: Backend;
  cwd: string;
  prompt?: string;
  model?: string | null;
  model_source?: ModelSource;
  model_settings?: RunModelSettings;
  parent_run_id?: string | null;
  session_id?: string | null;
  requested_session_id?: string | null;
  observed_session_id?: string | null;
  observed_model?: string | null;
  display?: RunDisplayMetadata;
  metadata?: Record<string, unknown>;
  execution_timeout_seconds?: number | null;
  git_snapshot_status?: GitSnapshotStatus;
  git_snapshot?: GitSnapshot | null;
}

export interface RunRecord {
  meta: RunMeta;
  events: WorkerEvent[];
  result: WorkerResult | null;
}

export interface ReadEventsResult {
  events: WorkerEvent[];
  next_sequence: number;
  has_more: boolean;
}

export interface PrunedRun {
  run_id: string;
  status: TerminalRunStatus;
  finished_at: string | null;
}

export interface PruneRunsResult {
  dry_run: boolean;
  cutoff: string;
  matched: PrunedRun[];
  deleted_run_ids: string[];
}

export class RunStore {
  readonly root: string;
  private readonly daemonStartedMs: number;

  constructor(root = resolveStoreRoot()) {
    this.root = root;
    this.daemonStartedMs = Date.now() - (process.uptime() * 1000);
  }

  async ensureReady(): Promise<void> {
    await ensureSecureRoot(this.root);
    await mkdir(this.runsRoot(), { recursive: true, mode: rootMode });
  }

  runsRoot(): string {
    return join(this.root, 'runs');
  }

  runDir(runId: string): string {
    return join(this.runsRoot(), runId);
  }

  async createRun(input: CreateRunInput): Promise<RunMeta> {
    await this.ensureReady();
    const now = new Date().toISOString();
    const runId = ulid();
    const meta: RunMeta = {
      run_id: runId,
      backend: input.backend,
      status: 'running',
      parent_run_id: input.parent_run_id ?? null,
      session_id: input.session_id ?? null,
      model: input.model ?? null,
      model_source: input.model_source ?? 'legacy_unknown',
      model_settings: input.model_settings ?? {
        reasoning_effort: null,
        service_tier: null,
        mode: null,
      },
      requested_session_id: input.requested_session_id ?? null,
      observed_session_id: input.observed_session_id ?? null,
      observed_model: input.observed_model ?? null,
      display: input.display ?? {
        session_title: null,
        session_summary: null,
        prompt_title: null,
        prompt_summary: null,
      },
      cwd: input.cwd,
      created_at: now,
      started_at: null,
      finished_at: null,
      worker_pid: null,
      worker_pgid: null,
      daemon_pid_at_spawn: null,
      worker_invocation: null,
      git_snapshot_status: input.git_snapshot_status ?? 'not_a_repo',
      git_snapshot: input.git_snapshot ?? null,
      git_snapshot_at_start: input.git_snapshot ?? null,
      execution_timeout_seconds: input.execution_timeout_seconds ?? null,
      metadata: input.metadata ?? {},
    };

    const dir = this.runDir(runId);
    await mkdir(dir, { recursive: false, mode: rootMode });
    await writeFile(this.eventsPath(runId), '', { mode: fileMode });
    await writeFile(this.eventSeqPath(runId), '0\n', { mode: fileMode });
    await writeFile(this.promptPath(runId), input.prompt ?? '', { mode: fileMode });
    await writeFile(this.stdoutPath(runId), '', { mode: fileMode });
    await writeFile(this.stderrPath(runId), '', { mode: fileMode });
    await writeAtomicJson(this.metaPath(runId), meta);
    return meta;
  }

  async updateMeta(runId: string, updater: (meta: RunMeta) => RunMeta | Promise<RunMeta>): Promise<RunMeta> {
    return this.withRunLock(runId, async () => {
      const current = await this.loadMeta(runId);
      const next = RunMetaSchema.parse(await updater(current));
      await writeAtomicJson(this.metaPath(runId), next);
      return next;
    });
  }

  async appendEvent(runId: string, event: Omit<WorkerEvent, 'seq' | 'ts'>): Promise<WorkerEvent> {
    return this.withRunLock(runId, async () => {
      const lastSeq = await this.getLastSequence(runId);
      const full = WorkerEventSchema.parse({
        ...event,
        seq: lastSeq + 1,
        ts: new Date().toISOString(),
      });
      await appendFile(this.eventsPath(runId), `${JSON.stringify(full)}\n`, { mode: fileMode });
      await writeFile(this.eventSeqPath(runId), `${full.seq}\n`, { mode: fileMode });
      return full;
    });
  }

  async writeResult(runId: string, result: WorkerResult): Promise<void> {
    await writeAtomicJson(this.resultPath(runId), WorkerResultSchema.parse(result));
  }

  async readPrompt(runId: string): Promise<string | null> {
    try {
      return await readFile(this.promptPath(runId), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async loadRun(runId: string): Promise<RunRecord | null> {
    try {
      const meta = await this.loadMeta(runId);
      const events = await this.readAllEvents(runId);
      const result = await this.loadResult(runId);
      return { meta, events, result };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async loadMeta(runId: string): Promise<RunMeta> {
    return RunMetaSchema.parse(JSON.parse(await readFile(this.metaPath(runId), 'utf8')));
  }

  async loadResult(runId: string): Promise<WorkerResult | null> {
    try {
      return WorkerResultSchema.parse(JSON.parse(await readFile(this.resultPath(runId), 'utf8')));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async listRuns(): Promise<RunMeta[]> {
    await this.ensureReady();
    let dirs: string[];
    try {
      dirs = await readdir(this.runsRoot());
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const runs: RunMeta[] = [];
    for (const dir of dirs) {
      try {
        runs.push(await this.loadMeta(dir));
      } catch {
        // Ignore partially-created or manually edited run dirs.
      }
    }

    return runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async readEvents(runId: string, afterSequence = 0, limit = 200): Promise<ReadEventsResult> {
    return this.readEventsPage(runId, afterSequence, limit);
  }

  async readEventSummary(runId: string, recentLimit = 5): Promise<{
    event_count: number;
    last_event: WorkerEvent | null;
    recent_events: WorkerEvent[];
  }> {
    const event_count = await this.getLastSequence(runId, true);
    const recent_events = await this.readRecentEventsFromLog(runId, recentLimit);
    return {
      event_count,
      last_event: recent_events.at(-1) ?? null,
      recent_events,
    };
  }

  async markTerminal(
    runId: string,
    status: TerminalRunStatus,
    errors: { message: string; context?: Record<string, unknown> }[] = [],
    result?: WorkerResult,
  ): Promise<RunMeta> {
    return this.withRunLock(runId, async () => {
      const current = await this.loadMeta(runId);
      if (isTerminalStatus(current.status)) return current;

      const finished = new Date().toISOString();
      const next = RunMetaSchema.parse({
        ...current,
        status,
        finished_at: finished,
      });
      const finalResult = result ?? WorkerResultSchema.parse({
        status: status === 'completed' ? 'completed' : 'failed',
        summary: '',
        files_changed: [],
        commands_run: [],
        artifacts: this.defaultArtifacts(runId),
        errors,
      });
      await writeAtomicJson(this.resultPath(runId), finalResult);
      await writeAtomicJson(this.metaPath(runId), next);
      const lastSeq = await this.getLastSequence(runId);
      const event = WorkerEventSchema.parse({
        seq: lastSeq + 1,
        ts: finished,
        type: 'lifecycle',
        payload: { status, errors },
      });
      await appendFile(this.eventsPath(runId), `${JSON.stringify(event)}\n`, { mode: fileMode });
      await writeFile(this.eventSeqPath(runId), `${event.seq}\n`, { mode: fileMode });
      return next;
    });
  }

  defaultArtifacts(runId: string): { name: string; path: string }[] {
    return [
      { name: 'result.json', path: this.resultPath(runId) },
      { name: 'prompt.txt', path: this.promptPath(runId) },
      { name: 'stdout.log', path: this.stdoutPath(runId) },
      { name: 'stderr.log', path: this.stderrPath(runId) },
      { name: 'events.jsonl', path: this.eventsPath(runId) },
    ];
  }

  metaPath(runId: string): string {
    return join(this.runDir(runId), 'meta.json');
  }

  resultPath(runId: string): string {
    return join(this.runDir(runId), 'result.json');
  }

  promptPath(runId: string): string {
    return join(this.runDir(runId), 'prompt.txt');
  }

  eventsPath(runId: string): string {
    return join(this.runDir(runId), 'events.jsonl');
  }

  eventSeqPath(runId: string): string {
    return join(this.runDir(runId), '.events.seq');
  }

  stdoutPath(runId: string): string {
    return join(this.runDir(runId), 'stdout.log');
  }

  stderrPath(runId: string): string {
    return join(this.runDir(runId), 'stderr.log');
  }

  private lockPath(runId: string): string {
    return join(this.runDir(runId), '.lock');
  }

  private async readAllEvents(runId: string): Promise<WorkerEvent[]> {
    const text = await readFile(this.eventsPath(runId), 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => WorkerEventSchema.parse(JSON.parse(line)));
  }

  private async getLastSequence(runId: string, reconcileLog = false): Promise<number> {
    try {
      const seq = Number.parseInt((await readFile(this.eventSeqPath(runId), 'utf8')).trim(), 10);
      if (Number.isInteger(seq) && seq >= 0) {
        if (!reconcileLog) return seq;
        const logSeq = await this.readLastEventSequenceFromLog(runId);
        if (logSeq > seq) {
          await writeFile(this.eventSeqPath(runId), `${logSeq}\n`, { mode: fileMode });
          return logSeq;
        }
        return seq;
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    try {
      const seq = await this.readLastEventSequenceFromLog(runId);
      await writeFile(this.eventSeqPath(runId), `${seq}\n`, { mode: fileMode });
      return seq;
    } catch (error) {
      if (isNotFound(error)) return 0;
      throw error;
    }
  }

  async pruneTerminalRuns(olderThanDays: number, dryRun = false): Promise<PruneRunsResult> {
    const cutoffMs = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    const cutoff = new Date(cutoffMs).toISOString();
    const matched: PrunedRun[] = [];
    for (const run of await this.listRuns()) {
      if (!isTerminalStatus(run.status) || !run.finished_at) continue;
      const finishedMs = Date.parse(run.finished_at);
      if (!Number.isFinite(finishedMs) || finishedMs >= cutoffMs) continue;
      matched.push({
        run_id: run.run_id,
        status: run.status,
        finished_at: run.finished_at,
      });
    }

    const deleted_run_ids: string[] = [];
    if (!dryRun) {
      for (const run of matched) {
        await rm(this.runDir(run.run_id), { recursive: true, force: true });
        deleted_run_ids.push(run.run_id);
      }
    }

    return { dry_run: dryRun, cutoff, matched, deleted_run_ids };
  }

  private async readEventsPage(runId: string, afterSequence: number, limit: number): Promise<ReadEventsResult> {
    const events: WorkerEvent[] = [];
    let has_more = false;
    const stream = createReadStream(this.eventsPath(runId), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        const event = WorkerEventSchema.parse(JSON.parse(line));
        if (event.seq <= afterSequence) continue;
        if (events.length >= limit) {
          has_more = true;
          break;
        }
        events.push(event);
      }
    } finally {
      lines.close();
      stream.destroy();
    }

    return {
      events,
      next_sequence: events.length > 0 ? events[events.length - 1]!.seq : afterSequence,
      has_more,
    };
  }

  private async readLastEventSequenceFromLog(runId: string): Promise<number> {
    const path = this.eventsPath(runId);
    const info = await stat(path);
    if (info.size === 0) return 0;

    const bytesToRead = Math.min(info.size, 64 * 1024);
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, info.size - bytesToRead);
      const lastLine = buffer.toString('utf8').trimEnd().split('\n').at(-1);
      if (!lastLine) return 0;
      return WorkerEventSchema.parse(JSON.parse(lastLine)).seq;
    } catch {
      const events = await this.readAllEvents(runId);
      return events.at(-1)?.seq ?? 0;
    } finally {
      await handle.close();
    }
  }

  private async readRecentEventsFromLog(runId: string, limit: number): Promise<WorkerEvent[]> {
    if (limit <= 0) return [];
    const path = this.eventsPath(runId);
    const info = await stat(path);
    if (info.size === 0) return [];

    let bytesToRead = Math.min(info.size, 64 * 1024);
    while (true) {
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(bytesToRead);
        await handle.read(buffer, 0, bytesToRead, info.size - bytesToRead);
        const text = buffer.toString('utf8');
        const lines = text.split('\n').filter(Boolean);
        const hasFileStart = bytesToRead === info.size;
        if (hasFileStart || lines.length > limit) {
          const completeLines = hasFileStart ? lines : lines.slice(1);
          return completeLines
            .slice(-limit)
            .map((line) => WorkerEventSchema.parse(JSON.parse(line)));
        }
      } finally {
        await handle.close();
      }

      const nextBytes = Math.min(info.size, bytesToRead * 2);
      if (nextBytes === bytesToRead) return this.readAllEvents(runId).then((events) => events.slice(-limit));
      bytesToRead = nextBytes;
    }
  }

  private async withRunLock<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const lockPath = this.lockPath(runId);
    await mkdir(dirname(lockPath), { recursive: true, mode: rootMode });
    for (let attempt = 0; attempt < maxLockAttempts; attempt += 1) {
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, fileMode);
        const metadata: LockMetadata = { pid: process.pid, acquired_at: new Date().toISOString() };
        await handle.writeFile(`${JSON.stringify(metadata)}\n`);
        return await action();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.breakStaleRunLock(lockPath);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        if (handle) {
          await handle.close();
          await rm(lockPath, { force: true });
        }
      }
    }

    throw new Error(`Timed out waiting for run lock ${runId}`);
  }

  private async breakStaleRunLock(lockPath: string): Promise<void> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(lockPath);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }

    if (info.mtimeMs <= this.daemonStartedMs) {
      await rm(lockPath, { force: true });
      return;
    }

    const ownerPid = await readLockOwnerPid(lockPath);
    if (ownerPid !== null && !isPidAlive(ownerPid)) {
      await rm(lockPath, { force: true });
    }
  }
}

export function resolveStoreRoot(): string {
  return process.env.AGENT_ORCHESTRATOR_HOME || join(homedir(), '.agent-orchestrator');
}

export async function ensureSecureRoot(root: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  await mkdir(root, { recursive: true, mode: rootMode });
  const info = await stat(root);
  if (platform === 'win32') return;

  const getuid = process.getuid?.();
  if (typeof getuid === 'number' && info.uid !== getuid) {
    throw new Error(`Agent orchestrator home ${root} is owned by uid ${info.uid}, expected ${getuid}`);
  }

  if ((info.mode & 0o777) !== rootMode) {
    await chmod(root, rootMode);
  }
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: fileMode });
  await rename(tmp, path);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readLockOwnerPid(lockPath: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<LockMetadata>;
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type { RunStatus };
