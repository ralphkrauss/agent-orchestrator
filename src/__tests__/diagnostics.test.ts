import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getBackendStatus } from '../diagnostics.js';
import { createBackendRegistry } from '../backend/registry.js';
import { OrchestratorService } from '../orchestratorService.js';
import { getPackageVersion } from '../packageMetadata.js';
import { RunStore } from '../runStore.js';

let originalPath = process.env.PATH;
let originalOpenAiKey = process.env.OPENAI_API_KEY;
let originalCodexKey = process.env.CODEX_API_KEY;
let originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
let originalCursorKey = process.env.CURSOR_API_KEY;
let originalPathext = process.env.PATHEXT;
let originalComSpec = process.env.ComSpec;
let originalComspec = process.env.COMSPEC;

const missingCursorAdapter = {
  available: async () => ({ ok: false as const, reason: 'cursor SDK not installed in test fixture' }),
  loadAgentApi: async () => { throw new Error('cursor SDK not installed in test fixture'); },
};

describe('backend diagnostics', () => {
  beforeEach(() => {
    originalPath = process.env.PATH;
    originalOpenAiKey = process.env.OPENAI_API_KEY;
    originalCodexKey = process.env.CODEX_API_KEY;
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    originalCursorKey = process.env.CURSOR_API_KEY;
    originalPathext = process.env.PATHEXT;
    originalComSpec = process.env.ComSpec;
    originalComspec = process.env.COMSPEC;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CURSOR_API_KEY;
  });

  afterEach(() => {
    restoreEnv('PATH', originalPath);
    restoreEnv('OPENAI_API_KEY', originalOpenAiKey);
    restoreEnv('CODEX_API_KEY', originalCodexKey);
    restoreEnv('ANTHROPIC_API_KEY', originalAnthropicKey);
    restoreEnv('CURSOR_API_KEY', originalCursorKey);
    restoreEnv('PATHEXT', originalPathext);
    restoreEnv('ComSpec', originalComSpec);
    restoreEnv('COMSPEC', originalComspec);
  });

  it('reports cursor as installed-but-broken with a rebuild hint when the SDK resolves but import fails', async () => {
    // Mirrors the Node 24 + sqlite3 native-binding case: the package is on disk
    // (resolvable), but `import('@cursor/sdk')` throws because sqlite3 has no
    // prebuilt binding for the current Node ABI.
    const installedBrokenAdapter = {
      available: async () => ({
        ok: false as const,
        reason: 'Could not locate the bindings file for sqlite3 (Node ABI 137)',
        modulePath: '/fake/node_modules/@cursor/sdk/dist/index.js',
      }),
      loadAgentApi: async () => { throw new Error('Could not locate the bindings file for sqlite3 (Node ABI 137)'); },
    };
    const root = await mkdtemp(join(tmpdir(), 'agent-diag-broken-'));
    process.env.PATH = join(root, 'missing-bin');

    const report = await getBackendStatus({ cursorSdkAdapter: installedBrokenAdapter });
    const cursor = report.backends.find((backend) => backend.name === 'cursor');
    assert.ok(cursor, 'expected cursor backend in report');
    assert.equal(cursor.status, 'missing');
    assert.equal(cursor.path, '/fake/node_modules/@cursor/sdk/dist/index.js');
    assert.ok(cursor.checks.some((check) => check.name === '@cursor/sdk module resolvable' && !check.ok));
    assert.equal(cursor.hints.length, 1);
    assert.match(cursor.hints[0]!, /pnpm rebuild @cursor\/sdk/);
    assert.match(cursor.hints[0]!, /\/fake\/node_modules\/@cursor\/sdk\/dist\/index\.js/);
    assert.match(cursor.hints[0]!, /sqlite3/i);
  });

  it('reports missing backend binaries without failing the whole report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-diag-missing-'));
    process.env.PATH = join(root, 'missing-bin');

    const report = await getBackendStatus({ cursorSdkAdapter: missingCursorAdapter });

    assert.equal(report.frontend_version, getPackageVersion());
    assert.equal(report.daemon_version, null);
    assert.equal(report.version_match, false);
    assert.equal(report.daemon_pid, null);
    assert.equal(report.posix_supported, true);
    assert.deepStrictEqual(report.backends.map((backend) => backend.status), ['missing', 'missing', 'missing']);
    assert.ok(report.backends.every((backend) => backend.hints.length > 0));
    const cursor = report.backends.find((backend) => backend.name === 'cursor');
    assert.equal(cursor?.binary, '@cursor/sdk');
    assert.ok(cursor?.checks.some((check) => check.name === '@cursor/sdk module resolvable' && !check.ok));
  });

  it('runs backend diagnostics on Windows instead of marking everything unsupported', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-diag-win-missing-'));
    process.env.PATH = join(root, 'missing-bin');

    const report = await getBackendStatus({ platform: 'win32', cursorSdkAdapter: missingCursorAdapter });

    assert.equal(report.platform, 'win32');
    assert.equal(report.posix_supported, false);
    assert.deepStrictEqual(report.backends.map((backend) => backend.status), ['missing', 'missing', 'missing']);
    const cliBackends = report.backends.filter((backend) => backend.name !== 'cursor');
    assert.ok(cliBackends.every((backend) => backend.checks.some((check) => check.name.includes('binary on PATH'))));
  });

  it('executes Windows cmd backend shims through the command processor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-diag-win-bin-'));
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeWindowsMockCli(bin, 'codex', [
      ['--version', 'codex 1.2.3'],
      ['exec --help', 'Usage: codex exec --json --cd --skip-git-repo-check --model -'],
      ['exec resume --help', 'Usage: codex exec resume --json --skip-git-repo-check --model <session> -'],
    ]);
    await writeWindowsMockCli(bin, 'claude', [
      ['--version', 'claude 2.3.4'],
      ['--help', 'Usage: claude -p --output-format stream-json --resume --model <session>'],
    ]);
    process.env.PATH = bin;
    process.env.PATHEXT = '.cmd';
    if (process.platform !== 'win32') {
      const commandProcessor = join(root, 'cmd-proxy.js');
      await writeWindowsCommandProcessor(commandProcessor);
      process.env.ComSpec = commandProcessor;
      delete process.env.COMSPEC;
    }

    const report = await getBackendStatus({ platform: 'win32', cursorSdkAdapter: missingCursorAdapter });

    assert.equal(report.platform, 'win32');
    assert.equal(report.posix_supported, false);
    assert.deepStrictEqual(report.backends.map((backend) => backend.status), ['auth_unknown', 'auth_unknown', 'missing']);
    assert.deepStrictEqual(report.backends.filter((backend) => backend.name !== 'cursor').map((backend) => backend.version), ['codex 1.2.3', 'claude 2.3.4']);
    assert.ok(report.backends.filter((backend) => backend.name !== 'cursor').every((backend) => backend.checks.every((check) => check.ok)));
  });

  it('reports auth_unknown when binaries and required flags exist but auth cannot be proven locally', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'agent-diag-bin-'));
    await writeMockCli(bin, 'codex', [
      ['--version', 'codex 1.2.3'],
      ['exec --help', 'Usage: codex exec --json --cd --skip-git-repo-check --model -'],
      ['exec resume --help', 'Usage: codex exec resume --json --skip-git-repo-check --model <session> -'],
    ]);
    await writeMockCli(bin, 'claude', [
      ['--version', 'claude 2.3.4'],
      ['--help', 'Usage: claude -p --output-format stream-json --resume --model <session>'],
    ]);
    process.env.PATH = prependPath(bin, originalPath);

    const report = await getBackendStatus({ cursorSdkAdapter: missingCursorAdapter });

    assert.deepStrictEqual(report.backends.map((backend) => backend.status), ['auth_unknown', 'auth_unknown', 'missing']);
    assert.deepStrictEqual(report.backends.filter((backend) => backend.name !== 'cursor').map((backend) => backend.version), ['codex 1.2.3', 'claude 2.3.4']);
    assert.ok(report.backends.filter((backend) => backend.name !== 'cursor').every((backend) => backend.checks.every((check) => check.ok)));
  });

  it('reports available when an auth environment variable is present', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'agent-diag-auth-bin-'));
    await writeMockCli(bin, 'codex', [
      ['--version', 'codex 1.2.3'],
      ['exec --help', 'Usage: codex exec --json --cd --skip-git-repo-check --model -'],
      ['exec resume --help', 'Usage: codex exec resume --json --skip-git-repo-check --model <session> -'],
    ]);
    await writeMockCli(bin, 'claude', [
      ['--version', 'claude 2.3.4'],
      ['--help', 'Usage: claude -p --output-format stream-json --resume --model <session>'],
    ]);
    process.env.PATH = prependPath(bin, originalPath);
    process.env.OPENAI_API_KEY = 'test-openai';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';

    const report = await getBackendStatus({ cursorSdkAdapter: missingCursorAdapter });

    const cli = report.backends.filter((backend) => backend.name !== 'cursor');
    assert.deepStrictEqual(cli.map((backend) => backend.status), ['available', 'available']);
    assert.deepStrictEqual(cli.map((backend) => backend.auth.status), ['ready', 'ready']);
  });

  it('exposes the same diagnostics through the orchestrator MCP dispatch path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-diag-service-'));
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeMockCli(bin, 'codex', [
      ['--version', 'codex 1.2.3'],
      ['exec --help', 'Usage: codex exec --json --cd --skip-git-repo-check --model -'],
      ['exec resume --help', 'Usage: codex exec resume --json --skip-git-repo-check --model <session> -'],
    ]);
    await writeMockCli(bin, 'claude', [
      ['--version', 'claude 2.3.4'],
      ['--help', 'Usage: claude -p --output-format stream-json --resume --model <session>'],
    ]);
    process.env.PATH = prependPath(bin, originalPath);

    const diagnosticsStore = new RunStore(join(root, 'home'));
    const service = new OrchestratorService(diagnosticsStore, createBackendRegistry(diagnosticsStore));
    await service.initialize();
    const result = await service.dispatch('get_backend_status', {}, { frontend_version: getPackageVersion() }) as { ok: boolean; status?: { frontend_version: string; daemon_version: string | null; version_match: boolean; daemon_pid: number | null; backends: { status: string }[] } };

    assert.equal(result.ok, true);
    assert.equal(result.status?.frontend_version, getPackageVersion());
    assert.equal(result.status?.daemon_version, getPackageVersion());
    assert.equal(result.status?.version_match, true);
    assert.equal(result.status?.daemon_pid, process.pid);
    const reported = result.status?.backends ?? [];
    assert.equal(reported.find((backend) => (backend as { name?: string }).name === 'codex')?.status, 'auth_unknown');
    assert.equal(reported.find((backend) => (backend as { name?: string }).name === 'claude')?.status, 'auth_unknown');
    assert.ok(reported.some((backend) => (backend as { name?: string }).name === 'cursor'));
  });

  it('reports unsupported when required model flags are missing', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'agent-diag-old-bin-'));
    await writeMockCli(bin, 'codex', [
      ['--version', 'codex 1.0.0'],
      ['exec --help', 'Usage: codex exec --json --cd --skip-git-repo-check -'],
      ['exec resume --help', 'Usage: codex exec resume --json <session> -'],
    ]);
    await writeMockCli(bin, 'claude', [
      ['--version', 'claude 1.0.0'],
      ['--help', 'Usage: claude -p --output-format stream-json --resume <session>'],
    ]);
    process.env.PATH = prependPath(bin, originalPath);

    const report = await getBackendStatus({ cursorSdkAdapter: missingCursorAdapter });

    const cli = report.backends.filter((backend) => backend.name !== 'cursor');
    assert.deepStrictEqual(cli.map((backend) => backend.status), ['unsupported', 'unsupported']);
    assert.ok(cli.every((backend) => backend.checks.some((check) => !check.ok && check.message?.includes('--model'))));
  });
});

