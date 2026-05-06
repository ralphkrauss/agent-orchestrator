import type { SupervisorEvent } from '../contract.js';
import { tools as mcpTools } from '../mcpTools.js';
import { quoteCommandTokens, type ResolvedMonitorPin } from './monitorPin.js';

export const CLAUDE_MCP_SERVER_NAME = 'agent-orchestrator';

/**
 * Built-in Claude Code tools available to the supervisor. Read-only inspection
 * tools and Skill match normal Claude workspace ergonomics; Bash is available
 * for read-only inspection commands and the pinned daemon monitor. Editing
 * tools and write-shaped shell commands remain unavailable.
 */
export const CLAUDE_SUPERVISOR_BUILTIN_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Skill'] as const;

export interface ClaudeSupervisorHookEntry {
  type: 'command';
  command: string;
}

export interface ClaudeSupervisorHookGroup {
  hooks: ClaudeSupervisorHookEntry[];
}

/**
 * Harness-generated supervisor hooks. Uses Claude Code's documented nested
 * `hooks.<EventName>[].hooks[]` shape. Five Claude lifecycle events are
 * mapped to internal SupervisorEvents (Decision 3b). The composed command
 * string is statically built from the pinned absolute supervisor-CLI path
 * plus a static event identifier — no untrusted interpolation.
 */
export interface ClaudeSupervisorHooks {
  UserPromptSubmit: ClaudeSupervisorHookGroup[];
  Notification: ClaudeSupervisorHookGroup[];
  Stop: ClaudeSupervisorHookGroup[];
  SessionStart: ClaudeSupervisorHookGroup[];
  SessionEnd: ClaudeSupervisorHookGroup[];
}

export interface ClaudeSupervisorRemoteControlSettings {
  remoteControlAtStartup: true;
  agentPushNotifEnabled: true;
}

export interface ClaudeSupervisorSettings {
  permissions: {
    defaultMode: 'dontAsk';
    allow: string[];
    deny: string[];
  };
  enableAllProjectMcpServers: false;
  hooks: ClaudeSupervisorHooks;
  enabledPlugins: Record<string, never>;
  remoteControlAtStartup?: true;
  agentPushNotifEnabled?: true;
}

export interface ClaudeSupervisorPermissionInput {
  /**
   * Explicit `Bash(...)` monitor allow patterns. The Claude harness supplies
   * exactly the argv shapes that `buildMonitorBashCommand()` produces, so the
   * Bash permission cannot be wider than the supervisor's pinned monitor
   * invocations.
   */
  monitorBashAllowPatterns: readonly string[];
  /**
   * Pinned absolute supervisor-CLI invocation. Used to compose harness-owned
   * Claude lifecycle hook command strings (Decisions 3 / 21). Must be
   * provided when generating supervisor settings; the print-config / launcher
   * paths always supply it.
   */
  monitorPin: ResolvedMonitorPin;
  /**
   * When true, embed the documented Remote Control settings keys
   * (`remoteControlAtStartup`, `agentPushNotifEnabled`) in the generated
   * supervisor settings. Default off; opt-in per Decision 12.
   */
  remoteControl?: boolean;
}

/**
 * Claude Code lifecycle event names used by the harness-generated supervisor
 * hooks (Decision 3 / 3b). Statically enumerated so `composeSupervisorHookCommand`
 * cannot be called with arbitrary, possibly user-supplied input.
 */
export const CLAUDE_SUPERVISOR_HOOK_EVENT_NAMES = [
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SessionStart',
  'SessionEnd',
] as const;
export type ClaudeSupervisorHookEventName = typeof CLAUDE_SUPERVISOR_HOOK_EVENT_NAMES[number];

const CLAUDE_HOOK_EVENT_TO_SUPERVISOR_EVENT: Record<ClaudeSupervisorHookEventName, SupervisorEvent> = {
  UserPromptSubmit: 'turn_started',
  Notification: 'waiting_for_user',
  Stop: 'turn_stopped',
  SessionStart: 'session_active',
  SessionEnd: 'session_ended',
};

export function supervisorEventForClaudeHookEvent(event: ClaudeSupervisorHookEventName): SupervisorEvent {
  return CLAUDE_HOOK_EVENT_TO_SUPERVISOR_EVENT[event];
}

export function isClaudeSupervisorHookEventName(value: string): value is ClaudeSupervisorHookEventName {
  return (CLAUDE_SUPERVISOR_HOOK_EVENT_NAMES as readonly string[]).includes(value);
}

