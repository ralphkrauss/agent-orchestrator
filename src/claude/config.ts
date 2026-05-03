import {
  type ValidatedWorkerProfiles,
  type WorkerCapabilityCatalog,
} from './capabilities.js';
import {
  buildClaudeSupervisorSettings,
  CLAUDE_MCP_SERVER_NAME,
  CLAUDE_SUPERVISOR_BUILTIN_TOOLS,
  orchestratorMcpToolAllowList,
  stringifyClaudeSupervisorSettings,
  type ClaudeSupervisorSettings,
} from './permission.js';
import { resolveMonitorPin, type ResolvedMonitorPin } from './monitorPin.js';

export interface ClaudeHarnessConfigInput {
  targetCwd: string;
  manifestPath: string;
  ephemeralSkillRoot: string;
  orchestrationSkillNames: string[];
  catalog: WorkerCapabilityCatalog;
  profiles?: ValidatedWorkerProfiles;
  profileDiagnostics: string[];
  mcpCliPath: string;
  monitorPin: ResolvedMonitorPin;
}

export interface ClaudeMcpConfig {
  mcpServers: Record<string, ClaudeMcpServerEntry>;
}

export interface ClaudeMcpServerEntry {
  type: 'stdio';
  command: string;
  args: string[];
}

export interface ClaudeHarnessConfig {
  systemPrompt: string;
  appendSystemPrompt?: string;
  settings: ClaudeSupervisorSettings;
  mcpConfig: ClaudeMcpConfig;
  monitorPin: ResolvedMonitorPin;
}

export function buildClaudeHarnessConfig(input: ClaudeHarnessConfigInput): ClaudeHarnessConfig {
  const monitorPin = input.monitorPin ?? resolveMonitorPin();
  const settings = buildClaudeSupervisorSettings();
  const mcpConfig: ClaudeMcpConfig = {
    mcpServers: {
      [CLAUDE_MCP_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args: [input.mcpCliPath],
      },
    },
  };
  return {
    systemPrompt: buildSupervisorSystemPrompt(input, monitorPin),
    settings,
    mcpConfig,
    monitorPin,
  };
}

