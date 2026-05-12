import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_TRUSTED_WORKER_SETTINGS_BODY,
  CLAUDE_WORKER_SETTINGS_BODY,
  CLAUDE_WORKER_SETTINGS_FILENAME,
  ClaudeBackend,
} from '../backend/claude.js';
import { RunStore } from '../runStore.js';
import type { WorkerPosture } from '../contract.js';

type ModelSettingsInput = {
  reasoning_effort: null;
  service_tier: null;
  mode: null;
  codex_network: null;
  worker_posture: WorkerPosture | null;
};

function modelSettings(worker_posture: WorkerPosture | null): ModelSettingsInput {
  return { reasoning_effort: null, service_tier: null, mode: null, codex_network: null, worker_posture };
}

describe('Claude worker isolation — restricted posture (issue #40 T5/D9; issue #47; issue #58 Decision 8 — preserved verbatim)', () => {
  it('start under restricted posture emits --setting-sources user and writes the v1 worker settings body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-iso-restricted-'));
    try {
      const store = new RunStore(root);
      await store.ensureReady();
      const meta = await store.createRun({ backend: 'claude', cwd: root, prompt: 'hi' });
      const backend = new ClaudeBackend(store);
      const invocation = await backend.start({
        runId: meta.run_id,
        cwd: root,
        prompt: 'hi',
        modelSettings: modelSettings('restricted'),
      });

      const sourcesIndex = invocation.args.findIndex((arg) => arg === '--setting-sources');
      assert.ok(sourcesIndex >= 0, 'invocation must include --setting-sources');
      assert.equal(invocation.args[sourcesIndex + 1], 'user');

      const settingsIndex = invocation.args.findIndex((arg) => arg === '--settings');
      const settingsPath = invocation.args[settingsIndex + 1]!;
      assert.equal(settingsPath, join(store.runDir(meta.run_id), CLAUDE_WORKER_SETTINGS_FILENAME));

      const permissionModeIndex = invocation.args.findIndex((arg) => arg === '--permission-mode');
      assert.equal(invocation.args[permissionModeIndex + 1], 'bypassPermissions');
      assert.ok(permissionModeIndex > sourcesIndex, '--permission-mode follows --setting-sources');
      assert.ok(!invocation.args.includes('--dangerously-skip-permissions'), '#13 D7/D21: dangerously-skip-permissions banned');

      const onDisk = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
      assert.deepStrictEqual(onDisk, CLAUDE_WORKER_SETTINGS_BODY);
      assert.equal('enableAllProjectMcpServers' in onDisk, false, 'restricted posture must NOT add enableAllProjectMcpServers');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resume under restricted posture emits the same isolation flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-iso-restricted-resume-'));
    try {
      const store = new RunStore(root);
      await store.ensureReady();
      const meta = await store.createRun({ backend: 'claude', cwd: root, prompt: 'hi' });
      const backend = new ClaudeBackend(store);
      const invocation = await backend.resume('session-123', {
        runId: meta.run_id,
        cwd: root,
        prompt: 'continue',
        modelSettings: modelSettings('restricted'),
      });
      assert.ok(invocation.args.includes('--resume'));
      const sourcesIndex = invocation.args.findIndex((arg) => arg === '--setting-sources');
      assert.equal(invocation.args[sourcesIndex + 1], 'user');
      const permissionModeIndex = invocation.args.findIndex((arg) => arg === '--permission-mode');
      assert.equal(invocation.args[permissionModeIndex + 1], 'bypassPermissions');
      const settingsPath = invocation.args[invocation.args.indexOf('--settings') + 1]!;
      const onDisk = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
      assert.deepStrictEqual(onDisk, CLAUDE_WORKER_SETTINGS_BODY);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('omits worker isolation flags when no run id is supplied (legacy / direct caller)', async () => {
    const backend = new ClaudeBackend();
    const invocation = await backend.start({
      cwd: '/tmp',
      prompt: 'hi',
      modelSettings: modelSettings('restricted'),
    });
    assert.ok(!invocation.args.includes('--settings'));
    assert.ok(!invocation.args.includes('--setting-sources'));
    assert.ok(!invocation.args.includes('--permission-mode'));
    assert.equal(invocation.initialEvents, undefined, 'legacy/no-runId path must not emit lifecycle events');
  });
});

describe('Claude worker isolation — trusted posture (issue #58)', () => {
  it('start under trusted posture emits --setting-sources user,project,local and writes the trusted body with enableAllProjectMcpServers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-iso-trusted-'));
    try {
      const store = new RunStore(root);
      await store.ensureReady();
      const meta = await store.createRun({ backend: 'claude', cwd: root, prompt: 'hi' });
      const backend = new ClaudeBackend(store);
      const invocation = await backend.start({
        runId: meta.run_id,
        cwd: root,
        prompt: 'hi',
        modelSettings: modelSettings('trusted'),
      });

      const sourcesIndex = invocation.args.findIndex((arg) => arg === '--setting-sources');
      assert.equal(invocation.args[sourcesIndex + 1], 'user,project,local', 'trusted must broaden setting-sources');

      const settingsPath = invocation.args[invocation.args.indexOf('--settings') + 1]!;
      const onDisk = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
      assert.deepStrictEqual(onDisk, CLAUDE_TRUSTED_WORKER_SETTINGS_BODY);
      assert.equal(onDisk.enableAllProjectMcpServers, true, 'trusted body must auto-approve project MCP servers');
      assert.equal(onDisk.disableAllHooks, true, 'trusted MUST still pin disableAllHooks (T5/T13)');
      const permissions = onDisk.permissions as Record<string, unknown> | undefined;
      assert.equal(permissions?.defaultMode, 'bypassPermissions', 'trusted MUST still pin bypassPermissions (#47)');
      assert.equal(onDisk.skipDangerousModePermissionPrompt, true);

      const permissionModeIndex = invocation.args.findIndex((arg) => arg === '--permission-mode');
      assert.equal(invocation.args[permissionModeIndex + 1], 'bypassPermissions', 'CLI permission-mode overrides any project settings.json value');
      assert.ok(!invocation.args.includes('--dangerously-skip-permissions'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resume under trusted posture emits the same isolation flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-iso-trusted-resume-'));
    try {
      const store = new RunStore(root);
      await store.ensureReady();
      const meta = await store.createRun({ backend: 'claude', cwd: root, prompt: 'hi' });
      const backend = new ClaudeBackend(store);
      const invocation = await backend.resume('session-456', {
        runId: meta.run_id,
        cwd: root,
        prompt: 'continue',
        modelSettings: modelSettings('trusted'),
      });

      const sourcesIndex = invocation.args.findIndex((arg) => arg === '--setting-sources');
      assert.equal(invocation.args[sourcesIndex + 1], 'user,project,local');
      const settingsPath = invocation.args[invocation.args.indexOf('--settings') + 1]!;
      const onDisk = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
      assert.deepStrictEqual(onDisk, CLAUDE_TRUSTED_WORKER_SETTINGS_BODY);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('legacy model_settings with worker_posture: null defaults to trusted', async () => {
    // T-Profile-2: a pre-#58 run record (worker_posture omitted / null)
    // resolves to the new product default 'trusted'.
    const root = await mkdtemp(join(tmpdir(), 'claude-iso-legacy-'));
    try {
      const store = new RunStore(root);
      await store.ensureReady();
      const meta = await store.createRun({ backend: 'claude', cwd: root, prompt: 'hi' });
      const backend = new ClaudeBackend(store);
      const invocation = await backend.start({
        runId: meta.run_id,
        cwd: root,
        prompt: 'hi',
        modelSettings: modelSettings(null),
      });
      const sourcesIndex = invocation.args.findIndex((arg) => arg === '--setting-sources');
      assert.equal(invocation.args[sourcesIndex + 1], 'user,project,local', 'legacy null posture resolves to trusted at the backend');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Claude worker isolation — telemetry (issue #58 Decision 11)', () => {
  it('start populates WorkerInvocation.initialEvents with a worker_posture lifecycle event under trusted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-iso-telemetry-trusted-'));
    try {
      const store = new RunStore(root);
      await store.ensureReady();
      const meta = await store.createRun({ backend: 'claude', cwd: root, prompt: 'hi' });
      const backend = new ClaudeBackend(store);
      const invocation = await backend.start({
        runId: meta.run_id,
        cwd: root,
        prompt: 'hi',
        modelSettings: modelSettings('trusted'),
      });

      assert.ok(invocation.initialEvents, 'initialEvents must be populated');
      assert.equal(invocation.initialEvents!.length, 1, 'exactly one lifecycle event per spawn');
      const event = invocation.initialEvents![0]!;
      assert.equal(event.type, 'lifecycle');
      const payload = event.payload as Record<string, unknown>;
      assert.equal(payload.state, 'worker_posture');
      assert.equal(payload.backend, 'claude');
      assert.equal(payload.worker_posture, 'trusted');
      const claude = payload.claude as Record<string, unknown>;
      assert.equal(claude.setting_sources, 'user,project,local');
      assert.equal(claude.enable_all_project_mcp_servers, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('start populates initialEvents under restricted with the closed-posture payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-iso-telemetry-restricted-'));
    try {
      const store = new RunStore(root);
      await store.ensureReady();
      const meta = await store.createRun({ backend: 'claude', cwd: root, prompt: 'hi' });
      const backend = new ClaudeBackend(store);
      const invocation = await backend.start({
        runId: meta.run_id,
        cwd: root,
        prompt: 'hi',
        modelSettings: modelSettings('restricted'),
      });

      assert.ok(invocation.initialEvents);
      const payload = invocation.initialEvents![0]!.payload as Record<string, unknown>;
      assert.equal(payload.worker_posture, 'restricted');
      const claude = payload.claude as Record<string, unknown>;
      assert.equal(claude.setting_sources, 'user');
      assert.equal(claude.enable_all_project_mcp_servers, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Claude worker isolation — hostile project fixture (issue #58 T-Claude-3)', () => {
  it('a project .claude/settings.json that tries to enable hooks and set permissionMode: "ask" cannot break trusted-worker safety contracts', async () => {
    // Regression test for the review rev. 1 Medium 1 / High 1 finding: under
    // `--setting-sources user,project,local`, a project `.claude/settings.json`
    // that re-enables hooks or sets a stricter permission mode must not
    // affect the worker, because the per-run `--settings <path>` body and
    // the CLI `--permission-mode bypassPermissions` flag take precedence.
    const root = await mkdtemp(join(tmpdir(), 'claude-iso-hostile-'));
    try {
      const cwd = join(root, 'project');
      await mkdir(cwd, { recursive: true });
      // Project-scoped `.mcp.json` so the broadened setting-sources finds
      // something to load.
      await writeFile(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
      // Hostile project `.claude/settings.json` — tries to re-enable hooks
      // and downgrade the permission mode.
      const projectClaude = join(cwd, '.claude');
      await mkdir(projectClaude, { recursive: true });
      const sentinel = join(root, 'hook-should-not-fire.sentinel');
      const hostileSettings = {
        disableAllHooks: false,
        permissions: { defaultMode: 'ask' },
        hooks: {
          PreToolUse: [{
            hooks: [{ type: 'command', command: `touch ${JSON.stringify(sentinel).slice(1, -1)}` }],
          }],
        },
      };
      await writeFile(join(projectClaude, 'settings.json'), JSON.stringify(hostileSettings, null, 2));

      const store = new RunStore(join(root, 'store'));
      await store.ensureReady();
      const meta = await store.createRun({ backend: 'claude', cwd, prompt: 'do work' });
      const backend = new ClaudeBackend(store);
      const invocation = await backend.start({
        runId: meta.run_id,
        cwd,
        prompt: 'do work',
        modelSettings: modelSettings('trusted'),
      });

      // 1. Per-run settings file still equals the trusted body — project
      // settings.json cannot override what we write.
      const settingsPath = invocation.args[invocation.args.indexOf('--settings') + 1]!;
      const onDisk = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
      assert.deepStrictEqual(onDisk, CLAUDE_TRUSTED_WORKER_SETTINGS_BODY);
      assert.equal(onDisk.disableAllHooks, true, 'trusted body pins disableAllHooks regardless of project settings');
      assert.equal(onDisk.enableAllProjectMcpServers, true);

      // 2. CLI --permission-mode bypassPermissions is emitted — survives
      // any project-level permissionMode override.
      const permissionModeIndex = invocation.args.findIndex((arg) => arg === '--permission-mode');
      assert.ok(permissionModeIndex >= 0);
      assert.equal(invocation.args[permissionModeIndex + 1], 'bypassPermissions');

      // 3. setting-sources is broadened — workers see project sources but
      // the per-run --settings + --permission-mode pair pins safety contracts.
      const sourcesIndex = invocation.args.findIndex((arg) => arg === '--setting-sources');
      assert.equal(invocation.args[sourcesIndex + 1], 'user,project,local');

      // 4. Sanity: the sentinel hook was not executed by the argv builder.
      const { stat } = await import('node:fs/promises');
      let sentinelExists = false;
      try {
        await stat(sentinel);
        sentinelExists = true;
      } catch {
        sentinelExists = false;
      }
      assert.equal(sentinelExists, false, 'argv builder must not execute user/project hooks');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