/**
 * Compose the harness-owned Claude `type: "command"` hook string for one
 * lifecycle event. The output has the fixed shape
 * `<pinned-cli-prefix> supervisor signal <Event>` with each repo-controlled
 * token statically shell-quoted by `quoteCommandTokens` (Decisions 3 / 21).
 *
 * The function rejects any non-enumerated event name. By construction the
 * returned string contains no shell metacharacters because each input token is
 * either a path validated by `assertMonitorPathIsSupported` or a static
 * identifier from the closed enum above. The unit-test injection fixture in
 * `claudeHarness.test.ts` exercises this rejection path.
 */
export function composeSupervisorHookCommand(
  monitorPin: ResolvedMonitorPin,
  eventName: string,
): string {
  if (!isClaudeSupervisorHookEventName(eventName)) {
    throw new Error(
      `composeSupervisorHookCommand received an unsupported event name: ${JSON.stringify(eventName)}`,
    );
  }
  return quoteCommandTokens([...monitorPin.command_prefix, 'supervisor', 'signal', eventName]);
}

export function buildClaudeSupervisorHooks(monitorPin: ResolvedMonitorPin): ClaudeSupervisorHooks {
  const groupFor = (event: ClaudeSupervisorHookEventName): ClaudeSupervisorHookGroup[] => [{
    hooks: [{ type: 'command', command: composeSupervisorHookCommand(monitorPin, event) }],
  }];
  return {
    UserPromptSubmit: groupFor('UserPromptSubmit'),
    Notification: groupFor('Notification'),
    Stop: groupFor('Stop'),
    SessionStart: groupFor('SessionStart'),
    SessionEnd: groupFor('SessionEnd'),
  };
}

export interface ClaudeBashPermissionDecision {
  permitted: boolean;
  allowedBy: string[];
  deniedBy: string[];
}

const CLAUDE_SUPERVISOR_DENIED_MCP_TOOL_NAMES = ['wait_for_any_run', 'wait_for_run'] as const;

/**
 * Positive allowlist of Bash inspection patterns the supervisor is permitted
 * to run alongside the pinned monitor command (which `buildClaudeAllowedToolsList`
 * appends separately). The complete Bash allow list is therefore the pinned
 * monitor plus these three patterns. Combined with `--permission-mode dontAsk`,
 * anything outside the four allow patterns is denied. Bypasses such as
 * `git -C . add README.md` or `command touch /tmp/x` are denied because they
 * do not match any allow pattern, not because the deny list enumerates every
 * possible escape route. The deny list below is defense in depth.
 */
const CLAUDE_SUPERVISOR_BASH_INSPECTION_ALLOWLIST = [
  // Working-directory inspection.
  'Bash(pwd)',
  // Read-only git inspection. `git status` cannot mutate state regardless of
  // its flags; the deny list still rejects shell metacharacters that would let
  // a flag value smuggle in a chained command.
  'Bash(git status)',
  'Bash(git status *)',
] as const;

// Defense-in-depth Bash deny list. The primary security boundary is the
// positive Bash allowlist (the pinned monitor, plus pwd / git status /
// git status *) combined with --permission-mode dontAsk; this list
// explicitly rejects common write/exec/network paths so the supervisor cannot
// escape via patterns that would otherwise depend solely on model compliance.
// Both `<cmd>` and `*/<cmd>` forms are included so absolute paths like
// `/usr/bin/<cmd>` are also denied.
const CLAUDE_DENIED_COMMAND_NAMES = [
  // file-mutation primitives
  'touch', 'mkdir', 'rm', 'rmdir', 'mv', 'cp', 'chmod', 'chown', 'chgrp',
  'ln', 'tee', 'dd', 'truncate', 'install', 'patch', 'sync',
  // script interpreters / eval / exec entry points
  // `node` is intentionally not included here: the pinned monitor itself runs
  // through process.execPath. Generic `node ...` commands remain outside the
  // positive Bash allowlist and are denied by dontAsk; inline execution is also
  // caught by the `*-e *` / `*--eval*` deny patterns below.
  'deno', 'bun', 'tsx', 'ts-node',
  'python', 'python3', 'perl', 'ruby', 'php', 'lua', 'osascript',
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh',
  'eval', 'exec', 'source', 'env', 'xargs', 'parallel', 'sudo', 'su', 'doas',
  // package managers / installers / build runners
  'npm', 'pnpm', 'yarn', 'npx', 'pnpx', 'bunx',
  'pip', 'pip3', 'pipx', 'uv', 'uvx', 'poetry', 'conda', 'mamba',
  'cargo', 'rustup', 'go',
  'brew', 'apt', 'apt-get', 'aptitude', 'dnf', 'yum', 'zypper', 'pacman', 'snap', 'flatpak',
  'gem', 'bundle', 'dotnet', 'mvn', 'gradle', 'sbt',
  'make', 'cmake', 'just', 'rake', 'task', 'meson', 'ninja',
  // network / file transfer
  'curl', 'wget', 'scp', 'rsync', 'ssh', 'sftp', 'ftp', 'nc', 'ncat', 'socat',
  'aria2c', 'gh', 'hub',
  // container / cloud
  'docker', 'podman', 'kubectl', 'helm', 'gcloud', 'aws', 'az', 'terraform',
  'ansible', 'ansible-playbook', 'pulumi',
  // process control / kernel
  'kill', 'killall', 'pkill', 'systemctl', 'service', 'launchctl', 'crontab',
] as const;

