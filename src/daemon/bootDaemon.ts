import { closeSync, existsSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { IpcServer } from '../ipc/server.js';
import { createBackendRegistry, type BackendRegistryOptions } from '../backend/registry.js';
import { OrchestratorService } from '../orchestratorService.js';
import { RunStore, ensureSecureRoot } from '../runStore.js';
import { loadUserSecretsIntoEnv, type LoadIntoEnvSummary } from '../auth/userSecrets.js';
import { AUTH_PROVIDERS } from '../auth/providers.js';
import type { DaemonPaths } from './paths.js';

export interface BootDaemonOptions {
  paths: DaemonPaths;
  log: (message: string) => void;
  /** Test seam: replace the secrets-into-env loader. Production omits this. */
  loadSecrets?: (env: NodeJS.ProcessEnv) => LoadIntoEnvSummary | void;
  /**
   * Test seam: pass-through for `createBackendRegistry` overrides
   * (e.g. injecting a fake `CursorSdkAdapter`). Production omits this.
   */
  registryOptions?: BackendRegistryOptions;
}

export interface BootedDaemon {
  service: OrchestratorService;
  ipcServer: IpcServer;
  shutdown: () => Promise<void>;
}

/**
 * Production daemon boot sequence, factored out of `daemonMain.ts` so tests
 * can drive it in-process. Equivalent behavior to running `daemonMain.js`:
 *  - load user secrets into the process env (env vars win),
 *  - acquire the pid file,
 *  - clean up stale ipc endpoints,
 *  - construct the run store + backend registry + orchestrator service,
 *  - start the IPC server.
 */
export async function bootDaemon(options: BootDaemonOptions): Promise<BootedDaemon> {
  const { paths, log } = options;

  await ensureSecureRoot(paths.home);

  const allowedKeys = wiredProviderEnvVars();
  let secretsSummary: LoadIntoEnvSummary | void = undefined;
  try {
    secretsSummary = options.loadSecrets
      ? options.loadSecrets(process.env)
      : loadUserSecretsIntoEnv(process.env, { allowedKeys });
  } catch (error) {
    log(`secrets load skipped due to error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (secretsSummary) {
    reportSecretsLoad(log, secretsSummary);
  }

  const pidFd = acquirePidFile(paths.pid);
  await cleanupIpcEndpoint(paths.ipc.cleanupPath);

  const store = new RunStore(paths.home);
  const service = new OrchestratorService(store, createBackendRegistry(store, options.registryOptions ?? {}), log);
  await service.initialize();

  const ipcServer = new IpcServer(paths.ipc.path, async (method, params, context) => service.dispatch(method, params, context));
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

  const shutdown = async (): Promise<void> => {
    try {
      await ipcServer.close();
    } catch {
      // ignore during shutdown
    }
    try {
      await cleanupIpcEndpoint(paths.ipc.cleanupPath);
    } catch {
      // ignore during shutdown
    }
    try {
      closeSync(pidFd);
      await rm(paths.pid, { force: true });
    } catch {
      // ignore during shutdown
    }
  };

  return { service, ipcServer, shutdown };
}

function wiredProviderEnvVars(): string[] {
  const keys = new Set<string>();
  for (const provider of AUTH_PROVIDERS) {
    if (provider.status !== 'wired') continue;
    for (const name of provider.envVars) keys.add(name);
  }
  return Array.from(keys);
}

function reportSecretsLoad(log: (message: string) => void, summary: LoadIntoEnvSummary): void {
  if (summary.refusal) {
    log(`secrets file refused: ${summary.refusal.reason}; ${summary.refusal.hint}`);
    return;
  }
  if (!summary.fileExisted) {
    log(`secrets file ${summary.path} not present; skipping`);
    return;
  }
  if (
    summary.applied.length === 0
    && summary.skippedBecauseEnvSet.length === 0
    && summary.skippedBecauseDisallowed.length === 0
  ) {
    log(`secrets file ${summary.path} loaded; no recognized keys`);
    return;
  }
  const parts: string[] = [];
  if (summary.applied.length > 0) parts.push(`applied=${summary.applied.join(',')}`);
  if (summary.skippedBecauseEnvSet.length > 0) {
    parts.push(`env_overrode=${summary.skippedBecauseEnvSet.join(',')}`);
  }
  if (summary.skippedBecauseDisallowed.length > 0) {
    parts.push(`disallowed=${summary.skippedBecauseDisallowed.join(',')}`);
  }
  log(`secrets file ${summary.path} loaded; ${parts.join(' ')}`);
}

function acquirePidFile(path: string): number {
  let pidFd: number;
  try {
    pidFd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existingPid = readExistingPid(path);
    if (existingPid && isPidAlive(existingPid)) {
      throw new Error(`another agent-orchestrator daemon is running with pid ${existingPid}`);
    }
    unlinkSync(path);
    pidFd = openSync(path, 'wx', 0o600);
  }
  writeFileSync(pidFd, `${process.pid}\n`);
  return pidFd;
}

function readExistingPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
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

async function cleanupIpcEndpoint(cleanupPath: string | null | undefined): Promise<void> {
  if (!cleanupPath) return;

  let info: Stats;
  try {
    info = await lstat(cleanupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const uid = process.getuid?.();
  if (typeof uid === 'number' && info.uid !== uid) {
    throw new Error(`Refusing to remove foreign-owned IPC endpoint ${cleanupPath} owned by uid ${info.uid}`);
  }
  try {
    await rm(cleanupPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function unlinkOwnedIpcEndpointSync(cleanupPath: string): void {
  let info: Stats;
  try {
    info = lstatSync(cleanupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const uid = process.getuid?.();
  if (typeof uid === 'number' && info.uid !== uid) {
    throw new Error(`Refusing to remove foreign-owned IPC endpoint ${cleanupPath} owned by uid ${info.uid}`);
  }
  try {
    unlinkSync(cleanupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function readPidFile(path: string): number | null {
  return readExistingPid(path);
}
