import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GitSnapshot, GitSnapshotStatus } from './contract.js';

const execFileAsync = promisify(execFile);
const maxChangedPaths = 50_000;
const maxRegularFileHashBytes = 1024 * 1024;
const maxTotalRegularFileHashBytes = 16 * 1024 * 1024;
const fingerprintCapExceededCode = 'FINGERPRINT_CAP_EXCEEDED';

interface FingerprintBudget {
  remainingBytes: number;
}

export interface GitSnapshotCapture {
  status: GitSnapshotStatus;
  snapshot: GitSnapshot | null;
}

export async function captureGitSnapshot(cwd: string): Promise<GitSnapshotCapture> {
  try {
    return await doCaptureGitSnapshot(cwd);
  } catch {
    return { status: 'git_unavailable', snapshot: null };
  }
}

async function doCaptureGitSnapshot(cwd: string): Promise<GitSnapshotCapture> {
  try {
    await git(cwd, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'git_unavailable', snapshot: null };
    }
    return { status: 'not_a_repo', snapshot: null };
  }

  let sha: string;
  try {
    sha = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'git_unavailable', snapshot: null };
    }
    return { status: 'empty_repo', snapshot: null };
  }

  let dirty: string[];
  try {
    dirty = parsePorcelain(await git(cwd, ['status', '--porcelain', '--untracked-files=all']));
  } catch (error) {
    return { status: snapshotFailureStatus(error), snapshot: null };
  }
  if (dirty.length > maxChangedPaths) {
    return { status: 'too_large', snapshot: null };
  }

  return {
    status: 'captured',
    snapshot: {
      sha,
      dirty_count: dirty.length,
      dirty,
      dirty_fingerprints: await fingerprintPaths(cwd, dirty),
    },
  };
}

export async function changedFilesSinceSnapshot(cwd: string, snapshot: GitSnapshot | null): Promise<string[]> {
  if (!snapshot) return [];

  const startDirty = new Set(snapshot.dirty ?? []);
  const files = new Set<string>();
  const fingerprintBudget = createFingerprintBudget();
  try {
    const committed = parseNameOnly(await git(cwd, ['diff', '--name-only', `${snapshot.sha}..HEAD`]));
    for (const path of committed) files.add(path);
  } catch {
    // Best-effort telemetry; working-tree diff below may still work.
  }

  let currentDirty: string[] = [];
  try {
    currentDirty = parsePorcelain(await git(cwd, ['status', '--porcelain', '--untracked-files=all']));
    for (const path of currentDirty) {
      if (!startDirty.has(path)) {
        files.add(path);
        continue;
      }

      const startFingerprint = snapshot.dirty_fingerprints?.[path];
      if (startFingerprint && await fingerprintPath(cwd, path, fingerprintBudget) !== startFingerprint) {
        files.add(path);
      }
    }
  } catch {
    // Keep committed paths when status fails.
  }

  const currentDirtySet = new Set(currentDirty);
  for (const path of startDirty) {
    if (currentDirtySet.has(path)) continue;
    const startFingerprint = snapshot.dirty_fingerprints?.[path];
    if (startFingerprint && await fingerprintPath(cwd, path, fingerprintBudget) !== startFingerprint) {
      files.add(path);
    }
  }

  const result = Array.from(files).sort();
  return result.length > maxChangedPaths ? result.slice(0, maxChangedPaths) : result;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 10_000,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  });
  return stdout;
}

function parseNameOnly(output: string): string[] {
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function parsePorcelain(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const raw = line.slice(3);
    const renameIndex = raw.indexOf(' -> ');
    paths.push(renameIndex >= 0 ? raw.slice(renameIndex + 4) : raw);
  }
  return paths;
}

async function fingerprintPaths(cwd: string, paths: string[]): Promise<Record<string, string>> {
  const fingerprints: Record<string, string> = {};
  const budget = createFingerprintBudget();
  for (const path of paths) {
    fingerprints[path] = await fingerprintPath(cwd, path, budget);
  }
  return fingerprints;
}

function createFingerprintBudget(): FingerprintBudget {
  return { remainingBytes: maxTotalRegularFileHashBytes };
}

async function fingerprintPath(cwd: string, relativePath: string, budget: FingerprintBudget): Promise<string> {
  const path = join(cwd, relativePath);
  try {
    const info = await lstat(path);
    const metadata = `${info.mode}:${info.size}:${Math.trunc(info.mtimeMs)}`;

    if (info.isSymbolicLink()) {
      const target = await readlink(path).catch((error: NodeJS.ErrnoException) => `unreadable:${error.code ?? 'unknown'}`);
      return `symlink:${metadata}:${target}`;
    }

    if (info.isDirectory()) {
      return `directory:${metadata}`;
    }

    if (!info.isFile()) {
      return `special:${metadata}`;
    }

    if (info.size > maxRegularFileHashBytes || info.size > budget.remainingBytes) {
      return `file-meta:${metadata}`;
    }

    budget.remainingBytes -= info.size;
    try {
      return `file:${info.size}:${await hashRegularFile(path)}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === fingerprintCapExceededCode) {
        return `file-meta:${metadata}`;
      }
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return `error:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`;
  }
}

async function hashRegularFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
    let bytesRead = 0;
    stream.on('data', (chunk: string | Buffer) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += buffer.length;
      if (bytesRead > maxRegularFileHashBytes) {
        const error = new Error('fingerprint byte cap exceeded') as NodeJS.ErrnoException;
        error.code = fingerprintCapExceededCode;
        stream.destroy(error);
        return;
      }
      hash.update(buffer);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function snapshotFailureStatus(error: unknown): GitSnapshotStatus {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'too_large';
  return 'git_unavailable';
}
