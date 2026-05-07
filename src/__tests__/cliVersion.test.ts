import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getPackageMetadata, getPackageVersion } from '../packageMetadata.js';
import { parseClaudeLauncherArgs, runClaudeLauncher } from '../claude/launcher.js';
import { parseOpenCodeLauncherArgs, runOpenCodeLauncher } from '../opencode/launcher.js';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(testDir, '..', 'cli.js');
const daemonCliPath = join(testDir, '..', 'daemonCli.js');
const claudeCliPath = join(testDir, '..', 'claudeCli.js');
const opencodeCliPath = join(testDir, '..', 'opencodeCli.js');

class CaptureStream {
  buffer = '';
  write(chunk: string | Uint8Array): boolean {
    this.buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }
}

describe('cli --version', () => {
  it('prints "agent-orchestrator <version>" for the main bin', async () => {
    const result = await execFileAsync(process.execPath, [cliPath, '--version'], { timeout: 5_000 });
    assert.equal(result.stdout, `agent-orchestrator ${getPackageVersion()}\n`);
    assert.equal(result.stderr, '');
  });

  it('prints "agent-orchestrator-daemon <version>" for the standalone daemon bin', async () => {
    const result = await execFileAsync(process.execPath, [daemonCliPath, '--version'], { timeout: 5_000 });
    assert.equal(result.stdout, `agent-orchestrator-daemon ${getPackageVersion()}\n`);
    assert.equal(result.stderr, '');
  });

  it('prints "agent-orchestrator-claude <version>" for the standalone claude bin', async () => {
    const result = await execFileAsync(process.execPath, [claudeCliPath, '--version'], { timeout: 5_000 });
    assert.equal(result.stdout, `agent-orchestrator-claude ${getPackageVersion()}\n`);
    assert.equal(result.stderr, '');
  });

  it('prints "agent-orchestrator-opencode <version>" for the standalone opencode bin', async () => {
    const result = await execFileAsync(process.execPath, [opencodeCliPath, '--version'], { timeout: 5_000 });
    assert.equal(result.stdout, `agent-orchestrator-opencode ${getPackageVersion()}\n`);
    assert.equal(result.stderr, '');
  });

  it('returns single-line JSON when --version --json is passed', async () => {
    const result = await execFileAsync(process.execPath, [cliPath, '--version', '--json'], { timeout: 5_000 });
    assert.equal(result.stdout.split('\n').filter((line) => line.length > 0).length, 1);
    const parsed = JSON.parse(result.stdout) as { name: string; version: string };
    const meta = getPackageMetadata();
    assert.equal(parsed.name, meta.name);
    assert.equal(parsed.version, meta.version);
  });

  it('returns single-line JSON for daemon --version --json', async () => {
    const result = await execFileAsync(process.execPath, [daemonCliPath, '--version', '--json'], { timeout: 5_000 });
    const parsed = JSON.parse(result.stdout) as { name: string; version: string };
    const meta = getPackageMetadata();
    assert.equal(parsed.name, meta.name);
    assert.equal(parsed.version, meta.version);
    assert.equal(result.stderr, '');
  });

  it('returns single-line JSON for claude --version --json', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exit = await runClaudeLauncher(['--version', '--json'], {
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      env: process.env,
    });
    const parsed = JSON.parse(stdout.buffer) as { name: string; version: string };
    const meta = getPackageMetadata();
    assert.equal(exit, 0);
    assert.equal(parsed.name, meta.name);
    assert.equal(parsed.version, meta.version);
    assert.equal(stderr.buffer, '');
  });

  it('returns single-line JSON for opencode --version --json', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exit = await runOpenCodeLauncher(['--version', '--json'], {
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      env: process.env,
    });
    const parsed = JSON.parse(stdout.buffer) as { name: string; version: string };
    const meta = getPackageMetadata();
    assert.equal(exit, 0);
    assert.equal(parsed.name, meta.name);
    assert.equal(parsed.version, meta.version);
    assert.equal(stderr.buffer, '');
  });

  it('routes "agent-orchestrator claude --version" through the launcher and prints the orchestrator version', async () => {
    const result = await execFileAsync(process.execPath, [cliPath, 'claude', '--version'], { timeout: 5_000 });
    assert.equal(result.stdout, `agent-orchestrator-claude ${getPackageVersion()}\n`);
    assert.equal(result.stderr, '');
  });

  it('routes "agent-orchestrator opencode --version" through the launcher and prints the orchestrator version', async () => {
    const result = await execFileAsync(process.execPath, [cliPath, 'opencode', '--version'], { timeout: 5_000 });
    assert.equal(result.stdout, `agent-orchestrator-opencode ${getPackageVersion()}\n`);
    assert.equal(result.stderr, '');
  });

  it('runClaudeLauncher returns 0 and prints version when --version is in own-args', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exit = await runClaudeLauncher(['--version'], {
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      env: process.env,
    });
    assert.equal(exit, 0);
    assert.equal(stdout.buffer, `agent-orchestrator-claude ${getPackageVersion()}\n`);
    assert.equal(stderr.buffer, '');
  });

  it('runOpenCodeLauncher returns 0 and prints version when --version is in own-args', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exit = await runOpenCodeLauncher(['--version'], {
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      env: process.env,
    });
    assert.equal(exit, 0);
    assert.equal(stdout.buffer, `agent-orchestrator-opencode ${getPackageVersion()}\n`);
    assert.equal(stderr.buffer, '');
  });

  it('does not intercept --version when it follows -- (claude passthrough)', () => {
    const result = parseClaudeLauncherArgs(['--', '--version'], {});
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.value.claudeArgs, ['--version']);
    }
  });

  it('does not intercept --version when it follows -- (opencode passthrough)', () => {
    const result = parseOpenCodeLauncherArgs(['--', '--version'], {});
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.value.opencodeArgs, ['--version']);
    }
  });

  it('does not intercept --version when it is not the first own-arg (claude)', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exit = await runClaudeLauncher(['--print-config', '--version'], {
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      env: process.env,
    });
    assert.notEqual(exit, 0);
    assert.equal(stdout.buffer, '');
    assert.match(stderr.buffer, /Unknown option: --version/);
  });

  it('does not intercept --version when it is not the first own-arg (opencode)', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exit = await runOpenCodeLauncher(['--print-config', '--version'], {
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      env: process.env,
    });
    assert.notEqual(exit, 0);
    assert.equal(stdout.buffer, '');
    assert.match(stderr.buffer, /Unknown option: --version/);
  });

  it('lists --version in the main bin help text', async () => {
    const result = await execFileAsync(process.execPath, [cliPath, '--help'], { timeout: 5_000 });
    assert.match(result.stdout, /agent-orchestrator --version/);
    assert.match(result.stdout, /agent-orchestrator-daemon --version/);
  });
});
