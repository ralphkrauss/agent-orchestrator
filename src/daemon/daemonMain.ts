#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { IpcServer } from '../ipc/server.js';
import { createBackendRegistry } from '../backend/registry.js';
import { OrchestratorService } from '../orchestratorService.js';
import { RunStore, ensureSecureRoot } from '../runStore.js';
import { daemonPaths } from './paths.js';

const paths = daemonPaths();
let pidFd: number | null = null;
let ipcServer: IpcServer | null = null;

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  appendFileSync(paths.log, line, { mode: 0o600 });
  process.stderr.write(line);
}

async function main(): Promise<void> {
  await ensureSecureRoot(paths.home);
  acquirePidFile();
  await cleanupIpcEndpoint();

  const store = new RunStore(paths.home);
  const service = new OrchestratorService(store, createBackendRegistry(), log);
  await service.initialize();

  ipcServer = new IpcServer(paths.ipc.path, async (method, params) => service.dispatch(method, params));
  if (paths.ipc.transport === 'unix_socket') {
    const oldUmask = process.umask(0o177);
    try {
      await ipcServer.listen();
    } finally {
      process.umask(oldUmask);
    }
  } else {
    await ipcServer.listen();
  }

  log(`daemon started pid=${process.pid} ipc=${paths.ipc.path}`);

  const forceShutdown = () => {
    void service.shutdown({ force: true });
  };
  process.on('SIGTERM', forceShutdown);
  process.on('SIGINT', forceShutdown);
}

function acquirePidFile(): void {
  try {
    pidFd = openSync(paths.pid, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existingPid = readExistingPid();
    if (existingPid && isPidAlive(existingPid)) {
      throw new Error(`another agent-orchestrator daemon is running with pid ${existingPid}`);
    }
    unlinkSync(paths.pid);
    pidFd = openSync(paths.pid, 'wx', 0o600);
  }
  writeFileSync(pidFd, `${process.pid}\n`);
}

function readExistingPid(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(paths.pid, 'utf8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
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

async function cleanupIpcEndpoint(): Promise<void> {
  if (!paths.ipc.cleanupPath || !existsSync(paths.ipc.cleanupPath)) return;
  const info = await lstat(paths.ipc.cleanupPath);
  const uid = process.getuid?.();
  if (typeof uid === 'number' && info.uid !== uid) {
    throw new Error(`Refusing to remove foreign-owned IPC endpoint ${paths.ipc.cleanupPath} owned by uid ${info.uid}`);
  }
  await rm(paths.ipc.cleanupPath, { force: true });
}

async function cleanup(): Promise<void> {
  try {
    await ipcServer?.close();
  } catch {
    // Ignore during process shutdown.
  }
  try {
    if (paths.ipc.cleanupPath) await rm(paths.ipc.cleanupPath, { force: true });
  } catch {
    // Ignore during process shutdown.
  }
  try {
    if (pidFd !== null) closeSync(pidFd);
    await rm(paths.pid, { force: true });
  } catch {
    // Ignore during process shutdown.
  }
}

process.on('exit', () => {
  try {
    if (pidFd !== null) closeSync(pidFd);
    if (existsSync(paths.pid) && readExistingPid() === process.pid) unlinkSync(paths.pid);
    if (paths.ipc.cleanupPath && existsSync(paths.ipc.cleanupPath)) unlinkSync(paths.ipc.cleanupPath);
  } catch {
    // Process is exiting; best effort only.
  }
});

main().catch(async (error) => {
  log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  await cleanup();
  process.exit(1);
});
