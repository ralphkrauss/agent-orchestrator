import { lstat, readFile } from 'node:fs/promises';

export type AppendSource =
  | 'cli-inline'
  | 'cli-file'
  | 'env-inline'
  | 'env-file'
  | 'convention-file'
  | 'none';

export const SUPERVISOR_APPEND_PROMPT_BYTE_CAP = 64 * 1024;

export const SUPERVISOR_APPEND_PROMPT_DELIMITER = '\n\n---\n# User-supplied supervisor prompt\n\n';

export const CONVENTION_APPEND_PROMPT_RELATIVE_PATH = '.agents/orchestrator/system-prompt.md';

export interface LoadedAppendContent {
  bytes: Buffer;
  path: string;
}

export type AppendPromptError =
  | { code: 'missing-file'; source: 'cli-file' | 'env-file'; path: string; message: string }
  | { code: 'oversize'; source: AppendSource; path: string | null; bytes: number; cap: number; message: string }
  | { code: 'read-failed'; source: AppendSource; path: string; cause: string; message: string };

export interface ResolveSupervisorAppendPromptInput {
  cliInlineText: string | null;
  cliFilePath: string | null;
  envInlineText: string | null;
  envFilePath: string | null;
  conventionFilePath: string;
  conventionFilePresent: boolean;
  disable: boolean;
  loaded: {
    cliFile?: LoadedAppendContent;
    envFile?: LoadedAppendContent;
    convention?: LoadedAppendContent;
  };
}

export interface ResolvedSupervisorAppendPrompt {
  source: AppendSource;
  path: string | null;
  text: string | null;
  conventionSkipNotice: string | null;
}

export function resolveSupervisorAppendPrompt(
  input: ResolveSupervisorAppendPromptInput,
):
  | { ok: true; value: ResolvedSupervisorAppendPrompt }
  | { ok: false; error: AppendPromptError } {
  if (input.disable) {
    return { ok: true, value: { source: 'none', path: null, text: null, conventionSkipNotice: null } };
  }

  const selected = selectSource(input);
  if (selected.source === 'none') {
    return { ok: true, value: { source: 'none', path: null, text: null, conventionSkipNotice: null } };
  }

  const skipNoticeRequired = input.conventionFilePresent && selected.source !== 'convention-file';
  const conventionSkipNotice = skipNoticeRequired
    ? `agent-orchestrator: skipping convention system-prompt file at ${input.conventionFilePath}: preempted by ${describeSource(selected.source)}`
    : null;

  const decoded = decodeSelected(selected);
  if (!decoded.ok) {
    return decoded;
  }

  return {
    ok: true,
    value: {
      source: selected.source,
      path: selected.path,
      text: decoded.text,
      conventionSkipNotice,
    },
  };
}

type SelectedSource =
  | { source: 'cli-inline'; path: null; inlineText: string }
  | { source: 'env-inline'; path: null; inlineText: string }
  | { source: 'cli-file'; path: string; loaded: LoadedAppendContent | undefined }
  | { source: 'env-file'; path: string; loaded: LoadedAppendContent | undefined }
  | { source: 'convention-file'; path: string; loaded: LoadedAppendContent | undefined }
  | { source: 'none'; path: null };

function selectSource(input: ResolveSupervisorAppendPromptInput): SelectedSource {
  if (input.cliInlineText !== null) {
    return { source: 'cli-inline', path: null, inlineText: input.cliInlineText };
  }
  if (input.cliFilePath !== null) {
    return { source: 'cli-file', path: input.cliFilePath, loaded: input.loaded.cliFile };
  }
  if (input.envInlineText !== null) {
    return { source: 'env-inline', path: null, inlineText: input.envInlineText };
  }
  if (input.envFilePath !== null) {
    return { source: 'env-file', path: input.envFilePath, loaded: input.loaded.envFile };
  }
  if (input.conventionFilePresent && input.loaded.convention) {
    return { source: 'convention-file', path: input.conventionFilePath, loaded: input.loaded.convention };
  }
  return { source: 'none', path: null };
}

function decodeSelected(
  selected: SelectedSource,
):
  | { ok: true; text: string | null }
  | { ok: false; error: AppendPromptError } {
  switch (selected.source) {
    case 'cli-inline':
    case 'env-inline':
      return decodeInline(selected.source, selected.inlineText);
    case 'cli-file':
    case 'env-file':
    case 'convention-file': {
      if (!selected.loaded) {
        return { ok: true, text: null };
      }
      return decodeBytes(selected.source, selected.path, selected.loaded.bytes);
    }
    default:
      return { ok: true, text: null };
  }
}

function decodeInline(
  source: 'cli-inline' | 'env-inline',
  raw: string,
):
  | { ok: true; text: string | null }
  | { ok: false; error: AppendPromptError } {
  const bytes = Buffer.from(raw, 'utf8');
  return decodeBytes(source, null, bytes);
}

