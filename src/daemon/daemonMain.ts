#!/usr/bin/env node
import { existsSync, unlinkSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { bootDaemon, readPidFile, unlinkOwnedIpcEndpointSync } from './bootDaemon.js';
import { daemonPaths } from './paths.js';

const paths = daemonPaths();
let bootedShutdown: (() => Promise<void>) | null = null;

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  appendFileSync(paths.log, line, { mode: 0o600 });
  process.stderr.write(line);
}

async function main(): Promise<void> {
  const booted = await bootDaemon({ paths, log });
  bootedShutdown = booted.shutdown;

  const forceShutdown = () => {
    void booted.service.shutdown({ force: true });
  };
  process.on('SIGTERM', forceShutdown);
  process.on('SIGINT', forceShutdown);
}

process.on('exit', () => {
  try {
    if (existsSync(paths.pid) && readPidFile(paths.pid) === process.pid) unlinkSync(paths.pid);
    if (paths.ipc.cleanupPath) unlinkOwnedIpcEndpointSync(paths.ipc.cleanupPath);
  } catch {
    // Process is exiting; best effort only.
  }
});

main().catch(async (error) => {
  log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  if (bootedShutdown) {
    try {
      await bootedShutdown();
    } catch {
      // ignore
    }
  }
  process.exit(1);
});
