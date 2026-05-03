import { isAbsolute, join, relative, sep } from 'node:path';
import type { ValidatedWorkerProfiles, WorkerCapabilityCatalog } from './capabilities.js';

export const OPENCODE_ORCHESTRATOR_AGENT = 'agent-orchestrator';

export interface OpenCodeHarnessConfigInput {
  targetCwd: string;
  skillRoots: string[];
  skillRoot: string;
  mcpCliPath: string;
  nodePath?: string;
  orchestratorModel?: string;
  orchestratorSmallModel?: string;
  profiles?: ValidatedWorkerProfiles;
  profileDiagnostics: string[];
  orchestrationSkillNames: string[];
  catalog: WorkerCapabilityCatalog;
  manifestPath: string;
}

export interface OpenCodeConfig {
  $schema: string;
  model?: string;
  small_model?: string;
  default_agent: string;
  agent: Record<string, Record<string, unknown>>;
  skills: { paths: string[] };
  mcp: Record<string, Record<string, unknown>>;
  permission: Record<string, unknown>;
}

export function buildOpenCodeHarnessConfig(input: OpenCodeHarnessConfigInput): OpenCodeConfig {
  const permission = orchestrationPermission(input.targetCwd, input.skillRoot, input.manifestPath);
  const agent: Record<string, unknown> = {
    mode: 'primary',
    description: 'Coordinate worker agents and maintain orchestrate-* skills.',
    prompt: orchestrationPrompt(input),
    permission,
  };
  if (input.orchestratorModel) agent.model = input.orchestratorModel;

  const config: OpenCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    default_agent: OPENCODE_ORCHESTRATOR_AGENT,
    agent: { [OPENCODE_ORCHESTRATOR_AGENT]: agent },
    skills: { paths: input.skillRoots },
    mcp: {
      github: { enabled: false },
      gh: { enabled: false },
      'agent-orchestrator': {
        type: 'local',
        command: [input.nodePath ?? process.execPath, input.mcpCliPath],
      },
    },
    permission,
  };
  if (input.orchestratorModel) config.model = input.orchestratorModel;
  if (input.orchestratorSmallModel) config.small_model = input.orchestratorSmallModel;
  return config;
}

