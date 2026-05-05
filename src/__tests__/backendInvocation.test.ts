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

  it('passes model selection to Codex start and resume (issue #31: codex_network drives sandbox argv)', async () => {
    const backend = new CodexBackend();

    // codex_network='user-config' must NOT add --ignore-user-config, even when
    // the legacy mode='normal' breadcrumb is also present. This is the
    // inverse-bug regression case (P5) for issue #31: it pins that the codex
    // backend reads codex_network only and never re-couples to mode/service_tier.
    assert.deepStrictEqual(
      (await backend.start({
        prompt: 'work',
        cwd: '/repo',
        model: 'gpt-5.2',
        modelSettings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: 'normal', codex_network: 'user-config' },
      })).args,
      ['exec', '--json', '--skip-git-repo-check', '--cd', '/repo', '--model', 'gpt-5.2', '-c', 'model_reasoning_effort="xhigh"', '-c', 'service_tier="fast"', '-'],
    );
    // codex_network='isolated' adds only --ignore-user-config.
    assert.deepStrictEqual(
      (await backend.resume('session-1', {
        prompt: 'continue',
        cwd: '/repo',
        model: 'gpt-5.4',
        modelSettings: { reasoning_effort: 'medium', service_tier: null, mode: 'normal', codex_network: 'isolated' },
      })).args,
      ['exec', 'resume', '--json', '--skip-git-repo-check', '--ignore-user-config', '--model', 'gpt-5.4', '-c', 'model_reasoning_effort="medium"', 'session-1', '-'],
    );
    // codex_network='workspace' adds --ignore-user-config plus the literal
    // -c sandbox_workspace_write.network_access=true verified on codex-cli
    // 0.128.0 (RQ2). Must NOT splice an explicit --sandbox flag (per C3).
    assert.deepStrictEqual(
      (await backend.start({
        prompt: 'fetch',
        cwd: '/repo',
        model: 'gpt-5.5',
        modelSettings: { reasoning_effort: 'xhigh', service_tier: null, mode: null, codex_network: 'workspace' },
      })).args,
      ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '-c', 'sandbox_workspace_write.network_access=true', '--cd', '/repo', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="xhigh"', '-'],
    );
  });

  it('issue #31 inverse-bug regression: codex_network=user-config + service_tier=normal must NOT pass --ignore-user-config', async () => {
    const backend = new CodexBackend();
    const args = (await backend.start({
      prompt: 'fetch',
      cwd: '/repo',
      model: 'gpt-5.5',
      // service_tier='normal' is preserved on input here for the regression
      // shape; in the orchestrator service service_tier='normal' is suppressed
      // before this point. The argv assertion is the load-bearing part: the
      // codex backend reads codex_network only.
      modelSettings: { reasoning_effort: 'high', service_tier: null, mode: 'normal', codex_network: 'user-config' },
    })).args;
    assert.equal(args.includes('--ignore-user-config'), false, '--ignore-user-config must not be present when codex_network=user-config');
  });

  it('passes model selection to Claude start and resume', async () => {
    const backend = new ClaudeBackend();

    assert.deepStrictEqual(
      (await backend.start({
        prompt: 'work',
        cwd: '/repo',
        model: 'claude-opus-4-7',
        modelSettings: { reasoning_effort: 'xhigh', service_tier: null, mode: null, codex_network: null },
      })).args,
      ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-4-7', '--effort', 'xhigh'],
    );
    assert.deepStrictEqual(
      (await backend.resume('session-1', {
        prompt: 'continue',
        cwd: '/repo',
        model: 'claude-opus-4-7[1m]',
        modelSettings: { reasoning_effort: 'max', service_tier: null, mode: null, codex_network: null },
      })).args,
      ['-p', '--resume', 'session-1', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-4-7[1m]', '--effort', 'max'],
    );
  });
});
