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

if (process.platform === 'win32') {
  process.stderr.write('agent-orchestrator daemon is POSIX-only in v1; Unix sockets are required.\n');
  process.exit(1);
}

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  appendFileSync(paths.log, line, { mode: 0o600 });
  process.stderr.write(line);
}

async function main(): Promise<void> {
  await ensureSecureRoot(paths.home);
  acquirePidFile();
  await cleanupSocket();

  const store = new RunStore(paths.home);
  const service = new OrchestratorService(store, createBackendRegistry(), log);
  await service.initialize();

  ipcServer = new IpcServer(paths.socket, async (method, params, context) => service.dispatch(method, params, context));
  const oldUmask = process.umask(0o177);
  try {
    await ipcServer.listen();
  } finally {
    process.umask(oldUmask);
  }

  log(`daemon started pid=${process.pid} socket=${paths.socket}`);

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

async function cleanupSocket(): Promise<void> {
  if (!existsSync(paths.socket)) return;
  const info = await lstat(paths.socket);
  const uid = process.getuid?.();
  if (typeof uid === 'number' && info.uid !== uid) {
    throw new Error(`Refusing to remove foreign-owned socket ${paths.socket} owned by uid ${info.uid}`);
  }
  await rm(paths.socket, { force: true });
}

async function cleanup(): Promise<void> {
  try {
    await ipcServer?.close();
  } catch {
    // Ignore during process shutdown.
  }
  try {
    await rm(paths.socket, { force: true });
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
    if (existsSync(paths.socket)) unlinkSync(paths.socket);
  } catch {
    // Process is exiting; best effort only.
  }
});

main().catch(async (error) => {
  log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  await cleanup();
  process.exit(1);
});
