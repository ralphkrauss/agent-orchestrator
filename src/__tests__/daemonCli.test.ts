import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { IpcServer } from '../ipc/server.js';
import { getPackageVersion } from '../packageMetadata.js';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(testDir, '..', 'cli.js');
const daemonCliPath = join(testDir, '..', 'daemonCli.js');

describe('daemon CLI', () => {
  it('documents restart and dashboard commands in the top-level CLI help', async () => {
    const result = await execFileAsync(process.execPath, [cliPath, '--help'], { timeout: 5_000 });

    assert.match(result.stdout, /agent-orchestrator-mcp-daemon restart \[--force\]/);
    assert.match(result.stdout, /agent-orchestrator-mcp-daemon status --json/);
    assert.match(result.stdout, /agent-orchestrator-mcp-daemon runs \[--json\] \[--prompts\]/);
    assert.match(result.stdout, /agent-orchestrator-mcp-daemon watch \[--interval-ms <ms>\] \[--limit <n>\]/);
  });

  it('restarts a stopped daemon and reports matching versions in status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-daemon-cli-'));
    const home = join(root, 'home');
    const env = { ...process.env, AGENT_ORCHESTRATOR_HOME: home };

    try {
      const restart = await execFileAsync(process.execPath, [daemonCliPath, 'restart'], { env, timeout: 10_000 });
      assert.match(restart.stdout, /agent-orchestrator daemon is stopped/);
      assert.match(restart.stdout, /agent-orchestrator daemon started pid=/);

      const status = await execFileAsync(process.execPath, [daemonCliPath, 'status'], { env, timeout: 10_000 });
      assert.match(status.stdout, /running pid=/);
      assert.match(status.stdout, new RegExp(`daemon_version=${escapeRegExp(getPackageVersion())}`));
      assert.match(status.stdout, new RegExp(`frontend_version=${escapeRegExp(getPackageVersion())}`));
      assert.match(status.stdout, /version_match=true/);
    } finally {
      await execFileAsync(process.execPath, [daemonCliPath, 'stop', '--force'], { env, timeout: 10_000 }).catch(() => undefined);
      await waitForStopped(env);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restarts a stale daemon with a mismatched package version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-daemon-cli-'));
    const home = join(root, 'home');
    const socket = join(home, 'daemon.sock');
    const env = { ...process.env, AGENT_ORCHESTRATOR_HOME: home };
    let staleServer: IpcServer | null = null;

    try {
      await mkdir(home);
      staleServer = new IpcServer(socket, async (method) => {
        if (method === 'ping') {
          return { ok: true, pong: true, daemon_pid: process.pid, daemon_version: '0.0.0-stale' };
        }
        if (method === 'shutdown') {
          setImmediate(() => {
            void staleServer?.close();
            staleServer = null;
          });
          return { ok: true, accepted: true };
        }
        return { ok: true, runs: [] };
      }, '0.0.0-stale');
      await staleServer.listen();

      const staleStatus = await execFileAsync(process.execPath, [daemonCliPath, 'status'], { env, timeout: 10_000 });
      assert.match(staleStatus.stdout, /daemon_version=0\.0\.0-stale/);
      assert.match(staleStatus.stdout, /version_match=false/);
      assert.match(staleStatus.stdout, /runs=unavailable/);

      const staleRuns = await execFileAsync(process.execPath, [daemonCliPath, 'runs'], { env, timeout: 10_000 });
      assert.match(staleRuns.stdout, /agent-orchestrator daemon: running pid=/);
      assert.match(staleRuns.stdout, /error: Frontend package version .* does not match daemon package version 0\.0\.0-stale/);
      assert.match(staleRuns.stdout, /sessions: 0 runs: 0/);

      const staleVerboseStatus = await execFileAsync(process.execPath, [daemonCliPath, 'status', '--verbose'], { env, timeout: 10_000 });
      assert.match(staleVerboseStatus.stdout, /agent-orchestrator daemon: running pid=/);
      assert.match(staleVerboseStatus.stdout, /error: Frontend package version .* does not match daemon package version 0\.0\.0-stale/);

      const staleWatch = await execFileAsync(process.execPath, [daemonCliPath, 'watch'], { env, timeout: 10_000 });
      assert.match(staleWatch.stdout, /agent-orchestrator daemon: running pid=/);
      assert.match(staleWatch.stdout, /error: Frontend package version .* does not match daemon package version 0\.0\.0-stale/);
      assert.match(staleWatch.stdout, /sessions: 0 runs: 0/);

      const restart = await execFileAsync(process.execPath, [daemonCliPath, 'restart'], { env, timeout: 10_000 });
      assert.match(restart.stdout, /agent-orchestrator daemon stopping/);
      assert.match(restart.stdout, /agent-orchestrator daemon started pid=/);

      const currentStatus = await execFileAsync(process.execPath, [daemonCliPath, 'status'], { env, timeout: 10_000 });
      assert.match(currentStatus.stdout, new RegExp(`daemon_version=${escapeRegExp(getPackageVersion())}`));
      assert.match(currentStatus.stdout, /version_match=true/);
    } finally {
      await staleServer?.close().catch(() => undefined);
      await execFileAsync(process.execPath, [daemonCliPath, 'stop', '--force'], { env, timeout: 10_000 }).catch(() => undefined);
      await waitForStopped(env);
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitForStopped(env: NodeJS.ProcessEnv): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await execFileAsync(process.execPath, [daemonCliPath, 'status'], { env, timeout: 2_000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      return;
    }
  }
  throw new Error('daemon did not stop before timeout');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
