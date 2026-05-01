import { join } from 'node:path';
import { resolveStoreRoot } from '../runStore.js';

export interface DaemonPaths {
  home: string;
  socket: string;
  pid: string;
  log: string;
}

export function daemonPaths(): DaemonPaths {
  const home = resolveStoreRoot();
  return {
    home,
    socket: join(home, 'daemon.sock'),
    pid: join(home, 'daemon.pid'),
    log: join(home, 'daemon.log'),
  };
}
