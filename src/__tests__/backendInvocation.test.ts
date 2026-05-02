import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeBackend } from '../backend/claude.js';
import { CodexBackend } from '../backend/codex.js';

describe('backend invocations', () => {
  it('passes model selection to Codex start and resume', async () => {
    const backend = new CodexBackend();

    assert.deepStrictEqual(
      (await backend.start({
        prompt: 'work',
        cwd: '/repo',
        model: 'gpt-5.2',
        modelSettings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null },
      })).args,
      ['exec', '--json', '--skip-git-repo-check', '--cd', '/repo', '--model', 'gpt-5.2', '-c', 'model_reasoning_effort="xhigh"', '-c', 'service_tier="fast"', '-'],
    );
    assert.deepStrictEqual(
      (await backend.resume('session-1', {
        prompt: 'continue',
        cwd: '/repo',
        model: 'gpt-5.4',
        modelSettings: { reasoning_effort: 'medium', service_tier: null, mode: 'normal' },
      })).args,
      ['exec', 'resume', '--json', '--skip-git-repo-check', '--ignore-user-config', '--model', 'gpt-5.4', '-c', 'model_reasoning_effort="medium"', 'session-1', '-'],
    );
  });

  it('passes model selection to Claude start and resume', async () => {
    const backend = new ClaudeBackend();

    assert.deepStrictEqual(
      (await backend.start({
        prompt: 'work',
        cwd: '/repo',
        model: 'claude-opus-4-7',
        modelSettings: { reasoning_effort: 'xhigh', service_tier: null, mode: null },
      })).args,
      ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-4-7', '--effort', 'xhigh'],
    );
    assert.deepStrictEqual(
      (await backend.resume('session-1', {
        prompt: 'continue',
        cwd: '/repo',
        model: 'claude-opus-4-7[1m]',
        modelSettings: { reasoning_effort: 'max', service_tier: null, mode: null },
      })).args,
      ['-p', '--resume', 'session-1', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-4-7[1m]', '--effort', 'max'],
    );
  });
});
