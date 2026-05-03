import { tools as mcpTools } from '../mcpTools.js';

export const CLAUDE_MCP_SERVER_NAME = 'agent-orchestrator';

/**
 * Built-in Claude Code tools the supervisor is allowed to use. Edit, Write,
 * WebFetch, WebSearch, Task, NotebookEdit, TodoWrite, and Bash are intentionally
 * excluded. Built-in availability is enforced at spawn time via `--tools`;
 * settings.permissions provide defense in depth.
 */
export const CLAUDE_SUPERVISOR_BUILTIN_TOOLS = ['Read', 'Glob', 'Grep'] as const;

export interface ClaudeSupervisorSettings {
  permissions: {
    defaultMode: 'default';
    allow: string[];
    deny: string[];
  };
  enableAllProjectMcpServers: false;
  hooks: Record<string, never>;
  enabledPlugins: Record<string, never>;
}

export function orchestratorMcpToolAllowList(): string[] {
  return mcpTools.map((tool) => `mcp__${CLAUDE_MCP_SERVER_NAME}__${tool.name}`).sort();
}

export function buildClaudeSupervisorSettings(): ClaudeSupervisorSettings {
  const allow = [
    ...CLAUDE_SUPERVISOR_BUILTIN_TOOLS,
    ...orchestratorMcpToolAllowList(),
  ];
  // Bash is in deny so any request goes through deny, not the default-prompt
  // path. Edit/Write/WebFetch/WebSearch/Task/NotebookEdit/TodoWrite are also
  // not in --tools (so unavailable as built-ins), but they appear in deny too
  // for defense in depth — should a future Claude release loosen --tools, the
  // settings deny still blocks them.
  const deny = [
    'Bash',
    'Edit',
    'Write',
    'WebFetch',
    'WebSearch',
    'Task',
    'NotebookEdit',
    'TodoWrite',
  ];
  return {
    permissions: {
      defaultMode: 'default',
      allow,
      deny,
    },
    enableAllProjectMcpServers: false,
    hooks: {},
    enabledPlugins: {},
  };
}

export function stringifyClaudeSupervisorSettings(settings: ClaudeSupervisorSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
