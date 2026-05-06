import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  ACCOUNT_NAME_PATTERN,
  AccountNameError,
  DEFAULT_COOLDOWN_SECONDS,
  isValidAccountName,
  resolveAccountPath,
  accountSecretKey,
} from './accountValidation.js';
import type { WorkerEnvPolicy } from '../backend/WorkerBackend.js';
import { loadUserSecrets, type LoadedSecrets } from '../auth/userSecrets.js';

const REGISTRY_VERSION = 1 as const;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Env-scrub deny list (D12 / D19 / HAT1). Locked at the verified deep-dive
 * list. Any change requires HAT1 approval.
 */
export const CLAUDE_ENV_SCRUB_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CONFIG_DIR',
  'CLAUDECODE',
] as const;

export const CLAUDE_ENV_SCRUB_GLOBS = [
  'ANTHROPIC_*',
  '*_API_KEY',
  '*_AUTH_TOKEN',
  '*_ACCESS_TOKEN',
  '*_SECRET_KEY',
  '*_BEARER_TOKEN',
  '*_SESSION_TOKEN',
] as const;

export const CLAUDE_ACCOUNT_ENV_POLICY: WorkerEnvPolicy = {
  scrub: [...CLAUDE_ENV_SCRUB_KEYS],
  scrubGlobs: [...CLAUDE_ENV_SCRUB_GLOBS],
};

export type AccountMode = 'config_dir' | 'api_env';

export interface AccountEntry {
  name: string;
  mode: AccountMode;
  config_dir_path?: string;
  secret_key?: string;
  registered_at: string;
  last_error_category?: string;
  cooldown_until_ms?: number;
}

const AccountEntrySchema = z.object({
  name: z.string().min(1),
  mode: z.enum(['config_dir', 'api_env']),
  config_dir_path: z.string().optional(),
  secret_key: z.string().optional(),
  registered_at: z.string().min(1),
  last_error_category: z.string().optional(),
  cooldown_until_ms: z.number().int().nonnegative().optional(),
});

const RegistryFileSchema = z.object({
  version: z.literal(REGISTRY_VERSION),
  accounts: z.array(AccountEntrySchema),
});

export type AccountRegistryFile = z.infer<typeof RegistryFileSchema>;

export interface AccountRegistryPaths {
  /** Daemon home (`<run_store>`). */
  home: string;
  /** `<run_store>/claude/`. */
  root: string;
  /** `<run_store>/claude/accounts.json`. */
  registry: string;
  /** `<run_store>/claude/accounts/`. */
  accountsRoot: string;
}

export function accountRegistryPaths(home: string): AccountRegistryPaths {
  const root = join(home, 'claude');
  return {
    home,
    root,
    registry: join(root, 'accounts.json'),
    accountsRoot: join(root, 'accounts'),
  };
}

export interface RegistryLoadResult {
  ok: true;
  file: AccountRegistryFile;
  recovered?: 'corrupt' | 'absent';
}

export interface RegistryLoadError {
  ok: false;
  reason: 'version_mismatch';
  observed_version: unknown;
}

export type RegistryLoadOutcome = RegistryLoadResult | RegistryLoadError;

/**
 * Read `<run_store>/claude/accounts.json`. Missing files produce an empty
 * registry. Corrupted JSON is reset to an empty registry with a marker so the
 * caller can log a warning. A schema-version mismatch is surfaced as an error
 * (`INVALID_STATE` at the orchestrator boundary).
 */
export async function loadAccountRegistry(paths: AccountRegistryPaths): Promise<RegistryLoadOutcome> {
  let raw: string;
  try {
    raw = await readFile(paths.registry, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: true, file: emptyRegistry(), recovered: 'absent' };
    }
    return { ok: true, file: emptyRegistry(), recovered: 'corrupt' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: true, file: emptyRegistry(), recovered: 'corrupt' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: true, file: emptyRegistry(), recovered: 'corrupt' };
  }
  const observedVersion = (parsed as { version?: unknown }).version;
  if (observedVersion !== REGISTRY_VERSION) {
    return { ok: false, reason: 'version_mismatch', observed_version: observedVersion };
  }
  const validated = RegistryFileSchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: true, file: emptyRegistry(), recovered: 'corrupt' };
  }
  return { ok: true, file: validated.data };
}

