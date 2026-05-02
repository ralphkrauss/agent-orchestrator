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
