import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, symlink, unlink, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureGitSnapshot, changedFilesSinceSnapshot } from '../gitSnapshot.js';

const execFileAsync = promisify(execFile);
let originalPath = process.env.PATH;

describe('git snapshots', () => {
  beforeEach(() => {
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('does not throw when git status fails during capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-git-'));
    const bin = join(root, 'bin');
    await mkdir(bin);
    const git = join(bin, 'git');
    await writeFile(git, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
  console.log(process.cwd());
  process.exit(0);
}
if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
  console.log('0123456789abcdef0123456789abcdef01234567');
  process.exit(0);
}
if (args[0] === 'status') {
  process.stderr.write('status unavailable');
  process.exit(2);
}
process.exit(1);
`);
    await chmod(git, 0o755);
    process.env.PATH = originalPath ? `${bin}${delimiter}${originalPath}` : bin;

    const capture = await captureGitSnapshot(root);
    assert.equal(capture.status, 'git_unavailable');
    assert.equal(capture.snapshot, null);
  });

  it('reports already-dirty files when their contents change after the snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-git-'));
    const repo = join(root, 'repo');
    await mkdir(repo);
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await writeFile(join(repo, 'tracked.txt'), 'clean\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });

    await writeFile(join(repo, 'tracked.txt'), 'dirty before\n');
    await writeFile(join(repo, 'untracked.txt'), 'untracked before\n');
    const capture = await captureGitSnapshot(repo);
    assert.equal(capture.status, 'captured');
    assert.ok(capture.snapshot);

    await writeFile(join(repo, 'tracked.txt'), 'dirty after\n');
    await writeFile(join(repo, 'untracked.txt'), 'untracked after\n');
    const changed = await changedFilesSinceSnapshot(repo, capture.snapshot);

    assert.ok(changed.includes('tracked.txt'));
    assert.ok(changed.includes('untracked.txt'));
  });

  it('bounds large file fingerprinting and fingerprints symlinks without following targets', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-git-'));
    const repo = join(root, 'repo');
    await mkdir(repo);
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await writeFile(join(repo, 'tracked.txt'), 'clean\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });

    await writeFile(join(repo, 'large.bin'), Buffer.alloc(1024 * 1024 + 1, 1));
    await symlink('target-one', join(repo, 'special-link'));

    const capture = await captureGitSnapshot(repo);
    assert.equal(capture.status, 'captured');
    assert.ok(capture.snapshot);
    assert.match(capture.snapshot.dirty_fingerprints?.['large.bin'] ?? '', /^file-meta:/);
    assert.match(capture.snapshot.dirty_fingerprints?.['special-link'] ?? '', /^symlink:/);
    assert.ok(capture.snapshot.dirty_fingerprints?.['special-link']?.includes('target-one'));

    await writeFile(join(repo, 'large.bin'), Buffer.alloc(1024 * 1024 + 2, 2));
    await unlink(join(repo, 'special-link'));
    await symlink('target-two', join(repo, 'special-link'));

    const changed = await changedFilesSinceSnapshot(repo, capture.snapshot);
    assert.ok(changed.includes('large.bin'));
    assert.ok(changed.includes('special-link'));
  });
});
