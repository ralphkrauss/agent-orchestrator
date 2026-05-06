import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  OrchestratorHooksFileSchema,
  type OrchestratorHookCommandEntry,
  type OrchestratorHooksFile,
  type OrchestratorStatusPayload,
} from '../contract.js';

/**
 * Default per-entry hook timeout (Decision 7). A user hook entry can override
 * with `timeout_ms` up to the hard cap below.
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 1500;
export const MAX_HOOK_TIMEOUT_MS = 5000;

/** Strict ULID format used for orchestrator and event ids. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The only hook event v1 emits today; matches `OrchestratorStatusPayload.event`. */
const ALLOWED_HOOK_EVENTS = new Set<string>(['orchestrator_status_changed']);

/**
 * User-level hook configuration path (Decision 5 / 19). Linux + macOS use
 * `~/.config/agent-orchestrator/hooks.json`. Daemon reads at startup and
 * rereads on mtime change; missing or invalid file → no hooks (logged once).
 */
export function defaultHooksFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdgConfig = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME
    : join(homedir(), '.config');
  return join(xdgConfig, 'agent-orchestrator', 'hooks.json');
}

interface CachedHooksFile {
  mtimeMs: number;
  parsed: OrchestratorHooksFile | null;
}

export interface OrchestratorHookExecutorOptions {
  /** Absolute path to the hooks.json file. Defaults to `defaultHooksFilePath()`. */
  hooksFilePath?: string;
  /** Daemon store root (paths.home). Used for stdio capture under <store_root>/hooks/<orchestrator_id>. */
  storeRoot: string;
  log?: (message: string) => void;
  /** Test seam: replace the spawn implementation. */
  spawnImpl?: typeof spawn;
}

export interface HookExecutionCounters {
  emitted: number;
  successes: number;
  failures: number;
  timeouts: number;
  /** Bumped when the per-event log file or its parent directory fails to open. */
  log_capture_failed: number;
}

/**
 * Loads `~/.config/agent-orchestrator/hooks.json` v1 and executes user hook
 * entries (Claude-parity shell-string form, Decisions 6 / 7 / 25). Best
 * effort: timeouts (default 1500 ms, max 5000 ms) SIGKILL the spawned shell
 * **and its process group** so grandchildren cannot survive, and the daemon
 * orchestration path is never blocked. The daemon never interpolates payload
 * data into `command`; the JSON payload reaches the script via stdin only.
 */
export class OrchestratorHookExecutor {
  private readonly hooksFilePath: string;
  private readonly storeRoot: string;
  private readonly log: (message: string) => void;
  private readonly spawnImpl: typeof spawn;
  private cached: CachedHooksFile | null = null;
  private warnedAboutLoad = false;
  readonly counters: HookExecutionCounters = {
    emitted: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    log_capture_failed: 0,
  };

