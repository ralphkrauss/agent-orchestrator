import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeBackend } from '../backend/claude.js';
import { CodexBackend } from '../backend/codex.js';

describe('backend invocations', () => {
  it('passes model selection to Codex start and resume', async () => {
    const backend = new CodexBackend();

    assert.deepStrictEqual(
      (await backend.start({ prompt: 'work', cwd: '/repo', model: 'gpt-5.2' })).args,
      ['exec', '--json', '--skip-git-repo-check', '--cd', '/repo', '--model', 'gpt-5.2', '-'],
    );
    assert.deepStrictEqual(
      (await backend.resume('session-1', { prompt: 'continue', cwd: '/repo', model: 'gpt-5.4' })).args,
      ['exec', 'resume', '--json', '--skip-git-repo-check', '--model', 'gpt-5.4', 'session-1', '-'],
    );
  });

  it('passes model selection to Claude start and resume', async () => {
    const backend = new ClaudeBackend();

    assert.deepStrictEqual(
      (await backend.start({ prompt: 'work', cwd: '/repo', model: 'sonnet' })).args,
      ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet'],
    );
    assert.deepStrictEqual(
      (await backend.resume('session-1', { prompt: 'continue', cwd: '/repo', model: 'opus' })).args,
      ['-p', '--resume', 'session-1', '--output-format', 'stream-json', '--verbose', '--model', 'opus'],
    );
  });
});
