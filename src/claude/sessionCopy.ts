import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isValidAccountName } from './accountValidation.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Encode an absolute cwd into Claude Code's `projects/` subdirectory name
 * (D-COR4). Path separators become `-`; the leading slash becomes a leading `-`.
 *
 * Pinned by the live on-disk path under
 * `<run_store>/claude/accounts/<name>/projects/...`.
 */
export function encodeProjectCwd(absoluteCwd: string): string {
  return absoluteCwd.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\//g, '-');
}

export interface ComputeSessionJsonlPathInput {
  accountsRoot: string;
  account: string;
  cwd: string;
  sessionId: string;
}

export function computeSessionJsonlPath(input: ComputeSessionJsonlPathInput): string {
  return join(
    input.accountsRoot,
    input.account,
    'projects',
    encodeProjectCwd(input.cwd),
    `${input.sessionId}.jsonl`,
  );
}

export type CopyOutcomeReason =
  | 'source_missing'
  | 'source_disappeared_during_copy'
  | 'source_not_regular_file'
  | 'unsafe_session_id'
  | 'unsafe_account_name'
  | 'path_escape'
  | 'copy_failed'
  | 'session_jsonl_collision'
  | 'session_jsonl_not_found';

export type CopyOutcome =
  | {
      ok: true;
      resumed_session_id: string;
      source_path: string;
      target_path: string;
      copied_bytes: number;
      copy_duration_ms: number;
      collision_resolution?: 'noop';
    }
  | {
      ok: false;
      reason: CopyOutcomeReason;
      details: Record<string, unknown>;
    };

export interface CopySessionJsonlInput {
  accountsRoot: string;
  priorAccount: string;
  newAccount: string;
  cwd: string;
  sessionId: string;
  now?: () => number;
}

/**
 * Copy a session JSONL from the prior account's `projects/` tree to the new
 * account's analogous path so `claude --resume <sessionId>` can succeed under
 * the new `CLAUDE_CONFIG_DIR`. See plan D-COR1, D-COR2, D-COR3, D-COR-PathHard.
 *
 * Never throws on the daemon's behalf — every failure mode is captured in the
 * discriminated `CopyOutcome.reason` union.
 */