  constructor(options: OrchestratorHookExecutorOptions) {
    this.hooksFilePath = options.hooksFilePath ?? defaultHooksFilePath();
    this.storeRoot = options.storeRoot;
    this.log = options.log ?? (() => undefined);
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  /** Load + cache the user's hooks.json. Returns null if missing/invalid. */
  async loadHooks(): Promise<OrchestratorHooksFile | null> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(this.hooksFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cached = { mtimeMs: 0, parsed: null };
        return null;
      }
      this.warnOnce(`failed to stat hooks file ${this.hooksFilePath}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (this.cached && this.cached.mtimeMs === info.mtimeMs) return this.cached.parsed;
    let raw: string;
    try {
      raw = await readFile(this.hooksFilePath, 'utf8');
    } catch (error) {
      this.warnOnce(`failed to read hooks file ${this.hooksFilePath}: ${error instanceof Error ? error.message : String(error)}`);
      this.cached = { mtimeMs: info.mtimeMs, parsed: null };
      return null;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      this.warnOnce(`hooks file ${this.hooksFilePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      this.cached = { mtimeMs: info.mtimeMs, parsed: null };
      return null;
    }
    const parsed = OrchestratorHooksFileSchema.safeParse(parsedJson);
    if (!parsed.success) {
      this.warnOnce(`hooks file ${this.hooksFilePath} failed schema validation: ${parsed.error.message}`);
      this.cached = { mtimeMs: info.mtimeMs, parsed: null };
      return null;
    }
    // Reset the warned flag once we successfully parse, so a future invalid
    // edit gets logged again.
    this.warnedAboutLoad = false;
    this.cached = { mtimeMs: info.mtimeMs, parsed: parsed.data };
    return parsed.data;
  }

  /** Fire-and-forget: emit the payload to all configured user hooks. */
  emit(payload: OrchestratorStatusPayload): void {
    void this.emitInternal(payload).catch(() => undefined);
  }

  private async emitInternal(payload: OrchestratorStatusPayload): Promise<void> {
    const file = await this.loadHooks();
    if (!file) return;
    const entries = file.hooks.orchestrator_status_changed ?? [];
    if (entries.length === 0) return;
    this.counters.emitted += 1;
    // Sanitize path components before joining them under store_root so a
    // malformed orchestrator_id, event name, or event_id can't escape the
    // captured-log directory via `..` or absolute paths.
    const safeOrchestratorId = ULID_PATTERN.test(payload.orchestrator.id) ? payload.orchestrator.id : null;
    const safeEvent = ALLOWED_HOOK_EVENTS.has(payload.event) ? payload.event : null;
    const safeEventId = ULID_PATTERN.test(payload.event_id) ? payload.event_id : null;
    let logDir: string | null = null;
    if (safeOrchestratorId) {
      logDir = join(this.storeRoot, 'hooks', safeOrchestratorId);
      try {
        await mkdir(logDir, { recursive: true, mode: 0o700 });
      } catch (error) {
        this.counters.log_capture_failed += 1;
        this.warnOnce(`failed to ensure hook log dir ${logDir}: ${error instanceof Error ? error.message : String(error)}`);
        logDir = null;
      }
    } else {
      this.counters.log_capture_failed += 1;
    }
    for (const entry of entries) {
      const captureLogPath = (logDir && safeEvent && safeEventId)
        ? join(logDir, `${safeEvent}-${safeEventId}.log`)
        : null;
      this.runHookEntry(entry, payload, captureLogPath);
    }
  }

  private runHookEntry(
    entry: OrchestratorHookCommandEntry,
    payload: OrchestratorStatusPayload,
    captureLogPath: string | null,
  ): void {
    const timeoutMs = clampTimeout(entry.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS);
    const env: NodeJS.ProcessEnv = {
      AGENT_ORCHESTRATOR_ORCH_ID: payload.orchestrator.id,
      AGENT_ORCHESTRATOR_EVENT: payload.event,
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      LANG: process.env.LANG ?? '',
      ...(entry.env ?? {}),
    };

    // Try to open the per-event log stream first. If that fails, fall back
    // to /dev/null (stdio: 'ignore') so timeout/exit semantics still hold.
    let logStream: WriteStream | null = null;
    let logStreamFailed = false;
    if (captureLogPath) {
      try {
        logStream = createWriteStream(captureLogPath, { flags: 'a', mode: 0o600 });
        logStream.on('error', (error) => {
          // Surface once; never throw into the orchestration path.
          if (!logStreamFailed) {
            logStreamFailed = true;
            this.counters.log_capture_failed += 1;
            this.log(`hook log capture stream error for ${captureLogPath}: ${error.message}`);
          }
        });
      } catch (error) {
        this.counters.log_capture_failed += 1;
        this.log(`hook log capture failed to open ${captureLogPath}: ${error instanceof Error ? error.message : String(error)}`);
        logStream = null;
      }
    }

    let child: ChildProcess;
    try {
      child = this.spawnImpl(entry.command, {
        shell: true,
        // Detached on POSIX so the hook command (and any grandchildren it
        // launches) lives in its own process group, which we can SIGKILL
        // wholesale on timeout. Windows has no comparable primitive; the
        // child's process tree is best-effort there.
        detached: process.platform !== 'win32',
        stdio: logStream
          ? ['pipe', 'pipe', 'pipe']
          : ['pipe', 'ignore', 'ignore'],
        env,
      });
    } catch (error) {
      this.counters.failures += 1;
      this.log(`hook spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      logStream?.end();
      return;
    }

    let timedOut = false;
    const killHookTree = () => {
      try {
        if (child.pid && process.platform !== 'win32') {
          // Negative pid targets the entire process group, so any
          // grandchildren the hook spawned (e.g. `sleep`) get SIGKILL too.
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* fallthrough */ }
        }
      } catch {
        // best effort
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // best effort
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      this.counters.timeouts += 1;
      killHookTree();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    if (logStream) {
      child.stdout?.on('error', () => undefined);
      child.stderr?.on('error', () => undefined);
      child.stdout?.pipe(logStream, { end: false });
      child.stderr?.pipe(logStream, { end: false });
    }
    child.on('error', (error) => {
      clearTimeout(timer);
      this.counters.failures += 1;
      if (logStream) {
        try { logStream.end(`# spawn error: ${error.message}\n`); } catch { /* best effort */ }
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        if (logStream) {
          try { logStream.end(`# hook timed out after ${timeoutMs}ms\n`); } catch { /* best effort */ }
        }
      } else if (code === 0) {
        this.counters.successes += 1;
        if (logStream) {
          try { logStream.end(); } catch { /* best effort */ }
        }
      } else {
        this.counters.failures += 1;
        if (logStream) {
          try { logStream.end(`# hook exited with code ${code}\n`); } catch { /* best effort */ }
        }
      }
    });
    if (child.stdin) {
      // Stdin write errors must not throw. Worst case the script gets
      // an empty stdin and either copes or fails its own assertions.
      child.stdin.on('error', (error) => {
        this.log(`hook stdin write error: ${error.message}`);
      });
      try {
        child.stdin.end(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.log(`hook stdin write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Detach the parent from the child group so a daemon shutdown does not
    // cascade SIGTERM into the hook's process group through the controlling
    // tty (POSIX only).
    if (process.platform !== 'win32' && typeof child.unref === 'function') {
      try { child.unref(); } catch { /* best effort */ }
    }
  }

  private warnOnce(message: string): void {
    if (this.warnedAboutLoad) return;
    this.warnedAboutLoad = true;
    this.log(message);
  }
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_HOOK_TIMEOUT_MS;
  return Math.min(value, MAX_HOOK_TIMEOUT_MS);
}

/** Convenience helper for tests / pre-flight schema validation. */
export async function readAndValidateHooksFile(path: string): Promise<{ ok: true; value: OrchestratorHooksFile } | { ok: false; error: string }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = OrchestratorHooksFileSchema.safeParse(parsedJson);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, value: parsed.data };
}
