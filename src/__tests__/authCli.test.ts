import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAuthCli, type AuthStatusJson } from '../auth/authCli.js';

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

async function withTempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'auth-cli-'));
  return join(dir, 'secrets.env');
}

const VALID_KEY = 'A'.repeat(32);

describe('authCli status', () => {
  it('emits structured JSON with provider rows', async () => {
    const path = await withTempPath();
    await writeFile(path, 'CURSOR_API_KEY=' + VALID_KEY + '\n', { mode: 0o600 });
    const stdout = new CaptureWritable();
    const stderr = new CaptureWritable();
    const code = await runAuthCli(['status', '--json'], {
      stdout,
      stderr,
      secretsPath: path,
      env: {},
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.text()) as AuthStatusJson;
    assert.equal(parsed.secrets_path, path);
    assert.equal(parsed.secrets_file_present, true);
    assert.equal(parsed.daemon_running, false);
    const cursor = parsed.providers.find((p) => p.id === 'cursor');
    assert.ok(cursor);
    assert.equal(cursor!.effective_status, 'ready');
    assert.equal(cursor!.effective_source, 'file');
    assert.equal(cursor!.file_set, true);
    assert.equal(cursor!.env_set, false);
    const claude = parsed.providers.find((p) => p.id === 'claude');
    assert.equal(claude!.status, 'wired');
    const codex = parsed.providers.find((p) => p.id === 'codex');
    assert.equal(codex!.status, 'reserved');
  });

  it('reports env precedence over file when both are set', async () => {
    const path = await withTempPath();
    await writeFile(path, 'CURSOR_API_KEY=fromfile\n', { mode: 0o600 });
    const stdout = new CaptureWritable();
    const code = await runAuthCli(['status', '--json'], {
      stdout,
      stderr: new CaptureWritable(),
      secretsPath: path,
      env: { CURSOR_API_KEY: 'envwins' },
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.text()) as AuthStatusJson;
    const cursor = parsed.providers.find((p) => p.id === 'cursor');
    assert.equal(cursor!.effective_source, 'env');
    assert.equal(cursor!.env_source_var, 'CURSOR_API_KEY');
  });

  it('reports reserved-provider file entries as drift only (file_set true, but not effective)', async () => {
    const path = await withTempPath();
    await writeFile(path, 'CURSOR_API_KEY=' + VALID_KEY + '\nOPENAI_API_KEY=should-not-look-effective\n', { mode: 0o600 });
    const stdout = new CaptureWritable();
    const code = await runAuthCli(['status', '--json'], {
      stdout,
      stderr: new CaptureWritable(),
      secretsPath: path,
      env: {},
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.text()) as AuthStatusJson;
    const codex = parsed.providers.find((p) => p.id === 'codex')!;
    assert.equal(codex.status, 'reserved');
    assert.equal(codex.file_set, true, 'file_set should still surface drift');
    assert.equal(codex.env_set, false);
    assert.equal(codex.effective_status, 'unknown', 'reserved providers must not be reported as effective via file');
    assert.equal(codex.effective_source, null);
    const cursor = parsed.providers.find((p) => p.id === 'cursor')!;
    assert.equal(cursor.effective_source, 'file', 'wired providers stay effective via file');
    assert.equal(cursor.effective_status, 'ready');
  });

  it('still treats env vars for reserved providers as effective (env precedence is provider-agnostic)', async () => {
    const path = await withTempPath();
    const stdout = new CaptureWritable();
    const code = await runAuthCli(['status', '--json'], {
      stdout,
      stderr: new CaptureWritable(),
      secretsPath: path,
      env: { OPENAI_API_KEY: 'set-by-user' },
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.text()) as AuthStatusJson;
    const codex = parsed.providers.find((p) => p.id === 'codex')!;
    assert.equal(codex.effective_source, 'env');
    assert.equal(codex.effective_status, 'ready');
  });

  it('renders human-readable output without --json', async () => {
    const path = await withTempPath();
    const stdout = new CaptureWritable();
    const code = await runAuthCli(['status'], {
      stdout,
      stderr: new CaptureWritable(),
      secretsPath: path,
      env: {},
      isDaemonRunning: async () => true,
    });
    assert.equal(code, 0);
    const text = stdout.text();
    assert.match(text, /Secrets file:.*secrets\.env \(not present\)/);
    assert.match(text, /Daemon: running/);
    assert.match(text, /- cursor \[wired\]: unknown via unset/);
  });
});

describe('authCli cursor save', () => {
  it('saves a key from --from-env (default primary var)', async () => {
    const path = await withTempPath();
    const stdout = new CaptureWritable();
    const code = await runAuthCli(['cursor', '--from-env'], {
      stdout,
      stderr: new CaptureWritable(),
      secretsPath: path,
      env: { CURSOR_API_KEY: VALID_KEY },
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 0);
    const text = await readFile(path, 'utf8');
    assert.equal(text, `CURSOR_API_KEY=${VALID_KEY}\n`);
    const out = stdout.text();
    assert.match(out, /Saved CURSOR_API_KEY to/);
    assert.match(out, /Run `agent-orchestrator start`/);
  });

  it('honors --from-env VAR (alternate variable name)', async () => {
    const path = await withTempPath();
    const stdout = new CaptureWritable();
    const code = await runAuthCli(['cursor', '--from-env', 'CURSOR_API_KEY_TEMP'], {
      stdout,
      stderr: new CaptureWritable(),
      secretsPath: path,
      env: { CURSOR_API_KEY_TEMP: VALID_KEY },
      isDaemonRunning: async () => true,
    });
    assert.equal(code, 0);
    const text = await readFile(path, 'utf8');
    assert.equal(text, `CURSOR_API_KEY=${VALID_KEY}\n`);
    const out = stdout.text();
    assert.match(out, /A running daemon is unchanged/);
  });

  it('fails when --from-env VAR is unset (no fallback)', async () => {
    const path = await withTempPath();
    const stderr = new CaptureWritable();
    const code = await runAuthCli(['cursor', '--from-env', 'NONEXISTENT_VAR'], {
      stdout: new CaptureWritable(),
      stderr,
      secretsPath: path,
      env: { CURSOR_API_KEY: VALID_KEY },
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /NONEXISTENT_VAR is not set/);
  });

  it('reads a key from --from-stdin', async () => {
    const path = await withTempPath();
    const stdin = Readable.from([VALID_KEY + '\n']);
    const stdout = new CaptureWritable();
    const code = await runAuthCli(['cursor', '--from-stdin'], {
      stdout,
      stderr: new CaptureWritable(),
      secretsPath: path,
      env: {},
      stdin,
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 0);
    const text = await readFile(path, 'utf8');
    assert.equal(text, `CURSOR_API_KEY=${VALID_KEY}\n`);
  });

  it('refuses to save when validation fails', async () => {
    const path = await withTempPath();
    const stderr = new CaptureWritable();
    const code = await runAuthCli(['cursor', '--from-env', 'CURSOR_API_KEY_BAD'], {
      stdout: new CaptureWritable(),
      stderr,
      secretsPath: path,
      env: { CURSOR_API_KEY_BAD: 'too short' },
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /refusing to save/);
  });

  it('rejects non-TTY interactive form without --from-env / --from-stdin', async () => {
    const path = await withTempPath();
    const stderr = new CaptureWritable();
    const stdout = new CaptureWritable();
    const code = await runAuthCli(['cursor'], {
      stdout,
      stderr,
      secretsPath: path,
      env: {},
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /TTY/);
  });
});

describe('authCli reserved providers', () => {
  it('exits 2 with a clear message for codex', async () => {
    const stderr = new CaptureWritable();
    const code = await runAuthCli(['codex', '--from-env'], {
      stdout: new CaptureWritable(),
      stderr,
      secretsPath: await withTempPath(),
      env: { OPENAI_API_KEY: 'value' },
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 2);
    assert.match(stderr.text(), /not yet supported/);
  });
});

describe('authCli unset', () => {
  it('removes the cursor key and prints a hint', async () => {
    const path = await withTempPath();
    await writeFile(path, '# header\nCURSOR_API_KEY=' + VALID_KEY + '\nA=alpha\n', { mode: 0o600 });
    const stdout = new CaptureWritable();
    const code = await runAuthCli(['unset', 'cursor'], {
      stdout,
      stderr: new CaptureWritable(),
      secretsPath: path,
      env: {},
      isDaemonRunning: async () => true,
    });
    assert.equal(code, 0);
    const text = await readFile(path, 'utf8');
    assert.equal(text, '# header\nA=alpha\n');
    const out = stdout.text();
    assert.match(out, /Removed CURSOR_API_KEY/);
    assert.match(out, /A running daemon is unchanged/);
  });

  it('reports already-absent state', async () => {
    const path = await withTempPath();
    await writeFile(path, '# header\nA=alpha\n', { mode: 0o600 });
    const stdout = new CaptureWritable();
    const code = await runAuthCli(['unset', 'cursor'], {
      stdout,
      stderr: new CaptureWritable(),
      secretsPath: path,
      env: {},
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 0);
    assert.match(stdout.text(), /was not present/);
  });

  it('rejects unknown providers', async () => {
    const stderr = new CaptureWritable();
    const code = await runAuthCli(['unset', 'nothing'], {
      stdout: new CaptureWritable(),
      stderr,
      secretsPath: await withTempPath(),
      env: {},
      isDaemonRunning: async () => false,
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /unknown provider/);
  });
});