function emptyRegistry(): AccountRegistryFile {
  return { version: REGISTRY_VERSION, accounts: [] };
}

export async function ensureRegistryRoots(paths: AccountRegistryPaths): Promise<void> {
  await mkdir(paths.accountsRoot, { recursive: true, mode: DIR_MODE });
}

async function writeRegistryAtomic(paths: AccountRegistryPaths, file: AccountRegistryFile): Promise<void> {
  await mkdir(dirname(paths.registry), { recursive: true, mode: DIR_MODE });
  const tmp = `${paths.registry}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: FILE_MODE });
  try {
    await rename(tmp, paths.registry);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

const registryLocks = new Map<string, Promise<void>>();

/**
 * Serialize per-registry-file read/validate/write so concurrent writers cannot
 * race each other. Mirrors the worker-profile lock pattern in
 * `OrchestratorService`.
 */
export async function withAccountRegistryLock<T>(
  paths: AccountRegistryPaths,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = registryLocks.get(paths.registry) ?? Promise.resolve();
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => released);
  registryLocks.set(paths.registry, tail);
  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (registryLocks.get(paths.registry) === tail) {
      registryLocks.delete(paths.registry);
    }
  }
}

export interface ListAccountsOptions {
  now?: number;
}

export interface AccountStatus {
  /** Cooled-down at `now`. */
  cooled_down: boolean;
  /** Cooldown expiry (`undefined` when not cooled-down). */
  cooldown_until_ms?: number;
  /** Last classified error category. */
  last_error_category?: string;
}

export function accountStatusAt(account: AccountEntry, now: number): AccountStatus {
  if (account.cooldown_until_ms && account.cooldown_until_ms > now) {
    return {
      cooled_down: true,
      cooldown_until_ms: account.cooldown_until_ms,
      last_error_category: account.last_error_category,
    };
  }
  return { cooled_down: false, last_error_category: account.last_error_category };
}

export interface ResolveAccountSpawnInput {
  paths: AccountRegistryPaths;
  account: AccountEntry;
  /** Override for tests. */
  loadSecrets?: (env?: NodeJS.ProcessEnv) => LoadedSecrets;
}

export interface ResolveAccountSpawnResult {
  ok: true;
  env: Record<string, string>;
  envPolicy: WorkerEnvPolicy;
}

export interface ResolveAccountSpawnError {
  ok: false;
  reason: 'missing_account_secret' | 'missing_config_dir' | 'tampered_account_config_dir';
  account: string;
  details: Record<string, unknown>;
}

/**
 * Build the `accountSpawn` contribution for an account. Returns the env to
 * inject and the deny-list policy. Fails fast (no fallback) when an
 * `api_env` account's `secret_key` is missing or empty.
 */
export function resolveAccountSpawn(input: ResolveAccountSpawnInput): ResolveAccountSpawnResult | ResolveAccountSpawnError {
  const { account, paths } = input;
  if (account.mode === 'config_dir') {
    if (!account.config_dir_path) {
      return {
        ok: false,
        reason: 'missing_config_dir',
        account: account.name,
        details: { account: account.name },
      };
    }
    // Defence in depth: a tampered registry could point CLAUDE_CONFIG_DIR
    // outside <run_store>/claude/accounts/, allowing a spawned Claude to
    // read/write arbitrary directories. Recompute the expected path with the
    // same containment-checking helper used at registration time and refuse
    // to spawn if the stored path no longer matches.
    let expected: string;
    try {
      expected = resolveAccountPath(paths.accountsRoot, account.name);
    } catch {
      return {
        ok: false,
        reason: 'tampered_account_config_dir',
        account: account.name,
        details: { account: account.name, stored: account.config_dir_path },
      };
    }
    if (account.config_dir_path !== expected) {
      return {
        ok: false,
        reason: 'tampered_account_config_dir',
        account: account.name,
        details: { account: account.name, expected, stored: account.config_dir_path },
      };
    }
    return {
      ok: true,
      env: { CLAUDE_CONFIG_DIR: expected },
      envPolicy: CLAUDE_ACCOUNT_ENV_POLICY,
    };
  }
  if (account.mode === 'api_env') {
    const secretKey = account.secret_key;
    if (!secretKey) {
      return {
        ok: false,
        reason: 'missing_account_secret',
        account: account.name,
        details: { account: account.name, secret_key: null },
      };
    }
    const loaded = (input.loadSecrets ?? loadUserSecrets)();
    const value = loaded.values?.[secretKey];
    if (typeof value !== 'string' || value.length === 0) {
      return {
        ok: false,
        reason: 'missing_account_secret',
        account: account.name,
        details: { account: account.name, secret_key: secretKey },
      };
    }
    // Re-confirm path via paths reference (not strictly needed for api_env, but keeps the
    // function shape uniform and ensures we read from the daemon home configured for
    // this orchestrator).
    void paths;
    return {
      ok: true,
      env: { ANTHROPIC_API_KEY: value },
      envPolicy: CLAUDE_ACCOUNT_ENV_POLICY,
    };
  }
  // Exhaustiveness — should be unreachable for valid registry entries.
  return {
    ok: false,
    reason: 'missing_config_dir',
    account: (account as AccountEntry).name,
    details: { account: (account as AccountEntry).name, reason: 'unknown_mode' },
  };
}

export interface UpsertAccountInput {
  name: string;
  mode: AccountMode;
  /** When mode === "config_dir", the resolved daemon-owned dir. */
  configDirPath?: string;
  /** When mode === "api_env", the userSecrets key reference. */
  secretKey?: string;
  /** Override for `Date.now()`. */
  now?: number;
}

export interface UpsertAccountResult {
  account: AccountEntry;
  created: boolean;
  previous: AccountEntry | null;
}

export async function upsertAccount(
  paths: AccountRegistryPaths,
  input: UpsertAccountInput,
): Promise<UpsertAccountResult> {
  if (!isValidAccountName(input.name)) {
    throw new AccountNameError(`invalid account name: ${JSON.stringify(input.name)}`);
  }
  const nowIso = new Date(input.now ?? Date.now()).toISOString();
  return withAccountRegistryLock(paths, async () => {
    const loaded = await loadAccountRegistry(paths);
    if (!loaded.ok) {
      throw new AccountRegistryError('version_mismatch', `claude account registry version mismatch (${String(loaded.observed_version)})`);
    }
    const accounts = [...loaded.file.accounts];
    const previousIndex = accounts.findIndex((entry) => entry.name === input.name);
    const previous = previousIndex === -1 ? null : { ...accounts[previousIndex]! };
    const next: AccountEntry = {
      name: input.name,
      mode: input.mode,
      registered_at: previous?.registered_at ?? nowIso,
    };
    if (input.mode === 'config_dir') {
      next.config_dir_path = input.configDirPath ?? resolveAccountPath(paths.accountsRoot, input.name);
    } else {
      next.secret_key = input.secretKey ?? accountSecretKey(input.name);
    }
    if (previousIndex === -1) {
      accounts.push(next);
    } else {
      accounts[previousIndex] = next;
    }
    await writeRegistryAtomic(paths, { version: REGISTRY_VERSION, accounts });
    return { account: next, created: previousIndex === -1, previous };
  });
}

export interface RemoveAccountResult {
  removed: boolean;
  previous: AccountEntry | null;
}

export async function removeAccount(paths: AccountRegistryPaths, name: string): Promise<RemoveAccountResult> {
  if (!isValidAccountName(name)) {
    throw new AccountNameError(`invalid account name: ${JSON.stringify(name)}`);
  }
  return withAccountRegistryLock(paths, async () => {
    const loaded = await loadAccountRegistry(paths);
    if (!loaded.ok) {
      throw new AccountRegistryError('version_mismatch', `claude account registry version mismatch (${String(loaded.observed_version)})`);
    }
    const accounts = [...loaded.file.accounts];
    const index = accounts.findIndex((entry) => entry.name === name);
    if (index === -1) return { removed: false, previous: null };
    const previous = { ...accounts[index]! };
    accounts.splice(index, 1);
    await writeRegistryAtomic(paths, { version: REGISTRY_VERSION, accounts });
    return { removed: true, previous };
  });
}

export interface MarkCooledDownInput {
  name: string;
  cooldownSeconds: number;
  errorCategory: string;
  now?: number;
}

export async function markAccountCooledDown(
  paths: AccountRegistryPaths,
  input: MarkCooledDownInput,
): Promise<AccountEntry | null> {
  if (!isValidAccountName(input.name)) return null;
  if (!Number.isFinite(input.cooldownSeconds) || input.cooldownSeconds <= 0) return null;
  return withAccountRegistryLock(paths, async () => {
    const loaded = await loadAccountRegistry(paths);
    if (!loaded.ok) return null;
    const accounts = [...loaded.file.accounts];
    const index = accounts.findIndex((entry) => entry.name === input.name);
    if (index === -1) return null;
    const now = input.now ?? Date.now();
    const next: AccountEntry = {
      ...accounts[index]!,
      cooldown_until_ms: now + input.cooldownSeconds * 1000,
      last_error_category: input.errorCategory,
    };
    accounts[index] = next;
    await writeRegistryAtomic(paths, { version: REGISTRY_VERSION, accounts });
    return next;
  });
}

export async function clearExpiredCooldowns(
  paths: AccountRegistryPaths,
  now: number = Date.now(),
): Promise<number> {
  return withAccountRegistryLock(paths, async () => {
    const loaded = await loadAccountRegistry(paths);
    if (!loaded.ok) return 0;
    const accounts = [...loaded.file.accounts];
    let cleared = 0;
    for (let index = 0; index < accounts.length; index += 1) {
      const entry = accounts[index]!;
      if (entry.cooldown_until_ms !== undefined && entry.cooldown_until_ms <= now) {
        const next = { ...entry };
        delete next.cooldown_until_ms;
        accounts[index] = next;
        cleared += 1;
      }
    }
    if (cleared === 0) return 0;
    await writeRegistryAtomic(paths, { version: REGISTRY_VERSION, accounts });
    return cleared;
  });
}

export class AccountRegistryError extends Error {
  reason: 'version_mismatch';
  constructor(reason: 'version_mismatch', message: string) {
    super(message);
    this.name = 'AccountRegistryError';
    this.reason = reason;
  }
}

export interface AccountStatusEntry {
  account: AccountEntry;
  status: 'ready' | 'cooled_down' | 'incomplete';
  message: string;
  cooled_down: boolean;
  cooldown_until_ms?: number;
  last_error_category?: string;
  /** Filesystem-level reason for `incomplete` status (config_dir mode only). */
  incomplete_reason?: 'missing_config_dir';
}

/**
 * Inspect each account against the live registry + filesystem at `now`. Used
 * by `auth list claude` and the `claude` diagnostic.
 */
export async function describeAccounts(
  paths: AccountRegistryPaths,
  now: number = Date.now(),
): Promise<AccountStatusEntry[]> {
  const loaded = await loadAccountRegistry(paths);
  if (!loaded.ok) return [];
  const out: AccountStatusEntry[] = [];
  for (const account of loaded.file.accounts) {
    const baseStatus = accountStatusAt(account, now);
    let status: AccountStatusEntry['status'] = baseStatus.cooled_down ? 'cooled_down' : 'ready';
    let message = '';
    let incompleteReason: AccountStatusEntry['incomplete_reason'];
    if (account.mode === 'config_dir' && account.config_dir_path) {
      try {
        await stat(account.config_dir_path);
      } catch {
        status = 'incomplete';
        incompleteReason = 'missing_config_dir';
      }
    }
    if (account.mode === 'api_env') {
      const loadedSecrets = loadUserSecrets();
      const secretKey = account.secret_key;
      const secretValue = secretKey ? loadedSecrets.values[secretKey] : undefined;
      if (!secretValue) {
        status = 'incomplete';
      }
    }
    if (status === 'ready') {
      message = 'ready';
    } else if (status === 'cooled_down' && baseStatus.cooldown_until_ms) {
      const cooldownIso = new Date(baseStatus.cooldown_until_ms).toISOString();
      message = `cooled until ${cooldownIso}${baseStatus.last_error_category ? `, last_error: ${baseStatus.last_error_category}` : ''}`;
    } else if (status === 'incomplete') {
      message = incompleteReason === 'missing_config_dir'
        ? `config_dir missing at ${account.config_dir_path}`
        : 'api_env secret missing';
    }
    out.push({
      account,
      status,
      message,
      cooled_down: baseStatus.cooled_down,
      cooldown_until_ms: baseStatus.cooldown_until_ms,
      last_error_category: baseStatus.last_error_category,
      incomplete_reason: incompleteReason,
    });
  }
  return out;
}

/**
 * Pure helper used by `accountSpawn` resolution / rotation logic. Returns the
 * first non-cooled-down account in `priority` that is registered. Useful so
 * call sites can keep their own data-flow but share selection rules.
 */
export function pickHealthyAccount(
  accounts: AccountEntry[],
  priority: string[],
  now: number = Date.now(),
): { picked: AccountEntry | null; cooldownSummary: Record<string, number | undefined> } {
  const map = new Map(accounts.map((entry) => [entry.name, entry] as const));
  const cooldownSummary: Record<string, number | undefined> = {};
  for (const name of priority) {
    const entry = map.get(name);
    if (!entry) continue;
    const status = accountStatusAt(entry, now);
    cooldownSummary[name] = status.cooldown_until_ms;
    if (!status.cooled_down) return { picked: entry, cooldownSummary };
  }
  return { picked: null, cooldownSummary };
}

export function defaultClaudeCooldownSeconds(): number {
  return DEFAULT_COOLDOWN_SECONDS;
}

export function isValidClaudeAccountName(name: string): boolean {
  return isValidAccountName(name);
}

export function ensureExistingAccount(
  accounts: AccountEntry[],
  name: string,
): AccountEntry | null {
  return accounts.find((entry) => entry.name === name) ?? null;
}

export interface AccountConfigDirInitOptions {
  /** Override for tests. */
  now?: number;
}

/**
 * Create the daemon-owned `<run_store>/claude/accounts/<name>/` directory
 * with `0o700` permissions; idempotent. Returns the resolved absolute path.
 */
export async function ensureAccountConfigDir(
  paths: AccountRegistryPaths,
  name: string,
): Promise<string> {
  const target = resolveAccountPath(paths.accountsRoot, name);
  await mkdir(target, { recursive: true, mode: DIR_MODE });
  return target;
}

export async function deleteAccountConfigDir(
  paths: AccountRegistryPaths,
  name: string,
): Promise<boolean> {
  const target = resolveAccountPath(paths.accountsRoot, name);
  if (!existsSync(target)) return false;
  await rm(target, { recursive: true, force: true });
  return true;
}

// Re-export the validation helper for one-stop import.
export { ACCOUNT_NAME_PATTERN, AccountNameError, isValidAccountName, resolveAccountPath };
