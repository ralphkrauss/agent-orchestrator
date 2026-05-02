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
} else if (command === '--help' || command === '-h' || command === 'help') {
  process.stdout.write(`agent-orchestrator-mcp

Usage:
  agent-orchestrator-mcp              Start the stdio MCP server
  agent-orchestrator-mcp server       Start the stdio MCP server
  agent-orchestrator-mcp doctor       Check local worker CLI availability
  agent-orchestrator-mcp doctor --json

Daemon lifecycle:
  agent-orchestrator-mcp-daemon status
  agent-orchestrator-mcp-daemon start
  agent-orchestrator-mcp-daemon stop [--force]
  agent-orchestrator-mcp-daemon restart [--force]
  agent-orchestrator-mcp-daemon prune --older-than-days <days> [--dry-run]
`);
} else {
  process.stderr.write(`Unknown command: ${command}\nRun agent-orchestrator-mcp --help for usage.\n`);
  process.exit(1);
}