export async function copySessionJsonlForRotation(input: CopySessionJsonlInput): Promise<CopyOutcome> {
  const now = input.now ?? Date.now;
  const startedAt = now();

  if (!SESSION_ID_PATTERN.test(input.sessionId)) {
    return { ok: false, reason: 'unsafe_session_id', details: { session_id: input.sessionId } };
  }
  if (!isValidAccountName(input.priorAccount)) {
    return { ok: false, reason: 'unsafe_account_name', details: { account: input.priorAccount, role: 'prior' } };
  }
  if (!isValidAccountName(input.newAccount)) {
    return { ok: false, reason: 'unsafe_account_name', details: { account: input.newAccount, role: 'new' } };
  }

  const projectCwd = await resolveProjectCwd(input.cwd);
  const sourcePath = computeSessionJsonlPath({
    accountsRoot: input.accountsRoot,
    account: input.priorAccount,
    cwd: projectCwd,
    sessionId: input.sessionId,
  });
  const priorAccountRoot = join(input.accountsRoot, input.priorAccount);
  const targetPath = computeSessionJsonlPath({
    accountsRoot: input.accountsRoot,
    account: input.newAccount,
    cwd: projectCwd,
    sessionId: input.sessionId,
  });
  const newAccountRoot = join(input.accountsRoot, input.newAccount);
  const targetParent = dirname(targetPath);
  const projectsPrefix = `projects${sep}`;

  try {
    await fs.mkdir(targetParent, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    return {
      ok: false,
      reason: 'copy_failed',
      details: { code: errorCode(error), syscall: errorSyscall(error), stage: 'mkdir_target_parent' },
    };
  }

  let sourceStat: import('node:fs').Stats;
  try {
    sourceStat = await fs.lstat(sourcePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { ok: false, reason: 'source_missing', details: { source_path: sourcePath } };
    }
    return {
      ok: false,
      reason: 'copy_failed',
      details: { code: errorCode(error), syscall: errorSyscall(error), stage: 'lstat_source' },
    };
  }
  if (!sourceStat.isFile()) {
    return {
      ok: false,
      reason: 'source_not_regular_file',
      details: { source_path: sourcePath, mode: sourceStat.mode },
    };
  }

  // Reviewer fix: anchor containment at the account root, not at
  // `<account>/projects/`. If `<account>/projects` itself is a symlink
  // pointing outside the account tree, both root and candidate would
  // resolve to the symlink target and `path.relative` would return a
  // non-escape path even though the write lands outside the daemon-owned
  // tree. Anchoring at `<account>/` and requiring the relative path starts
  // with `projects/` closes that hole.
  const sourceContainment = await checkContainment(sourcePath, priorAccountRoot, projectsPrefix);
  if (!sourceContainment.ok) {
    return {
      ok: false,
      reason: 'path_escape',
      details: { side: 'source', source_path: sourcePath, ...sourceContainment.details },
    };
  }
  const targetContainment = await checkContainment(targetParent, newAccountRoot, projectsPrefix);
  if (!targetContainment.ok) {
    return {
      ok: false,
      reason: 'path_escape',
      details: { side: 'target', target_parent: targetParent, ...targetContainment.details },
    };
  }

  let existingTargetBytes: Buffer | null = null;
  try {
    const targetStat = await fs.lstat(targetPath);
    if (!targetStat.isFile()) {
      return {
        ok: false,
        reason: 'path_escape',
        details: { side: 'target_existing_non_regular', target_path: targetPath, mode: targetStat.mode },
      };
    }
    existingTargetBytes = await fs.readFile(targetPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      return {
        ok: false,
        reason: 'copy_failed',
        details: { code: errorCode(error), syscall: errorSyscall(error), stage: 'lstat_or_read_target' },
      };
    }
  }

  if (existingTargetBytes !== null) {
    let sourceBytes: Buffer;
    try {
      sourceBytes = await fs.readFile(sourcePath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { ok: false, reason: 'source_disappeared_during_copy', details: { source_path: sourcePath } };
      }
      return {
        ok: false,
        reason: 'copy_failed',
        details: { code: errorCode(error), syscall: errorSyscall(error), stage: 'read_source_for_collision' },
      };
    }
    if (sourceBytes.equals(existingTargetBytes)) {
      return {
        ok: true,
        resumed_session_id: input.sessionId,
        source_path: sourcePath,
        target_path: targetPath,
        copied_bytes: 0,
        copy_duration_ms: now() - startedAt,
        collision_resolution: 'noop',
      };
    }
    return {
      ok: false,
      reason: 'session_jsonl_collision',
      details: {
        source_path: sourcePath,
        target_path: targetPath,
        source_bytes: sourceBytes.length,
        target_bytes: existingTargetBytes.length,
      },
    };
  }

  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let copiedBytes = 0;
  try {
    await fs.copyFile(sourcePath, tmpPath);
    await fs.chmod(tmpPath, FILE_MODE);
    const tmpStat = await fs.stat(tmpPath);
    copiedBytes = tmpStat.size;
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    const code = errorCode(error);
    const syscall = errorSyscall(error);
    if (code === 'ENOENT' && (syscall === 'copyfile' || syscall === 'open')) {
      await safeRm(tmpPath);
      return { ok: false, reason: 'source_disappeared_during_copy', details: { source_path: sourcePath, code, syscall } };
    }
    await safeRm(tmpPath);
    return { ok: false, reason: 'copy_failed', details: { code, syscall, stage: 'atomic_copy' } };
  }

  return {
    ok: true,
    resumed_session_id: input.sessionId,
    source_path: sourcePath,
    target_path: targetPath,
    copied_bytes: copiedBytes,
    copy_duration_ms: now() - startedAt,
  };
}

async function resolveProjectCwd(cwd: string): Promise<string> {
  try {
    return await fs.realpath(cwd);
  } catch {
    return cwd;
  }
}

async function checkContainment(
  candidate: string,
  root: string,
  requiredPrefix?: string,
): Promise<{ ok: true } | { ok: false; details: Record<string, unknown> }> {
  let resolvedCandidate: string;
  let resolvedRoot: string;
  try {
    resolvedCandidate = await fs.realpath(candidate);
  } catch (error) {
    return { ok: false, details: { code: errorCode(error), stage: 'realpath_candidate' } };
  }
  try {
    resolvedRoot = await fs.realpath(root);
  } catch (error) {
    return { ok: false, details: { code: errorCode(error), stage: 'realpath_root' } };
  }
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, details: { resolved_candidate: resolvedCandidate, resolved_root: resolvedRoot, rel } };
  }
  if (requiredPrefix && !(rel + sep).startsWith(requiredPrefix)) {
    return {
      ok: false,
      details: { resolved_candidate: resolvedCandidate, resolved_root: resolvedRoot, rel, required_prefix: requiredPrefix },
    };
  }
  return { ok: true };
}

async function safeRm(path: string): Promise<void> {
  try {
    await fs.rm(path, { force: true });
  } catch {
    // Best effort — the temp file is in the daemon-owned tree.
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function errorSyscall(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'syscall' in error) {
    const syscall = (error as { syscall?: unknown }).syscall;
    return typeof syscall === 'string' ? syscall : undefined;
  }
  return undefined;
}
