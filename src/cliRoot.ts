export const HELP_TEXT = `agent-orchestrator

Usage:
  agent-orchestrator              Show this help in a terminal; start the MCP server for piped stdio
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

OpenCode orchestration:
  agent-orchestrator-opencode [options]
`;

export function decideRootMode(stdinIsTty: boolean | undefined): 'help' | 'server' {
  return stdinIsTty === true ? 'help' : 'server';
}