export function stringifyOpenCodeConfig(config: OpenCodeConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function orchestrationPermission(targetCwd: string, skillRoot: string, manifestPath: string): Record<string, unknown> {
  return {
    '*': 'deny',
    read: 'allow',
    list: 'allow',
    glob: 'allow',
    grep: 'allow',
    skill: {
      '*': 'deny',
      'orchestrate-*': 'allow',
    },
    question: 'allow',
    edit: setupEditPermission(targetCwd, skillRoot, manifestPath),
    todowrite: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    task: 'deny',
    external_directory: externalDirectoryPermission(targetCwd, skillRoot, manifestPath),
    bash: 'deny',
    'agent-orchestrator_*': 'allow',
    'github_*': 'deny',
    'gh_*': 'deny',
  };
}

function setupEditPermission(targetCwd: string, skillRoot: string, manifestPath: string): Record<string, string> {
  return Object.fromEntries([
    ['*', 'deny'],
    ...manifestPermissionPaths(manifestPath, targetCwd).map((path) => [path, 'allow']),
    ...skillPermissionPaths(skillRoot, targetCwd).map((path) => [path, 'allow']),
  ]);
}

function externalDirectoryPermission(targetCwd: string, skillRoot: string, manifestPath: string): Record<string, string> {
  const permission: Record<string, string> = {
    '*': 'deny',
    [manifestPath]: 'allow',
  };
  const skillPattern = join(skillRoot, 'orchestrate-*', 'SKILL.md');
  if (isOutsideTargetCwd(targetCwd, skillPattern)) {
    permission[skillPattern] = 'allow';
  }
  return permission;
}

function manifestPermissionPaths(manifestPath: string, targetCwd: string): string[] {
  return setupPermissionPaths(manifestPath, targetCwd, { includeOutsideRelative: true });
}

function skillPermissionPaths(skillRoot: string, targetCwd: string): string[] {
  const absolutePattern = join(skillRoot, 'orchestrate-*', 'SKILL.md');
  return setupPermissionPaths(absolutePattern, targetCwd, { includeOutsideRelative: false });
}

function setupPermissionPaths(
  absolutePath: string,
  targetCwd: string,
  options: { includeOutsideRelative: boolean },
): string[] {
  const paths = [absolutePath];
  const relativePattern = relative(targetCwd, absolutePath);
  if (relativePattern && (options.includeOutsideRelative || (!relativePattern.startsWith('..') && relativePattern !== '..'))) {
    paths.push(relativePattern);
  }
  return Array.from(new Set(paths));
}

function isOutsideTargetCwd(targetCwd: string, absolutePath: string): boolean {
  const relativePath = relative(targetCwd, absolutePath);
  return relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function orchestrationPrompt(input: OpenCodeHarnessConfigInput): string {
  return [
    'You are the Agent Orchestrator supervisor.',
    '',
    'Your job is to coordinate worker agents through the agent-orchestrator MCP server and maintain project-owned orchestrate-* skills for this workspace.',
    '',
    'Hard constraints:',
    '- Do not directly edit, write, patch, todowrite, commit, push, publish, create pull requests, or mutate external services except for the writable profiles manifest and orchestrate-* skill SKILL.md files under the shared skill root.',
    '- Direct file edits are allowed only for the writable profiles manifest path and SKILL.md files under the shared skill root.',
    '- Source, docs, package metadata, MCP configs, secrets, commits, pull requests, publishing, and external-service writes must not be done directly from this supervisor.',
    '- Direct bash/shell execution is disabled. Use read/list/glob/grep and agent-orchestrator MCP tools for supervisor context, or delegate shell inspection to workers.',
    '- Start worker runs either by live profile alias or by direct backend/model settings only when the user explicitly asks for a direct override or profile setup is broken.',
    '- Prefer start_run with profile plus profiles_file so the daemon reads and validates the current profiles manifest at worker-start time.',
    '- Use the target workspace as the default cwd for worker runs unless the user explicitly chooses another workspace.',
    '- If profiles are missing or invalid, discuss the needed profile aliases with the user. Create or update the writable profiles manifest only after the user asks you to configure profiles.',
    '',
    `Target workspace: ${input.targetCwd}`,
    `Writable profiles manifest path: ${input.manifestPath}`,
    `Writable profiles manifest path relative to workspace: ${relative(input.targetCwd, input.manifestPath)}`,
    `Shared skill root: ${input.skillRoot}`,
    `Shared skill root relative to workspace: ${relative(input.targetCwd, input.skillRoot)}`,
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
    'Project-owned orchestrate-* skills currently found:',
    formatProjectSkills(input.orchestrationSkillNames),
    '',
    'Profiles manifest guidance:',
    '- You may create or update only the writable profiles manifest path when the user asks you to configure profiles.',
    '- Keep profiles provider-agnostic: profile ids map to backend, model, variant, reasoning effort, service tier, description, and metadata.',
    '- Use list_worker_profiles with profiles_file to inspect the live profile manifest before choosing workers.',
    '- For normal worker starts, call start_run with profile and profiles_file using the writable profiles manifest path.',
    '- Use direct backend/model/reasoning_effort/service_tier in start_run only when the user explicitly requests a one-off direct model or when live profile resolution is broken.',
    '',
    'Long-running run supervision (notification-aware path preferred):',
    '- Prefer wait_for_any_run with the active run_ids and a bounded wait_seconds (1-300). The default wake semantics are the union of "terminal" and "fatal_error", so a fatal backend error surfaces as soon as it appears rather than waiting for terminal.',
    '- Maintain a notification cursor across calls: pass the highest notification_id you have seen as after_notification_id on the next wait_for_any_run.',
    '- Use list_run_notifications with since_notification_id to reconcile state after disconnect or after returning control to the user.',
    '- Bounded wait_for_run remains supported for single-run supervision.',
    '- If notifications are not surfaced (older daemon), fall back to bounded wait_for_run calls rather than one very long wait. Make the first check-in around 30 seconds after start_run so startup, auth, model, quota, and protocol failures surface quickly.',
    '- At each check-in, inspect get_run_status and compare last_activity_at, last_activity_source, timeout_reason, terminal_reason, and latest_error with the previous check-in. Use get_run_events for recent context when the state changed or latest_error is present.',
    '- If latest_error is fatal, stop waiting and report or route a focused follow-up based on the error category. Do not wait for the idle window after a fatal backend error is visible.',
    '- If activity is advancing and no fatal error is present, back off future waits toward about 2 minutes, then 5 minutes, then a 10-15 minute ceiling chosen for the task.',
    '- Do not cancel a worker solely because elapsed wall-clock time is high. Cancel only on explicit user request, clear no-activity evidence past the idle window, or a deliberate stop/restart recovery path.',
    '- For known quiet tasks, choose a larger idle_timeout_seconds at start_run or send_followup instead of relying on a hard execution_timeout_seconds.',
    '',
    'Orchestration skill guidance:',
    '- Normal and orchestration skills share the same skill root. Orchestration skills must be named orchestrate-* so they are clearly distinguishable and loadable by this supervisor.',
    '- Create or update orchestration skills as .agents/skills/orchestrate-{name}/SKILL.md unless a custom shared skill root was configured.',
    '- Do not write non-orchestrate-* skills from this supervisor.',
    '- A skill file needs YAML frontmatter with name and description, followed by concise workflow instructions.',
    '- Orchestration skills must reference profile aliases, not raw model names, variants, service tiers, backend names, or reasoning effort values. The user controls those concrete model settings in the profiles manifest.',
    '- Orchestration skills should explain how to select profile aliases, start worker runs with start_run profile plus profiles_file and cwd from supervisor context, perform adaptive check-ins, evaluate latest_error and activity state, and request follow-up. They should not tell the supervisor to edit source directly.',
    '',
    'Manifest shape:',
    JSON.stringify({
      version: 1,
      profiles: {
        'example-implementation': {
          backend: 'codex',
          model: 'gpt-example',
          reasoning_effort: 'high',
          description: 'Deep implementation work',
        },
      },
    }, null, 2),
  ].join('\n');
}

function formatProjectSkills(skillNames: string[]): string {
  if (skillNames.length === 0) return '- none yet';
  return skillNames.map((name) => `- ${name}`).join('\n');
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
