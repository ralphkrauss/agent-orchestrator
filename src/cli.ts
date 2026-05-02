#!/usr/bin/env node
import { getBackendStatus, formatBackendStatus } from './diagnostics.js';

const command = process.argv[2];

if (command === 'doctor') {
  const status = await getBackendStatus();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write(formatBackendStatus(status));
  }
} else if (!command || command === 'server') {
  await import('./server.js');
} else if (command === 'opencode') {
  const { runOpenCodeLauncher } = await import('./opencode/launcher.js');
  process.exitCode = await runOpenCodeLauncher(process.argv.slice(3));
} else if (command === '--help' || command === '-h' || command === 'help') {
  process.stdout.write(`agent-orchestrator

Usage:
  agent-orchestrator              Start the stdio MCP server
  agent-orchestrator server       Start the stdio MCP server
  agent-orchestrator doctor       Check local worker CLI availability
  agent-orchestrator doctor --json
  agent-orchestrator opencode     Start OpenCode in orchestration mode

Daemon lifecycle:
  agent-orchestrator-daemon status
  agent-orchestrator-daemon status --verbose
  agent-orchestrator-daemon status --json
  agent-orchestrator-daemon runs [--json] [--prompts]
  agent-orchestrator-daemon watch [--interval-ms <ms>] [--limit <n>]
  agent-orchestrator-daemon start
  agent-orchestrator-daemon stop [--force]
  agent-orchestrator-daemon restart [--force]
  agent-orchestrator-daemon prune --older-than-days <days> [--dry-run]

OpenCode orchestration:
  agent-orchestrator-opencode [options]
`);
} else {
  process.stderr.write(`Unknown command: ${command}\nRun agent-orchestrator --help for usage.\n`);
  process.exit(1);
}
