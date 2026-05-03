import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBinary } from '../backend/common.js';
import { getBackendStatus } from '../diagnostics.js';
import { defaultWorkerProfilesFile } from '../workerRouting.js';
import {
  createWorkerCapabilityCatalog,
  parseWorkerProfileManifest,
  validateWorkerProfiles,
  type ValidatedWorkerProfiles,
} from './capabilities.js';
import {
  buildClaudeHarnessConfig,
  CLAUDE_MCP_SERVER_NAME,
  stringifyClaudeMcpConfig,
} from './config.js';
import { discoverClaudeSurface, summarizeReport, type ClaudeSurfaceReport } from './discovery.js';
import { resolveMonitorPin } from './monitorPin.js';
import { CLAUDE_SUPERVISOR_BUILTIN_TOOLS, stringifyClaudeSupervisorSettings } from './permission.js';
import { validateClaudePassthroughArgs } from './passthrough.js';
import { curateOrchestrateSkills } from './skills.js';

export interface ParsedClaudeLauncherArgs {
  cwd: string;
  profilesFile: string;
  profilesJson: string | null;
  manifestPath: string;
  skillsPath: string;
  claudeBinary: string;
  printConfig: boolean;
  printDiscovery: boolean;
  help: boolean;
  claudeArgs: string[];
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
  let claudeBinary = env.AGENT_ORCHESTRATOR_CLAUDE_BIN || env.CLAUDE_BIN || 'claude';
  let printConfig = false;
  let printDiscovery = false;
  let help = false;

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
      } else if (arg === '--claude-binary') {
        claudeBinary = readOptionValue(ownArgs, ++index, arg);
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
  return {
    ok: true,
    value: {
      cwd: resolvedCwd,
      profilesFile: resolvedProfilesFile,
      profilesJson,
      manifestPath: resolvedProfilesFile,
      skillsPath: resolvedSkillsPath,
      claudeBinary,
      printConfig,
      printDiscovery,
      help,
      claudeArgs,
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
  settingsPath: string;
  mcpConfigPath: string;
  systemPromptPath: string;
  skillsRoot: string;
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

  const built = await buildClaudeEnvelope({ options, env, catalog, profilesResult });
  if (options.printConfig) {
    io.stdout.write(`# system prompt\n${built.systemPrompt}\n\n# settings.json\n${built.settingsContent}\n# mcp.json\n${built.mcpConfigContent}\n# spawn args\n${JSON.stringify(built.spawnArgs)}\n`);
    await built.cleanup();
    return 0;
  }

  const binary = await resolveBinary(options.claudeBinary, process.platform, env);
  if (!binary) {
    await built.cleanup();
    io.stderr.write(`Claude binary not found: ${options.claudeBinary}\n`);
    return 1;
  }

  try {
    return await spawnClaude(binary, options, built);
  } finally {
    await built.cleanup();
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
  --claude-binary <path>             Defaults to claude on PATH.
  --print-discovery                  Print the Claude binary compatibility report and exit.
  --print-config                     Print the generated supervisor envelope (system prompt, settings, mcp) and exit.
  --help

Passthrough after --:
  Allowed Claude flags: --print, -p, --output-format, --input-format, --include-partial-messages,
  --include-hook-events, --verbose, --debug, -d, --debug-file, --name, -n,
  --exclude-dynamic-system-prompt-sections, --no-session-persistence.
  Forbidden flags (the harness owns these or they would break isolation):
  --dangerously-skip-permissions, --mcp-config, --strict-mcp-config, --tools,
  --allowed-tools, --disallowed-tools, --add-dir, --settings, --setting-sources,
  --system-prompt(-file), --append-system-prompt(-file), --plugin-dir, --agents,
  --agent, --permission-mode, --disable-slash-commands, --bare. (--bare disables
  skill / CLAUDE.md / plugin / MCP auto-discovery, which would hide the curated
  orchestrate-* skills the supervisor depends on.)

Environment fallbacks:
  AGENT_ORCHESTRATOR_CLAUDE_CWD
  AGENT_ORCHESTRATOR_CLAUDE_PROFILES_FILE
  AGENT_ORCHESTRATOR_CLAUDE_PROFILES_JSON
  AGENT_ORCHESTRATOR_CLAUDE_MANIFEST
  AGENT_ORCHESTRATOR_CLAUDE_SKILLS_PATH
  AGENT_ORCHESTRATOR_CLAUDE_BIN
  AGENT_ORCHESTRATOR_BIN (override the pinned monitor binary)
`;
}

export async function buildClaudeEnvelope(input: {
  options: ParsedClaudeLauncherArgs;
  env: NodeJS.ProcessEnv;
  catalog: ReturnType<typeof createWorkerCapabilityCatalog>;
  profilesResult: { profiles: ValidatedWorkerProfiles | undefined; diagnostics: string[] };
  discovery?: ClaudeSurfaceReport;
}): Promise<BuiltClaudeEnvelope> {
  const { options, env, catalog, profilesResult } = input;
  const envelopeDir = await mkdtemp(join(tmpdir(), 'agent-orchestrator-claude-'));
  const ephemeralHome = join(envelopeDir, 'home');
  const ephemeralXdg = join(envelopeDir, 'xdg-config');
  const ephemeralClaudeConfig = join(envelopeDir, 'claude-config');
  // Skills live under the envelope's own .claude/skills/ so Claude Code's
  // cwd-rooted skill discovery picks them up when the supervisor runs with
  // cwd = envelopeDir. The target workspace is intentionally not exposed via
  // --add-dir (would scan target's .claude/* into discovery); the supervisor
  // reaches the target only indirectly by dispatching worker runs with
  // cwd = <target> via mcp__agent-orchestrator__start_run.
  const ephemeralProjectClaude = join(envelopeDir, '.claude');
  const ephemeralSkillRoot = join(ephemeralProjectClaude, 'skills');
  await Promise.all([
    mkdir(ephemeralHome, { recursive: true, mode: 0o700 }),
    mkdir(ephemeralXdg, { recursive: true, mode: 0o700 }),
    mkdir(ephemeralClaudeConfig, { recursive: true, mode: 0o700 }),
    mkdir(ephemeralProjectClaude, { recursive: true, mode: 0o700 }),
  ]);
  const skills = await curateOrchestrateSkills({
    sourceSkillRoot: options.skillsPath,
    ephemeralSkillRoot,
  });
  const monitorPin = resolveMonitorPin(env);
  const config = buildClaudeHarnessConfig({
    targetCwd: options.cwd,
    manifestPath: options.manifestPath,
    ephemeralSkillRoot: skills.ephemeralRoot,
    orchestrationSkillNames: skills.orchestrationSkillNames,
    catalog,
    profiles: profilesResult.profiles,
    profileDiagnostics: profilesResult.diagnostics,
    mcpCliPath: packageCliPath(),
    monitorPin,
  });
  const settingsPath = join(envelopeDir, 'settings.json');
  const mcpConfigPath = join(envelopeDir, 'mcp.json');
  const systemPromptPath = join(envelopeDir, 'system-prompt.md');
  const settingsContent = stringifyClaudeSupervisorSettings(config.settings);
  const mcpConfigContent = stringifyClaudeMcpConfig(config.mcpConfig);
  await Promise.all([
    writeFile(settingsPath, settingsContent, { mode: 0o600 }),
    writeFile(mcpConfigPath, mcpConfigContent, { mode: 0o600 }),
    writeFile(systemPromptPath, config.systemPrompt, { mode: 0o600 }),
  ]);
  const spawnArgs = buildClaudeSpawnArgs({
    settingsPath,
    mcpConfigPath,
    systemPromptPath,
    builtinTools: [...CLAUDE_SUPERVISOR_BUILTIN_TOOLS],
    passthrough: options.claudeArgs,
  });
  const spawnEnv: NodeJS.ProcessEnv = {
    ...env,
    HOME: ephemeralHome,
    XDG_CONFIG_HOME: ephemeralXdg,
    CLAUDE_CONFIG_DIR: ephemeralClaudeConfig,
    NO_COLOR: env.NO_COLOR ?? '1',
  };
  const cleanup = async () => {
    await rm(envelopeDir, { recursive: true, force: true });
  };
  return {
    envelopeDir,
    settingsPath,
    mcpConfigPath,
    systemPromptPath,
    skillsRoot: skills.ephemeralRoot,
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
  passthrough: readonly string[];
}): string[] {
  // Isolation envelope (see buildClaudeEnvelope):
  // - Spawn cwd is the ephemeral envelope, so cwd-rooted discovery (.claude/,
  //   .mcp.json, project skills/commands/agents/hooks) sees only our curated
  //   content and not the target workspace.
  // - --setting-sources "" disables loading of user/project/local settings.json.
  // - HOME, XDG_CONFIG_HOME, and CLAUDE_CONFIG_DIR are redirected to ephemeral
  //   subdirectories so the user's ~/.claude is unreachable.
  // - --tools restricts built-in tool *availability* (this is the correct
  //   restriction surface; --allowed-tools only pre-approves and does not
  //   block availability). Bash, Edit, Write, WebFetch, WebSearch, Task,
  //   NotebookEdit, and TodoWrite are intentionally NOT on this list.
  // - --add-dir is intentionally NOT passed: Claude Code scans add-dir paths
  //   for project skills/commands/agents/hooks and CLAUDE.md, which would
  //   re-introduce target workspace .claude/* leakage. The supervisor reads
  //   the target workspace only indirectly, by dispatching worker runs with
  //   cwd set to the target workspace via mcp__agent-orchestrator__start_run.
  const args = [
    '--strict-mcp-config',
    '--mcp-config', input.mcpConfigPath,
    '--settings', input.settingsPath,
    '--setting-sources', '',
    '--append-system-prompt-file', input.systemPromptPath,
    '--tools', input.builtinTools.join(','),
    ...input.passthrough,
  ];
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
  if (!parsed.ok) return { ok: true, profiles: undefined, diagnostics: parsed.errors };
  const validated = validateWorkerProfiles(parsed.value, catalog);
  if (!validated.ok) return { ok: true, profiles: undefined, diagnostics: validated.errors };
  return { ok: true, profiles: validated.value, diagnostics: [] };
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
  // Spawn cwd is the ephemeral envelope so Claude Code's cwd-rooted discovery
  // (project .claude/, .mcp.json, hooks, commands, agents, plugins) sees only
  // our curated content. The target workspace is intentionally not exposed
  // (no --add-dir); the supervisor reaches it only by dispatching worker runs
  // with cwd = <target> via mcp__agent-orchestrator__start_run.
  void options;
  const child = spawn(binary, built.spawnArgs, {
    cwd: built.envelopeDir,
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

function readOptionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

export { CLAUDE_MCP_SERVER_NAME };
