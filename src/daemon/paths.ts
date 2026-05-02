import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { resolveStoreRoot } from '../runStore.js';

export type DaemonIpcTransport = 'unix_socket' | 'windows_pipe';

export interface DaemonIpcEndpoint {
  transport: DaemonIpcTransport;
  path: string;
  cleanupPath: string | null;
}

export interface DaemonPaths {
  home: string;
  ipc: DaemonIpcEndpoint;
  pid: string;
  log: string;
}

export function daemonPaths(): DaemonPaths {
  const home = resolveStoreRoot();
  return {
    home,
    ipc: daemonIpcEndpoint(home),
    pid: join(home, 'daemon.pid'),
    log: join(home, 'daemon.log'),
  };
}

export function daemonIpcEndpoint(home: string, platform: NodeJS.Platform = process.platform): DaemonIpcEndpoint {
  if (platform === 'win32') {
    const hash = createHash('sha256')
      .update(normalizeStoreRootForPipe(home))
      .digest('hex')
      .slice(0, 16);
    return {
      transport: 'windows_pipe',
      path: `\\\\.\\pipe\\agent-orchestrator-${hash}`,
      cleanupPath: null,
    };
  }

  const socketPath = join(home, 'daemon.sock');
  return {
    transport: 'unix_socket',
    path: socketPath,
    cleanupPath: socketPath,
  };
}

function normalizeStoreRootForPipe(home: string): string {
  return resolve(home).replaceAll('/', '\\').toLowerCase();
}
