#!/usr/bin/env node
import { getBackendStatus, formatBackendStatus } from './diagnostics.js';
import { isDaemonCliCommand, runDaemonCli } from './daemon/daemonCli.js';
import { HELP_TEXT, decideRootMode } from './cliRoot.js';

const command = process.argv[2];

if (command === 'doctor') {
  const status = await getBackendStatus();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write(formatBackendStatus(status));
  }
} else if (!command) {
  if (decideRootMode(process.stdin.isTTY) === 'help') {
    process.stdout.write(HELP_TEXT);
  } else {
    await import('./server.js');
  }
} else if (command === 'server') {
  await import('./server.js');
} else if (command === 'opencode') {
  const { runOpenCodeLauncher } = await import('./opencode/launcher.js');
  process.exitCode = await runOpenCodeLauncher(process.argv.slice(3));
} else if (command === 'claude') {
  const { runClaudeLauncher } = await import('./claude/launcher.js');
  process.exitCode = await runClaudeLauncher(process.argv.slice(3));
} else if (command === 'monitor') {
  const { runMonitorCli } = await import('./monitorCli.js');
  process.exitCode = await runMonitorCli(process.argv.slice(3));
} else if (command === 'auth') {
  const { runAuthCli } = await import('./auth/authCli.js');
  process.exitCode = await runAuthCli(process.argv.slice(3));
} else if (command === 'supervisor') {
  const { runSupervisorCli } = await import('./supervisorCli.js');
  process.exitCode = await runSupervisorCli(process.argv.slice(3));
} else if (isDaemonCliCommand(command)) {
  try {
    await runDaemonCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
} else if (command === '--help' || command === '-h' || command === 'help') {
  process.stdout.write(HELP_TEXT);
} else {
  process.stderr.write(`Unknown command: ${command}\nRun agent-orchestrator --help for usage.\n`);
  process.exit(1);
}
