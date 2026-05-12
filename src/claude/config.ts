import {
  type ValidatedWorkerProfiles,
  type WorkerCapabilityCatalog,
} from './capabilities.js';
import {
  assertClaudeBashCommandsPermitted,
  buildClaudeAllowedToolsList,
  buildClaudeSupervisorSettings,
  CLAUDE_MCP_SERVER_NAME,
  CLAUDE_SUPERVISOR_BUILTIN_TOOLS,
  claudeOrchestratorMcpToolAllowList,
  stringifyClaudeSupervisorSettings,
  type ClaudeSupervisorSettings,
} from './permission.js';
import { buildMonitorBashCommand, type ResolvedMonitorPin } from './monitorPin.js';
import type { ResolvedClaudeSkill } from './skills.js';
import { SUPERVISOR_APPEND_PROMPT_DELIMITER, type AppendSource } from './appendPrompt.js';

export interface ClaudeHarnessConfigInput {
  targetCwd: string;
  manifestPath: string;
  ephemeralSkillRoot: string;
  orchestrationSkillNames: string[];
  orchestrationSkills: ResolvedClaudeSkill[];
  runtimeSkillRoot: string;
  runtimeSkillNames: string[];
  catalog: WorkerCapabilityCatalog;
  profiles?: ValidatedWorkerProfiles;
  profileDiagnostics: string[];
  mcpCliPath: string;
  monitorPin: ResolvedMonitorPin;
  /**
   * Pinned orchestrator id supplied by the launcher (issue #40, Decision 10).
   * Forwarded to the harness-owned MCP server entry's env so the MCP frontend
   * can stamp `RpcPolicyContext.orchestrator_id` on every IPC call.
   */
  orchestratorId?: string;
  /** Embed Remote Control settings keys when true (Decision 12). */
  remoteControl?: boolean;
  /**
   * Resolved user-supplied supervisor prompt append (issue #56).
   * When `text` is a non-empty string, `buildSupervisorSystemPrompt` appends
   * the literal delimiter followed by the user text after the harness prompt.
   * When omitted or when `text` is null/empty, the supervisor prompt is
   * byte-identical to the no-append baseline.
   */
  userAppendSystemPrompt?: {
    source: AppendSource;
    path: string | null;
    text: string | null;
  };
}

export interface ClaudeMcpConfig {
  mcpServers: Record<string, ClaudeMcpServerEntry>;
}

