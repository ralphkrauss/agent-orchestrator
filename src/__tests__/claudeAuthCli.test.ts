import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { runAuthCli } from '../auth/authCli.js';
import { accountRegistryPaths, loadAccountRegistry } from '../claude/accountRegistry.js';
import { accountSecretKey } from '../claude/accountValidation.js';

class CaptureWritable extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    callback();
  }
  text(): string {
    return this.chunks.join('');
  }
}

async function freshHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'auth-claude-'));
}

async function freshSecretsPath(home: string): Promise<string> {
  return join(home, 'secrets.env');
}

function fakeLoginChild(exitCode: number): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  setImmediate(() => emitter.emit('close', exitCode));
  return emitter;
}

describe('auth login claude --account', () => {
  it('refuses without TTY', async () => {
    const home = await freshHome();
    const stdout = new CaptureWritable();
    const stderr = new CaptureWritable();
    const code = await runAuthCli(['login', 'claude', '--account', 'work'], {
      home,
      stdout,
      stderr,
      stdin: process.stdin, // not a TTY in CI
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /interactive TTY/);
  });

  it('refuses --api-key value-bearing flag', async () => {
    const home = await freshHome();
    const stderr = new CaptureWritable();
    const code = await runAuthCli(['login', 'claude', '--account', 'work', '--api-key', 'sk-foo'], {
      home,
      stdout: new CaptureWritable(),
      stderr,
      stdin: process.stdin,
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /refusing --api-key/);
  });

  it('rejects invalid account names', async () => {
    const home = await freshHome();
    const stderr = new CaptureWritable();
    const code = await runAuthCli(['login', 'claude', '--account', '..'], {
      home,
      stdout: new CaptureWritable(),
      stderr,
      stdin: process.stdin,
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /invalid account name/);
  });
});

describe('auth set claude --account', () => {
  it('writes the secret via userSecrets and registers an api_env account', async () => {
    const home = await freshHome();
    const secretsPath = await freshSecretsPath(home);
    const stdout = new CaptureWritable();
    const stderr = new CaptureWritable();
    const code = await runAuthCli(['set', 'claude', '--account', 'work', '--from-env', 'ANTHROPIC_API_KEY'], {
      home,
      secretsPath,
      stdout,
      stderr,
      env: { ANTHROPIC_API_KEY: 'a'.repeat(32) },
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 0);
    const text = await readFile(secretsPath, 'utf8');
    const expectedKey = accountSecretKey('work');
    assert.match(text, new RegExp(`${expectedKey}=`));
    const loaded = await loadAccountRegistry(accountRegistryPaths(home));
    assert.ok(loaded.ok);
    if (loaded.ok) {
      const work = loaded.file.accounts.find((entry) => entry.name === 'work');
      assert.equal(work?.mode, 'api_env');
      assert.equal(work?.secret_key, expectedKey);
    }
  });

  it('rejects --api-key value-bearing flag', async () => {
    const home = await freshHome();
    const secretsPath = await freshSecretsPath(home);
    const stderr = new CaptureWritable();
    const code = await runAuthCli(['set', 'claude', '--account', 'work', '--api-key', 'sk-do-not-pass'], {
      home,
      secretsPath,
      stdout: new CaptureWritable(),
      stderr,
      env: {},
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /refusing --api-key/);
  });

  it('reports an error when --from-env points at an unset variable', async () => {
    const home = await freshHome();
    const secretsPath = await freshSecretsPath(home);
    const stderr = new CaptureWritable();
    const code = await runAuthCli(['set', 'claude', '--account', 'work', '--from-env', 'NOT_SET'], {
      home,
      secretsPath,
      stdout: new CaptureWritable(),
      stderr,
      env: {},
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /environment variable NOT_SET/);
  });
});

describe('auth list claude', () => {
  it('emits JSON with no accounts when registry is empty', async () => {
    const home = await freshHome();
    const stdout = new CaptureWritable();
    const code = await runAuthCli(['list', 'claude', '--json'], {
      home,
      stdout,
      stderr: new CaptureWritable(),
      env: {},
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.text()) as { accounts: unknown[] };
    assert.deepStrictEqual(parsed.accounts, []);
  });

  it('lists registered accounts as JSON without raw secrets', async () => {
    const home = await freshHome();
    const secretsPath = await freshSecretsPath(home);
    await runAuthCli(['set', 'claude', '--account', 'work', '--from-env', 'ANTHROPIC_API_KEY'], {
      home,
      secretsPath,
      stdout: new CaptureWritable(),
      stderr: new CaptureWritable(),
      env: { ANTHROPIC_API_KEY: 'a'.repeat(32) },
      isDaemonRunning: async () => false,
    });
    const stdout = new CaptureWritable();
    await runAuthCli(['list', 'claude', '--json'], {
      home,
      secretsPath,
      stdout,
      stderr: new CaptureWritable(),
      env: { ANTHROPIC_API_KEY: 'a'.repeat(32) },
      isDaemonRunning: async () => false,
    });
    const parsed = JSON.parse(stdout.text()) as { accounts: { name: string; mode: string; secret_key: string | null }[] };
    assert.equal(parsed.accounts.length, 1);
    assert.equal(parsed.accounts[0]?.name, 'work');
    assert.equal(parsed.accounts[0]?.mode, 'api_env');
    assert.match(parsed.accounts[0]?.secret_key ?? '', /^ANTHROPIC_API_KEY__/);
    assert.ok(!stdout.text().includes('a'.repeat(32)), 'list output must never contain raw secrets');
  });
});

describe('auth remove claude --account', () => {
  it('removes the registry entry and the userSecrets entry for api_env mode', async () => {
    const home = await freshHome();
    const secretsPath = await freshSecretsPath(home);
    await runAuthCli(['set', 'claude', '--account', 'work', '--from-env', 'ANTHROPIC_API_KEY'], {
      home,
      secretsPath,
      stdout: new CaptureWritable(),
      stderr: new CaptureWritable(),
      env: { ANTHROPIC_API_KEY: 'a'.repeat(32) },
      isDaemonRunning: async () => false,
    });
    const expectedKey = accountSecretKey('work');
    let secrets = await readFile(secretsPath, 'utf8');
    assert.match(secrets, new RegExp(expectedKey));
    const code = await runAuthCli(['remove', 'claude', '--account', 'work'], {
      home,
      secretsPath,
      stdout: new CaptureWritable(),
      stderr: new CaptureWritable(),
      env: {},
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 0);
    secrets = await readFile(secretsPath, 'utf8');
    assert.equal(secrets.includes(expectedKey), false);
  });

  it('preserves config_dir directory unless --delete-config-dir is passed', async () => {
    const home = await freshHome();
    let captured = '';
    void captured;
    const stdout = new CaptureWritable();
    const stderr = new CaptureWritable();
    const fakeStdin = Object.assign(new Readable({ read() {} }), { isTTY: true });
    const fakeStdout = Object.assign(new CaptureWritable(), { isTTY: true }) as unknown as NodeJS.WritableStream;
    const code = await runAuthCli(['login', 'claude', '--account', 'persisted'], {
      home,
      stdout: fakeStdout,
      stderr,
      stdin: fakeStdin,
      env: {},
      isDaemonRunning: async () => false,
      spawnLogin: () => fakeLoginChild(0),
    });
    assert.equal(code, 0);
    const paths = accountRegistryPaths(home);
    const dir = join(paths.accountsRoot, 'persisted');
    await stat(dir);

    const removeStdout = new CaptureWritable();
    await runAuthCli(['remove', 'claude', '--account', 'persisted'], {
      home,
      stdout: removeStdout,
      stderr: new CaptureWritable(),
      env: {},
      isDaemonRunning: async () => false,
    });
    // Directory must still exist.
    await stat(dir);

    // Re-register and remove with --delete-config-dir.
    await runAuthCli(['login', 'claude', '--account', 'persisted'], {
      home,
      stdout: fakeStdout,
      stderr: new CaptureWritable(),
      stdin: fakeStdin,
      env: {},
      isDaemonRunning: async () => false,
      spawnLogin: () => fakeLoginChild(0),
    });
    await runAuthCli(['remove', 'claude', '--account', 'persisted', '--delete-config-dir'], {
      home,
      stdout: new CaptureWritable(),
      stderr: new CaptureWritable(),
      env: {},
      isDaemonRunning: async () => false,
    });
    await assert.rejects(() => stat(dir));
  });
});

describe('auth login claude idempotency (--refresh)', () => {
  it('refuses to register the same name twice without --refresh', async () => {
    const home = await freshHome();
    const fakeStdin = Object.assign(new Readable({ read() {} }), { isTTY: true });
    const fakeStdout = Object.assign(new CaptureWritable(), { isTTY: true }) as unknown as NodeJS.WritableStream;
    const ok = await runAuthCli(['login', 'claude', '--account', 'work'], {
      home,
      stdout: fakeStdout,
      stderr: new CaptureWritable(),
      stdin: fakeStdin,
      env: {},
      isDaemonRunning: async () => false,
      spawnLogin: () => fakeLoginChild(0),
    });
    assert.equal(ok, 0);
    const stderr = new CaptureWritable();
    const dup = await runAuthCli(['login', 'claude', '--account', 'work'], {
      home,
      stdout: fakeStdout,
      stderr,
      stdin: fakeStdin,
      env: {},
      isDaemonRunning: async () => false,
      spawnLogin: () => fakeLoginChild(0),
    });
    assert.equal(dup, 1);
    assert.match(stderr.text(), /--refresh/);
  });

  it('accepts --refresh and re-runs /login against the existing dir', async () => {
    const home = await freshHome();
    const fakeStdin = Object.assign(new Readable({ read() {} }), { isTTY: true });
    const fakeStdout = Object.assign(new CaptureWritable(), { isTTY: true }) as unknown as NodeJS.WritableStream;
    const ok = await runAuthCli(['login', 'claude', '--account', 'work'], {
      home,
      stdout: fakeStdout,
      stderr: new CaptureWritable(),
      stdin: fakeStdin,
      env: {},
      isDaemonRunning: async () => false,
      spawnLogin: () => fakeLoginChild(0),
    });
    assert.equal(ok, 0);
    const refreshed = await runAuthCli(['login', 'claude', '--account', 'work', '--refresh'], {
      home,
      stdout: fakeStdout,
      stderr: new CaptureWritable(),
      stdin: fakeStdin,
      env: {},
      isDaemonRunning: async () => false,
      spawnLogin: () => fakeLoginChild(0),
    });
    assert.equal(refreshed, 0);
  });
});

describe('auth login claude spawn shape (fresh vs --refresh)', () => {
  it('fresh-dir login spawns claude with NO /login arg so the first-run setup runs once', async () => {
    const home = await freshHome();
    const fakeStdin = Object.assign(new Readable({ read() {} }), { isTTY: true });
    const captured: { refresh: boolean | undefined }[] = [];
    const stdout = Object.assign(new CaptureWritable(), { isTTY: true }) as unknown as NodeJS.WritableStream & { text(): string };
    const code = await runAuthCli(['login', 'claude', '--account', 'fresh-account'], {
      home,
      stdout,
      stderr: new CaptureWritable(),
      stdin: fakeStdin,
      env: {},
      isDaemonRunning: async () => false,
      spawnLogin: (_configDir, options) => {
        captured.push({ refresh: options.refresh });
        return fakeLoginChild(0);
      },
    });
    assert.equal(code, 0);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.refresh, false, 'fresh-dir spawn must pass refresh=false (no /login slash command)');
    assert.match((stdout as unknown as { text(): string }).text(), /first-run setup/);
    assert.match((stdout as unknown as { text(): string }).text(), /\/exit/);
  });

  it('--refresh against an existing entry passes refresh=true so the spawn uses /login', async () => {
    const home = await freshHome();
    const fakeStdin = Object.assign(new Readable({ read() {} }), { isTTY: true });
    const fakeStdout = Object.assign(new CaptureWritable(), { isTTY: true }) as unknown as NodeJS.WritableStream;
    // First register the account fresh.
    const initial = await runAuthCli(['login', 'claude', '--account', 'work'], {
      home,
      stdout: fakeStdout,
      stderr: new CaptureWritable(),
      stdin: fakeStdin,
      env: {},
      isDaemonRunning: async () => false,
      spawnLogin: () => fakeLoginChild(0),
    });
    assert.equal(initial, 0);

    const captured: { refresh: boolean | undefined }[] = [];
    const refreshStdout = Object.assign(new CaptureWritable(), { isTTY: true }) as unknown as NodeJS.WritableStream & { text(): string };
    const refreshed = await runAuthCli(['login', 'claude', '--account', 'work', '--refresh'], {
      home,
      stdout: refreshStdout,
      stderr: new CaptureWritable(),
      stdin: fakeStdin,
      env: {},
      isDaemonRunning: async () => false,
      spawnLogin: (_configDir, options) => {
        captured.push({ refresh: options.refresh });
        return fakeLoginChild(0);
      },
    });
    assert.equal(refreshed, 0);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.refresh, true, '--refresh must pass refresh=true so the default spawn uses /login');
    assert.match((refreshStdout as unknown as { text(): string }).text(), /claude \/login/);
  });
});
