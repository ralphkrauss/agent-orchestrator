import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadUserSecrets,
  loadUserSecretsIntoEnv,
  resolveSecretsPath,
  saveUserSecret,
  unsetUserSecret,
} from '../auth/userSecrets.js';

let originalOverride: string | undefined;

beforeEach(() => {
  originalOverride = process.env.AGENT_ORCHESTRATOR_SECRETS_FILE;
});

afterEach(() => {
  if (originalOverride === undefined) {
    delete process.env.AGENT_ORCHESTRATOR_SECRETS_FILE;
  } else {
    process.env.AGENT_ORCHESTRATOR_SECRETS_FILE = originalOverride;
  }
});

async function withTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-secrets-'));
}

describe('userSecrets resolveSecretsPath', () => {
  it('honors the AGENT_ORCHESTRATOR_SECRETS_FILE override', () => {
    const env = { AGENT_ORCHESTRATOR_SECRETS_FILE: '/tmp/custom.env' } as NodeJS.ProcessEnv;
    assert.equal(resolveSecretsPath(env), '/tmp/custom.env');
  });

  it('defaults to ~/.config/agent-orchestrator/secrets.env', () => {
    const env = {} as NodeJS.ProcessEnv;
    const resolved = resolveSecretsPath(env);
    assert.match(resolved, /\.config[\\/]agent-orchestrator[\\/]secrets\.env$/);
  });
});

describe('userSecrets parse and load', () => {
  it('returns an empty result when the file does not exist', () => {
    const env = { AGENT_ORCHESTRATOR_SECRETS_FILE: '/tmp/nonexistent-aoo-secrets.env' } as NodeJS.ProcessEnv;
    const loaded = loadUserSecrets({ env });
    assert.equal(loaded.exists, false);
    assert.deepStrictEqual(loaded.values, {});
  });

  it('parses key=value lines and ignores comments/blank lines', async () => {
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    await writeFile(path, '# header comment\n\nCURSOR_API_KEY=abc123\n# trailing\nOTHER_KEY=value\n', { mode: 0o600 });

    const env = { AGENT_ORCHESTRATOR_SECRETS_FILE: path } as NodeJS.ProcessEnv;
    const loaded = loadUserSecrets({ env });
    assert.equal(loaded.exists, true);
    assert.equal(loaded.refusal, undefined);
    assert.deepStrictEqual(loaded.values, { CURSOR_API_KEY: 'abc123', OTHER_KEY: 'value' });
  });

  it('unquotes single- and double-quoted values', async () => {
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    await writeFile(path, 'A="quoted value"\nB=\'single\'\n', { mode: 0o600 });
    const env = { AGENT_ORCHESTRATOR_SECRETS_FILE: path } as NodeJS.ProcessEnv;
    const loaded = loadUserSecrets({ env });
    assert.deepStrictEqual(loaded.values, { A: 'quoted value', B: 'single' });
  });

  it('refuses to load a too-permissive file on POSIX', async () => {
    if (process.platform === 'win32') return; // perm check is POSIX-only
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    await writeFile(path, 'CURSOR_API_KEY=abc\n', { mode: 0o644 });
    await chmod(path, 0o644);
    const env = { AGENT_ORCHESTRATOR_SECRETS_FILE: path } as NodeJS.ProcessEnv;
    const loaded = loadUserSecrets({ env });
    assert.equal(loaded.exists, true);
    assert.deepStrictEqual(loaded.values, {});
    assert.ok(loaded.refusal, 'expected a refusal');
    assert.match(loaded.refusal!.hint, /chmod 600/);
  });

  it('skips the perm check on Windows', async () => {
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    await writeFile(path, 'CURSOR_API_KEY=ok\n');
    const env = { AGENT_ORCHESTRATOR_SECRETS_FILE: path } as NodeJS.ProcessEnv;
    const loaded = loadUserSecrets({ env, platform: 'win32' });
    assert.equal(loaded.exists, true);
    assert.equal(loaded.refusal, undefined);
    assert.deepStrictEqual(loaded.values, { CURSOR_API_KEY: 'ok' });
  });
});

describe('userSecrets read-failure resilience', () => {
  it('returns a refusal (not a throw) when the path points at a directory', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(join(tmpdir(), 'agent-secrets-dir-'));
    const fakeSecretsDir = join(dir, 'secrets.env');
    await (await import('node:fs/promises')).mkdir(fakeSecretsDir, { mode: 0o700 });
    const env = { AGENT_ORCHESTRATOR_SECRETS_FILE: fakeSecretsDir } as NodeJS.ProcessEnv;
    const loaded = loadUserSecrets({ env });
    assert.equal(loaded.exists, true);
    assert.deepStrictEqual(loaded.values, {});
    assert.ok(loaded.refusal, 'expected refusal');
    assert.match(loaded.refusal!.reason, /failed to read|EISDIR/);
  });
});

