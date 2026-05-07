import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_WORKER_SETTINGS_BODY,
  CLAUDE_WORKER_SETTINGS_FILENAME,
  ClaudeBackend,
} from '../backend/claude.js';
import { RunStore } from '../runStore.js';

describe('Claude worker isolation (issue #40, T5 / Decision 9)', () => {
  it('start emits --settings <per-run-path>, --setting-sources user, --permission-mode bypassPermissions, and writes the bypass+disableAllHooks settings on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-iso-'));
    try {
      const store = new RunStore(root);
      await store.ensureReady();
      const meta = await store.createRun({ backend: 'claude', cwd: root, prompt: 'hi' });
      const backend = new ClaudeBackend(store);
      const invocation = await backend.start({
        runId: meta.run_id,
        cwd: root,
        prompt: 'hi',
        modelSettings: { reasoning_effort: null, service_tier: null, mode: null, codex_network: null },
      });
      const settingsIndex = invocation.args.findIndex((arg) => arg === '--settings');
      assert.ok(settingsIndex >= 0, 'invocation must include --settings');
      const settingsPath = invocation.args[settingsIndex + 1];
      assert.ok(settingsPath, '--settings must be followed by an absolute path');
      assert.equal(settingsPath, join(store.runDir(meta.run_id), CLAUDE_WORKER_SETTINGS_FILENAME));
      assert.ok(invocation.args.includes('--setting-sources'));
      const sourcesIndex = invocation.args.findIndex((arg) => arg === '--setting-sources');
      assert.equal(invocation.args[sourcesIndex + 1], 'user');

      const permissionModeIndex = invocation.args.findIndex((arg) => arg === '--permission-mode');
      assert.ok(permissionModeIndex >= 0, 'invocation must include --permission-mode');
      assert.equal(invocation.args[permissionModeIndex + 1], 'bypassPermissions');
      assert.ok(
        permissionModeIndex > sourcesIndex,
        '--permission-mode should be adjacent to or after --setting-sources user (supervisor parity)',
      );
      assert.ok(
        !invocation.args.includes('--dangerously-skip-permissions'),
        '--dangerously-skip-permissions is banned per issue #13 Decisions 7 / 21',
      );

      const onDisk = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
      assert.deepStrictEqual(onDisk, CLAUDE_WORKER_SETTINGS_BODY);
      assert.equal(onDisk.disableAllHooks, true, 'worker isolation requires disableAllHooks');
      const permissions = onDisk.permissions as Record<string, unknown> | undefined;
      assert.equal(permissions?.defaultMode, 'bypassPermissions', 'on-disk permissions.defaultMode must be bypassPermissions');
      assert.equal(onDisk.skipDangerousModePermissionPrompt, true, 'on-disk skipDangerousModePermissionPrompt must be true');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resume emits the same isolation flags and writes the same per-run settings on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-iso-'));
    try {
      const store = new RunStore(root);
      await store.ensureReady();
      const meta = await store.createRun({ backend: 'claude', cwd: root, prompt: 'hi' });
      const backend = new ClaudeBackend(store);
      const invocation = await backend.resume('session-123', {
        runId: meta.run_id,
        cwd: root,
        prompt: 'continue',
        modelSettings: { reasoning_effort: null, service_tier: null, mode: null, codex_network: null },
      });
      assert.ok(invocation.args.includes('--settings'));
      assert.ok(invocation.args.includes('--setting-sources'));
      assert.ok(invocation.args.includes('--resume'));

      const sourcesIndex = invocation.args.findIndex((arg) => arg === '--setting-sources');
      assert.equal(invocation.args[sourcesIndex + 1], 'user');
      const permissionModeIndex = invocation.args.findIndex((arg) => arg === '--permission-mode');
      assert.ok(permissionModeIndex >= 0, 'resume invocation must include --permission-mode');
      assert.equal(invocation.args[permissionModeIndex + 1], 'bypassPermissions');
      assert.ok(
        permissionModeIndex > sourcesIndex,
        '--permission-mode should be adjacent to or after --setting-sources user',
      );
      assert.ok(
        !invocation.args.includes('--dangerously-skip-permissions'),
        '--dangerously-skip-permissions is banned per issue #13 Decisions 7 / 21',
      );

      const settingsIndex = invocation.args.findIndex((arg) => arg === '--settings');
      const settingsPath = invocation.args[settingsIndex + 1]!;
      assert.equal(settingsPath, join(store.runDir(meta.run_id), CLAUDE_WORKER_SETTINGS_FILENAME));
      const onDisk = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
      assert.equal(onDisk.disableAllHooks, true, 'resume must still pin disableAllHooks');
      const permissions = onDisk.permissions as Record<string, unknown> | undefined;
      assert.equal(permissions?.defaultMode, 'bypassPermissions', 'resume on-disk permissions.defaultMode must be bypassPermissions');
      assert.equal(onDisk.skipDangerousModePermissionPrompt, true, 'resume on-disk skipDangerousModePermissionPrompt must be true');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('omits worker isolation flags when no run id is supplied (legacy / direct caller)', async () => {
    const backend = new ClaudeBackend();
    const invocation = await backend.start({
      cwd: '/tmp',
      prompt: 'hi',
      modelSettings: { reasoning_effort: null, service_tier: null, mode: null, codex_network: null },
    });
    assert.ok(!invocation.args.includes('--settings'));
    assert.ok(!invocation.args.includes('--setting-sources'));
    assert.ok(!invocation.args.includes('--permission-mode'));
  });

  it('with a representative user ~/.claude/settings.json hook present, the worker invocation still pins disableAllHooks:true and --setting-sources user (T5 / D9 isolation contract)', async () => {
    // Argv-level isolation proof: even with a representative user-side hook
    // configured under HOME/.claude/settings.json, the Claude worker
    // invocation references a per-run settings file containing
    // {disableAllHooks: true} and forces --setting-sources user. Per Claude
    // Code semantics, this combination prevents inherited user hooks from
    // firing during a worker run.
    //
    // TODO(t13b): when/if the Anthropic-credentialed live smoke is enabled,
    // extend this to launch a real claude --print process against the temp
    // HOME and assert no hook side effects (e.g. no marker file written).
    // Today the wire-contract assertion is what we ship; the live proof is
    // gated behind AGENT_ORCHESTRATOR_RC_LIVE_SMOKE.
    const root = await mkdtemp(join(tmpdir(), 'claude-iso-userhook-'));
    try {
      const homeClaudeDir = join(root, 'home', '.claude');
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(homeClaudeDir, { recursive: true, mode: 0o700 });
      // Representative user-side hook fixture. If this hook were to fire
      // it would touch a sentinel file; the wire contract guarantees it
      // won't because Claude Code respects disableAllHooks:true.
      const sentinel = join(root, 'user-hook-fired.sentinel');
      const userHookSettings = {
        hooks: {
          UserPromptSubmit: [{
            hooks: [{ type: 'command', command: `touch ${JSON.stringify(sentinel).slice(1, -1)}` }],
          }],
          Stop: [{
            hooks: [{ type: 'command', command: `touch ${JSON.stringify(sentinel).slice(1, -1)}` }],
          }],
        },
      };
      await writeFile(join(homeClaudeDir, 'settings.json'), `${JSON.stringify(userHookSettings, null, 2)}\n`, { mode: 0o600 });

      const store = new RunStore(join(root, 'store'));
      await store.ensureReady();
      const meta = await store.createRun({ backend: 'claude', cwd: root, prompt: 'do work' });
      const backend = new ClaudeBackend(store);
      const invocation = await backend.start({
        runId: meta.run_id,
        cwd: root,
        prompt: 'do work',
        modelSettings: { reasoning_effort: null, service_tier: null, mode: null, codex_network: null },
      });

      // 1. The worker invocation pins a per-run settings file...
      const settingsIdx = invocation.args.indexOf('--settings');
      assert.ok(settingsIdx >= 0, 'worker must pass --settings');
      const settingsPath = invocation.args[settingsIdx + 1]!;
      assert.equal(settingsPath, join(store.runDir(meta.run_id), CLAUDE_WORKER_SETTINGS_FILENAME));
      // ...whose contents include disableAllHooks: true plus the worker
      // permission posture (bypassPermissions + skipDangerousModePermissionPrompt).
      const onDisk = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
      assert.deepStrictEqual(onDisk, CLAUDE_WORKER_SETTINGS_BODY);
      assert.equal(onDisk.disableAllHooks, true);
      const permissions = onDisk.permissions as Record<string, unknown> | undefined;
      assert.equal(permissions?.defaultMode, 'bypassPermissions');
      assert.equal(onDisk.skipDangerousModePermissionPrompt, true);

      // 2. --setting-sources user forces Claude to read only user-tier
      // settings (combined with the harness-supplied --settings file). With
      // disableAllHooks:true the user-side hooks above will not fire.
      const sourcesIdx = invocation.args.indexOf('--setting-sources');
      assert.ok(sourcesIdx >= 0, 'worker must pass --setting-sources');
      assert.equal(invocation.args[sourcesIdx + 1], 'user');

      // 3. Sanity: the sentinel is NOT created by argv builder paths (this
      // catches a regression where someone wires the argv to actually exec
      // a hook script during invocation building).
      const { stat } = await import('node:fs/promises');
      let sentinelExists = false;
      try {
        await stat(sentinel);
        sentinelExists = true;
      } catch {
        sentinelExists = false;
      }
      assert.equal(sentinelExists, false, 'argv builder must not execute user hooks');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
