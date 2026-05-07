#!/usr/bin/env node
import { getBackendStatus, formatBackendStatus } from './diagnostics.js';
import { isDaemonCliCommand, runDaemonCli } from './daemon/daemonCli.js';
import { formatVersionOutput } from './packageMetadata.js';

const command = process.argv[2];

if (command === '--version') {
  process.stdout.write(formatVersionOutput('agent-orchestrator', process.argv.includes('--json')));
} else if (command === 'doctor') {
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
  process.stdout.write(`agent-orchestrator

Usage:
  agent-orchestrator              Start the stdio MCP server
  agent-orchestrator server       Start the stdio MCP server
  agent-orchestrator doctor       Check local worker CLI availability
  agent-orchestrator doctor --json
  agent-orchestrator opencode     Start OpenCode in orchestration mode
  agent-orchestrator claude       Start Claude Code in orchestration mode (recommended rich-feature harness)
  agent-orchestrator monitor <run_id> [--json-line] [--since <id>]
  agent-orchestrator auth status [--json]
  agent-orchestrator auth <provider> [--from-env [VAR] | --from-stdin]
  agent-orchestrator auth unset <provider>
  agent-orchestrator supervisor register --label <name> --cwd <path>
  agent-orchestrator supervisor signal <event>
  agent-orchestrator supervisor unregister --orchestrator-id <id>
  agent-orchestrator supervisor status [--orchestrator-id <id>]
  agent-orchestrator status       Show daemon status
  agent-orchestrator status --json
  agent-orchestrator runs [--json] [--prompts]
  agent-orchestrator watch [--interval-ms <ms>] [--limit <n>]
  agent-orchestrator start
  agent-orchestrator stop [--force]
  agent-orchestrator restart [--force]
  agent-orchestrator prune --older-than-days <days> [--dry-run]
  agent-orchestrator --version
  agent-orchestrator --version --json

Standalone daemon alias:
  agent-orchestrator-daemon status
  agent-orchestrator-daemon status --verbose
  agent-orchestrator-daemon status --json
  agent-orchestrator-daemon runs [--json] [--prompts]
  agent-orchestrator-daemon watch [--interval-ms <ms>] [--limit <n>]
  agent-orchestrator-daemon start
  agent-orchestrator-daemon stop [--force]
  agent-orchestrator-daemon restart [--force]
  agent-orchestrator-daemon prune --older-than-days <days> [--dry-run]
  agent-orchestrator-daemon auth status [--json]
  agent-orchestrator-daemon auth <provider> [--from-env [VAR] | --from-stdin]
  agent-orchestrator-daemon auth unset <provider>
  agent-orchestrator-daemon --version
  agent-orchestrator-daemon --version --json

OpenCode orchestration:
  agent-orchestrator-opencode [options]
  agent-orchestrator-opencode --version
`);
} else {
  process.stderr.write(`Unknown command: ${command}\nRun agent-orchestrator --help for usage.\n`);
  process.exit(1);
}
