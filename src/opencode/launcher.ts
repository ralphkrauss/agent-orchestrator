import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
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
import { OPENCODE_ORCHESTRATOR_AGENT, buildOpenCodeHarnessConfig, stringifyOpenCodeConfig } from './config.js';
import { ensureProjectSkillRoot, loadProjectSkills } from './skills.js';

export interface ParsedOpenCodeLauncherArgs {
  cwd: string;
  profilesFile: string | null;
  profilesJson: string | null;
  manifestPath: string;
  skillsPath: string;
  orchestratorModel: string | undefined;
  orchestratorSmallModel: string | undefined;
  opencodeBinary: string;
  printConfig: boolean;
  help: boolean;
  opencodeArgs: string[];
}

export function parseOpenCodeLauncherArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  defaultCwd = process.cwd(),
): { ok: true; value: ParsedOpenCodeLauncherArgs } | { ok: false; error: string } {
  const args = [...argv];
  if (args[0] === 'setup') args.shift();

  const separator = args.indexOf('--');
  const ownArgs = separator >= 0 ? args.slice(0, separator) : args;
  const opencodeArgs = separator >= 0 ? args.slice(separator + 1) : [];

  let cwd = env.AGENT_ORCHESTRATOR_OPENCODE_CWD || defaultCwd;
  let profilesFile: string | null = env.AGENT_ORCHESTRATOR_OPENCODE_PROFILES_FILE || env.AGENT_ORCHESTRATOR_OPENCODE_ROUTES_FILE || null;
  let profilesJson: string | null = env.AGENT_ORCHESTRATOR_OPENCODE_PROFILES_JSON || env.AGENT_ORCHESTRATOR_OPENCODE_ROUTES_JSON || null;
  let manifestPath: string | null = env.AGENT_ORCHESTRATOR_OPENCODE_MANIFEST || null;
  let skillsPath: string | null = env.AGENT_ORCHESTRATOR_OPENCODE_SKILLS_PATH || null;
  let orchestratorModel = env.AGENT_ORCHESTRATOR_OPENCODE_MODEL || undefined;
  let orchestratorSmallModel = env.AGENT_ORCHESTRATOR_OPENCODE_SMALL_MODEL || undefined;
  let opencodeBinary = env.AGENT_ORCHESTRATOR_OPENCODE_BIN || env.OPENCODE_BIN || 'opencode';
  let printConfig = false;
  let help = false;

  try {
    for (let index = 0; index < ownArgs.length; index += 1) {
      const arg = ownArgs[index];
      if (!arg) continue;
      if (arg === '--help' || arg === '-h') {
        help = true;
      } else if (arg === '--print-config' || arg === '--dry-run') {
        printConfig = true;
      } else if (arg === '--keep-temp') {
        // Compatibility no-op for older launcher invocations.
      } else if (arg === '--cwd') {
        cwd = readOptionValue(ownArgs, ++index, arg);
      } else if (arg === '--profiles-file' || arg === '--routes-file') {
        profilesFile = readOptionValue(ownArgs, ++index, arg);
      } else if (arg === '--profiles-json' || arg === '--routes-json') {
        profilesJson = readOptionValue(ownArgs, ++index, arg);
      } else if (arg === '--manifest') {
        manifestPath = readOptionValue(ownArgs, ++index, arg);
        profilesFile ??= manifestPath;
      } else if (arg === '--skills' || arg === '--orchestration-skills') {
        skillsPath = readOptionValue(ownArgs, ++index, arg);
      } else if (arg === '--orchestrator-model') {
        orchestratorModel = readOptionValue(ownArgs, ++index, arg);
      } else if (arg === '--orchestrator-small-model') {
        orchestratorSmallModel = readOptionValue(ownArgs, ++index, arg);
      } else if (arg === '--opencode-binary') {
        opencodeBinary = readOptionValue(ownArgs, ++index, arg);
      } else {
        return { ok: false, error: `Unknown option: ${arg}. Pass OpenCode arguments after --.` };
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const resolvedCwd = resolve(defaultCwd, cwd);
  const defaultProfilesPath = defaultWorkerProfilesFile(env);
  const resolvedManifest = resolve(resolvedCwd, manifestPath ?? profilesFile ?? defaultProfilesPath);
  const resolvedSkillsPath = resolve(resolvedCwd, skillsPath ?? '.agents/skills');
  return {
    ok: true,
    value: {
      cwd: resolvedCwd,
      profilesFile: profilesFile ? resolve(resolvedCwd, profilesFile) : resolvedManifest,
      profilesJson,
      manifestPath: resolvedManifest,
      skillsPath: resolvedSkillsPath,
      orchestratorModel,
      orchestratorSmallModel,
      opencodeBinary,
      printConfig,
      help,
      opencodeArgs,
    },
  };
}

export async function runOpenCodeLauncher(
  argv: readonly string[],
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream; env?: NodeJS.ProcessEnv } = {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  },
): Promise<number> {
  const parsed = parseOpenCodeLauncherArgs(argv, io.env ?? process.env);
  if (!parsed.ok) {
    io.stderr.write(`${parsed.error}\nRun agent-orchestrator-opencode --help for usage.\n`);
    return 1;
  }
  const options = parsed.value;
  if (options.help) {
    io.stdout.write(openCodeLauncherHelp());
    return 0;
  }

  const cwdValidation = await validateCwd(options.cwd);
  if (!cwdValidation.ok) {
    io.stderr.write(`${cwdValidation.error}\n`);
    return 1;
  }

  if (hasUnsafeOpenCodeArg(options.opencodeArgs)) {
    io.stderr.write('OpenCode orchestration mode does not allow --agent or --dangerously-skip-permissions passthrough arguments.\n');
    return 1;
  }

  const backendStatus = await getBackendStatus();
  const catalog = createWorkerCapabilityCatalog(backendStatus);
  const profilesResult = await loadProfilesForLaunch(options, catalog);
  if (!profilesResult.ok) {
    io.stderr.write(`${profilesResult.errors.join('\n')}\n`);
    return 1;
  }

  if (!options.printConfig) {
    try {
      await ensureProjectSkillRoot(options.skillsPath);
      await ensureProfilesDirectory(options.manifestPath);
    } catch (error) {
      io.stderr.write(`Failed to prepare OpenCode setup paths: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  const skills = await loadProjectSkills(options.skillsPath);
  {
    const config = buildOpenCodeHarnessConfig({
      targetCwd: options.cwd,
      skillRoots: skills.roots,
      skillRoot: options.skillsPath,
      mcpCliPath: packageCliPath(),
      orchestratorModel: options.orchestratorModel,
      orchestratorSmallModel: options.orchestratorSmallModel,
      profiles: profilesResult.profiles,
      profileDiagnostics: profilesResult.diagnostics,
      orchestrationSkillNames: skills.orchestrationSkills,
      catalog,
      manifestPath: options.manifestPath,
    });
    const configContent = stringifyOpenCodeConfig(config);
    if (options.printConfig) {
      io.stdout.write(configContent);
      return 0;
    }

    const binary = await resolveBinary(options.opencodeBinary, process.platform, io.env ?? process.env);
    if (!binary) {
      io.stderr.write(`OpenCode binary not found: ${options.opencodeBinary}\n`);
      return 1;
    }

    return await spawnOpenCode(binary, options, configContent, io.env ?? process.env);
  }
}

export function openCodeLauncherHelp(): string {
  return `agent-orchestrator-opencode

Usage:
  agent-orchestrator-opencode [options] [-- <opencode args>]
  agent-orchestrator opencode [options] [-- <opencode args>]

Options:
  --cwd <path>                         Target workspace. Defaults to current directory.
  --profiles-file <path>               Worker profiles manifest. Defaults to ~/.config/agent-orchestrator/profiles.json.
  --profiles-json <json>               Inline worker profiles manifest.
  --manifest <path>                    Compatibility alias for --profiles-file.
  --routes-file <path>                 Deprecated alias for --profiles-file.
  --routes-json <json>                 Deprecated alias for --profiles-json.
  --skills <path>                      Shared skill root. Defaults to .agents/skills.
  --orchestration-skills <path>        Compatibility alias for --skills.
  --orchestrator-model <provider/model>
  --orchestrator-small-model <provider/model>
  --opencode-binary <path>             Defaults to opencode on PATH.
  --print-config                       Print generated OpenCode config and exit.
  --help

Environment fallbacks:
  AGENT_ORCHESTRATOR_OPENCODE_CWD
  AGENT_ORCHESTRATOR_OPENCODE_PROFILES_FILE
  AGENT_ORCHESTRATOR_OPENCODE_PROFILES_JSON
  AGENT_ORCHESTRATOR_OPENCODE_MANIFEST
  AGENT_ORCHESTRATOR_OPENCODE_SKILLS_PATH
  AGENT_ORCHESTRATOR_OPENCODE_MODEL
  AGENT_ORCHESTRATOR_OPENCODE_SMALL_MODEL
  AGENT_ORCHESTRATOR_OPENCODE_BIN
`;
}

async function ensureProfilesDirectory(manifestPath: string): Promise<void> {
  await mkdir(dirname(manifestPath), { recursive: true });
}

async function loadProfilesForLaunch(
  options: ParsedOpenCodeLauncherArgs,
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
  if (!validated.ok) {
    return { ok: true, profiles: undefined, diagnostics: validated.errors };
  }
  return { ok: true, profiles: validated.value, diagnostics: [] };
}

async function loadManifestInput(
  options: ParsedOpenCodeLauncherArgs,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; missing?: boolean }> {
  if (options.profilesJson) {
    try {
      return { ok: true, value: JSON.parse(options.profilesJson) as unknown };
    } catch (error) {
      return { ok: false, error: `Invalid --profiles-json: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  if (!options.profilesFile) {
    return { ok: false, error: 'No profiles file configured', missing: true };
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

function withAgentArg(args: string[], agentName: string): string[] {
  if (args[0] === 'run') {
    return ['run', '--agent', agentName, ...args.slice(1)];
  }
  return ['--agent', agentName, ...args];
}

function hasUnsafeOpenCodeArg(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--agent' || arg.startsWith('--agent=') || arg === '--dangerously-skip-permissions');
}

async function validateCwd(cwd: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const info = await stat(cwd);
    return info.isDirectory() ? { ok: true } : { ok: false, error: `Target cwd is not a directory: ${cwd}` };
  } catch (error) {
    return { ok: false, error: `Target cwd is not accessible: ${cwd}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function spawnOpenCode(
  binary: string,
  options: ParsedOpenCodeLauncherArgs,
  configContent: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const child = spawn(binary, withAgentArg(options.opencodeArgs, OPENCODE_ORCHESTRATOR_AGENT), {
    cwd: options.cwd,
    stdio: 'inherit',
    env: {
      ...env,
      OPENCODE_CONFIG_CONTENT: configContent,
    },
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