export function stringifyClaudeMcpConfig(config: ClaudeMcpConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export {
  CLAUDE_MCP_SERVER_NAME,
  CLAUDE_SUPERVISOR_BUILTIN_TOOLS,
  orchestratorMcpToolAllowList,
  stringifyClaudeSupervisorSettings,
};

function buildSupervisorSystemPrompt(input: ClaudeHarnessConfigInput, monitorPin: ResolvedMonitorPin): string {
  const allowedMcpTools = orchestratorMcpToolAllowList();
  return [
    'You are the Agent Orchestrator supervisor running inside an isolated Claude Code envelope.',
    '',
    'Hard isolation contract:',
    '- The only MCP server reachable inside this envelope is "agent-orchestrator". User-level and project-level MCP servers are not loaded.',
    '- The only skills reachable are project-owned orchestrate-* skills curated for this session.',
    '- Slash commands, sub-agents, hooks, and project skills outside orchestrate-* are not loaded.',
    `- Permitted built-in tools: ${[...CLAUDE_SUPERVISOR_BUILTIN_TOOLS].join(', ')}, plus the agent-orchestrator MCP tools listed below.`,
    '- Bash, Edit, Write, WebFetch, WebSearch, Task, NotebookEdit, and TodoWrite are not available. Do not request them.',
    '- The supervisor cannot directly read files outside this envelope. To inspect or modify the target workspace, dispatch a worker run via mcp__agent-orchestrator__start_run with cwd set to the target workspace; the worker has full access in its own session.',
    '',
    'Allowed agent-orchestrator MCP tools:',
    allowedMcpTools.map((name) => `- ${name}`).join('\n'),
    '',
    'Worker run lifecycle:',
    '- Start worker runs by profile: call mcp__agent-orchestrator__start_run with profile and profiles_file. Use direct backend/model only when the user explicitly requests it.',
    '- Default cwd for worker runs is the target workspace below unless the user explicitly chooses another.',
    '',
    'Long-running run supervision (MCP polling):',
    '- Run supervision uses bounded mcp__agent-orchestrator__wait_for_any_run polls (1-300 s each). Default wake semantics are the union of "terminal" and "fatal_error", so a fatal backend error surfaces immediately rather than waiting for terminal.',
    '- Maintain a notification cursor across calls: pass the highest notification_id you have seen as after_notification_id on the next wait_for_any_run.',
    '- Adaptive cadence: first check around 30 s after start_run so startup, auth, model, quota, and protocol failures surface quickly. Then back off through ~2 min, ~5 min, and a 10-15 min ceiling chosen for the task. Stop waiting early when latest_error is fatal.',
    '- After returning control to the user, reconcile by calling mcp__agent-orchestrator__list_run_notifications with since_notification_id set to the cursor. Acknowledge surfaced notifications with mcp__agent-orchestrator__ack_run_notification.',
    '- Do not cancel a worker solely because elapsed time is high. Cancel only on explicit user request, clear no-activity evidence past the idle window, or a deliberate stop/restart recovery.',
    '- For known quiet tasks, choose a larger idle_timeout_seconds at start_run or send_followup instead of relying on a hard execution_timeout_seconds.',
    '',
    'Out-of-envelope monitoring (informational):',
    `- For users who want a background process tied to a single run from their own shell, the standalone CLI is: ${monitorPin.command_prefix_string} monitor <run_id> [--json-line] [--since <id>]`,
    '- The supervisor itself does not invoke this command — Bash is not available inside the envelope. The CLI is documented here only so the supervisor can mention it to the user.',
    '',
    `Target workspace: ${input.targetCwd}`,
    `Writable profiles manifest path: ${input.manifestPath}`,
    `Curated skills root (orchestrate-* only): ${input.ephemeralSkillRoot}`,
    '',
    'Profiles manifest status:',
    formatProfileDiagnostics(input.profiles, input.profileDiagnostics),
    '',
    'Validated worker profiles:',
    formatProfiles(input.profiles),
    '',
    'Available backend capabilities:',
    formatCatalog(input.catalog),
    '',
    'Project-owned orchestrate-* skills currently exposed:',
    input.orchestrationSkillNames.length > 0
      ? input.orchestrationSkillNames.map((name) => `- ${name}`).join('\n')
      : '- none yet',
  ].join('\n');
}

function formatProfileDiagnostics(profiles: ValidatedWorkerProfiles | undefined, diagnostics: string[]): string {
  if (profiles && diagnostics.length === 0) return '- valid';
  if (diagnostics.length === 0) return '- No profiles manifest has been loaded yet.';
  return diagnostics.map((item) => `- ${item}`).join('\n');
}

function formatProfiles(profiles: ValidatedWorkerProfiles | undefined): string {
  if (!profiles) return '- No validated profiles loaded. Configure the profiles manifest before starting worker runs.';
  return Object.values(profiles.profiles)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((profile) => {
      const settings = [
        `backend=${profile.backend}`,
        profile.model ? `model=${profile.model}` : null,
        profile.variant ? `variant=${profile.variant}` : null,
        profile.reasoning_effort ? `reasoning_effort=${profile.reasoning_effort}` : null,
        profile.service_tier ? `service_tier=${profile.service_tier}` : null,
      ].filter(Boolean).join(', ');
      return `- ${profile.id}: ${settings}${profile.description ? `; ${profile.description}` : ''}`;
    })
    .join('\n');
}

function formatCatalog(catalog: WorkerCapabilityCatalog): string {
  return catalog.backends.map((backend) => [
    `- ${backend.backend} (${backend.display_name}): status=${backend.availability_status}, start=${backend.supports_start}, resume=${backend.supports_resume}`,
    `  reasoning_efforts=${backend.settings.reasoning_efforts.join(', ') || 'none'}`,
    `  service_tiers=${backend.settings.service_tiers.join(', ') || 'none'}`,
    `  variants=${backend.settings.variants.join(', ') || 'none'}`,
  ].join('\n')).join('\n');
}