export interface ClaudeMcpServerEntry {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ClaudeHarnessConfig {
  systemPrompt: string;
  appendSystemPrompt?: string;
  settings: ClaudeSupervisorSettings;
  mcpConfig: ClaudeMcpConfig;
  monitorPin: ResolvedMonitorPin;
  /** Source tag for the user-supplied supervisor prompt (issue #56). */
  userSystemPromptSource: AppendSource;
  /** Resolved path for file-backed user append sources; null otherwise. */
  userSystemPromptPath: string | null;
  /** Decoded user append text; null when no append is in effect or text is empty/whitespace-only. */
  userSystemPromptAppend: string | null;
}

export function buildClaudeHarnessConfig(input: ClaudeHarnessConfigInput): ClaudeHarnessConfig {
  const settings = buildClaudeSupervisorSettings({
    monitorBashAllowPatterns: input.monitorPin.monitor_bash_allow_patterns,
    monitorPin: input.monitorPin,
    remoteControl: input.remoteControl,
  });
  assertMonitorPermissionInvariant(settings, input.monitorPin);
  const mcpEnv: Record<string, string> = {
    AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE: input.manifestPath,
  };
  if (input.orchestratorId) {
    // Pin the orchestrator id into the MCP server entry env so the MCP
    // frontend can attach it to every IPC call's policy_context. The model
    // never authors this value (Decision 10).
    mcpEnv.AGENT_ORCHESTRATOR_ORCH_ID = input.orchestratorId;
  }
  const mcpConfig: ClaudeMcpConfig = {
    mcpServers: {
      [CLAUDE_MCP_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args: [input.mcpCliPath],
        env: mcpEnv,
      },
    },
  };
  const userAppend = input.userAppendSystemPrompt;
  return {
    systemPrompt: buildSupervisorSystemPrompt(input),
    settings,
    mcpConfig,
    monitorPin: input.monitorPin,
    userSystemPromptSource: userAppend?.source ?? 'none',
    userSystemPromptPath: userAppend?.path ?? null,
    userSystemPromptAppend: userAppend?.text ?? null,
  };
}

function assertMonitorPermissionInvariant(settings: ClaudeSupervisorSettings, monitorPin: ResolvedMonitorPin): void {
  const probeRunId = '01KQRTVEP1Y0ANFYCSXZJ2FHPZ';
  const probeNotificationId = '00000000000000000151-01KQRTW38GARC7T3EMG6BTRD2N';
  assertClaudeBashCommandsPermitted(settings, [
    { label: 'pinned monitor', command: buildMonitorBashCommand(monitorPin, probeRunId) },
    { label: 'pinned monitor with cursor', command: buildMonitorBashCommand(monitorPin, probeRunId, true, probeNotificationId) },
  ]);
}

export function stringifyClaudeMcpConfig(config: ClaudeMcpConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export {
  CLAUDE_MCP_SERVER_NAME,
  CLAUDE_SUPERVISOR_BUILTIN_TOOLS,
  buildClaudeAllowedToolsList,
  claudeOrchestratorMcpToolAllowList,
  stringifyClaudeSupervisorSettings,
};

function buildSupervisorSystemPrompt(input: ClaudeHarnessConfigInput): string {
  const allowedMcpTools = claudeOrchestratorMcpToolAllowList();
  const monitorPin = input.monitorPin;
  const harness = [
    'You are the Agent Orchestrator supervisor running inside a restricted Claude Code launch.',
    '',
    'Hard isolation contract:',
    '- The only MCP server reachable in this launch is "agent-orchestrator". User-level and project-level MCP servers are not loaded.',
    '- Claude slash commands are enabled for normal Claude Code controls such as /exit and /skills.',
    '- The Skill tool is available so Claude Code can expose the redirected user skill mirror populated from the target workspace .claude/skills entries.',
    '- For orchestration workflows, prefer project-owned orchestrate-* skills. Do not use skills that would require unavailable editing, shell, external-service, or non-agent-orchestrator MCP access.',
    '- Project-owned orchestrate-* workflow instructions are also embedded in this system prompt below so the supervisor can follow them even when slash UI is not inspected.',
    `- Permitted built-in tools: ${[...CLAUDE_SUPERVISOR_BUILTIN_TOOLS].join(', ')}, plus the agent-orchestrator MCP tools listed below.`,
    `- Bash is restricted by an explicit allowlist. The only Bash patterns that will run are: ${monitorPin.monitor_bash_allow_patterns.join(', ')}, Bash(pwd), Bash(git status), and Bash(git status *). Anything else, including read-only commands such as cat, ls, head, tail, grep, find, jq, git log, git diff, git show, git rev-parse, and git branch, will be denied.`,
    '- Do not attempt to run other shell commands. Use Read for file contents, Glob for file discovery, Grep for content search, and the agent-orchestrator MCP tools for daemon, worker, and notification state. Worker runs are the only way to make changes to the target workspace.',
    '- Edit, Write, WebFetch, WebSearch, Task, NotebookEdit, and TodoWrite are not available. Do not request them.',
    '- The supervisor must not directly modify files in the target workspace. To modify the target workspace, dispatch a worker run via mcp__agent-orchestrator__start_run with cwd set to the target workspace; the worker has full access in its own session.',
    '- To inspect or modify the worker profiles manifest, use list_worker_profiles and upsert_worker_profile. Do not dispatch a worker to edit the profiles manifest.',
    '- Do not inspect Claude Code internal files under .claude/projects or tool-results. MCP tool responses are authoritative.',
    '',
    'Allowed agent-orchestrator MCP tools:',
    allowedMcpTools.map((name) => `- ${name}`).join('\n'),
    '',
    'Orchestrator status hooks:',
    '- Supervisor turn signaling is automatic. The harness installs Claude Code lifecycle hooks (UserPromptSubmit / Notification / Stop / SessionStart / SessionEnd) that report turn boundaries to the daemon; the daemon emits aggregate-status events to the user\'s ~/.config/agent-orchestrator/hooks.json scripts. Do not invoke any "supervisor signal" CLI yourself — the harness handles it. A user tmux or desktop hook will see the daemon-owned aggregate state, not whichever Claude/worker process last fired a local hook.',
    '',
    'Daemon-owned run lifecycle:',
    '- The persistent agent-orchestrator daemon owns worker subprocesses, durable run state, event logs, results, and notification records. The supervisor is only an orchestration client.',
    '- Worker runs continue in the daemon after the supervisor returns control to the user. Do not imply that runs stop, pause, or lose notifications when the supervisor turn ends.',
    '- The daemon appends durable notifications for terminal and fatal_error states. MCP push hints may exist, but durable notification records are authoritative.',
    '',
    'Worker run lifecycle:',
    '- Start worker runs by profile: call mcp__agent-orchestrator__start_run with profile and profiles_file. Use direct backend/model only when the user explicitly requests it.',
    '- If list_worker_profiles reports invalid_profiles, you may still use validated profiles. For an invalid profile the user asks you to repair, call upsert_worker_profile instead of starting a worker to edit config.',
    '- Default cwd for worker runs is the target workspace below unless the user explicitly chooses another.',
    '',
    'Run supervision decision rules:',
    '- MCP tools are the source of truth for starting runs, fetching run status/events/results, cancelling runs, and reconciling durable notifications.',
    '- Use Bash only for the pinned notification monitor and the explicitly allowlisted inspection commands (pwd, git status). Do not use Bash to start workers, poll worker status, inspect MCP results, or make changes.',
    '- For each active run, use exactly one active wait mechanism at a time.',
    '',
    'Progress and status checks:',
    '- When the user asks what happened, asks for progress, or asks for status on a worker run, call mcp__agent-orchestrator__get_run_progress first. It returns bounded recent event summaries and text snippets.',
    '- Use mcp__agent-orchestrator__get_run_status for lifecycle metadata and mcp__agent-orchestrator__get_run_result for terminal results.',
    '- Use mcp__agent-orchestrator__get_run_events only when raw events are explicitly needed. Keep limit small, normally 5-20, and use after_sequence cursors.',
    '- Never use Bash, jq, cat, head, tail, grep, rg, sed, awk, or Claude Code tool-result files to inspect MCP results or worker progress.',
    '',
    'Primary wake path for runs started in this turn:',
    '- After each start_run or send_followup returns a run_id, immediately launch exactly one Bash background task using Bash run_in_background: true with the exact command shape below.',
    `- Primary monitor command: ${monitorPin.command_prefix_string} monitor <run_id> --json-line`,
    `- Cursored monitor command: ${monitorPin.command_prefix_string} monitor <run_id> --json-line --since <notification_id>`,
    '- While a Bash monitor is active for a run, do not call any MCP blocking wait tool for that run. The monitor is the wait.',
    '- When the monitor exits, parse its single JSON line, update the notification cursor from notification_id, then call get_run_result or get_run_status via MCP to fetch authoritative state.',
    '',
    'Monitor recovery path:',
    '- If you inherit active run_ids without live monitor handles and need to block during the current turn, launch a new pinned Bash monitor for each run instead of using MCP wait tools.',
    '- Use the cursored monitor command with --since <notification_id> when you already have a notification cursor, so an old notification does not wake the supervisor twice.',
    '- Do not call wait_for_any_run or wait_for_run in the Claude supervisor. They are MCP blocking wait tools for non-Claude clients and are intentionally not allowlisted here.',
    '',
    'Cross-turn reconciliation:',
    '- Maintain a notification cursor across the session: keep the highest notification_id you have seen.',
    '- At the start of a later turn, or before answering a user status request about prior runs, call mcp__agent-orchestrator__list_run_notifications with since_notification_id set to the cursor. This is reconciliation, not the primary current-turn wait path.',
    '- Acknowledge surfaced notifications with mcp__agent-orchestrator__ack_run_notification after you have reported or handled them.',
    '- Do not cancel a worker solely because elapsed time is high. Cancel only on explicit user request, clear no-activity evidence past the idle window, or a deliberate stop/restart recovery.',
    '- For known quiet tasks, choose a larger idle_timeout_seconds at start_run or send_followup instead of relying on a hard execution_timeout_seconds.',
    '',
    `Target workspace: ${input.targetCwd}`,
    `Writable profiles manifest path: ${input.manifestPath}`,
    `Curated skills snapshot root (orchestrate-* only): ${input.ephemeralSkillRoot}`,
    `Runtime skill mirror root: ${input.runtimeSkillRoot}`,
    `Runtime skill mirror entries: ${input.runtimeSkillNames.length > 0 ? input.runtimeSkillNames.join(', ') : 'none'}`,
    '- Runtime /skills discovery comes from the redirected user skill mirror so project settings can remain disabled while workspace skills are still available.',
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
    'Project-owned orchestrate-* workflows embedded for this supervisor:',
    input.orchestrationSkillNames.length > 0
      ? input.orchestrationSkillNames.map((name) => `- ${name}`).join('\n')
      : '- none yet',
    '',
    'Embedded orchestration workflow instructions:',
    formatEmbeddedOrchestrationSkills(input.orchestrationSkills),
  ].join('\n');
  const userText = input.userAppendSystemPrompt?.text;
  if (typeof userText === 'string' && userText.length > 0) {
    return `${harness}${SUPERVISOR_APPEND_PROMPT_DELIMITER}${userText}`;
  }
  return harness;
}

function formatProfileDiagnostics(profiles: ValidatedWorkerProfiles | undefined, diagnostics: string[]): string {
  if (profiles && diagnostics.length === 0) return '- valid';
  if (diagnostics.length === 0) return '- No profiles manifest has been loaded yet.';
  return diagnostics.map((item) => `- ${item}`).join('\n');
}

function formatProfiles(profiles: ValidatedWorkerProfiles | undefined): string {
  if (!profiles) return '- No validated profiles loaded. Configure the profiles manifest before starting worker runs.';
  const validProfiles = Object.values(profiles.profiles);
  if (validProfiles.length === 0) return '- No validated profiles are currently usable.';
  return validProfiles
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((profile) => {
      const settings = [
        `backend=${profile.backend}`,
        profile.model ? `model=${profile.model}` : null,
        profile.variant ? `variant=${profile.variant}` : null,
        profile.reasoning_effort ? `reasoning_effort=${profile.reasoning_effort}` : null,
        profile.service_tier ? `service_tier=${profile.service_tier}` : null,
        codexNetworkLine(profile),
      ].filter(Boolean).join(', ');
      return `- ${profile.id}: ${settings}${profile.description ? `; ${profile.description}` : ''}`;
    })
    .join('\n');
}

// Issue #31 / B1: render the *effective* codex_network on codex profiles so
// the supervisor sees the resolved posture (and the OD1=B default of
// 'isolated') in the prompt, even when the manifest does not set it. Non-codex
// profiles continue to render identically to today.
function codexNetworkLine(profile: { backend: string; codex_network?: string }): string | null {
  if (profile.backend !== 'codex') return null;
  if (profile.codex_network) return `codex_network=${profile.codex_network}`;
  return 'codex_network=isolated (default)';
}

function formatEmbeddedOrchestrationSkills(skills: readonly ResolvedClaudeSkill[]): string {
  if (skills.length === 0) return '- none';
  return skills
    .map((skill) => [
      `## ${skill.name}`,
      '```markdown',
      skill.content.trimEnd(),
      '```',
    ].join('\n'))
    .join('\n\n');
}

function formatCatalog(catalog: WorkerCapabilityCatalog): string {
  return catalog.backends.map((backend) => {
    const lines = [
      `- ${backend.backend} (${backend.display_name}): status=${backend.availability_status}, start=${backend.supports_start}, resume=${backend.supports_resume}`,
      `  reasoning_efforts=${backend.settings.reasoning_efforts.join(', ') || 'none'}`,
      `  service_tiers=${backend.settings.service_tiers.join(', ') || 'none'}`,
      `  variants=${backend.settings.variants.join(', ') || 'none'}`,
    ];
    if (backend.settings.network_modes.length > 0) {
      lines.push(`  network_modes=${backend.settings.network_modes.join(', ')}`);
    }
    return lines.join('\n');
  }).join('\n');
}
