import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeBackend } from '../backend/claude.js';
import { CodexBackend } from '../backend/codex.js';
import { resolveBinary } from '../backend/common.js';

describe('backend invocations', () => {
  it('resolves Windows PATHEXT command shims from PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-backend-bin-'));
    const missing = join(root, 'missing');
    const bin = join(root, 'bin');
    const command = join(bin, 'codex.CMD');
    await mkdir(bin);
    await writeFile(command, '@echo off\r\n');
    await chmod(command, 0o755);

    assert.equal(
      await resolveBinary('codex', 'win32', { PATH: `${missing};${bin}`, PATHEXT: '.EXE;.CMD' }),
      command,
    );
  });

  it('restricted posture: codex_network drives sandbox argv (issue #31 contract preserved)', async () => {
    const backend = new CodexBackend();

    // codex_network='user-config' must NOT add --ignore-user-config.
    assert.deepStrictEqual(
      (await backend.start({
        prompt: 'work',
        cwd: '/repo',
        model: 'gpt-5.2',
        modelSettings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: 'normal', codex_network: 'user-config', worker_posture: 'restricted' },
      })).args,
      ['exec', '--json', '--skip-git-repo-check', '--cd', '/repo', '--model', 'gpt-5.2', '-c', 'model_reasoning_effort="xhigh"', '-c', 'service_tier="fast"', '-'],
    );
    // codex_network='isolated' under restricted adds only --ignore-user-config.
    assert.deepStrictEqual(
      (await backend.resume('session-1', {
        prompt: 'continue',
        cwd: '/repo',
        model: 'gpt-5.4',
        modelSettings: { reasoning_effort: 'medium', service_tier: null, mode: 'normal', codex_network: 'isolated', worker_posture: 'restricted' },
      })).args,
      ['exec', 'resume', '--json', '--skip-git-repo-check', '--ignore-user-config', '--model', 'gpt-5.4', '-c', 'model_reasoning_effort="medium"', 'session-1', '-'],
    );
    // codex_network='workspace' under restricted adds --ignore-user-config plus
    // -c sandbox_workspace_write.network_access=true. Must NOT splice --sandbox.
    assert.deepStrictEqual(
      (await backend.start({
        prompt: 'fetch',
        cwd: '/repo',
        model: 'gpt-5.5',
        modelSettings: { reasoning_effort: 'xhigh', service_tier: null, mode: null, codex_network: 'workspace', worker_posture: 'restricted' },
      })).args,
      ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '-c', 'sandbox_workspace_write.network_access=true', '--cd', '/repo', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="xhigh"', '-'],
    );
  });

  it('trusted posture: codex_network drives sandbox argv via -c overrides, no --ignore-user-config and no --sandbox (issue #58 Decisions 6/9)', async () => {
    const backend = new CodexBackend();

    // trusted + 'user-config' => no flags
    assert.deepStrictEqual(
      (await backend.start({
        prompt: 'work',
        cwd: '/repo',
        model: 'gpt-5.2',
        modelSettings: { reasoning_effort: 'xhigh', service_tier: null, mode: null, codex_network: 'user-config', worker_posture: 'trusted' },
      })).args,
      ['exec', '--json', '--skip-git-repo-check', '--cd', '/repo', '--model', 'gpt-5.2', '-c', 'model_reasoning_effort="xhigh"', '-'],
    );

    // trusted + 'isolated' => no flags (codex defaults apply)
    assert.deepStrictEqual(
      (await backend.resume('session-1', {
        prompt: 'continue',
        cwd: '/repo',
        model: 'gpt-5.4',
        modelSettings: { reasoning_effort: 'medium', service_tier: null, mode: 'normal', codex_network: 'isolated', worker_posture: 'trusted' },
      })).args,
      ['exec', 'resume', '--json', '--skip-git-repo-check', '--model', 'gpt-5.4', '-c', 'model_reasoning_effort="medium"', 'session-1', '-'],
    );

    // trusted + 'workspace' => only network-access override
    assert.deepStrictEqual(
      (await backend.start({
        prompt: 'fetch',
        cwd: '/repo',
        model: 'gpt-5.5',
        modelSettings: { reasoning_effort: 'xhigh', service_tier: null, mode: null, codex_network: 'workspace', worker_posture: 'trusted' },
      })).args,
      ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_workspace_write.network_access=true', '--cd', '/repo', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="xhigh"', '-'],
    );

    // trusted + absent codex_network => sandbox_mode workspace-write + network on
    const trustedDefaultStart = (await backend.start({
      prompt: 'work',
      cwd: '/repo',
      model: 'gpt-5.5',
      modelSettings: { reasoning_effort: 'medium', service_tier: null, mode: null, codex_network: null, worker_posture: 'trusted' },
    })).args;
    assert.deepStrictEqual(trustedDefaultStart, ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true', '--cd', '/repo', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="medium"', '-']);

    // trusted + absent on resume must NOT emit --sandbox or --cd (review rev. 2 F1).
    const trustedDefaultResume = (await backend.resume('session-7', {
      prompt: 'continue',
      cwd: '/repo',
      model: 'gpt-5.5',
      modelSettings: { reasoning_effort: 'medium', service_tier: null, mode: null, codex_network: null, worker_posture: 'trusted' },
    })).args;
    assert.equal(trustedDefaultResume.includes('--sandbox'), false, 'resume must never emit --sandbox (codex 0.130.0 rejects it)');
    assert.equal(trustedDefaultResume.includes('--cd'), false, 'resume must never emit --cd (codex 0.130.0 rejects it on resume)');
    assert.ok(trustedDefaultResume.includes('-c'), 'resume keeps -c overrides which both subcommands accept');
  });

  it('codex backend populates initialEvents with a worker_posture lifecycle event (issue #58 Decision 11)', async () => {
    const backend = new CodexBackend();
    const inv = await backend.start({
      prompt: 'work',
      cwd: '/repo',
      model: 'gpt-5.5',
      modelSettings: { reasoning_effort: 'medium', service_tier: null, mode: null, codex_network: 'workspace', worker_posture: 'trusted' },
    });
    assert.ok(inv.initialEvents);
    assert.equal(inv.initialEvents!.length, 1);
    const payload = inv.initialEvents![0]!.payload as Record<string, unknown>;
    assert.equal(payload.state, 'worker_posture');
    assert.equal(payload.backend, 'codex');
    assert.equal(payload.worker_posture, 'trusted');
    const codex = payload.codex as Record<string, unknown>;
    assert.equal(codex.ignore_user_config, false, 'trusted must not ignore user config');
    assert.equal(codex.network_access, true);
    assert.equal(codex.codex_network, 'workspace');

    const restrictedInv = await backend.resume('session-x', {
      prompt: 'continue',
      cwd: '/repo',
      model: 'gpt-5.5',
      modelSettings: { reasoning_effort: 'medium', service_tier: null, mode: null, codex_network: 'isolated', worker_posture: 'restricted' },
    });
    const restrictedPayload = restrictedInv.initialEvents![0]!.payload as Record<string, unknown>;
    const restrictedCodex = restrictedPayload.codex as Record<string, unknown>;
    assert.equal(restrictedPayload.worker_posture, 'restricted');
    assert.equal(restrictedCodex.ignore_user_config, true);
    assert.equal(restrictedCodex.network_access, false);
  });

  it('passes model selection to Claude start and resume', async () => {
    const backend = new ClaudeBackend();

    assert.deepStrictEqual(
      (await backend.start({
        prompt: 'work',
        cwd: '/repo',
        model: 'claude-opus-4-7',
        modelSettings: { reasoning_effort: 'xhigh', service_tier: null, mode: null, codex_network: null, worker_posture: null },
      })).args,
      ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-4-7', '--effort', 'xhigh'],
    );
    assert.deepStrictEqual(
      (await backend.resume('session-1', {
        prompt: 'continue',
        cwd: '/repo',
        model: 'claude-opus-4-7[1m]',
        modelSettings: { reasoning_effort: 'max', service_tier: null, mode: null, codex_network: null, worker_posture: null },
      })).args,
      ['-p', '--resume', 'session-1', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-4-7[1m]', '--effort', 'max'],
    );
  });
});
