import { constants, type Dirent } from 'node:fs';
import { access, copyFile, lstat, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Conservative allowlist for skill directory names so the discovered names that
 * land in prompts and `/skills` cannot inject newlines, control characters, or
 * other prompt-shaped content. Mirrors the existing AI-workspace naming
 * convention (kebab-case, dotted suffixes for grouping) and bounds length.
 */
const SAFE_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SKILL_NAME_LENGTH = 96;

function isSafeSkillName(name: string): boolean {
  return name.length <= MAX_SKILL_NAME_LENGTH && SAFE_SKILL_NAME_PATTERN.test(name);
}

export interface ResolvedClaudeSkills {
  ephemeralRoot: string;
  orchestrationSkillNames: string[];
  orchestrationSkills: ResolvedClaudeSkill[];
  sourceSkillRoot: string;
}

export interface MirroredClaudeSkills {
  sourceSkillRoot: string;
  targetSkillRoot: string;
  skillNames: string[];
}

export interface ResolvedClaudeSkill {
  name: string;
  content: string;
}

export async function curateOrchestrateSkills(input: {
  sourceSkillRoot: string;
  ephemeralSkillRoot: string;
}): Promise<ResolvedClaudeSkills> {
  await rm(input.ephemeralSkillRoot, { recursive: true, force: true });
  await mkdir(input.ephemeralSkillRoot, { recursive: true, mode: 0o700 });
  const orchestrationSkillNames = await listOrchestrationSkills(input.sourceSkillRoot);
  const orchestrationSkills: ResolvedClaudeSkill[] = [];
  const acceptedNames: string[] = [];
  for (const name of orchestrationSkillNames) {
    const sourceFile = join(input.sourceSkillRoot, name, 'SKILL.md');
    // Re-validate at the copy/read boundary: discovery uses lstat, but a path
    // can be swapped to a symlink between discovery and use. Read the validated
    // content once and write it to the target so the curated file and the
    // embedded prompt content come from the same checked bytes.
    const validated = await readValidatedSkillContent(sourceFile);
    if (validated === null) continue;
    const targetDir = join(input.ephemeralSkillRoot, name);
    const targetFile = join(targetDir, 'SKILL.md');
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    await writeFile(targetFile, validated, { mode: 0o600 });
    orchestrationSkills.push({ name, content: validated });
    acceptedNames.push(name);
  }
  return {
    ephemeralRoot: input.ephemeralSkillRoot,
    orchestrationSkillNames: acceptedNames,
    orchestrationSkills,
    sourceSkillRoot: input.sourceSkillRoot,
  };
}

/**
 * Open the file with O_NOFOLLOW so a symlink swapped in between discovery and
 * use is rejected. Then re-stat through the open fd and confirm it is still a
 * regular file before reading. Returns null only when the file is no longer a
 * trustworthy regular file at the source path (symlink swap, vanished, or
 * still listed but not a regular file). Unexpected I/O errors such as EACCES,
 * EPERM, EIO, EMFILE, etc. are rethrown so the launcher surfaces them rather
 * than silently dropping required orchestrate-* skills.
 */
async function readValidatedSkillContent(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isExpectedSkillRevalidationError(error)) return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    return await handle.readFile('utf8');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * `O_NOFOLLOW` open returns ELOOP on Linux and EMLINK/EFTYPE on macOS/BSD when
 * the final path component is a symlink. ENOENT covers a file that vanished
 * between discovery and re-validation. Anything else is an unexpected
 * filesystem error and should propagate to the caller.
 */
function isExpectedSkillRevalidationError(error: unknown): boolean {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
  return code === 'ELOOP' || code === 'EMLINK' || code === 'EFTYPE' || code === 'ENOENT';
}

export async function listOrchestrationSkills(sourceSkillRoot: string): Promise<string[]> {
  const names = await listClaudeSkills(sourceSkillRoot);
  return names.filter((name) => name.startsWith('orchestrate-'));
}

export async function mirrorClaudeProjectSkills(input: {
  sourceSkillRoot: string;
  targetSkillRoot: string;
}): Promise<MirroredClaudeSkills> {
  await rm(input.targetSkillRoot, { recursive: true, force: true });
  await mkdir(input.targetSkillRoot, { recursive: true, mode: 0o700 });
  const skillNames = await listClaudeSkills(input.sourceSkillRoot);
  for (const name of skillNames) {
    await copyDirectoryWithoutSymlinks(
      join(input.sourceSkillRoot, name),
      join(input.targetSkillRoot, name),
    );
  }
  return {
    sourceSkillRoot: input.sourceSkillRoot,
    targetSkillRoot: input.targetSkillRoot,
    skillNames,
  };
}

async function listClaudeSkills(sourceSkillRoot: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = (await readdir(sourceSkillRoot, { withFileTypes: true })) as unknown as Dirent[];
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip directory names that would inject newlines, control characters, or
    // other prompt-shaped content when interpolated into the system prompt or
    // the `/skills` mirror.
    if (!isSafeSkillName(entry.name)) continue;
    const skillFile = join(sourceSkillRoot, entry.name, 'SKILL.md');
    try {
      // lstat (not stat) so symlinked SKILL.md never copies host content into
      // the curated envelope or runtime skill mirror; only real regular files
      // are accepted.
      const info = await lstat(skillFile);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      await access(skillFile, constants.R_OK);
      names.push(entry.name);
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
      if (code !== 'ENOENT') throw error;
    }
  }
  return names.sort();
}

async function copyDirectoryWithoutSymlinks(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const entries = (await readdir(sourceDir, { withFileTypes: true })) as unknown as Dirent[];
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await copyDirectoryWithoutSymlinks(sourcePath, targetPath);
    } else if (info.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}
