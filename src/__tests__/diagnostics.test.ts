import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getBackendStatus } from '../diagnostics.js';
import { createBackendRegistry } from '../backend/registry.js';
import { OrchestratorService } from '../orchestratorService.js';
import { RunStore } from '../runStore.js';

let originalPath = process.env.PATH;
let originalOpenAiKey = process.env.OPENAI_API_KEY;
let originalCodexKey = process.env.CODEX_API_KEY;
let originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

describe('backend diagnostics', () => {
  beforeEach(() => {
    originalPath = process.env.PATH;
    originalOpenAiKey = process.env.OPENAI_API_KEY;
    originalCodexKey = process.env.CODEX_API_KEY;
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    restoreEnv('OPENAI_API_KEY', originalOpenAiKey);
    restoreEnv('CODEX_API_KEY', originalCodexKey);
    restoreEnv('ANTHROPIC_API_KEY', originalAnthropicKey);
  });

  it('reports missing backend binaries without failing the whole report', async () => {
    process.env.PATH = '/tmp/agent-orchestrator-no-diagnostics-binaries';

    const report = await getBackendStatus();

    assert.equal(report.posix_supported, true);
    assert.deepStrictEqual(report.backends.map((backend) => backend.status), ['missing', 'missing']);
    assert.ok(report.backends.every((backend) => backend.hints.length > 0));
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
    process.env.PATH = `${bin}:${originalPath}`;

    const report = await getBackendStatus();

    assert.deepStrictEqual(report.backends.map((backend) => backend.status), ['auth_unknown', 'auth_unknown']);
    assert.deepStrictEqual(report.backends.map((backend) => backend.version), ['codex 1.2.3', 'claude 2.3.4']);
    assert.ok(report.backends.every((backend) => backend.checks.every((check) => check.ok)));
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
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.OPENAI_API_KEY = 'test-openai';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';

    const report = await getBackendStatus();

    assert.deepStrictEqual(report.backends.map((backend) => backend.status), ['available', 'available']);
    assert.deepStrictEqual(report.backends.map((backend) => backend.auth.status), ['ready', 'ready']);
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
    process.env.PATH = `${bin}:${originalPath}`;

    const service = new OrchestratorService(new RunStore(join(root, 'home')), createBackendRegistry());
    await service.initialize();
    const result = await service.dispatch('get_backend_status', {}) as { ok: boolean; status?: { backends: { status: string }[] } };

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.status?.backends.map((backend) => backend.status), ['auth_unknown', 'auth_unknown']);
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
    process.env.PATH = `${bin}:${originalPath}`;

    const report = await getBackendStatus();

    assert.deepStrictEqual(report.backends.map((backend) => backend.status), ['unsupported', 'unsupported']);
    assert.ok(report.backends.every((backend) => backend.checks.some((check) => !check.ok && check.message?.includes('--model'))));
  });
});

async function writeMockCli(bin: string, name: string, responses: [string, string][]): Promise<void> {
  const script = join(bin, name);
  const cases = responses
    .map(([args, output]) => `if (key === ${JSON.stringify(args)}) { console.log(${JSON.stringify(output)}); process.exit(0); }`)
    .join('\n');
  await writeFile(script, `#!/usr/bin/env node
const key = process.argv.slice(2).join(' ');
${cases}
console.error('unexpected args: ' + key);
process.exit(1);
`);
  await chmod(script, 0o755);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
