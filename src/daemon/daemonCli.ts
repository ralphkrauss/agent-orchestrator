#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { IpcClient, IpcRequestError } from '../ipc/client.js';
import { daemonPaths } from './paths.js';
import { checkDaemonVersion } from '../daemonVersion.js';
import { getPackageVersion } from '../packageMetadata.js';
import { RunStore, type PruneRunsResult } from '../runStore.js';
import { buildObservabilitySnapshot } from '../observability.js';
import { getBackendStatus } from '../diagnostics.js';
import {
  clampDashboardState,
  formatSnapshot,
  renderDashboard,
  type DashboardState,
  type SnapshotEnvelope,
} from './observabilityFormat.js';
import type { ObservabilitySnapshot, OrchestratorError } from '../contract.js';

const paths = daemonPaths();
const daemonCommands = new Set(['start', 'stop', 'restart', 'status', 'runs', 'watch', 'prune', 'auth']);

export function isDaemonCliCommand(command: string | undefined): boolean {
  return command !== undefined && daemonCommands.has(command);
}

export async function runDaemonCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? 'status';
  switch (command) {
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(daemonHelp());
      break;
    case 'start':
      await start();
      break;
    case 'stop':
      await stop(argv.includes('--force'));
      break;
    case 'restart':
      await restart(argv.includes('--force'));
      break;
    case 'status':
      await status(argv);
      break;
    case 'runs':
      await runs(argv);
      break;
    case 'watch':
      await watch(argv);
      break;
    case 'prune':
      await prune(argv);
      break;
    case 'auth': {
      const { runAuthCli } = await import('../auth/authCli.js');
      const exit = await runAuthCli(argv.slice(1));
      if (exit !== 0) process.exit(exit);
      break;
    }
    default:
      process.stderr.write(daemonHelp());
      process.exit(1);
  }
}

function daemonHelp(): string {
  return [
    'Usage:',
    '  agent-orchestrator start | stop [--force] | restart [--force] | status [--verbose|--json] | runs [--json] [--prompts] | watch [--interval-ms <ms>] [--limit <n>] | prune --older-than-days <days> [--dry-run] | auth ...',
    '  agent-orchestrator-daemon start | stop [--force] | restart [--force] | status [--verbose|--json] | runs [--json] [--prompts] | watch [--interval-ms <ms>] [--limit <n>] | prune --older-than-days <days> [--dry-run] | auth ...',
    '',
  ].join('\n');
}

function pruneUsage(): string {
  return [
    'Usage: agent-orchestrator prune --older-than-days <days> [--dry-run]',
    '   or: agent-orchestrator-daemon prune --older-than-days <days> [--dry-run]',
    '',
  ].join('\n');
}

async function start(): Promise<void> {
  if (await ping()) {
    process.stdout.write('agent-orchestrator daemon is already running\n');
    return;
  }

  const daemonMain = resolve(dirname(fileURLToPath(import.meta.url)), 'daemonMain.js');
  const child = spawn(process.execPath, [daemonMain], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  await waitForDaemon(2_000);
  process.stdout.write(`agent-orchestrator daemon started pid=${await readPid() ?? 'unknown'}\n`);
}

async function stop(force: boolean): Promise<void> {
  const client = new IpcClient(paths.ipc.path);
  try {
    const result = await client.request('shutdown', { force }, 10_000) as { ok: boolean; error?: { details?: { active_runs?: unknown } } };
    if (!result.ok) {
      const activeRuns = Array.isArray(result.error?.details?.active_runs) ? result.error.details.active_runs.join(', ') : '(unknown)';
      process.stderr.write(`daemon refused to stop; active runs: ${activeRuns}\n`);
      process.exit(2);
    }
    process.stdout.write('agent-orchestrator daemon stopping\n');
  } catch (error) {
    const message = error instanceof IpcRequestError ? error.orchestratorError.message : error instanceof Error ? error.message : String(error);
    process.stderr.write(`failed to stop daemon: ${message}\n`);
    process.exit(1);
  }
}

async function restart(force: boolean): Promise<void> {
  if (await ping()) {
    await stop(force);
    await waitForStopped(5_000);
  } else {
    process.stdout.write('agent-orchestrator daemon is stopped\n');
  }
  await start();
}

async function status(argv: readonly string[]): Promise<void> {
  if (argv.includes('--verbose') || argv.includes('--json')) {
    const envelope = await readSnapshotFromDaemonOrStore(snapshotOptionsFromArgs(argv, { includePrompts: argv.includes('--prompts') }));
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stdout.write(formatSnapshot(envelope));
    }
    return;
  }

  const client = new IpcClient(paths.ipc.path);
  try {
    const pingResult = await client.request('ping', {}) as { ok: true; pong: true; daemon_pid: number; daemon_version?: string };
    let runs = 'unavailable';
    try {
      const listResult = await client.request('list_runs', {}) as { ok: true; runs: { status: string }[] };
      const counts = new Map<string, number>();
      for (const run of listResult.runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
      runs = JSON.stringify(Object.fromEntries(counts));
    } catch (error) {
      if (!(error instanceof IpcRequestError && error.orchestratorError.code === 'DAEMON_VERSION_MISMATCH')) {
        throw error;
      }
    }
    const daemonVersion = typeof pingResult.daemon_version === 'string' ? pingResult.daemon_version : null;
    const frontendVersion = getPackageVersion();
    const versionMatch = daemonVersion === frontendVersion;
    process.stdout.write(`running pid=${pingResult.daemon_pid} daemon_version=${daemonVersion ?? 'unknown'} frontend_version=${frontendVersion} version_match=${versionMatch} runs=${runs}\n`);
  } catch {
    process.stdout.write('stopped\n');
    process.exitCode = 1;
  }
}

async function runs(argv: readonly string[]): Promise<void> {
  const envelope = await readSnapshotFromDaemonOrStore(snapshotOptionsFromArgs(argv, { includePrompts: argv.includes('--prompts') }));
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    process.stdout.write(formatSnapshot(envelope));
  }
}

