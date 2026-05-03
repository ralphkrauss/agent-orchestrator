import { IpcClient, IpcRequestError } from './ipc/client.js';
import { daemonPaths } from './daemon/paths.js';
import {
  RunNotificationSchema,
  type RunNotification,
  type RunStatus,
  type RunTerminalReason,
} from './contract.js';
import { ipcTimeoutForTool } from './toolTimeout.js';

export interface MonitorCliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface MonitorCliOptions {
  runId: string;
  jsonLine: boolean;
  sinceNotificationId?: string;
  pollSeconds?: number;
}

export interface MonitorCliJsonLine {
  run_id: string;
  notification_id: string;
  kind: 'terminal' | 'fatal_error';
  status: RunStatus;
  terminal_reason: RunTerminalReason | string | null;
  latest_error: RunNotification['latest_error'];
}

export const MONITOR_EXIT_TERMINAL_COMPLETED = 0;
export const MONITOR_EXIT_TERMINAL_FAILED = 1;
export const MONITOR_EXIT_TERMINAL_CANCELLED = 2;
export const MONITOR_EXIT_TERMINAL_TIMED_OUT = 3;
export const MONITOR_EXIT_UNKNOWN_RUN = 4;
export const MONITOR_EXIT_DAEMON_UNAVAILABLE = 5;
export const MONITOR_EXIT_ARGUMENT_ERROR = 6;
export const MONITOR_EXIT_FATAL_ERROR = 10;
export const MONITOR_EXIT_INTERNAL = 7;

export function parseMonitorCliArgs(argv: readonly string[]): { ok: true; value: MonitorCliOptions } | { ok: false; error: string } {
  let runId: string | null = null;
  let jsonLine = false;
  let sinceNotificationId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') {
      return { ok: false, error: '__HELP__' };
    } else if (arg === '--json-line') {
      jsonLine = true;
    } else if (arg === '--since') {
      const value = argv[++index];
      if (!value) return { ok: false, error: '--since requires a notification id value' };
      sinceNotificationId = value;
    } else if (arg.startsWith('--since=')) {
      sinceNotificationId = arg.slice('--since='.length);
      if (!sinceNotificationId) return { ok: false, error: '--since requires a notification id value' };
    } else if (arg.startsWith('-')) {
      return { ok: false, error: `Unknown monitor option: ${arg}` };
    } else if (runId === null) {
      runId = arg;
    } else {
      return { ok: false, error: `Unexpected positional argument: ${arg}` };
    }
  }
  if (!runId) return { ok: false, error: 'monitor requires a positional run_id argument' };
  return { ok: true, value: { runId, jsonLine, sinceNotificationId } };
}

export function monitorCliHelp(): string {
  return `agent-orchestrator monitor

Usage:
  agent-orchestrator monitor <run_id> [--json-line] [--since <notification_id>]

Blocks against the local daemon until the run reaches a terminal state or
emits a fatal_error notification. Emits exactly one JSON line on stdout for
the wake notification and exits with the documented exit-code table:
  0  terminal+completed
  1  terminal+failed or terminal+orphaned
  2  terminal+cancelled
  3  terminal+timed_out
  10 fatal_error (run may still be running; supervisor must react)
  4  unknown run
  5  daemon unavailable
  6  argument error
`;
}