function decodeBytes(
  source: AppendSource,
  path: string | null,
  bytes: Buffer,
):
  | { ok: true; text: string | null }
  | { ok: false; error: AppendPromptError } {
  const stripped = stripUtf8Bom(bytes);
  if (stripped.length > SUPERVISOR_APPEND_PROMPT_BYTE_CAP) {
    return {
      ok: false,
      error: {
        code: 'oversize',
        source,
        path,
        bytes: stripped.length,
        cap: SUPERVISOR_APPEND_PROMPT_BYTE_CAP,
        message: `Supervisor append prompt exceeds the ${SUPERVISOR_APPEND_PROMPT_BYTE_CAP}-byte cap (got ${stripped.length} bytes) from source ${source}${path ? ` at ${path}` : ''}.`,
      },
    };
  }
  const decoded = stripped.toString('utf8').trimEnd();
  return { ok: true, text: decoded.length === 0 ? null : decoded };
}

function stripUtf8Bom(bytes: Buffer): Buffer {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3);
  }
  return bytes;
}

function describeSource(source: AppendSource): string {
  switch (source) {
    case 'cli-inline': return '--append-system-prompt';
    case 'cli-file': return '--append-system-prompt-file';
    case 'env-inline': return 'AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT';
    case 'env-file': return 'AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE';
    case 'convention-file': return 'convention file';
    case 'none': return 'none';
  }
}

export type ConventionPromptProbeResult =
  | { kind: 'regular'; path: string }
  | { kind: 'absent' }
  | { kind: 'skipped-non-regular'; path: string; reason: string; notice: string }
  | { kind: 'error'; error: AppendPromptError };

/**
 * Cheap, body-free presence/non-regular probe for the convention file. Only
 * the convention path is subject to the lstat regular-file guard. CLI- and
 * env-named paths are read as-is by `readAppendPromptFile`.
 */
export async function probeConventionAppendPromptFile(path: string): Promise<ConventionPromptProbeResult> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) {
      const reason = describeNonRegular(info);
      return {
        kind: 'skipped-non-regular',
        path,
        reason,
        notice: `agent-orchestrator: skipping convention system-prompt file at ${path}: not a regular file (${reason})`,
      };
    }
    return { kind: 'regular', path };
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT') return { kind: 'absent' };
    return {
      kind: 'error',
      error: {
        code: 'read-failed',
        source: 'convention-file',
        path,
        cause: errorMessage(error),
        message: `Failed to inspect convention system-prompt file at ${path}: ${errorMessage(error)}`,
      },
    };
  }
}

export interface LoadAppendPromptInput {
  kind: 'cli-file' | 'env-file' | 'convention-file';
  source: AppendSource;
  path: string;
}

export type LoadAppendPromptResult =
  | { kind: 'loaded'; path: string; bytes: Buffer }
  | { kind: 'absent' }
  | { kind: 'error'; error: AppendPromptError };

/**
 * Reads the bytes of an append-prompt source. Convention-file callers should
 * call `probeConventionAppendPromptFile` first so the lstat regular-file
 * guard runs separately; this function trusts the caller to read only the
 * winning source and treats missing CLI/env files as a typed `missing-file`
 * error while keeping missing convention reads silent.
 */
export async function readAppendPromptFile(
  input: LoadAppendPromptInput,
): Promise<LoadAppendPromptResult> {
  try {
    const bytes = await readFile(input.path);
    return { kind: 'loaded', path: input.path, bytes };
  } catch (error) {
    const code = errnoCode(error);
    if (input.kind === 'convention-file' && code === 'ENOENT') {
      return { kind: 'absent' };
    }
    if (input.kind !== 'convention-file' && code === 'ENOENT') {
      return {
        kind: 'error',
        error: {
          code: 'missing-file',
          source: input.kind,
          path: input.path,
          message: `Supervisor append-prompt file not found for source ${input.source} at ${input.path}.`,
        },
      };
    }
    return {
      kind: 'error',
      error: {
        code: 'read-failed',
        source: input.source,
        path: input.path,
        cause: errorMessage(error),
        message: `Failed to read supervisor append-prompt file for source ${input.source} at ${input.path}: ${errorMessage(error)}`,
      },
    };
  }
}

/**
 * Back-compat shim retained so existing callers can keep using a single
 * entry point. Convention-file kind composes the lstat probe and the read.
 */
export async function loadAppendPromptSource(
  input: LoadAppendPromptInput,
): Promise<LoadAppendPromptResult | { kind: 'skipped-non-regular'; path: string; reason: string; notice: string }> {
  if (input.kind === 'convention-file') {
    const probe = await probeConventionAppendPromptFile(input.path);
    if (probe.kind === 'absent') return { kind: 'absent' };
    if (probe.kind === 'skipped-non-regular') {
      return { kind: 'skipped-non-regular', path: probe.path, reason: probe.reason, notice: probe.notice };
    }
    if (probe.kind === 'error') return { kind: 'error', error: probe.error };
  }
  return readAppendPromptFile(input);
}

function describeNonRegular(info: { isSymbolicLink: () => boolean; isDirectory: () => boolean; isFIFO: () => boolean; isSocket: () => boolean; isCharacterDevice: () => boolean; isBlockDevice: () => boolean }): string {
  if (info.isSymbolicLink()) return 'symlink';
  if (info.isDirectory()) return 'directory';
  if (info.isFIFO()) return 'fifo';
  if (info.isSocket()) return 'socket';
  if (info.isCharacterDevice()) return 'character device';
  if (info.isBlockDevice()) return 'block device';
  return 'non-regular file';
}

function errnoCode(error: unknown): string | null {
  if (typeof error === 'object' && error && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
