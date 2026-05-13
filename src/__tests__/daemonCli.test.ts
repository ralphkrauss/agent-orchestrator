import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { IpcServer } from '../ipc/server.js';
import { getPackageVersion } from '../packageMetadata.js';
import { daemonSpawnEnv } from '../daemon/spawnDaemon.js';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(testDir, '..', 'cli.js');
const daemonCliPath = join(testDir, '..', 'daemonCli.js');

describe('daemon CLI', () => {
  it('documents restart and dashboard commands in the top-level CLI help', async () => {
    const result = await execFileAsync(process.execPath, [cliPath, '--help'], { timeout: 5_000 });

    assert.match(result.stdout, /agent-orchestrator restart \[--force\]/);
    assert.match(result.stdout, /agent-orchestrator status --json/);
    assert.match(result.stdout, /agent-orchestrator runs \[--json\] \[--prompts\]/);
    assert.match(result.stdout, /agent-orchestrator watch \[--interval-ms <ms>\] \[--limit <n>\]/);
    assert.match(result.stdout, /agent-orchestrator-daemon restart \[--force\]/);
    assert.match(result.stdout, /agent-orchestrator-daemon status --json/);
    assert.match(result.stdout, /agent-orchestrator-daemon runs \[--json\] \[--prompts\]/);
    assert.match(result.stdout, /agent-orchestrator-daemon watch \[--interval-ms <ms>\] \[--limit <n>\]/);
  });

  it('prints daemon help successfully for packed-bin smoke tests', async () => {
    const result = await execFileAsync(process.execPath, [daemonCliPath, '--help'], { timeout: 5_000 });

    assert.match(result.stdout, /agent-orchestrator-daemon start/);
    assert.equal(result.stderr, '');
  });

  it('sanitizes supervisor-specific environment when spawning the daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-daemon-env-'));
    const storeRoot = join(root, '.agent-orchestrator');
    const supervisorHome = join(root, '.agent-orchestrator', 'claude-supervisor', 'home');

    try {
      const env = daemonSpawnEnv(storeRoot, {
        HOME: supervisorHome,
        PWD: '/tmp/supervisor-worktree',
        INIT_CWD: '/tmp/supervisor-init',
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDECODE: '1',
        CLAUDE_PROJECT_DIR: '/tmp/project',
      });

      assert.equal(env.AGENT_ORCHESTRATOR_HOME, storeRoot);
      assert.equal(env.HOME, root);
      assert.equal(env.PWD, undefined);
      assert.equal(env.INIT_CWD, undefined);
      assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
      assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
      assert.equal(env.CLAUDECODE, undefined);
      assert.equal(env.CLAUDE_PROJECT_DIR, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prints both prune command forms when the required age is missing', async () => {
    await assertPruneMissingAgeUsage(cliPath);
    await assertPruneMissingAgeUsage(daemonCliPath);
  });

  it('exposes the canonical main CLI and standalone daemon bins', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      bin?: Record<string, string>;
    };

    assert.deepStrictEqual(packageJson.bin, {
      'agent-orchestrator': 'dist/cli.js',
      'agent-orchestrator-daemon': 'dist/daemonCli.js',
      'agent-orchestrator-opencode': 'dist/opencodeCli.js',
      'agent-orchestrator-claude': 'dist/claudeCli.js',
    });
  });

  it('controls the daemon through the top-level CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-main-cli-'));
    const home = join(root, 'home');
    const env = { ...process.env, AGENT_ORCHESTRATOR_HOME: home };

    try {
      const restart = await execFileAsync(process.execPath, [cliPath, 'restart'], { env, timeout: 10_000 });
      assert.match(restart.stdout, new RegExp(`agent-orchestrator daemon is stopped store=${escapeRegExp(home)}`));
      assert.match(restart.stdout, new RegExp(`agent-orchestrator daemon started pid=(?:\\d+|unknown) store=${escapeRegExp(home)}`));

      const status = await execFileAsync(process.execPath, [cliPath, 'status'], { env, timeout: 10_000 });
      assert.match(status.stdout, new RegExp(`running pid=\\d+ store=${escapeRegExp(home)}`));
      assert.match(status.stdout, /version_match=true/);

      const jsonStatus = await execFileAsync(process.execPath, [cliPath, 'status', '--json'], { env, timeout: 10_000 });
      const envelope = JSON.parse(jsonStatus.stdout) as {
        running?: boolean;
        snapshot?: { daemon_pid?: number | null };
      };
      assert.equal(envelope.running, true);
      assert.equal(typeof envelope.snapshot?.daemon_pid, 'number');
    } finally {
      await execFileAsync(process.execPath, [cliPath, 'stop', '--force'], { env, timeout: 10_000 }).catch(() => undefined);
      await waitForStopped(env);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restarts a stopped daemon and reports matching versions in status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-daemon-cli-'));
    const home = join(root, 'home');
    const env = { ...process.env, AGENT_ORCHESTRATOR_HOME: home };

    try {
      const restart = await execFileAsync(process.execPath, [daemonCliPath, 'restart'], { env, timeout: 10_000 });
      assert.match(restart.stdout, new RegExp(`agent-orchestrator daemon is stopped store=${escapeRegExp(home)}`));
      assert.match(restart.stdout, new RegExp(`agent-orchestrator daemon started pid=(?:\\d+|unknown) store=${escapeRegExp(home)}`));

      const status = await execFileAsync(process.execPath, [daemonCliPath, 'status'], { env, timeout: 10_000 });
      assert.match(status.stdout, new RegExp(`running pid=\\d+ store=${escapeRegExp(home)}`));
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
    let snapshotRequests = 0;

    try {
      await mkdir(home);
      staleServer = new IpcServer(socket, async (method) => {
        if (method === 'ping') {
          return { ok: true, pong: true, daemon_pid: process.pid, daemon_version: '0.0.0-stale' };
        }
        if (method === 'get_observability_snapshot') {
          snapshotRequests += 1;
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
      assert.match(staleStatus.stdout, new RegExp(`running pid=\\d+ store=${escapeRegExp(home)}`));
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
      assert.equal(snapshotRequests, 0);

      const restart = await execFileAsync(process.execPath, [daemonCliPath, 'restart'], { env, timeout: 10_000 });
      assert.match(restart.stdout, new RegExp(`agent-orchestrator daemon stopping store=${escapeRegExp(home)}`));
      assert.match(restart.stdout, new RegExp(`agent-orchestrator daemon started pid=(?:\\d+|unknown) store=${escapeRegExp(home)}`));

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

  it('watch merges live orchestrators through lightweight daemon IPC without rich snapshot polling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-daemon-watch-live-'));
    const home = join(root, 'home');
    const socket = join(home, 'daemon.sock');
    const env = { ...process.env, AGENT_ORCHESTRATOR_HOME: home };
    let server: IpcServer | null = null;
    let richSnapshotRequests = 0;
    let liveRequests = 0;

    try {
      await mkdir(home);
      server = new IpcServer(socket, async (method) => {
        if (method === 'ping') {
          return { ok: true, pong: true, daemon_pid: process.pid, daemon_version: getPackageVersion() };
        }
        if (method === 'get_live_orchestrators') {
          liveRequests += 1;
          return {
            ok: true,
            live_orchestrators: [{
              record: {
                id: '01WATCHLIVEORCH0000000000A',
                client: 'claude',
                label: 'Live watch session',
                cwd: '/tmp/watch-live',
                display: { tmux_pane: '%1', tmux_window_id: '@1', base_title: 'Live watch session', host: 'host' },
                registered_at: '2026-05-13T00:00:00.000Z',
                last_supervisor_event_at: '2026-05-13T00:00:01.000Z',
              },
              status: {
                state: 'waiting_for_user',
                supervisor_turn_active: false,
                waiting_for_user: true,
                running_child_count: 0,
                failed_unacked_count: 0,
              },
            }],
          };
        }
        if (method === 'get_observability_snapshot') {
          richSnapshotRequests += 1;
        }
        return { ok: true };
      }, getPackageVersion());
      await server.listen();

      const watch = await execFileAsync(process.execPath, [daemonCliPath, 'watch'], { env, timeout: 10_000 });

      assert.match(watch.stdout, /agent-orchestrator daemon: running pid=/);
      assert.match(watch.stdout, /live_orchestrators: 1 archived_orchestrators: 0/);
      assert.match(watch.stdout, /Live watch session \[waiting_for_user\]/);
      assert.equal(liveRequests, 1);
      assert.equal(richSnapshotRequests, 0);
    } finally {
      await server?.close().catch(() => undefined);
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

async function assertPruneMissingAgeUsage(entrypoint: string): Promise<void> {
  await assert.rejects(
    execFileAsync(process.execPath, [entrypoint, 'prune'], { timeout: 5_000 }),
    (error: unknown) => {
      const result = error as { code?: number; stdout?: string; stderr?: string };
      assert.equal(result.code, 1);
      assert.equal(result.stdout ?? '', '');
      assert.match(result.stderr ?? '', /Usage: agent-orchestrator prune --older-than-days <days> \[--dry-run\]/);
      assert.match(result.stderr ?? '', /or: agent-orchestrator-daemon prune --older-than-days <days> \[--dry-run\]/);
      return true;
    },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