async function writeMockCli(bin: string, name: string, responses: [string, string][]): Promise<void> {
  const cases = responses
    .map(([args, output]) => `if (key === ${JSON.stringify(args)}) { console.log(${JSON.stringify(output)}); process.exit(0); }`)
    .join('\n');
  const script = `#!/usr/bin/env node
const key = process.argv.slice(2).join(' ');
${cases}
console.error('unexpected args: ' + key);
process.exit(1);
`;

  if (process.platform === 'win32') {
    const scriptPath = join(bin, `${name}.js`);
    await writeFile(scriptPath, script);
    await writeFile(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`);
    return;
  }

  const scriptPath = join(bin, name);
  await writeFile(scriptPath, script);
  await chmod(scriptPath, 0o755);
}

async function writeWindowsMockCli(bin: string, name: string, responses: [string, string][]): Promise<void> {
  const cases = responses
    .map(([args, output]) => `if (key === ${JSON.stringify(args)}) { console.log(${JSON.stringify(output)}); process.exit(0); }`)
    .join('\n');
  const script = `const key = process.argv.slice(2).join(' ');
${cases}
console.error('unexpected args: ' + key);
process.exit(1);
`;

  await writeFile(join(bin, `${name}.js`), script);
  const cmdPath = join(bin, `${name}.cmd`);
  await writeFile(cmdPath, `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`);
  if (process.platform !== 'win32') await chmod(cmdPath, 0o755);
}

async function writeWindowsCommandProcessor(path: string): Promise<void> {
  const script = `#!${process.execPath}
const { basename } = require('node:path');

const commandLine = process.argv.at(-1) || '';
const parsed = parseCommandLine(commandLine);
const binary = basename(parsed.command).replace(/\\.cmd$/i, '').toLowerCase();
const responses = {
  codex: {
    '--version': 'codex 1.2.3',
    'exec --help': 'Usage: codex exec --json --cd --skip-git-repo-check --model -',
    'exec resume --help': 'Usage: codex exec resume --json --skip-git-repo-check --model <session> -',
  },
  claude: {
    '--version': 'claude 2.3.4',
    '--help': 'Usage: claude -p --output-format stream-json --resume --model <session>',
  },
};
const output = responses[binary]?.[parsed.args];
if (output) {
  console.log(output);
  process.exit(0);
}
console.error('unexpected command: ' + commandLine);
process.exit(1);

function parseCommandLine(value) {
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1);
    return { command: value.slice(1, end), args: value.slice(end + 1).trim() };
  }
  const [command, ...rest] = value.split(' ');
  return { command, args: rest.join(' ').trim() };
}
`;
  await writeFile(path, script);
  await chmod(path, 0o755);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function prependPath(entry: string, current: string | undefined): string {
  return current ? `${entry}${delimiter}${current}` : entry;
}
