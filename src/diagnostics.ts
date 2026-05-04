import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import type { Backend, BackendDiagnostic, BackendStatusReport } from './contract.js';
import { resolveBinary } from './backend/common.js';
import { defaultCursorSdkAdapter, type CursorSdkAdapter } from './backend/cursor/sdk.js';
import { daemonPaths } from './daemon/paths.js';
import { prepareWorkerSpawn } from './processManager.js';
import { getPackageVersion } from './packageMetadata.js';
import { loadUserSecrets, type LoadedSecrets } from './auth/userSecrets.js';

const execFileAsync = promisify(execFile);
const commandTimeoutMs = 2_000;

export interface BackendStatusOptions {
  frontendVersion?: string | null;
  daemonVersion?: string | null;
  daemonPid?: number | null;
  platform?: NodeJS.Platform;
  cursorSdkAdapter?: CursorSdkAdapter;
}

interface BackendCheckDefinition {
  name: Backend;
  binary: string;
  requiredHelp: {
    name: string;
    args: string[];
    contains: string[];
  }[];
  authEnv: string[];
  installHint: string;
  authHint: string;
}

const definitions: BackendCheckDefinition[] = [
  {
    name: 'codex',
    binary: 'codex',
    requiredHelp: [
      {
        name: 'codex exec supports JSON/stdin/cwd flags',
        args: ['exec', '--help'],
        contains: ['--json', '--cd', '--skip-git-repo-check', '--model'],
      },
      {
        name: 'codex exec resume supports JSON/model resume',
        args: ['exec', 'resume', '--help'],
        contains: ['--json', '--skip-git-repo-check', '--model'],
      },
    ],
    authEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    installHint: 'Install and authenticate the Codex CLI, then ensure `codex` is on PATH.',
    authHint: 'Run the Codex CLI auth flow or provide OPENAI_API_KEY/CODEX_API_KEY in the MCP server environment.',
  },
  {
    name: 'claude',
    binary: 'claude',
    requiredHelp: [
      {
        name: 'claude supports print, stream-json, and resume flags',
        args: ['--help'],
        contains: ['-p', '--output-format', '--resume', '--model'],
      },
    ],
    authEnv: ['ANTHROPIC_API_KEY'],
    installHint: 'Install and authenticate the Claude CLI, then ensure `claude` is on PATH.',
    authHint: 'Run the Claude CLI auth flow or provide ANTHROPIC_API_KEY in the MCP server environment.',
  },
];

export async function getBackendStatus(options: BackendStatusOptions = {}): Promise<BackendStatusReport> {
  const paths = daemonPaths();
  const runStore = await checkRunStore(paths.home);
  const platform = options.platform ?? process.platform;
  const posixSupported = platform !== 'win32';
  // Only probe the secrets file when env precedence cannot already answer for
  // every wired provider. Env always wins, so when CURSOR_API_KEY is set the
  // file is irrelevant to the diagnostic and a misconfigured path must not
  // crash `doctor`.
  const secrets = process.env.CURSOR_API_KEY ? null : loadUserSecrets({ platform });
  const cliBackends = await Promise.all(definitions.map((definition) => diagnoseBackend(definition, platform)));
  const cursorAdapter = options.cursorSdkAdapter ?? defaultCursorSdkAdapter();
  const cursorBackend = await diagnoseCursorBackend(cursorAdapter, secrets);
  const backends = [...cliBackends, cursorBackend];
  const frontendVersion = options.frontendVersion ?? getPackageVersion();
  const daemonVersion = options.daemonVersion ?? null;

  return {
    frontend_version: frontendVersion,
    daemon_version: daemonVersion,
    version_match: daemonVersion !== null && frontendVersion === daemonVersion,
    daemon_pid: options.daemonPid ?? null,
    platform,
    node_version: process.version,
    posix_supported: posixSupported,
    run_store: runStore,
    backends,
  };
}

