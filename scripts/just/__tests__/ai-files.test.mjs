import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const helper = join(repoRoot, 'scripts', 'just', 'ai-files.mjs');

function buildFixture(root) {
  // Two top-level files (depth 0).
  writeFileSync(join(root, 'AGENTS.md'), 'a');
  writeFileSync(join(root, 'CLAUDE.md'), 'c');

  // .agents directory with files at depths 1-4 plus a depth-5 file that must not appear.
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'd1.md'), '');
  mkdirSync(join(root, '.agents', 'd2'), { recursive: true });
  writeFileSync(join(root, '.agents', 'd2', 'd2.md'), '');
  mkdirSync(join(root, '.agents', 'd2', 'd3'), { recursive: true });
  writeFileSync(join(root, '.agents', 'd2', 'd3', 'd3.md'), '');
  mkdirSync(join(root, '.agents', 'd2', 'd3', 'd4'), { recursive: true });
  writeFileSync(join(root, '.agents', 'd2', 'd3', 'd4', 'd4.md'), '');
  mkdirSync(join(root, '.agents', 'd2', 'd3', 'd4', 'd5'), { recursive: true });
  writeFileSync(join(root, '.agents', 'd2', 'd3', 'd4', 'd5', 'd5.md'), '');

  // Hidden file inside a tracked dir — must appear.
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', '.hidden'), '');
  writeFileSync(join(root, '.claude', 'visible.md'), '');

  // .cursor with a symlink that must not be followed.
  mkdirSync(join(root, '.cursor'), { recursive: true });
  writeFileSync(join(root, '.cursor', 'real.md'), '');
  try {
    symlinkSync(join(root, 'AGENTS.md'), join(root, '.cursor', 'link.md'));
  } catch {
    // Symlink creation may not be permitted; the test still asserts traversal correctness.
  }

  // .codex root is intentionally absent (ENOENT case). Must be silently skipped.

  // .githooks with one file.
  mkdirSync(join(root, '.githooks'), { recursive: true });
  writeFileSync(join(root, '.githooks', 'pre-commit'), '');

  // docs/development with one file.
  mkdirSync(join(root, 'docs', 'development'), { recursive: true });
  writeFileSync(join(root, 'docs', 'development', 'mcp-tooling.md'), '');
}

function runHelper(cwd) {
  const result = spawnSync(process.execPath, [helper], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  return result.stdout;
}

function expectedFixtureOutput() {
  // Slash-normalized, sorted byte-wise. Must match the find command output below.
  const lines = [
    '.agents/d1.md',
    '.agents/d2/d2.md',
    '.agents/d2/d3/d3.md',
    '.agents/d2/d3/d4/d4.md',
    '.claude/.hidden',
    '.claude/visible.md',
    '.cursor/real.md',
    '.githooks/pre-commit',
    'AGENTS.md',
    'CLAUDE.md',
    'docs/development/mcp-tooling.md',
  ];
  return `${lines.sort().join('\n')}\n`;
}

test('ai-files matches expected fixture output', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-files-fixture-'));
  try {
    buildFixture(root);
    const output = runHelper(root);
    assert.equal(output, expectedFixtureOutput());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ai-files matches `find ... | sort` byte-for-byte on POSIX', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-files-find-'));
  try {
    buildFixture(root);
    const helperOut = runHelper(root);
    const findCmd = `LC_ALL=C find AGENTS.md CLAUDE.md .agents .claude .cursor .codex .githooks docs/development -maxdepth 4 -type f 2>/dev/null | LC_ALL=C sort`;
    const findResult = spawnSync('sh', ['-c', findCmd], { cwd: root, encoding: 'utf8' });
    assert.equal(findResult.status, 0, `stderr: ${findResult.stderr}`);
    assert.equal(helperOut, findResult.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ai-files silently skips a permission-restricted dir on POSIX', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-files-perm-'));
  try {
    buildFixture(root);
    // Restrict .agents/d2/d3 traversal.
    chmodSync(join(root, '.agents', 'd2', 'd3'), 0o000);
    const result = spawnSync(process.execPath, [helper], { cwd: root, encoding: 'utf8' });
    // Restore so cleanup works.
    chmodSync(join(root, '.agents', 'd2', 'd3'), 0o755);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    // Output must still include the rest and produce no stderr noise.
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /AGENTS\.md/);
  } finally {
    try { chmodSync(join(root, '.agents', 'd2', 'd3'), 0o755); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
