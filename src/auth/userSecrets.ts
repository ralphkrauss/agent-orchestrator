import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, rename, stat, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SECRETS_FILE_MODE = 0o600;
const SECRETS_DIR_MODE = 0o700;
const POSIX_PERM_MASK = 0o077;

const KEY_VALUE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export interface UserSecretsOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface LoadedSecrets {
  /** Resolved secrets file path (whether or not the file exists). */
  path: string;
  /** Parsed key/value pairs. Empty object when the file is missing. */
  values: Record<string, string>;
  /** True when the file exists and could be read. */
  exists: boolean;
  /** Set when the file exists but was refused (e.g. perms too permissive). */
  refusal?: { reason: string; hint: string };
}

interface ParsedFile {
  /** Ordered entries representing the file. Comments/blank lines are preserved. */
  entries: FileEntry[];
}

type FileEntry =
  | { kind: 'key'; key: string; rawValue: string; value: string }
  | { kind: 'other'; raw: string };

/**
 * Resolve the secrets file path. Honors the `AGENT_ORCHESTRATOR_SECRETS_FILE`
 * env override (falling back to `~/.config/agent-orchestrator/secrets.env`).
 */
export function resolveSecretsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_ORCHESTRATOR_SECRETS_FILE?.trim();
  if (override) return resolve(override);
  return join(homedir(), '.config', 'agent-orchestrator', 'secrets.env');
}

/**
 * Read the secrets file. Returns an empty result when the file does not exist.
 * On POSIX, refuses to read when the file mode is group/world-readable
 * (`mode & 0o077 != 0`). Refusals are surfaced via {@link LoadedSecrets.refusal}
 * so callers can decide whether to log or escalate.
 *
 * Never throws. Read/parse failures (bad path, unreadable file, race) are
 * converted into a `refusal` so callers (`doctor`, daemon boot) degrade
 * gracefully rather than crashing on a misconfigured path.
 */
