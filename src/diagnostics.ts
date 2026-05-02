import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import type { Backend, BackendDiagnostic, BackendStatusReport } from './contract.js';
import { resolveBinary } from './backend/common.js';
import { daemonPaths } from './daemon/paths.js';
import { getPackageVersion } from './packageMetadata.js';

const execFileAsync = promisify(execFile);
const commandTimeoutMs = 2_000;

export interface BackendStatusOptions {
  frontendVersion?: string | null;
  daemonVersion?: string | null;
  daemonPid?: number | null;
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
  const posixSupported = process.platform !== 'win32';
  const backends = await Promise.all(definitions.map((definition) => diagnoseBackend(definition, posixSupported)));
  const frontendVersion = options.frontendVersion ?? getPackageVersion();
  const daemonVersion = options.daemonVersion ?? null;

  return {
    frontend_version: frontendVersion,
    daemon_version: daemonVersion,
    version_match: daemonVersion !== null && frontendVersion === daemonVersion,
    daemon_pid: options.daemonPid ?? null,
    platform: process.platform,
    node_version: process.version,
    posix_supported: posixSupported,
    run_store: runStore,
    backends,
  };
}

export function formatBackendStatus(report: BackendStatusReport): string {
  const lines: string[] = [
    'Agent Orchestrator MCP diagnostics',
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
    lines.push(`  auth: ${backend.auth.status}${backend.auth.source ? ` (${backend.auth.source})` : ''}`);
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

async function diagnoseBackend(definition: BackendCheckDefinition, posixSupported: boolean): Promise<BackendDiagnostic> {
  const checks: BackendDiagnostic['checks'] = [];
  const hints: string[] = [];
  const path = await resolveBinary(definition.binary);

  if (!posixSupported) {
    return {
      name: definition.name,
      binary: definition.binary,
      status: 'unsupported',
      path,
      version: null,
      auth: { status: 'unknown', hint: 'Windows named-pipe support is not implemented in v1.' },
      checks: [{ name: 'POSIX platform support', ok: false, message: 'Unix sockets and POSIX process groups are required.' }],
      hints: ['Use Linux, macOS, or WSL for v1.'],
    };
  }

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
  const version = await readVersion(path);
  for (const required of definition.requiredHelp) {
    const output = await runCommand(path, required.args);
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

async function readVersion(binaryPath: string): Promise<string | null> {
  const output = await runCommand(binaryPath, ['--version']);
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

async function runCommand(binaryPath: string, args: string[]): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  try {
    const result = await execFileAsync(binaryPath, args, {
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

async function checkRunStore(path: string): Promise<BackendStatusReport['run_store']> {
  try {
    await access(path, constants.F_OK);
    await access(path, constants.R_OK | constants.W_OK);
    return { path, accessible: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, accessible: true, message: 'directory does not exist yet; the daemon will create it with 0700 permissions' };
    }

    return {
      path,
      accessible: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