// Mutating or network-touching git subcommands beyond the originally denied set.
// `git diff`, `git log`, `git status`, `git show`, `git rev-parse`, `git blame`,
// `git ls-files`, `git ls-tree`, `git for-each-ref`, `git describe`,
// `git config --get`, etc. remain available because they are read-only.
const CLAUDE_DENIED_GIT_SUBCOMMANDS = [
  'add', 'commit', 'push', 'reset', 'checkout', 'switch', 'restore', 'clean',
  'apply', 'am', 'rebase', 'merge', 'cherry-pick', 'revert', 'tag', 'branch',
  'stash', 'config', 'rm', 'mv', 'fetch', 'pull', 'clone', 'init',
  'update-index', 'update-ref', 'worktree', 'sparse-checkout', 'remote',
  'submodule', 'notes', 'replace', 'filter-branch', 'filter-repo', 'gc',
  'prune', 'repack', 'hash-object', 'symbolic-ref', 'update-server-info',
  'daemon', 'fast-import', 'fast-export', 'p4', 'svn', 'lfs', 'maintenance',
  'send-email', 'request-pull', 'ls-remote', 'archive', 'bundle', 'pack-objects',
  'pack-refs', 'reflog', 'replay', 'commit-tree', 'mktag', 'mktree',
] as const;

const CLAUDE_DENIED_COMMAND_BASH_PATTERNS = CLAUDE_DENIED_COMMAND_NAMES.flatMap((name) => [
  `Bash(${name})`,
  `Bash(${name} *)`,
  `Bash(*/${name})`,
  `Bash(*/${name} *)`,
]);

const CLAUDE_DENIED_GIT_BASH_PATTERNS = CLAUDE_DENIED_GIT_SUBCOMMANDS.flatMap((sub) => [
  `Bash(git ${sub})`,
  `Bash(git ${sub} *)`,
]);

const CLAUDE_SUPERVISOR_DENIED_BASH_PATTERNS = [
  // shell metacharacters: chaining, redirection, expansion, command substitution
  'Bash(*;*)',
  'Bash(*&*)',
  'Bash(*|*)',
  'Bash(*>*)',
  'Bash(*<*)',
  'Bash(*$*)',
  'Bash(*`*)',
  'Bash(*\\*)',
  'Bash(*\n*)',
  // eval / inline-script flags that any interpreter or shell could use to
  // execute code regardless of the binary name
  'Bash(*-e *)',
  'Bash(*-c *)',
  'Bash(*--eval*)',
  'Bash(*--exec*)',
  'Bash(*--command*)',
  // git global option bypasses: `git -C dir <subcommand>`,
  // `git --git-dir=...`, `git --work-tree=...`, and `git --no-pager <subcmd>`
  // would otherwise let a mutating subcommand sneak past first-token deny
  // patterns such as `Bash(git add *)`.
  'Bash(git -C *)',
  'Bash(git -c *)',
  'Bash(git --git-dir*)',
  'Bash(git --work-tree*)',
  'Bash(git --namespace*)',
  'Bash(git --no-pager *)',
  'Bash(git --exec-path*)',
  // shell command-dispatch builtins that bypass first-token name matching:
  // `command touch x`, `command -p touch x`, `builtin touch x`,
  // `exec touch x`. The interpreters and `exec`/`command`/`builtin` names are
  // also covered above as `CLAUDE_DENIED_COMMAND_NAMES`, but these absolute
  // patterns make the bypass intent explicit.
  'Bash(command *)',
  'Bash(*/command *)',
  'Bash(builtin *)',
  ...CLAUDE_DENIED_COMMAND_BASH_PATTERNS,
  ...CLAUDE_DENIED_GIT_BASH_PATTERNS,
  // forbid Bash equivalents of the read-only Claude built-ins so the supervisor
  // is funnelled through Read/Glob/Grep instead of shelling out
  'Bash(jq *)',
  'Bash(cat *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(grep *)',
  'Bash(rg *)',
  'Bash(sed *)',
  'Bash(awk *)',
  'Bash(find *)',
  'Bash(ls *)',
  // forbid inspection of Claude's own internal session files
  'Bash(*tool-results*)',
  'Bash(*.claude/projects*)',
] as const;

