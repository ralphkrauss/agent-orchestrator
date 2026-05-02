#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { IpcClient, IpcRequestError } from '../ipc/client.js';
import { daemonPaths } from './paths.js';
import { getPackageVersion } from '../packageMetadata.js';
import { RunStore, type PruneRunsResult } from '../runStore.js';

const paths = daemonPaths();
const command = process.argv[2] ?? 'status';

async function main(): Promise<void> {
  switch (command) {
    case 'start':
      await start();
      break;
    case 'stop':
      await stop(process.argv.includes('--force'));
      break;
    case 'restart':
      await restart(process.argv.includes('--force'));
      break;
    case 'status':
      await status();
      break;
    case 'prune':
      await prune();
      break;
    default:
      process.stderr.write('Usage: daemonCli.js start | stop [--force] | restart [--force] | status | prune --older-than-days <days> [--dry-run]\n');
      process.exit(1);
  }
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
  const client = new IpcClient(paths.socket);
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

async function status(): Promise<void> {
  const client = new IpcClient(paths.socket);
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

async function prune(): Promise<void> {
  const olderThanDays = readPositiveIntOption('--older-than-days');
  if (!olderThanDays) {
    process.stderr.write('Usage: daemonCli.js prune --older-than-days <days> [--dry-run]\n');
    process.exit(1);
  }

  const params = {
    older_than_days: olderThanDays,
    dry_run: process.argv.includes('--dry-run'),
  };
  let result: PruneRunsResult;
  if (await ping()) {
    const client = new IpcClient(paths.socket);
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

async function ping(): Promise<boolean> {
  try {
    const client = new IpcClient(paths.socket);
    await client.request('ping', {}, 1000);
    return true;
  } catch {
    return false;
  }
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

function readPositiveIntOption(name: string): number | null {
  for (let index = 3; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === name) {
      const value = Number.parseInt(process.argv[index + 1] ?? '', 10);
      return Number.isInteger(value) && value > 0 ? value : null;
    }
    if (arg?.startsWith(`${name}=`)) {
      const value = Number.parseInt(arg.slice(name.length + 1), 10);
      return Number.isInteger(value) && value > 0 ? value : null;
    }
  }
  return null;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
