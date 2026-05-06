import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { cp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { IpcClient, IpcRequestError } from '../ipc/client.js';
import { daemonPaths } from '../daemon/paths.js';
import {
  removeOrchestratorSidecar,
  writeOrchestratorSidecar,
} from '../daemon/orchestratorSidecar.js';
import { OrchestratorRecordSchema, type OrchestratorDisplay, type OrchestratorRecord } from '../contract.js';
import { resolveBinary } from '../backend/common.js';
import { getBackendStatus } from '../diagnostics.js';
import { ensureSecureRoot, resolveStoreRoot } from '../runStore.js';
import { defaultWorkerProfilesFile } from '../workerRouting.js';
import {
  createWorkerCapabilityCatalog,
  inspectWorkerProfiles,
  parseWorkerProfileManifest,
  type InspectedWorkerProfiles,
  type ValidatedWorkerProfiles,
} from './capabilities.js';
import {
  buildClaudeHarnessConfig,
  CLAUDE_MCP_SERVER_NAME,
  stringifyClaudeMcpConfig,
} from './config.js';
import { discoverClaudeSurface, summarizeReport, type ClaudeSurfaceReport } from './discovery.js';
import { buildClaudeAllowedToolsList, CLAUDE_SUPERVISOR_BUILTIN_TOOLS, stringifyClaudeSupervisorSettings } from './permission.js';
import { resolveMonitorPin } from './monitorPin.js';
import { validateClaudePassthroughArgs } from './passthrough.js';
import { curateOrchestrateSkills, mirrorClaudeProjectSkills } from './skills.js';

export interface ParsedClaudeLauncherArgs {
  cwd: string;
  profilesFile: string;
  profilesJson: string | null;
  manifestPath: string;
  skillsPath: string;
  stateDir: string;
  claudeBinary: string;
  printConfig: boolean;
  printDiscovery: boolean;
  help: boolean;
  claudeArgs: string[];
  remoteControl: boolean;
  remoteControlSessionNamePrefix: string | null;
  orchestratorLabel: string | null;
}

export function parseClaudeLauncherArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  defaultCwd = process.cwd(),
): { ok: true; value: ParsedClaudeLauncherArgs } | { ok: false; error: string } {
  const args = [...argv];
  if (args[0] === 'setup') args.shift();

  const separator = args.indexOf('--');
  const ownArgs = separator >= 0 ? args.slice(0, separator) : args;
  const claudeArgs = separator >= 0 ? args.slice(separator + 1) : [];

  let cwd = env.AGENT_ORCHESTRATOR_CLAUDE_CWD || defaultCwd;
  let profilesFile: string | null = env.AGENT_ORCHESTRATOR_CLAUDE_PROFILES_FILE
    || env.AGENT_ORCHESTRATOR_CLAUDE_MANIFEST
    || null;
  let profilesJson: string | null = env.AGENT_ORCHESTRATOR_CLAUDE_PROFILES_JSON || null;
  let skillsPath: string | null = env.AGENT_ORCHESTRATOR_CLAUDE_SKILLS_PATH || null;
  let stateDir: string | null = env.AGENT_ORCHESTRATOR_CLAUDE_STATE_DIR || null;
  let claudeBinary = env.AGENT_ORCHESTRATOR_CLAUDE_BIN || env.CLAUDE_BIN || 'claude';
  let printConfig = false;
  let printDiscovery = false;
  let help = false;
  let remoteControl = false;
  let remoteControlSessionNamePrefix: string | null = null;
  let orchestratorLabel: string | null = null;

  try {
    for (let index = 0; index < ownArgs.length; index += 1) {
      const arg = ownArgs[index];
      if (!arg) continue;
      if (arg === '--help' || arg === '-h') {
        help = true;
      } else if (arg === '--print-config' || arg === '--dry-run') {
        printConfig = true;
      } else if (arg === '--print-discovery') {
        printDiscovery = true;
      } else if (arg === '--cwd') {
        cwd = readOptionValue(ownArgs, ++index, arg);
      } else if (arg === '--profiles-file' || arg === '--manifest') {
        profilesFile = readOptionValue(ownArgs, ++index, arg);
      } else if (arg === '--profiles-json') {
        profilesJson = readOptionValue(ownArgs, ++index, arg);
      } else if (arg === '--skills' || arg === '--orchestration-skills') {
        skillsPath = readOptionValue(ownArgs, ++index, arg);
      } else if (arg === '--state-dir') {
        stateDir = readOptionValue(ownArgs, ++index, arg);
      } else if (arg === '--claude-binary') {
        claudeBinary = readOptionValue(ownArgs, ++index, arg);
      } else if (arg === '--remote-control') {
        remoteControl = true;
      } else if (arg === '--remote-control-session-name-prefix') {
        remoteControlSessionNamePrefix = readOptionValue(ownArgs, ++index, arg);
      } else if (arg === '--orchestrator-label') {
        orchestratorLabel = readOptionValue(ownArgs, ++index, arg);
      } else {
        return { ok: false, error: `Unknown option: ${arg}. Pass Claude arguments after --.` };
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const resolvedCwd = resolve(defaultCwd, cwd);
  const defaultProfilesPath = defaultWorkerProfilesFile(env);
  const resolvedProfilesFile = resolve(resolvedCwd, profilesFile ?? defaultProfilesPath);
  const resolvedSkillsPath = resolve(resolvedCwd, skillsPath ?? '.agents/skills');
  const defaultStateDir = join(env.AGENT_ORCHESTRATOR_HOME || resolveStoreRoot(), 'claude-supervisor');
  const resolvedStateDir = resolve(defaultCwd, stateDir ?? defaultStateDir);
  return {
    ok: true,
    value: {
      cwd: resolvedCwd,
      profilesFile: resolvedProfilesFile,
      profilesJson,
      manifestPath: resolvedProfilesFile,
      skillsPath: resolvedSkillsPath,
      stateDir: resolvedStateDir,
      claudeBinary,
      printConfig,
      printDiscovery,
      help,
      claudeArgs,
      remoteControl,
      remoteControlSessionNamePrefix,
      orchestratorLabel,
    },
  };
}

export interface ClaudeLauncherIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
}

export interface BuiltClaudeEnvelope {
  envelopeDir: string;
  launchCwd: string;
  settingsPath: string;
  mcpConfigPath: string;
  systemPromptPath: string;
  skillsRoot: string;
  stateDir: string;
  stateHome: string;
  stateXdgConfigHome: string;
  stateClaudeConfigDir: string;
  userSkillsRoot: string;
  userSkillNames: string[];
  systemPrompt: string;
  settingsContent: string;
  mcpConfigContent: string;
  spawnArgs: string[];
  spawnEnv: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

export async function runClaudeLauncher(
  argv: readonly string[],
  io: ClaudeLauncherIo = { stdout: process.stdout, stderr: process.stderr, env: process.env },
): Promise<number> {
  const env = io.env ?? process.env;
  const parsed = parseClaudeLauncherArgs(argv, env);
  if (!parsed.ok) {
    io.stderr.write(`${parsed.error}\nRun agent-orchestrator claude --help for usage.\n`);
    return 1;
  }
  const options = parsed.value;
  if (options.help) {
    io.stdout.write(claudeLauncherHelp());
    return 0;
  }

  const cwdValidation = await validateCwd(options.cwd);
  if (!cwdValidation.ok) {
    io.stderr.write(`${cwdValidation.error}\n`);
    return 1;
  }

  const passthroughValidation = validateClaudePassthroughArgs(options.claudeArgs);
  if (!passthroughValidation.ok) {
    io.stderr.write(`${passthroughValidation.error}\n`);
    return 1;
  }

  const discovery = await discoverClaudeSurface(options.claudeBinary);
  if (options.printDiscovery) {
    io.stdout.write(summarizeReport(discovery));
    return discovery.recommended_path === 'isolated_envelope' ? 0 : 1;
  }
  if (discovery.recommended_path !== 'isolated_envelope') {
    io.stderr.write(`Claude isolation envelope unsupported by this binary:\n${summarizeReport(discovery)}`);
    return 1;
  }

  const backendStatus = await getBackendStatus();
  const catalog = createWorkerCapabilityCatalog(backendStatus);
  const profilesResult = await loadProfilesForLaunch(options, catalog);
  if (!profilesResult.ok) {
    io.stderr.write(`${profilesResult.errors.join('\n')}\n`);
    return 1;
  }

  // Generate orchestrator identity before spawning Claude (Decision 2).
  // The launcher pins it into the supervisor's MCP server entry env so the
  // model never authors `metadata.orchestrator_id`.
  const orchestratorId = ulid();
  const display = captureSupervisorDisplay(env, options);

  const built = await buildClaudeEnvelope({
    options,
    env,
    catalog,
    profilesResult,
    orchestratorId,
    remoteControl: options.remoteControl,
    display,
  });
  if (options.printConfig) {
    io.stdout.write(`# system prompt\n${built.systemPrompt}\n\n# settings.json\n${built.settingsContent}\n# mcp.json\n${built.mcpConfigContent}\n# launch cwd\n${built.launchCwd}\n# runtime skills root\n${built.userSkillsRoot}\n# runtime skills\n${built.userSkillNames.join(', ') || 'none'}\n# spawn args\n${JSON.stringify(built.spawnArgs)}\n# orchestrator id\n${orchestratorId}\n# orchestrator label\n${orchestratorLabelFor(options)}\n# remote control\n${options.remoteControl ? 'enabled' : 'disabled'}\n# display\n${JSON.stringify(display)}\n`);
    await built.cleanup();
    return 0;
  }

  const binary = await resolveBinary(options.claudeBinary, process.platform, env);
  if (!binary) {
    await built.cleanup();
    io.stderr.write(`Claude binary not found: ${options.claudeBinary}\n`);
    return 1;
  }

  // Write a registration sidecar at <store_root>/orchestrators/<id>.json so
  // the supervisor's signal CLI can transparently re-register if the daemon
  // restarts mid-session (issue #40, F5 / Assumption A7). Best effort;
  // failures only log a warning.
  const storeRoot = env.AGENT_ORCHESTRATOR_HOME || resolveStoreRoot();
  const registrationRecord: OrchestratorRecord = OrchestratorRecordSchema.parse({
    id: orchestratorId,
    client: 'claude',
    label: orchestratorLabelFor(options),
    cwd: options.cwd,
    display,
    registered_at: new Date().toISOString(),
    last_supervisor_event_at: null,
  });
  try {
    await writeOrchestratorSidecar(storeRoot, registrationRecord);
  } catch (error) {
    io.stderr.write(`agent-orchestrator: failed to write orchestrator sidecar: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  // Best-effort registration with the local daemon. Failures must not block
  // the launch; the supervisor's first hook signal will trigger a transparent
  // re-register from the sidecar if the daemon is later available.
  await registerOrchestrator({
    orchestratorId,
    label: orchestratorLabelFor(options),
    cwd: options.cwd,
    display,
    log: (message) => io.stderr.write(`${message}\n`),
  });

  try {
    return await spawnClaude(binary, options, built);
  } finally {
    await unregisterOrchestrator(orchestratorId, (message) => io.stderr.write(`${message}\n`));
    try {
      await removeOrchestratorSidecar(storeRoot, orchestratorId);
    } catch (error) {
      io.stderr.write(`agent-orchestrator: failed to remove orchestrator sidecar: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await built.cleanup();
  }
}

export function orchestratorLabelFor(options: ParsedClaudeLauncherArgs): string {
  if (options.orchestratorLabel && options.orchestratorLabel.trim()) return options.orchestratorLabel.trim();
  return basename(options.cwd) || 'orchestrator';
}

/**
 * Capture display metadata at supervisor launch (Decision 11). Best effort:
 * failures leave fields `null`. Tmux window id is queried via
 * `tmux display-message` only when `TMUX` is set; spawnSync uses `shell:false`
 * with a 500ms timeout.
 */
export function captureSupervisorDisplay(
  env: NodeJS.ProcessEnv,
  options: ParsedClaudeLauncherArgs,
): OrchestratorDisplay {
  const tmuxPane = stringOrNull(env.TMUX_PANE);
  const tmux = stringOrNull(env.TMUX);
  let tmuxWindowId: string | null = null;
  if (tmux) {
    try {
      const result = spawnSync('tmux', ['display-message', '-p', '-F', '#{window_id}'], {
        encoding: 'utf8',
        timeout: 500,
        shell: false,
      });
      if (result.status === 0 && typeof result.stdout === 'string') {
        const value = result.stdout.trim();
        if (value) tmuxWindowId = value;
      }
    } catch {
      // best effort
    }
  }
  return {
    tmux_pane: tmuxPane,
    tmux_window_id: tmuxWindowId,
    base_title: orchestratorLabelFor(options),
    host: hostname() || null,
  };
}

function stringOrNull(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

async function registerOrchestrator(input: {
  orchestratorId: string;
  label: string;
  cwd: string;
  display: OrchestratorDisplay;
  log: (message: string) => void;
}): Promise<void> {
  try {
    const client = new IpcClient(daemonPaths().ipc.path);
    await client.request('register_supervisor', {
      orchestrator_id: input.orchestratorId,
      label: input.label,
      cwd: input.cwd,
      client: 'claude',
      display: input.display,
    }, 5_000);
  } catch (error) {
    if (error instanceof IpcRequestError && error.orchestratorError.code === 'DAEMON_UNAVAILABLE') {
      input.log('agent-orchestrator: daemon unavailable; skipping orchestrator registration (will register on first signal)');
      return;
    }
    input.log(`agent-orchestrator: orchestrator register failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function unregisterOrchestrator(orchestratorId: string, log: (message: string) => void): Promise<void> {
  try {
    const client = new IpcClient(daemonPaths().ipc.path);
    await client.request('unregister_supervisor', { orchestrator_id: orchestratorId }, 2_000);
  } catch (error) {
    if (error instanceof IpcRequestError && error.orchestratorError.code === 'DAEMON_UNAVAILABLE') return;
    log(`agent-orchestrator: orchestrator unregister failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function claudeLauncherHelp(): string {
  return `agent-orchestrator claude

Usage:
  agent-orchestrator claude [options] [-- <claude args>]
  agent-orchestrator-claude [options] [-- <claude args>]

Options:
  --cwd <path>                       Target workspace. Defaults to current directory.
  --profiles-file <path>             Worker profiles manifest. Defaults to ~/.config/agent-orchestrator/profiles.json.
  --manifest <path>                  Compatibility alias for --profiles-file.
  --profiles-json <json>             Inline worker profiles manifest.
  --skills <path>                    Source skill root. Defaults to .agents/skills (orchestrate-* only is exposed).
  --state-dir <path>                 Durable Claude supervisor state (auth + stable workspace envelopes). Defaults to \${AGENT_ORCHESTRATOR_HOME:-~/.agent-orchestrator}/claude-supervisor.
  --claude-binary <path>             Defaults to claude on PATH.
  --remote-control                   Opt in to Claude Remote Control (issue #40). Embeds the documented
                                     remoteControlAtStartup / agentPushNotifEnabled keys in the generated
                                     supervisor settings. Default: off.
  --remote-control-session-name-prefix <prefix>
                                     Forwarded to Claude as --remote-control-session-name-prefix.
  --orchestrator-label <name>        Label written to the orchestrator record's display.base_title and
                                     surfaced to user status hooks. Defaults to basename(cwd).
  --print-discovery                  Print the Claude binary compatibility report and exit.
  --print-config                     Print the generated supervisor envelope (system prompt, settings, mcp, runtime skills) and exit.
  --help

Passthrough after --:
  Allowed Claude flags: --print, -p, --output-format, --input-format, --include-partial-messages,
  --include-hook-events, --verbose, --debug, -d, --name, -n,
  --exclude-dynamic-system-prompt-sections, --no-session-persistence,
  --remote-control-session-name-prefix.
  Forbidden flags (the harness owns these or they would break isolation):
  --dangerously-skip-permissions, --mcp-config, --strict-mcp-config, --tools,
  --allowed-tools, --disallowed-tools, --add-dir, --settings, --setting-sources,
  --system-prompt(-file), --append-system-prompt(-file), --plugin-dir, --agents,
  --agent, --permission-mode, --disable-slash-commands, --bare. (--bare changes
  memory, plugin, auth/keychain, and discovery behavior that the harness owns
  through its restricted launch.)

Environment fallbacks:
  AGENT_ORCHESTRATOR_CLAUDE_CWD
  AGENT_ORCHESTRATOR_CLAUDE_PROFILES_FILE
  AGENT_ORCHESTRATOR_CLAUDE_PROFILES_JSON
  AGENT_ORCHESTRATOR_CLAUDE_MANIFEST
  AGENT_ORCHESTRATOR_CLAUDE_SKILLS_PATH
  AGENT_ORCHESTRATOR_CLAUDE_STATE_DIR
  AGENT_ORCHESTRATOR_CLAUDE_BIN
`;
}

export async function buildClaudeEnvelope(input: {
  options: ParsedClaudeLauncherArgs;
  env: NodeJS.ProcessEnv;
  catalog: ReturnType<typeof createWorkerCapabilityCatalog>;
  profilesResult: { profiles: ValidatedWorkerProfiles | undefined; diagnostics: string[] };
  discovery?: ClaudeSurfaceReport;
  orchestratorId?: string;
  remoteControl?: boolean;
  display?: OrchestratorDisplay;
}): Promise<BuiltClaudeEnvelope> {
  const { options, env, catalog, profilesResult } = input;
  await ensureSecureRoot(options.stateDir);
  const envelopeDir = await stableClaudeEnvelopeDir(options.stateDir, options.cwd);
  const stateHome = join(options.stateDir, 'home');
  const stateXdgConfigHome = join(stateHome, '.config');
  const stateClaudeConfigDir = join(stateHome, '.claude');
  const userSkillsRoot = join(stateClaudeConfigDir, 'skills');
  // Keep a snapshot of project-owned orchestrate-* skills in the stable
  // envelope for print-config/debugging and embed their workflow text in the
  // system prompt. Runtime skill discovery comes from the normal target
  // workspace cwd, matching a regular Claude launch.
  const projectClaude = join(envelopeDir, '.claude');
  const ephemeralSkillRoot = join(projectClaude, 'skills');
  await resetClaudeProjectDiscoverySurface(envelopeDir);
  await Promise.all([
    mkdir(stateHome, { recursive: true, mode: 0o700 }),
    mkdir(stateXdgConfigHome, { recursive: true, mode: 0o700 }),
    mkdir(stateClaudeConfigDir, { recursive: true, mode: 0o700 }),
    mkdir(projectClaude, { recursive: true, mode: 0o700 }),
  ]);
  await migrateLegacyClaudeConfigDir(join(options.stateDir, 'claude-config'), stateClaudeConfigDir);
  const [skills, userSkills] = await Promise.all([
    curateOrchestrateSkills({
      sourceSkillRoot: options.skillsPath,
      ephemeralSkillRoot,
    }),
    mirrorClaudeProjectSkills({
      sourceSkillRoot: join(options.cwd, '.claude', 'skills'),
      targetSkillRoot: userSkillsRoot,
    }),
  ]);
  const monitorPin = resolveMonitorPin(env);
  let manifestPath = options.manifestPath;
  if (options.profilesJson) {
    const inlineManifestPath = join(envelopeDir, 'profiles.json');
    const inlineContent = options.profilesJson.endsWith('\n')
      ? options.profilesJson
      : `${options.profilesJson}\n`;
    await writeFile(inlineManifestPath, inlineContent, { mode: 0o600 });
    manifestPath = inlineManifestPath;
  }
  const config = buildClaudeHarnessConfig({
    targetCwd: options.cwd,
    manifestPath,
    ephemeralSkillRoot: skills.ephemeralRoot,
    orchestrationSkillNames: skills.orchestrationSkillNames,
    orchestrationSkills: skills.orchestrationSkills,
    runtimeSkillRoot: userSkills.targetSkillRoot,
    runtimeSkillNames: userSkills.skillNames,
    catalog,
    profiles: profilesResult.profiles,
    profileDiagnostics: profilesResult.diagnostics,
    mcpCliPath: packageCliPath(),
    monitorPin,
    orchestratorId: input.orchestratorId,
    remoteControl: input.remoteControl,
  });
  const settingsPath = join(envelopeDir, 'settings.json');
  const userSettingsPath = join(stateClaudeConfigDir, 'settings.json');
  const mcpConfigPath = join(envelopeDir, 'mcp.json');
  const systemPromptPath = join(envelopeDir, 'system-prompt.md');
  const settingsContent = stringifyClaudeSupervisorSettings(config.settings);
  const mcpConfigContent = stringifyClaudeMcpConfig(config.mcpConfig);
  await Promise.all([
    writeFile(settingsPath, settingsContent, { mode: 0o600 }),
    writeFile(userSettingsPath, settingsContent, { mode: 0o600 }),
    writeFile(mcpConfigPath, mcpConfigContent, { mode: 0o600 }),
    writeFile(systemPromptPath, config.systemPrompt, { mode: 0o600 }),
  ]);
  const spawnArgs = buildClaudeSpawnArgs({
    settingsPath,
    mcpConfigPath,
    systemPromptPath,
    builtinTools: [...CLAUDE_SUPERVISOR_BUILTIN_TOOLS],
    allowedTools: buildClaudeAllowedToolsList({
      monitorBashAllowPatterns: monitorPin.monitor_bash_allow_patterns,
    }),
    passthrough: options.claudeArgs,
    remoteControlSessionNamePrefix: options.remoteControlSessionNamePrefix ?? null,
  });
  const spawnEnv: NodeJS.ProcessEnv = {
    ...env,
    AGENT_ORCHESTRATOR_HOME: env.AGENT_ORCHESTRATOR_HOME || resolveStoreRoot(),
    HOME: stateHome,
    XDG_CONFIG_HOME: stateXdgConfigHome,
    CLAUDE_CONFIG_DIR: stateClaudeConfigDir,
  };
  if (input.orchestratorId) {
    spawnEnv.AGENT_ORCHESTRATOR_ORCH_ID = input.orchestratorId;
  }
  const cleanup = async () => undefined;
  return {
    envelopeDir,
    launchCwd: options.cwd,
    settingsPath,
    mcpConfigPath,
    systemPromptPath,
    skillsRoot: skills.ephemeralRoot,
    stateDir: options.stateDir,
    stateHome,
    stateXdgConfigHome,
    stateClaudeConfigDir,
    userSkillsRoot: userSkills.targetSkillRoot,
    userSkillNames: userSkills.skillNames,
    systemPrompt: config.systemPrompt,
    settingsContent,
    mcpConfigContent,
    spawnArgs,
    spawnEnv,
    cleanup,
  };
}

export function buildClaudeSpawnArgs(input: {
  settingsPath: string;
  mcpConfigPath: string;
  systemPromptPath: string;
  builtinTools: readonly string[];
  allowedTools: readonly string[];
  passthrough: readonly string[];
  permissionMode?: 'dontAsk';
  remoteControlSessionNamePrefix?: string | null;
}): string[] {
  // Isolation envelope (see buildClaudeEnvelope):
  // - Spawn cwd is the target workspace so Claude Code slash commands and
  //   project skill discovery behave like a normal Claude launch.
  // - --setting-sources user loads only the redirected orchestrator-owned
  //   HOME/.claude source. The launcher writes safe settings there and mirrors
  //   the target workspace skills into HOME/.claude/skills so /skills works
  //   without loading project or real-user settings.
  // - HOME is redirected to a durable orchestrator-owned state directory, and
  //   CLAUDE_CONFIG_DIR points at that HOME's .claude directory. Claude Code's
  //   auth path is HOME/.claude, so this preserves login state across launches
  //   without reading the user's normal ~/.claude.
  // - Slash commands stay enabled so the supervisor keeps normal Claude Code
  //   controls such as /exit and /skills.
  // - --tools restricts built-in tool *availability* to read-only inspection,
  //   Skill, and Bash. The Bash allowlist contains exactly five patterns:
  //   two explicit pinned monitor argv shapes (no-cursor and cursored),
  //   Bash(pwd), Bash(git status), and Bash(git status *).
  //   --permission-mode dontAsk denies anything outside the allowlist
  //   instead of surfacing permission prompts.
  // - --add-dir is intentionally NOT passed; cwd already is the target workspace.
  const args = [
    '--strict-mcp-config',
    '--mcp-config', input.mcpConfigPath,
    '--settings', input.settingsPath,
    '--setting-sources', 'user',
    '--append-system-prompt-file', input.systemPromptPath,
    '--tools', input.builtinTools.join(','),
    '--allowed-tools', input.allowedTools.join(','),
    '--permission-mode', input.permissionMode ?? 'dontAsk',
  ];
  if (input.remoteControlSessionNamePrefix) {
    args.push('--remote-control-session-name-prefix', input.remoteControlSessionNamePrefix);
  }
  args.push(...input.passthrough);
  return args;
}

async function loadProfilesForLaunch(
  options: ParsedClaudeLauncherArgs,
  catalog: ReturnType<typeof createWorkerCapabilityCatalog>,
): Promise<{ ok: true; profiles: ValidatedWorkerProfiles | undefined; diagnostics: string[] } | { ok: false; errors: string[] }> {
  const raw = await loadManifestInput(options);
  if (!raw.ok) {
    if (options.profilesJson) return { ok: false, errors: [raw.error] };
    return { ok: true, profiles: undefined, diagnostics: [raw.error] };
  }
  const parsed = parseWorkerProfileManifest(raw.value);
  if (!parsed.ok) {
    // Explicit inline manifests must fail fast on validation errors so the
    // operator notices the bad manifest immediately, matching the syntax-error
    // behavior. File-backed manifests stay diagnostics-only.
    if (options.profilesJson) return { ok: false, errors: parsed.errors };
    return { ok: true, profiles: undefined, diagnostics: parsed.errors };
  }
  const inspected = inspectWorkerProfiles(parsed.value, catalog);
  if (options.profilesJson && inspected.errors.length > 0) {
    // Explicit inline manifests must fail fast on inspection-time errors so the
    // operator notices a bad manifest immediately, matching parse-error
    // behavior. File-backed manifests stay diagnostics-only.
    return { ok: false, errors: inspected.errors };
  }
  return {
    ok: true,
    profiles: validatedSubset(inspected),
    diagnostics: inspected.errors,
  };
}

function validatedSubset(inspected: InspectedWorkerProfiles): ValidatedWorkerProfiles {
  return {
    manifest: inspected.manifest,
    profiles: inspected.profiles,
  };
}

async function loadManifestInput(
  options: ParsedClaudeLauncherArgs,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; missing?: boolean }> {
  if (options.profilesJson) {
    try {
      return { ok: true, value: JSON.parse(options.profilesJson) as unknown };
    } catch (error) {
      return { ok: false, error: `Invalid --profiles-json: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  try {
    return { ok: true, value: JSON.parse(await readFile(options.profilesFile, 'utf8')) as unknown };
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') {
      return { ok: false, error: `Worker profiles manifest not found: ${options.profilesFile}. Provide a valid profiles file or --profiles-json before starting worker runs.`, missing: true };
    }
    return { ok: false, error: `Failed to read worker profiles manifest ${options.profilesFile}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function validateCwd(cwd: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const info = await stat(cwd);
    return info.isDirectory() ? { ok: true } : { ok: false, error: `Target cwd is not a directory: ${cwd}` };
  } catch (error) {
    return { ok: false, error: `Target cwd is not accessible: ${cwd}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function spawnClaude(
  binary: string,
  options: ParsedClaudeLauncherArgs,
  built: BuiltClaudeEnvelope,
): Promise<number> {
  // Spawn from the target workspace so slash commands and project skills behave
  // like a normal Claude Code session. The restricted MCP/tool surface comes
  // from the explicit launch flags and generated settings.
  const child = spawn(binary, built.spawnArgs, {
    cwd: built.launchCwd,
    stdio: 'inherit',
    env: built.spawnEnv,
  });
  return await new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('exit', (code, signal) => {
      if (signal) resolve(1);
      else resolve(code ?? 0);
    });
  });
}

function packageCliPath(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'cli.js');
}

async function stableClaudeEnvelopeDir(stateDir: string, cwd: string): Promise<string> {
  const root = join(stateDir, 'envelopes');
  await ensureSecureRoot(root);
  const canonicalCwd = await realpath(cwd).catch(() => cwd);
  const hash = createHash('sha256').update(canonicalCwd).digest('hex').slice(0, 16);
  const slug = sanitizePathSegment(basename(canonicalCwd) || 'workspace');
  const envelopeDir = join(root, `${slug}-${hash}`);
  await ensureSecureRoot(envelopeDir);
  return envelopeDir;
}

async function resetClaudeProjectDiscoverySurface(envelopeDir: string): Promise<void> {
  await Promise.all([
    rm(join(envelopeDir, '.claude'), { recursive: true, force: true }),
    rm(join(envelopeDir, '.mcp.json'), { force: true }),
    rm(join(envelopeDir, 'CLAUDE.md'), { force: true }),
    rm(join(envelopeDir, 'CLAUDE.local.md'), { force: true }),
  ]);
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.slice(0, 48) || 'workspace';
}

function readOptionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

async function migrateLegacyClaudeConfigDir(sourceDir: string, targetDir: string): Promise<void> {
  if (sourceDir === targetDir || !(await pathExists(sourceDir))) return;
  for (const entry of [
    '.credentials.json',
    '.claude.json',
    'settings.json',
    'history.jsonl',
    'backups',
    'cache',
    'plugins',
    'projects',
  ]) {
    const source = join(sourceDir, entry);
    const target = join(targetDir, entry);
    if (await pathExists(source) && !(await pathExists(target))) {
      await cp(source, target, { recursive: true, preserveTimestamps: true, force: false });
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export { CLAUDE_MCP_SERVER_NAME };