export function formatBackendStatus(report: BackendStatusReport): string {
  const lines: string[] = [
    'Agent Orchestrator diagnostics',
    '',
    `Frontend version: ${report.frontend_version}`,
    `Daemon version: ${report.daemon_version ?? 'not connected'}`,
    `Version match: ${report.daemon_version === null ? 'not checked' : report.version_match ? 'yes' : 'no'}`,
    ...(report.daemon_pid === null ? [] : [`Daemon PID: ${report.daemon_pid}`]),
    `Platform: ${report.platform}`,
    `Node: ${report.node_version}`,
    `POSIX support: ${report.posix_supported ? 'yes' : 'no'}`,
    `Run store: ${report.run_store.path} (${report.run_store.accessible ? 'accessible' : 'not accessible'})`,
  ];

  if (report.run_store.message) {
    lines.push(`Run store note: ${report.run_store.message}`);
  }

  lines.push('', 'Backends:');
  for (const backend of report.backends) {
    lines.push(`- ${backend.name}: ${backend.status}`);
    if (backend.path) lines.push(`  path: ${backend.path}`);
    if (backend.version) lines.push(`  version: ${backend.version}`);
    lines.push(`  auth: ${backend.auth.status}${formatAuthSource(backend.auth)}`);
    if (backend.auth.hint) lines.push(`  auth hint: ${backend.auth.hint}`);
    for (const check of backend.checks) {
      lines.push(`  ${check.ok ? 'ok' : 'fail'}: ${check.name}${check.message ? ` - ${check.message}` : ''}`);
    }
    for (const hint of backend.hints) {
      lines.push(`  hint: ${hint}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function diagnoseBackend(definition: BackendCheckDefinition, platform: NodeJS.Platform): Promise<BackendDiagnostic> {
  const checks: BackendDiagnostic['checks'] = [];
  const hints: string[] = [];
  const path = await resolveBinary(definition.binary, platform);

  if (!path) {
    return {
      name: definition.name,
      binary: definition.binary,
      status: 'missing',
      path: null,
      version: null,
      auth: { status: 'unknown', hint: definition.authHint },
      checks: [{ name: `${definition.binary} binary on PATH`, ok: false, message: definition.installHint }],
      hints: [definition.installHint],
    };
  }

  checks.push({ name: `${definition.binary} binary on PATH`, ok: true, message: path });
  const version = await readVersion(path, platform);
  for (const required of definition.requiredHelp) {
    const output = await runCommand(path, required.args, platform);
    if (!output.ok) {
      checks.push({ name: required.name, ok: false, message: output.message });
      hints.push(`Upgrade ${definition.binary}; failed to verify ${required.args.join(' ')}.`);
      continue;
    }

    const missing = required.contains.filter((fragment) => !output.text.includes(fragment));
    checks.push({
      name: required.name,
      ok: missing.length === 0,
      message: missing.length === 0 ? undefined : `missing ${missing.join(', ')}`,
    });
    if (missing.length > 0) {
      hints.push(`Upgrade ${definition.binary}; required help output did not include ${missing.join(', ')}.`);
    }
  }

  const auth = detectAuth(definition);
  const hasUnsupportedCheck = checks.some((check) => !check.ok);
  const status = hasUnsupportedCheck
    ? 'unsupported'
    : auth.status === 'ready'
      ? 'available'
      : auth.status === 'failed'
        ? 'auth_failed'
        : 'auth_unknown';

  if (auth.hint) hints.push(auth.hint);

  return {
    name: definition.name,
    binary: definition.binary,
    status,
    path,
    version,
    auth,
    checks,
    hints: Array.from(new Set(hints)),
  };
}

async function readVersion(binaryPath: string, platform: NodeJS.Platform): Promise<string | null> {
  const output = await runCommand(binaryPath, ['--version'], platform);
  if (!output.ok) return null;
  return output.text.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

function detectAuth(definition: BackendCheckDefinition): BackendDiagnostic['auth'] {
  const found = definition.authEnv.find((name) => Boolean(process.env[name]));
  if (found) {
    return { status: 'ready', source: found };
  }

  return {
    status: 'unknown',
    hint: definition.authHint,
  };
}

async function runCommand(binaryPath: string, args: string[], platform: NodeJS.Platform): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  try {
    const prepared = prepareWorkerSpawn(binaryPath, args, platform);
    const result = await execFileAsync(prepared.command, prepared.args, {
      timeout: commandTimeoutMs,
      maxBuffer: 512 * 1024,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });
    return { ok: true, text: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string; code?: number };
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    const timedOut = err.killed || err.signal === 'SIGTERM';
    return {
      ok: false,
      message: timedOut
        ? `timed out after ${commandTimeoutMs}ms`
        : output || err.message || `exit code ${err.code ?? 'unknown'}`,
    };
  }
}

function formatAuthSource(auth: BackendDiagnostic['auth']): string {
  if (!auth.source) return '';
  if (auth.source_kind === 'env') return ` (${auth.source}, env)`;
  if (auth.source_kind === 'file') {
    return auth.source_path ? ` (${auth.source}, file: ${auth.source_path})` : ` (${auth.source}, file)`;
  }
  return ` (${auth.source})`;
}

async function diagnoseCursorBackend(adapter: CursorSdkAdapter, secrets: LoadedSecrets | null): Promise<BackendDiagnostic> {
  const moduleId = '@cursor/sdk';
  const installHint = `Install ${moduleId} (it ships as an optional dependency); run \`pnpm add ${moduleId}\` or \`npm install ${moduleId}\`.`;
  const authHint = 'Set CURSOR_API_KEY in the daemon environment, or run `agent-orchestrator auth cursor` to save it to ~/.config/agent-orchestrator/secrets.env.';
  const availability = await adapter.available();
  const envValue = process.env.CURSOR_API_KEY;
  const fileValue = secrets?.values.CURSOR_API_KEY;
  const auth: BackendDiagnostic['auth'] = envValue
    ? { status: 'ready', source: 'CURSOR_API_KEY', source_kind: 'env' }
    : fileValue && secrets
      ? { status: 'ready', source: 'CURSOR_API_KEY', source_kind: 'file', source_path: secrets.path }
      : { status: 'unknown', hint: authHint };

  // Auth-related hints are surfaced regardless of SDK availability so a
  // misconfigured `secrets.env` is not hidden behind an SDK install hint.
  // Permission/read failures only matter when env is unset (env wins).
  const authHints: string[] = [];
  if (auth.status !== 'ready') authHints.push(authHint);
  if (!envValue && secrets?.refusal) authHints.push(secrets.refusal.hint);

  if (!availability.ok) {
    const resolvedPath = availability.modulePath ?? null;
    const installed = resolvedPath !== null;
    const failureHint = installed
      ? `${moduleId} resolves at ${resolvedPath} but failed to import — usually a native dependency or Node version mismatch (for example a missing \`sqlite3\` prebuilt binding for the current Node ABI). Try \`pnpm rebuild ${moduleId}\` or reinstalling with native rebuilds (e.g. \`npm install --build-from-source ${moduleId}\`).`
      : installHint;
    return {
      name: 'cursor',
      binary: moduleId,
      status: 'missing',
      path: resolvedPath,
      version: null,
      auth,
      checks: [{ name: `${moduleId} module resolvable`, ok: false, message: availability.reason }],
      hints: [failureHint, ...authHints],
    };
  }

  const checks = [{ name: `${moduleId} module resolvable`, ok: true, message: availability.modulePath ?? undefined }];
  const status = auth.status === 'ready' ? 'available' : 'auth_unknown';
  return {
    name: 'cursor',
    binary: moduleId,
    status,
    path: availability.modulePath,
    version: null,
    auth,
    checks,
    hints: authHints,
  };
}

async function checkRunStore(path: string): Promise<BackendStatusReport['run_store']> {
  try {
    await access(path, constants.F_OK);
    await access(path, constants.R_OK | constants.W_OK);
    return { path, accessible: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, accessible: true, message: 'directory does not exist yet; the daemon will create it with user-only permissions where supported' };
    }

    return {
      path,
      accessible: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
