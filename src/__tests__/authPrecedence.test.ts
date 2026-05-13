import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CursorSdkRuntime } from '../backend/cursor/runtime.js';
import { RunStore } from '../runStore.js';
import { getBackendStatus } from '../diagnostics.js';
import type { CursorAgentApi, CursorSdkAdapter } from '../backend/cursor/sdk.js';

const okAdapter: CursorSdkAdapter = {
  available: async () => ({ ok: true, modulePath: '/fake/cursor-sdk' }),
  loadAgentApi: async () => {
    const api: CursorAgentApi = {
      create: async () => { throw new Error('should not be called when api key is missing'); },
      resume: async () => { throw new Error('should not be called when api key is missing'); },
    };
    return api;
  },
};

let originalCursor: string | undefined;
let originalSecretsFile: string | undefined;

beforeEach(() => {
  originalCursor = process.env.CURSOR_API_KEY;
  originalSecretsFile = process.env.AGENT_ORCHESTRATOR_SECRETS_FILE;
  delete process.env.CURSOR_API_KEY;
  delete process.env.AGENT_ORCHESTRATOR_SECRETS_FILE;
});

afterEach(() => {
  if (originalCursor === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = originalCursor;
  if (originalSecretsFile === undefined) delete process.env.AGENT_ORCHESTRATOR_SECRETS_FILE;
  else process.env.AGENT_ORCHESTRATOR_SECRETS_FILE = originalSecretsFile;
});

describe('cursor auth precedence and missing-key shape', () => {
  it('preserves the SPAWN_FAILED auth failure shape when neither env nor file provides the key', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cursor-noauth-'));
    const store = new RunStore(home);
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-noauth-cwd-'));
    const runtime = new CursorSdkRuntime(okAdapter, { store, env: {} });
    const result = await runtime.start({ runId: 'r1', prompt: 'p', cwd, model: 'composer-2', modelSettings: { reasoning_effort: null, service_tier: null, mode: null, codex_network: null, worker_posture: null } });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, 'SPAWN_FAILED');
    assert.equal(result.failure.details.binary, '@cursor/sdk');
    assert.equal(result.failure.details.auth_env, 'CURSOR_API_KEY');
    assert.equal(result.failure.details.category, 'auth');
    assert.equal(result.failure.details.retryable, false);
    assert.ok(typeof result.failure.details.install_hint === 'string');
  });

  it('doctor reports source_kind=file and the runtime accepts the file value when env is unset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursor-precedence-'));
    const secretsPath = join(dir, 'secrets.env');
    const fileKey = 'F'.repeat(32);
    await writeFile(secretsPath, `CURSOR_API_KEY=${fileKey}\n`, { mode: 0o600 });
    process.env.AGENT_ORCHESTRATOR_SECRETS_FILE = secretsPath;
    const report = await getBackendStatus({ cursorSdkAdapter: okAdapter });
    const cursor = report.backends.find((b) => b.name === 'cursor')!;
    assert.equal(cursor.auth.status, 'ready');
    assert.equal(cursor.auth.source_kind, 'file');
    assert.equal(cursor.auth.source_path, secretsPath);
  });

  it('doctor does not crash when CURSOR_API_KEY is set and the secrets-file path is invalid (e.g. a directory)', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(join(tmpdir(), 'cursor-bad-path-'));
    const fakeSecretsDir = join(dir, 'secrets.env');
    await (await import('node:fs/promises')).mkdir(fakeSecretsDir, { mode: 0o700 });
    process.env.AGENT_ORCHESTRATOR_SECRETS_FILE = fakeSecretsDir;
    process.env.CURSOR_API_KEY = 'envwins';
    const report = await getBackendStatus({ cursorSdkAdapter: okAdapter });
    const cursor = report.backends.find((b) => b.name === 'cursor')!;
    assert.equal(cursor.auth.status, 'ready');
    assert.equal(cursor.auth.source_kind, 'env');
    // No file-noise hint should leak in when env wins.
    assert.ok(!cursor.hints.some((h) => /chmod|secrets file/i.test(h)));
  });

  it('doctor surfaces a refusal hint without crashing when env is unset and the secrets-file path is invalid', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(join(tmpdir(), 'cursor-bad-path-'));
    const fakeSecretsDir = join(dir, 'secrets.env');
    await (await import('node:fs/promises')).mkdir(fakeSecretsDir, { mode: 0o700 });
    process.env.AGENT_ORCHESTRATOR_SECRETS_FILE = fakeSecretsDir;
    const report = await getBackendStatus({ cursorSdkAdapter: okAdapter });
    const cursor = report.backends.find((b) => b.name === 'cursor')!;
    assert.equal(cursor.auth.status, 'unknown');
    assert.ok(cursor.hints.some((h) => /readable regular file|chmod 600|EISDIR/i.test(h)), `expected refusal hint in ${JSON.stringify(cursor.hints)}`);
  });

  it('doctor reports source_kind=env when both env and file are set, and never claims file source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursor-precedence-'));
    const secretsPath = join(dir, 'secrets.env');
    await writeFile(secretsPath, 'CURSOR_API_KEY=fileonly\n', { mode: 0o600 });
    process.env.AGENT_ORCHESTRATOR_SECRETS_FILE = secretsPath;
    process.env.CURSOR_API_KEY = 'envwins';
    const report = await getBackendStatus({ cursorSdkAdapter: okAdapter });
    const cursor = report.backends.find((b) => b.name === 'cursor')!;
    assert.equal(cursor.auth.source_kind, 'env');
    assert.equal(cursor.auth.source_path, undefined);
  });
});