export async function runMonitorCli(
  argv: readonly string[],
  io: MonitorCliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const parsed = parseMonitorCliArgs(argv);
  if (!parsed.ok) {
    if (parsed.error === '__HELP__') {
      io.stdout.write(monitorCliHelp());
      return 0;
    }
    io.stderr.write(`${parsed.error}\nRun agent-orchestrator monitor --help for usage.\n`);
    return MONITOR_EXIT_ARGUMENT_ERROR;
  }
  const options = parsed.value;
  const client = new IpcClient(daemonPaths().ipc.path);

  try {
    const exists = await ensureRunExists(client, options.runId);
    if (!exists) {
      io.stderr.write(`Unknown run: ${options.runId}\n`);
      return MONITOR_EXIT_UNKNOWN_RUN;
    }
  } catch (error) {
    if (error instanceof IpcRequestError && error.orchestratorError.code === 'UNKNOWN_RUN') {
      io.stderr.write(`Unknown run: ${options.runId}\n`);
      return MONITOR_EXIT_UNKNOWN_RUN;
    }
    if (error instanceof IpcRequestError && error.orchestratorError.code === 'DAEMON_UNAVAILABLE') {
      io.stderr.write(`Daemon unavailable: ${error.orchestratorError.message}\n`);
      return MONITOR_EXIT_DAEMON_UNAVAILABLE;
    }
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return MONITOR_EXIT_INTERNAL;
  }

  let cursor = options.sinceNotificationId;
  const waitChunkSeconds = 60;
  while (true) {
    let response: { ok: boolean; notifications?: unknown[]; wait_exceeded?: boolean };
    try {
      const params: Record<string, unknown> = {
        run_ids: [options.runId],
        wait_seconds: waitChunkSeconds,
      };
      if (cursor) params.after_notification_id = cursor;
      response = await client.request('wait_for_any_run', params, ipcTimeoutForTool('wait_for_any_run', params));
    } catch (error) {
      if (error instanceof IpcRequestError && error.orchestratorError.code === 'DAEMON_UNAVAILABLE') {
        io.stderr.write(`Daemon unavailable: ${error.orchestratorError.message}\n`);
        return MONITOR_EXIT_DAEMON_UNAVAILABLE;
      }
      if (error instanceof IpcRequestError && error.orchestratorError.code === 'UNKNOWN_RUN') {
        io.stderr.write(`Unknown run: ${options.runId}\n`);
        return MONITOR_EXIT_UNKNOWN_RUN;
      }
      io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return MONITOR_EXIT_INTERNAL;
    }
    if (!response.ok) {
      io.stderr.write('wait_for_any_run failed\n');
      return MONITOR_EXIT_INTERNAL;
    }
    const notifications = Array.isArray(response.notifications) ? response.notifications : [];
    for (const raw of notifications) {
      const parsedRecord = RunNotificationSchema.safeParse(raw);
      if (!parsedRecord.success) continue;
      const record = parsedRecord.data;
      if (cursor === undefined || record.notification_id > cursor) cursor = record.notification_id;
      if (record.run_id !== options.runId) continue;
      if (record.kind !== 'terminal' && record.kind !== 'fatal_error') continue;
      const line: MonitorCliJsonLine = {
        run_id: record.run_id,
        notification_id: record.notification_id,
        kind: record.kind,
        status: record.status,
        terminal_reason: record.terminal_reason ?? null,
        latest_error: record.latest_error,
      };
      io.stdout.write(`${JSON.stringify(line)}\n`);
      return monitorExitCode(record.kind, record.status);
    }
    if (response.wait_exceeded === false && notifications.length === 0) {
      // No matching notification yet; continue.
    }
  }
}

async function ensureRunExists(client: IpcClient, runId: string): Promise<boolean> {
  try {
    const result = await client.request<{ ok: boolean; run_summary?: unknown }>('get_run_status', { run_id: runId }, 5_000);
    return result.ok === true && result.run_summary !== undefined;
  } catch (error) {
    throw error;
  }
}

function monitorExitCode(kind: 'terminal' | 'fatal_error', status: RunStatus): number {
  if (kind === 'fatal_error') return MONITOR_EXIT_FATAL_ERROR;
  if (status === 'completed') return MONITOR_EXIT_TERMINAL_COMPLETED;
  if (status === 'cancelled') return MONITOR_EXIT_TERMINAL_CANCELLED;
  if (status === 'timed_out') return MONITOR_EXIT_TERMINAL_TIMED_OUT;
  return MONITOR_EXIT_TERMINAL_FAILED;
}