export function loadUserSecrets(options: UserSecretsOptions = {}): LoadedSecrets {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = resolveSecretsPath(env);

  if (!existsSync(path)) {
    return { path, values: {}, exists: false };
  }

  if (platform !== 'win32') {
    let mode: number;
    try {
      mode = statSync(path).mode;
    } catch (error) {
      return {
        path,
        values: {},
        exists: true,
        refusal: {
          reason: `failed to stat secrets file ${path}: ${errorMessage(error)}`,
          hint: `Verify ${path} is a regular file owned by the current user.`,
        },
      };
    }
    if ((mode & POSIX_PERM_MASK) !== 0) {
      return {
        path,
        values: {},
        exists: true,
        refusal: {
          reason: `secrets file ${path} is too permissive (mode 0o${(mode & 0o777).toString(8)})`,
          hint: `Run \`chmod 600 ${path}\` to restrict access to the owning user.`,
        },
      };
    }
  }

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      path,
      values: {},
      exists: true,
      refusal: {
        reason: `failed to read secrets file ${path}: ${errorMessage(error)}`,
        hint: `Verify ${path} is a readable regular file owned by the current user.`,
      },
    };
  }
  const parsed = parseSecretsText(text);
  const values: Record<string, string> = {};
  for (const entry of parsed.entries) {
    if (entry.kind === 'key') values[entry.key] = entry.value;
  }
  return { path, values, exists: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Overlay secrets-file values onto `env` *without overriding values already
 * present*. Existing env values always win. Returns a summary describing what
 * happened so callers can log without exposing secrets.
 *
 * `allowedKeys` is an allowlist of env-var names that may be applied. Keys
 * present in the file but not in the allowlist are reported via
 * `skippedBecauseDisallowed` and never written to the env. The daemon passes
 * the env vars of currently *wired* providers so a hand-edited secrets file
 * cannot inject `NODE_OPTIONS`, proxy vars, or reserved-provider keys into
 * the daemon environment. When `allowedKeys` is omitted the loader is
 * permissive — used by tooling like `auth status` that only reads the file.
 */
export interface LoadIntoEnvOptions extends UserSecretsOptions {
  allowedKeys?: ReadonlyArray<string>;
}

export interface LoadIntoEnvSummary {
  path: string;
  applied: string[];
  skippedBecauseEnvSet: string[];
  skippedBecauseDisallowed: string[];
  refusal?: { reason: string; hint: string };
  fileExisted: boolean;
}

export function loadUserSecretsIntoEnv(
  env: NodeJS.ProcessEnv,
  options: LoadIntoEnvOptions = {},
): LoadIntoEnvSummary {
  const loaded = loadUserSecrets({ env, platform: options.platform });
  const allowlist = options.allowedKeys ? new Set(options.allowedKeys) : null;
  const applied: string[] = [];
  const skippedEnv: string[] = [];
  const skippedDisallowed: string[] = [];
  for (const [key, value] of Object.entries(loaded.values)) {
    if (allowlist !== null && !allowlist.has(key)) {
      skippedDisallowed.push(key);
      continue;
    }
    const existing = env[key];
    if (typeof existing === 'string' && existing.length > 0) {
      skippedEnv.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return {
    path: loaded.path,
    applied,
    skippedBecauseEnvSet: skippedEnv,
    skippedBecauseDisallowed: skippedDisallowed,
    refusal: loaded.refusal,
    fileExisted: loaded.exists,
  };
}

export interface SaveSecretOptions extends UserSecretsOptions {
  /** Override for testing only. */
  path?: string;
}

/**
 * Atomically save (or replace) a single key in the secrets file. Comments,
 * blank lines, and unrelated keys are preserved in their original order.
 * The file is written `0o600`; the parent directory is created `0o700`.
 */
export async function saveUserSecret(
  key: string,
  value: string,
  options: SaveSecretOptions = {},
): Promise<{ path: string }> {
  if (!isValidKey(key)) throw new Error(`invalid env-style key: ${key}`);
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error('secret values must not contain newlines');
  }

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = options.path ?? resolveSecretsPath(env);

  await ensureSecretsDir(dirname(path), platform);

  let parsed: ParsedFile = { entries: [] };
  if (existsSync(path)) {
    parsed = parseSecretsText(await readFile(path, 'utf8'));
  }

  const formattedValue = formatValue(value);
  let replaced = false;
  for (const entry of parsed.entries) {
    if (entry.kind === 'key' && entry.key === key) {
      entry.rawValue = formattedValue;
      entry.value = value;
      replaced = true;
    }
  }
  if (!replaced) {
    parsed.entries.push({ kind: 'key', key, rawValue: formattedValue, value });
  }

  await writeAtomic(path, serializeSecrets(parsed));
  return { path };
}

/**
 * Remove a key from the secrets file if present. Other entries are preserved.
 * Returns whether a key was actually removed.
 */
export async function unsetUserSecret(
  key: string,
  options: SaveSecretOptions = {},
): Promise<{ path: string; removed: boolean }> {
  if (!isValidKey(key)) throw new Error(`invalid env-style key: ${key}`);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = options.path ?? resolveSecretsPath(env);

  if (!existsSync(path)) return { path, removed: false };

  const parsed = parseSecretsText(await readFile(path, 'utf8'));
  const before = parsed.entries.length;
  parsed.entries = parsed.entries.filter((entry) => entry.kind !== 'key' || entry.key !== key);
  const removed = parsed.entries.length !== before;
  if (!removed) return { path, removed: false };

  await ensureSecretsDir(dirname(path), platform);
  await writeAtomic(path, serializeSecrets(parsed));
  return { path, removed: true };
}

function parseSecretsText(text: string): ParsedFile {
  const entries: FileEntry[] = [];
  const lines = text.split(/\r?\n/);
  // Drop a single trailing empty line so we round-trip cleanly.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const match = line.match(KEY_VALUE_PATTERN);
    if (!match) {
      entries.push({ kind: 'other', raw: line });
      continue;
    }
    const [, key, rawValue] = match;
    entries.push({ kind: 'key', key: key!, rawValue: rawValue!, value: unquote(rawValue!) });
  }
  return { entries };
}

function serializeSecrets(parsed: ParsedFile): string {
  const out: string[] = [];
  for (const entry of parsed.entries) {
    if (entry.kind === 'key') {
      out.push(`${entry.key}=${entry.rawValue}`);
    } else {
      out.push(entry.raw);
    }
  }
  return `${out.join('\n')}\n`;
}

function formatValue(value: string): string {
  // Quote values that include leading/trailing whitespace or shell-metas so the
  // file round-trips. Otherwise emit raw to match the existing bridge style.
  if (value === '') return '';
  if (/[\s"'#=]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
  }
  return value;
}

function isValidKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

async function ensureSecretsDir(dir: string, platform: NodeJS.Platform): Promise<void> {
  await mkdir(dir, { recursive: true, mode: SECRETS_DIR_MODE });
  if (platform === 'win32') return;
  try {
    const info = await stat(dir);
    if ((info.mode & 0o777) !== SECRETS_DIR_MODE) {
      await chmod(dir, SECRETS_DIR_MODE);
    }
  } catch {
    // best-effort
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, contents, { mode: SECRETS_FILE_MODE });
  // ensure perms even if umask altered the file (writeFile honors mode on
  // create but a pre-existing tmp should not happen — guard anyway).
  try {
    await chmod(tmp, SECRETS_FILE_MODE);
  } catch {
    // best-effort
  }
  await rename(tmp, path);
}