async function watch(argv: readonly string[]): Promise<void> {
  const intervalMs = readPositiveIntOption(argv, '--interval-ms') ?? 1_000;
  const options = snapshotOptionsFromArgs(argv, { includePrompts: true });
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stdout.write(formatSnapshot(await readSnapshotFromDaemonOrStore(options)));
    return;
  }

  let envelope = await readSnapshotFromDaemonOrStore(options);
  let state: DashboardState = { view: 'sessions', selectedSession: 0, selectedPrompt: 0 };
  let stopped = false;
  let refreshTimer: NodeJS.Timeout | null = null;
  let resolveDone: (() => void) | null = null;

  const finish = () => {
    if (stopped) return;
    stopped = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    process.stdin.off('data', onKey);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[?25h\x1b[0m\n');
    resolveDone?.();
  };

  const repaint = () => {
    state = clampDashboardState(state, envelope.snapshot);
    process.stdout.write('\x1b[?25l\x1b[H\x1b[2J');
    process.stdout.write(renderDashboard(envelope, state, process.stdout.columns ?? 100, process.stdout.rows ?? 30));
  };

  const refresh = async () => {
    if (stopped) return;
    try {
      envelope = await readSnapshotFromDaemonOrStore(options);
    } catch (error) {
      envelope = {
        running: false,
        snapshot: {
          generated_at: new Date().toISOString(),
          daemon_pid: null,
          store_root: paths.home,
          sessions: [],
          runs: [],
          backend_status: null,
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (stopped) return;
    repaint();
    refreshTimer = setTimeout(refresh, intervalMs);
  };

  const onKey = (chunk: Buffer) => {
    const key = chunk.toString('utf8');
    if (key === '\u0003' || key === 'q') {
      finish();
      return;
    }
    if (key === '\x1b[A') {
      if (state.view === 'sessions') state.selectedSession -= 1;
      if (state.view === 'prompts' || state.view === 'detail') state.selectedPrompt -= 1;
      repaint();
      return;
    }
    if (key === '\x1b[B') {
      if (state.view === 'sessions') state.selectedSession += 1;
      if (state.view === 'prompts' || state.view === 'detail') state.selectedPrompt += 1;
      repaint();
      return;
    }
    if (key === '\r' || key === '\n') {
      if (state.view === 'sessions') state.view = 'prompts';
      else if (state.view === 'prompts') state.view = 'detail';
      repaint();
      return;
    }
    if (key === '\x7f' || key === '\x1b') {
      if (state.view === 'detail') state.view = 'prompts';
      else if (state.view === 'prompts') state.view = 'sessions';
      repaint();
    }
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  process.once('SIGINT', finish);
  process.once('SIGTERM', finish);
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  await refresh();
  await done;
}

async function prune(argv: readonly string[]): Promise<void> {
  const olderThanDays = readPositiveIntOption(argv, '--older-than-days');
  if (!olderThanDays) {
    process.stderr.write(pruneUsage());
    process.exit(1);
  }

  const params = {
    older_than_days: olderThanDays,
    dry_run: argv.includes('--dry-run'),
  };
  let result: PruneRunsResult;
  if (await ping()) {
    const client = new IpcClient(paths.ipc.path);
    result = await client.request('prune_runs', params, 30_000) as PruneRunsResult;
  } else {
    result = await new RunStore(paths.home).pruneTerminalRuns(params.older_than_days, params.dry_run);
  }

  const action = result.dry_run ? 'would delete' : 'deleted';
  const count = result.dry_run ? result.matched.length : result.deleted_run_ids.length;
  process.stdout.write(`${action} ${count} terminal runs older than ${olderThanDays} days\n`);
  for (const run of result.matched) {
    process.stdout.write(`${run.run_id} ${run.status} ${run.finished_at ?? ''}\n`);
  }
}

interface SnapshotOptions {
  limit: number;
  includePrompts: boolean;
  recentEventLimit: number;
  diagnostics: boolean;
}

function snapshotOptionsFromArgs(argv: readonly string[], defaults: Partial<SnapshotOptions> = {}): SnapshotOptions {
  return {
    limit: readPositiveIntOption(argv, '--limit') ?? defaults.limit ?? 50,
    includePrompts: defaults.includePrompts ?? false,
    recentEventLimit: readPositiveIntOption(argv, '--recent-events') ?? defaults.recentEventLimit ?? 5,
    diagnostics: argv.includes('--diagnostics') || defaults.diagnostics === true,
  };
}

async function readSnapshotFromDaemonOrStore(options: SnapshotOptions): Promise<SnapshotEnvelope> {
  const params = {
    limit: options.limit,
    include_prompts: options.includePrompts,
    recent_event_limit: options.recentEventLimit,
    diagnostics: options.diagnostics,
  };
  const pingResult = await pingDaemon();
  if (pingResult) {
    const versionCheck = checkDaemonVersion(pingResult);
    if (!versionCheck.ok) {
      return readSnapshotFromStore(options, {
        running: true,
        daemonPid: errorDetailNumber(versionCheck.error, 'daemon_pid'),
        daemonVersion: errorDetailString(versionCheck.error, 'daemon_version'),
        error: versionCheck.error.message,
      });
    }

    const client = new IpcClient(paths.ipc.path);
    const result = await client.request('get_observability_snapshot', params, 30_000) as {
      ok: boolean;
      snapshot?: ObservabilitySnapshot;
      error?: { message?: string };
    };
    if (result.ok && result.snapshot) return { running: true, snapshot: result.snapshot };
    throw new Error(result.error?.message ?? 'failed to read observability snapshot');
  }

  return readSnapshotFromStore(options, { running: false });
}

async function readSnapshotFromStore(
  options: SnapshotOptions,
  state: { running: boolean; daemonPid?: number | null; daemonVersion?: string | null; error?: string },
): Promise<SnapshotEnvelope> {
  return {
    running: state.running,
    snapshot: await buildObservabilitySnapshot(new RunStore(paths.home), {
      limit: options.limit,
      includePrompts: options.includePrompts,
      recentEventLimit: options.recentEventLimit,
      daemonPid: state.daemonPid ?? null,
      backendStatus: options.diagnostics ? await getBackendStatus({
        frontendVersion: getPackageVersion(),
        daemonVersion: state.daemonVersion ?? null,
        daemonPid: state.daemonPid ?? null,
      }) : null,
    }),
    error: state.error,
  };
}

async function ping(): Promise<boolean> {
  return (await pingDaemon()) !== null;
}

async function pingDaemon(): Promise<unknown | null> {
  try {
    const client = new IpcClient(paths.ipc.path);
    return await client.request('ping', {}, 1000);
  } catch {
    return null;
  }
}

function errorDetailString(error: OrchestratorError, key: string): string | null {
  const value = error.details?.[key];
  return typeof value === 'string' ? value : null;
}

function errorDetailNumber(error: OrchestratorError, key: string): number | null {
  const value = error.details?.[key];
  return typeof value === 'number' ? value : null;
}

async function waitForDaemon(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('daemon did not start before timeout');
}

async function waitForStopped(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await ping()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('daemon did not stop before timeout');
}

async function readPid(): Promise<string | null> {
  if (!existsSync(paths.pid)) return null;
  return (await readFile(paths.pid, 'utf8')).trim();
}

function readPositiveIntOption(argv: readonly string[], name: string): number | null {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) {
      const value = Number.parseInt(argv[index + 1] ?? '', 10);
      return Number.isInteger(value) && value > 0 ? value : null;
    }
    if (arg?.startsWith(`${name}=`)) {
      const value = Number.parseInt(arg.slice(name.length + 1), 10);
      return Number.isInteger(value) && value > 0 ? value : null;
    }
  }
  return null;
}
