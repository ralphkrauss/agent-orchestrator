import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, writeFile, chmod, symlink, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeSessionJsonlPath,
  copySessionJsonlForRotation,
  encodeProjectCwd,
} from '../claude/sessionCopy.js';

const VALID_SESSION_ID = '8bb342f7-0000-4000-8000-00000000abcd';

async function newAccountsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'claude-accounts-'));
}

async function seedSourceJsonl(opts: {
  accountsRoot: string;
  account: string;
  cwd: string;
  sessionId: string;
  contents: string;
}): Promise<string> {
  const path = computeSessionJsonlPath(opts);
  await mkdir(join(opts.accountsRoot, opts.account, 'projects', encodeProjectCwd(opts.cwd)), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(path, opts.contents, { mode: 0o600 });
  return path;
}

describe('encodeProjectCwd', () => {
  it('matches the live on-disk path observed under accounts/<name>/projects/', () => {
    assert.equal(
      encodeProjectCwd('/home/ubuntu/worktrees-agent-orchestrator/17-add-coding-backend-for-ccs'),
      '-home-ubuntu-worktrees-agent-orchestrator-17-add-coding-backend-for-ccs',
    );
  });

  it('handles edge cases', () => {
    assert.equal(encodeProjectCwd('/'), '-');
    assert.equal(encodeProjectCwd('/foo'), '-foo');
    assert.equal(encodeProjectCwd('/a/b'), '-a-b');
    assert.equal(encodeProjectCwd('C:\\Users\\ralph\\workspace'), 'C:-Users-ralph-workspace');
    assert.equal(encodeProjectCwd('\\\\?\\C:\\Users\\ralph\\workspace'), 'C:-Users-ralph-workspace');
  });
});

describe('copySessionJsonlForRotation — happy path', () => {
  it('copies the JSONL atomically with mode 0o600 and reports bytes/duration', async () => {
    const accountsRoot = await newAccountsRoot();
    const cwd = '/home/test/project';
    const contents = '{"session":"start"}\n{"turn":1}\n';
    await seedSourceJsonl({ accountsRoot, account: 'A', cwd, sessionId: VALID_SESSION_ID, contents });

    const outcome = await copySessionJsonlForRotation({
      accountsRoot,
      priorAccount: 'A',
      newAccount: 'B',
      cwd,
      sessionId: VALID_SESSION_ID,
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.resumed_session_id, VALID_SESSION_ID);
    assert.ok(outcome.copied_bytes > 0);
    assert.equal(outcome.copy_duration_ms >= 0, true);
    assert.equal(outcome.collision_resolution, undefined);

    const targetStat = await stat(outcome.target_path);
    assert.equal(targetStat.mode & 0o777, 0o600);
    const written = await readFile(outcome.target_path, 'utf8');
    assert.equal(written, contents);
  });

  it('looks up project JSONL files using the cwd realpath seen by worker processes', {
    skip: process.platform === 'win32'
      ? 'directory symlink privileges vary on Windows; this covers POSIX/macOS cwd alias behavior'
      : false,
  }, async () => {
    const accountsRoot = await newAccountsRoot();
    const root = await mkdtemp(join(tmpdir(), 'claude-cwd-alias-'));
    const physicalCwd = join(root, 'physical');
    const aliasCwd = join(root, 'alias');
    await mkdir(physicalCwd);
    await symlink(physicalCwd, aliasCwd, 'dir');
    const workerCwd = await realpath(aliasCwd);
    const contents = '{"session":"realpath"}\n';
    const sourcePath = await seedSourceJsonl({
      accountsRoot,
      account: 'A',
      cwd: workerCwd,
      sessionId: VALID_SESSION_ID,
      contents,
    });

    const outcome = await copySessionJsonlForRotation({
      accountsRoot,
      priorAccount: 'A',
      newAccount: 'B',
      cwd: aliasCwd,
      sessionId: VALID_SESSION_ID,
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.source_path, sourcePath);
    assert.equal(await readFile(outcome.target_path, 'utf8'), contents);
  });
});

describe('copySessionJsonlForRotation — input validation', () => {
  it('rejects unsafe session ids', async () => {
    const accountsRoot = await newAccountsRoot();
    const outcome = await copySessionJsonlForRotation({
      accountsRoot,
      priorAccount: 'A',
      newAccount: 'B',
      cwd: '/home/x',
      sessionId: '../../etc/passwd',
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'unsafe_session_id');
  });

  it('rejects unsafe account names', async () => {
    const accountsRoot = await newAccountsRoot();
    const outcome = await copySessionJsonlForRotation({
      accountsRoot,
      priorAccount: '../escape',
      newAccount: 'B',
      cwd: '/home/x',
      sessionId: VALID_SESSION_ID,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'unsafe_account_name');
  });
});

describe('copySessionJsonlForRotation — source missing / non-regular', () => {
  it('returns source_missing when no JSONL exists', async () => {
    const accountsRoot = await newAccountsRoot();
    const outcome = await copySessionJsonlForRotation({
      accountsRoot,
      priorAccount: 'A',
      newAccount: 'B',
      cwd: '/home/x',
      sessionId: VALID_SESSION_ID,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'source_missing');
  });

  it('rejects symlink sources via lstat', async () => {
    const accountsRoot = await newAccountsRoot();
    const cwd = '/home/x';
    const decoy = join(accountsRoot, 'A', 'projects', encodeProjectCwd(cwd));
    await mkdir(decoy, { recursive: true });
    const realFile = join(decoy, 'real.jsonl');
    await writeFile(realFile, 'real');
    await symlink(realFile, computeSessionJsonlPath({ accountsRoot, account: 'A', cwd, sessionId: VALID_SESSION_ID }));

    const outcome = await copySessionJsonlForRotation({
      accountsRoot,
      priorAccount: 'A',
      newAccount: 'B',
      cwd,
      sessionId: VALID_SESSION_ID,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'source_not_regular_file');
  });
});

describe('copySessionJsonlForRotation — cycle handling', () => {
  it('byte-equal existing target → noop success', async () => {
    const accountsRoot = await newAccountsRoot();
    const cwd = '/home/cycle';
    const contents = 'identical body\n';
    await seedSourceJsonl({ accountsRoot, account: 'A', cwd, sessionId: VALID_SESSION_ID, contents });
    await seedSourceJsonl({ accountsRoot, account: 'B', cwd, sessionId: VALID_SESSION_ID, contents });

    const outcome = await copySessionJsonlForRotation({
      accountsRoot,
      priorAccount: 'A',
      newAccount: 'B',
      cwd,
      sessionId: VALID_SESSION_ID,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.collision_resolution, 'noop');
    assert.equal(outcome.copied_bytes, 0);
  });

  it('byte-different existing target → session_jsonl_collision', async () => {
    const accountsRoot = await newAccountsRoot();
    const cwd = '/home/cycle';
    await seedSourceJsonl({ accountsRoot, account: 'A', cwd, sessionId: VALID_SESSION_ID, contents: 'A version' });
    await seedSourceJsonl({ accountsRoot, account: 'B', cwd, sessionId: VALID_SESSION_ID, contents: 'B version' });

    const outcome = await copySessionJsonlForRotation({
      accountsRoot,
      priorAccount: 'A',
      newAccount: 'B',
      cwd,
      sessionId: VALID_SESSION_ID,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'session_jsonl_collision');
  });
});

describe('copySessionJsonlForRotation — copy failures', () => {
  it('reports copy_failed (EACCES) when destination parent is not writable', async () => {
    if (process.getuid?.() === 0) return;
    const accountsRoot = await newAccountsRoot();
    const cwd = '/home/eacces';
    await seedSourceJsonl({ accountsRoot, account: 'A', cwd, sessionId: VALID_SESSION_ID, contents: 'src' });
    const targetParent = join(accountsRoot, 'B', 'projects', encodeProjectCwd(cwd));
    await mkdir(targetParent, { recursive: true });
    await chmod(targetParent, 0o500);

    try {
      const outcome = await copySessionJsonlForRotation({
        accountsRoot,
        priorAccount: 'A',
        newAccount: 'B',
        cwd,
        sessionId: VALID_SESSION_ID,
      });
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.reason, 'copy_failed');
    } finally {
      await chmod(targetParent, 0o700);
    }
  });

  it('does not leave a temp file behind on copy failure', async () => {
    if (process.getuid?.() === 0) return;
    const accountsRoot = await newAccountsRoot();
    const cwd = '/home/leak';
    await seedSourceJsonl({ accountsRoot, account: 'A', cwd, sessionId: VALID_SESSION_ID, contents: 'src' });
    const targetParent = join(accountsRoot, 'B', 'projects', encodeProjectCwd(cwd));
    await mkdir(targetParent, { recursive: true });
    await chmod(targetParent, 0o500);

    try {
      const outcome = await copySessionJsonlForRotation({
        accountsRoot,
        priorAccount: 'A',
        newAccount: 'B',
        cwd,
        sessionId: VALID_SESSION_ID,
      });
      assert.equal(outcome.ok, false);
      const entries = await fs.readdir(targetParent);
      assert.equal(entries.filter((e) => e.includes('.tmp.')).length, 0);
    } finally {
      await chmod(targetParent, 0o700);
    }
  });
});

describe('copySessionJsonlForRotation — path escape', () => {
  it('refuses a target whose realpath escapes <new-account>/projects/', async () => {
    const accountsRoot = await newAccountsRoot();
    const cwd = '/home/escape';
    await seedSourceJsonl({ accountsRoot, account: 'A', cwd, sessionId: VALID_SESSION_ID, contents: 'src' });

    // Create B/projects/ legitimately, then plant a symlink at the encoded-cwd
    // subdir position so its realpath escapes the projects/ root.
    const elsewhere = await mkdtemp(join(tmpdir(), 'claude-elsewhere-'));
    const projectsDir = join(accountsRoot, 'B', 'projects');
    await mkdir(projectsDir, { recursive: true });
    await symlink(elsewhere, join(projectsDir, encodeProjectCwd(cwd)));

    const outcome = await copySessionJsonlForRotation({
      accountsRoot,
      priorAccount: 'A',
      newAccount: 'B',
      cwd,
      sessionId: VALID_SESSION_ID,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'path_escape');
  });

  it('refuses a target when <new-account>/projects/ ITSELF is a symlink outside the account tree (reviewer fix #3)', async () => {
    const accountsRoot = await newAccountsRoot();
    const cwd = '/home/projects-escape';
    await seedSourceJsonl({ accountsRoot, account: 'A', cwd, sessionId: VALID_SESSION_ID, contents: 'src' });

    // Replace <new-account>/projects/ with a symlink to an attacker-controlled
    // location. The pre-fix containment check anchored at
    // realpath(<account>/projects/) — both root and candidate would resolve
    // to the symlink target, so `path.relative` would falsely accept it.
    // The fix anchors containment at realpath(<account>/) and requires the
    // relative path starts with `projects/`, closing this hole.
    const elsewhere = await mkdtemp(join(tmpdir(), 'claude-projects-elsewhere-'));
    await mkdir(join(accountsRoot, 'B'), { recursive: true });
    await symlink(elsewhere, join(accountsRoot, 'B', 'projects'));

    const outcome = await copySessionJsonlForRotation({
      accountsRoot,
      priorAccount: 'A',
      newAccount: 'B',
      cwd,
      sessionId: VALID_SESSION_ID,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'path_escape');
  });

  it('refuses a source when <prior-account>/projects/ ITSELF is a symlink outside the account tree', async () => {
    const accountsRoot = await newAccountsRoot();
    const cwd = '/home/source-projects-escape';
    // Plant the JSONL at the elsewhere location (where the symlink will resolve to).
    const elsewhere = await mkdtemp(join(tmpdir(), 'claude-source-elsewhere-'));
    await mkdir(join(elsewhere, encodeProjectCwd(cwd)), { recursive: true });
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(join(elsewhere, encodeProjectCwd(cwd), `${VALID_SESSION_ID}.jsonl`), 'src'));
    // Symlink <accountsRoot>/A/projects → elsewhere so the source path resolves outside A's tree.
    await mkdir(join(accountsRoot, 'A'), { recursive: true });
    await symlink(elsewhere, join(accountsRoot, 'A', 'projects'));

    const outcome = await copySessionJsonlForRotation({
      accountsRoot,
      priorAccount: 'A',
      newAccount: 'B',
      cwd,
      sessionId: VALID_SESSION_ID,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'path_escape');
  });
});
