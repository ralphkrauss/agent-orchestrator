#!/usr/bin/env node
import { runDaemonCli } from './daemon/daemonCli.js';

runDaemonCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