export function orchestratorMcpToolAllowList(): string[] {
  return mcpTools.map((tool) => `mcp__${CLAUDE_MCP_SERVER_NAME}__${tool.name}`).sort();
}

export function claudeOrchestratorMcpToolAllowList(): string[] {
  const denied = new Set(claudeOrchestratorMcpToolDenyList());
  return orchestratorMcpToolAllowList().filter((name) => !denied.has(name));
}

export function claudeOrchestratorMcpToolDenyList(): string[] {
  return CLAUDE_SUPERVISOR_DENIED_MCP_TOOL_NAMES
    .map((name) => `mcp__${CLAUDE_MCP_SERVER_NAME}__${name}`)
    .sort();
}

export function buildClaudeAllowedToolsList(input: { monitorBashAllowPatterns: readonly string[] }): string[] {
  return [
    'Read',
    'Glob',
    'Grep',
    ...input.monitorBashAllowPatterns,
    ...CLAUDE_SUPERVISOR_BASH_INSPECTION_ALLOWLIST,
    'Skill',
    ...claudeOrchestratorMcpToolAllowList(),
  ];
}

export function claudeSupervisorBashInspectionAllowlist(): readonly string[] {
  return CLAUDE_SUPERVISOR_BASH_INSPECTION_ALLOWLIST;
}

export function buildClaudeSupervisorSettings(input: ClaudeSupervisorPermissionInput): ClaudeSupervisorSettings {
  const allow = buildClaudeAllowedToolsList({ monitorBashAllowPatterns: input.monitorBashAllowPatterns });
  const deny = [
    'Edit',
    'Write',
    'WebFetch',
    'WebSearch',
    'Task',
    'NotebookEdit',
    'TodoWrite',
    ...CLAUDE_SUPERVISOR_DENIED_BASH_PATTERNS,
    ...claudeOrchestratorMcpToolDenyList(),
  ];
  const settings: ClaudeSupervisorSettings = {
    permissions: {
      defaultMode: 'dontAsk',
      allow,
      deny,
    },
    enableAllProjectMcpServers: false,
    hooks: buildClaudeSupervisorHooks(input.monitorPin),
    enabledPlugins: {},
  };
  if (input.remoteControl) {
    settings.remoteControlAtStartup = true;
    settings.agentPushNotifEnabled = true;
  }
  return settings;
}

export function stringifyClaudeSupervisorSettings(settings: ClaudeSupervisorSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export function evaluateClaudeBashPermission(settings: ClaudeSupervisorSettings, command: string): ClaudeBashPermissionDecision {
  const invocation = `Bash(${command})`;
  const allowedBy = settings.permissions.allow.filter((entry) => claudePermissionPatternMatches(entry, invocation));
  const deniedBy = settings.permissions.deny.filter((entry) => claudePermissionPatternMatches(entry, invocation));
  return {
    permitted: allowedBy.length > 0 && deniedBy.length === 0,
    allowedBy,
    deniedBy,
  };
}

export function assertClaudeBashCommandsPermitted(settings: ClaudeSupervisorSettings, commands: readonly { label: string; command: string }[]): void {
  for (const { label, command } of commands) {
    const decision = evaluateClaudeBashPermission(settings, command);
    if (decision.permitted) continue;
    const reason = decision.allowedBy.length === 0
      ? 'does not match any allow pattern'
      : `is shadowed by deny pattern(s): ${decision.deniedBy.join(', ')}`;
    throw new Error(`Claude Bash permission invariant failed for ${label}: ${JSON.stringify(command)} ${reason}`);
  }
}

function claudePermissionPatternMatches(pattern: string, invocation: string): boolean {
  return globPatternToRegExp(pattern).test(invocation);
}

function globPatternToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[\\^$+?.()|[\]{}]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 's');
}