describe('userSecrets loadUserSecretsIntoEnv', () => {
  it('applies file values to env without overriding existing values', async () => {
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    await writeFile(path, 'CURSOR_API_KEY=fromfile\nNEWKEY=alsoset\n', { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { CURSOR_API_KEY: 'envwins', AGENT_ORCHESTRATOR_SECRETS_FILE: path };
    const summary = loadUserSecretsIntoEnv(env);
    assert.equal(env.CURSOR_API_KEY, 'envwins');
    assert.equal(env.NEWKEY, 'alsoset');
    assert.deepStrictEqual(summary.applied, ['NEWKEY']);
    assert.deepStrictEqual(summary.skippedBecauseEnvSet, ['CURSOR_API_KEY']);
  });

  it('treats empty env values as unset and applies the file value', async () => {
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    await writeFile(path, 'CURSOR_API_KEY=fromfile\n', { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { CURSOR_API_KEY: '', AGENT_ORCHESTRATOR_SECRETS_FILE: path };
    loadUserSecretsIntoEnv(env);
    assert.equal(env.CURSOR_API_KEY, 'fromfile');
  });

  it('honors an allowlist: only allowed keys are applied; others are reported and not written', async () => {
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    await writeFile(path, 'CURSOR_API_KEY=ok\nNODE_OPTIONS=--inspect\nANTHROPIC_API_KEY=secret\n', { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { AGENT_ORCHESTRATOR_SECRETS_FILE: path };
    const summary = loadUserSecretsIntoEnv(env, { allowedKeys: ['CURSOR_API_KEY'] });
    assert.equal(env.CURSOR_API_KEY, 'ok');
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.deepStrictEqual(summary.applied, ['CURSOR_API_KEY']);
    assert.deepStrictEqual(summary.skippedBecauseDisallowed.sort(), ['ANTHROPIC_API_KEY', 'NODE_OPTIONS'].sort());
  });

  it('passes through refusal information without applying values', async () => {
    if (process.platform === 'win32') return;
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    await writeFile(path, 'CURSOR_API_KEY=abc\n');
    await chmod(path, 0o644);
    const env: NodeJS.ProcessEnv = { AGENT_ORCHESTRATOR_SECRETS_FILE: path };
    const summary = loadUserSecretsIntoEnv(env);
    assert.equal(env.CURSOR_API_KEY, undefined);
    assert.deepStrictEqual(summary.applied, []);
    assert.ok(summary.refusal);
  });
});

describe('userSecrets saveUserSecret', () => {
  it('creates the file with mode 0o600 and parent dir 0o700', async () => {
    const dir = await withTempDir();
    const path = join(dir, 'subdir', 'secrets.env');
    await saveUserSecret('CURSOR_API_KEY', 'value-1', { path });
    const fileInfo = await stat(path);
    if (process.platform !== 'win32') {
      assert.equal(fileInfo.mode & 0o777, 0o600);
      const dirInfo = await stat(join(dir, 'subdir'));
      assert.equal(dirInfo.mode & 0o777, 0o700);
    }
    const text = await readFile(path, 'utf8');
    assert.equal(text, 'CURSOR_API_KEY=value-1\n');
  });

  it('replaces an existing key in-place and preserves comments/ordering', async () => {
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    await writeFile(path, '# user note\nA=alpha\nCURSOR_API_KEY=old\nB=bravo\n', { mode: 0o600 });
    await saveUserSecret('CURSOR_API_KEY', 'new', { path });
    const text = await readFile(path, 'utf8');
    assert.equal(text, '# user note\nA=alpha\nCURSOR_API_KEY=new\nB=bravo\n');
  });

  it('appends a new key when not present', async () => {
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    await writeFile(path, '# header\nA=alpha\n', { mode: 0o600 });
    await saveUserSecret('CURSOR_API_KEY', 'value', { path });
    const text = await readFile(path, 'utf8');
    assert.equal(text, '# header\nA=alpha\nCURSOR_API_KEY=value\n');
  });

  it('rejects values containing newlines', async () => {
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    await assert.rejects(() => saveUserSecret('CURSOR_API_KEY', 'a\nb', { path }), /newlines/);
  });

  it('rejects invalid env-style keys', async () => {
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    await assert.rejects(() => saveUserSecret('1BAD', 'v', { path }), /invalid env-style key/);
  });
});

describe('userSecrets unsetUserSecret', () => {
  it('removes the key in-place and preserves siblings', async () => {
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    await writeFile(path, '# header\nA=alpha\nCURSOR_API_KEY=old\nB=bravo\n', { mode: 0o600 });
    const result = await unsetUserSecret('CURSOR_API_KEY', { path });
    assert.equal(result.removed, true);
    const text = await readFile(path, 'utf8');
    assert.equal(text, '# header\nA=alpha\nB=bravo\n');
  });

  it('reports removed=false when the key was not present', async () => {
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    await writeFile(path, 'A=alpha\n', { mode: 0o600 });
    const result = await unsetUserSecret('MISSING', { path });
    assert.equal(result.removed, false);
    const text = await readFile(path, 'utf8');
    assert.equal(text, 'A=alpha\n');
  });

  it('is a no-op when the file does not exist', async () => {
    const dir = await withTempDir();
    const path = join(dir, 'secrets.env');
    const result = await unsetUserSecret('CURSOR_API_KEY', { path });
    assert.equal(result.removed, false);
  });
});
