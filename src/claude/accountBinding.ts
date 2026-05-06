import {
  accountRegistryPaths,
  defaultClaudeCooldownSeconds,
  loadAccountRegistry,
  pickHealthyAccount,
  resolveAccountSpawn,
  type AccountEntry,
  type AccountRegistryPaths,
} from './accountRegistry.js';
import { isValidAccountName } from './accountValidation.js';
import type { OrchestratorError } from '../contract.js';
import { orchestratorError } from '../contract.js';
import type { AccountSpawnContribution } from '../backend/runtime.js';

export type AccountBindingSource = 'profile' | 'direct';

/**
 * Frozen rotation context carried on `RunSummary.metadata.claude_rotation_state`
 * (D9). Reading it back from the parent run is the only state that matters
 * for `send_followup`; the live profile manifest is not re-resolved.
 */
export interface ClaudeRotationState {
  accounts: string[];
  cooldown_seconds: number;
  source: AccountBindingSource;
  frozen_at: string;
}

export interface ClaudeRotationHistoryEntry {
  parent_run_id: string;
  prior_account: string;
  new_account: string;
  parent_error_category: string;
  rotated_at: string;
  /**
   * T-COR3 (BI-COR6): true iff resume was *attempted* in this rotation step
   * (the daemon selected and spawned `runtime.resume(<sid>)`). Independent of
   * whether the child later succeeded or got rejected for `session_not_found`
   * — those outcomes live in `terminal_context` on the run record itself.
   * Optional / absent on legacy entries.
   */
  resumed?: boolean;
}

export const ROTATION_HISTORY_CAP = 32;

export interface ResolvedAccountBinding {
  account: AccountEntry;
  accountSpawn: AccountSpawnContribution;
  /** Frozen rotation state to persist on the run, if rotation is enabled. */
  rotationState: ClaudeRotationState | null;
  /** Cooldown TTL (seconds) for this binding. */
  cooldownSeconds: number;
}

export interface AccountBindingInput {
  /** Daemon home — pinned via `OrchestratorService.store.root`. */
  home: string;
  /** Account name to use as the active account, if specified. */
  account?: string;
  /**
   * Priority list. When set, `account` (if provided) MUST be a member; the
   * resolver picks the first non-cooled-down account from this list at
   * binding time.
   */
  priority?: string[];
  /** Per-binding cooldown TTL override (D6). */
  cooldownSecondsOverride?: number;
  /** Where the binding came from. */
  source: AccountBindingSource;
  /** Override `Date.now()` for tests / determinism. */
  now?: number;
}

export type AccountBindingOutcome =
  | { ok: true; value: ResolvedAccountBinding }
  | { ok: false; error: OrchestratorError };

/**
 * Resolve a Claude account binding for a `start_run` (or rotated
 * `send_followup`) call. Validates that all referenced names exist in the
 * registry, picks the first healthy account when a priority array is set,
 * and constructs the `accountSpawn` contribution with the env-scrub policy.
 */
export async function resolveClaudeAccountBinding(
  input: AccountBindingInput,
): Promise<AccountBindingOutcome> {
  const paths = accountRegistryPaths(input.home);
  const loaded = await loadAccountRegistry(paths);
  if (!loaded.ok) {
    return {
      ok: false,
      error: orchestratorError('INVALID_STATE', `claude account registry version mismatch (observed: ${String(loaded.observed_version)})`, {
        observed_version: loaded.observed_version,
      }),
    };
  }
  const accounts = loaded.file.accounts;
  const cooldownSeconds = input.cooldownSecondsOverride ?? defaultClaudeCooldownSeconds();

  if (input.priority && input.priority.length > 0) {
    for (const name of input.priority) {
      if (!accounts.find((entry) => entry.name === name)) {
        return {
          ok: false,
          error: orchestratorError('INVALID_INPUT', `claude account ${JSON.stringify(name)} is not registered`, {
            account: name,
          }),
        };
      }
    }
    if (input.account && !input.priority.includes(input.account)) {
      return {
        ok: false,
        error: orchestratorError('INVALID_INPUT', `claude_account ${JSON.stringify(input.account)} is not a member of the priority list`, {
          account: input.account,
        }),
      };
    }
    const { picked, cooldownSummary } = pickHealthyAccount(accounts, input.priority, input.now ?? Date.now());
    if (!picked) {
      return {
        ok: false,
        error: orchestratorError('INVALID_STATE', 'all claude accounts in the priority list are currently cooled-down', {
          cooldown_summary: cooldownSummary,
        }),
      };
    }
    const spawn = resolveAccountSpawn({ paths, account: picked });
    if (!spawn.ok) return { ok: false, error: spawnErrorToOrchestratorError(spawn) };
    return {
      ok: true,
      value: {
        account: picked,
        accountSpawn: { env: spawn.env, envPolicy: spawn.envPolicy },
        rotationState: {
          accounts: [...input.priority],
          cooldown_seconds: cooldownSeconds,
          source: input.source,
          frozen_at: new Date(input.now ?? Date.now()).toISOString(),
        },
        cooldownSeconds,
      },
    };
  }

  if (input.account) {
    const account = accounts.find((entry) => entry.name === input.account);
    if (!account) {
      return {
        ok: false,
        error: orchestratorError('INVALID_INPUT', `claude account ${JSON.stringify(input.account)} is not registered`, {
          account: input.account,
        }),
      };
    }
    const spawn = resolveAccountSpawn({ paths, account });
    if (!spawn.ok) return { ok: false, error: spawnErrorToOrchestratorError(spawn) };
    return {
      ok: true,
      value: {
        account,
        accountSpawn: { env: spawn.env, envPolicy: spawn.envPolicy },
        rotationState: null,
        cooldownSeconds,
      },
    };
  }

  return {
    ok: false,
    error: orchestratorError('INVALID_INPUT', 'resolveClaudeAccountBinding called with no account or priority'),
  };
}

function spawnErrorToOrchestratorError(error: {
  reason: 'missing_account_secret' | 'missing_config_dir' | 'tampered_account_config_dir';
  account: string;
  details: Record<string, unknown>;
}): OrchestratorError {
  if (error.reason === 'missing_account_secret') {
    return orchestratorError('INVALID_STATE', `claude account ${error.account} has no stored secret; run \`agent-orchestrator auth set claude --account ${error.account}\``, {
      reason: error.reason,
      ...error.details,
    });
  }
  if (error.reason === 'tampered_account_config_dir') {
    return orchestratorError('INVALID_STATE', `claude account ${error.account} stored config_dir does not match the daemon-owned path under <run_store>/claude/accounts/; refusing to spawn against a possibly-tampered registry entry`, {
      reason: error.reason,
      ...error.details,
    });
  }
  return orchestratorError('INVALID_STATE', `claude account ${error.account} has no daemon-owned config_dir; re-run \`agent-orchestrator auth login claude --account ${error.account}\``, {
    reason: error.reason,
    ...error.details,
  });
}

/**
 * Read a frozen rotation state off `RunSummary.metadata`. Returns null when
 * absent or shape-invalid (treated as "no rotation enabled").
 */
export function readRotationState(metadata: Record<string, unknown>): ClaudeRotationState | null {
  const value = metadata.claude_rotation_state;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const accounts = candidate.accounts;
  const cooldownSeconds = candidate.cooldown_seconds;
  const source = candidate.source;
  const frozenAt = candidate.frozen_at;
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  if (!accounts.every((name): name is string => typeof name === 'string' && isValidAccountName(name))) return null;
  if (typeof cooldownSeconds !== 'number' || !Number.isInteger(cooldownSeconds) || cooldownSeconds <= 0) return null;
  if (source !== 'profile' && source !== 'direct') return null;
  if (typeof frozenAt !== 'string') return null;
  return { accounts: accounts.slice(), cooldown_seconds: cooldownSeconds, source, frozen_at: frozenAt };
}

export function readAccountUsed(metadata: Record<string, unknown>): string | null {
  const value = metadata.claude_account_used;
  return typeof value === 'string' && isValidAccountName(value) ? value : null;
}

export function readRotationHistory(metadata: Record<string, unknown>): ClaudeRotationHistoryEntry[] {
  const value = metadata.claude_rotation_history;
  if (!Array.isArray(value)) return [];
  const out: ClaudeRotationHistoryEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.parent_run_id !== 'string') continue;
    if (typeof rec.prior_account !== 'string') continue;
    if (typeof rec.new_account !== 'string') continue;
    if (typeof rec.parent_error_category !== 'string') continue;
    if (typeof rec.rotated_at !== 'string') continue;
    const next: ClaudeRotationHistoryEntry = {
      parent_run_id: rec.parent_run_id,
      prior_account: rec.prior_account,
      new_account: rec.new_account,
      parent_error_category: rec.parent_error_category,
      rotated_at: rec.rotated_at,
    };
    if (typeof rec.resumed === 'boolean') next.resumed = rec.resumed;
    out.push(next);
  }
  return out;
}

export interface AppendRotationEntryResult {
  history: Array<ClaudeRotationHistoryEntry | { truncated_count: number }>;
  truncated: boolean;
}

export function appendRotationEntry(
  history: Array<ClaudeRotationHistoryEntry | { truncated_count: number }>,
  entry: ClaudeRotationHistoryEntry,
): AppendRotationEntryResult {
  // Single-pass: separate any pre-existing truncation marker(s) from real
  // entries so the cap calculation never has to compete with a marker for a
  // slot mid-loop (the previous loop was infinite once the marker took the
  // dropped slot).
  let existingTruncated = 0;
  const working: ClaudeRotationHistoryEntry[] = [];
  for (const item of history) {
    if (item && typeof item === 'object' && 'truncated_count' in (item as Record<string, unknown>)) {
      existingTruncated += (item as { truncated_count: number }).truncated_count;
    } else {
      working.push(item as ClaudeRotationHistoryEntry);
    }
  }
  working.push(entry);

  // No truncation needed and no prior marker — return the plain list.
  if (existingTruncated === 0 && working.length <= ROTATION_HISTORY_CAP) {
    return { history: working, truncated: false };
  }

  // Truncating: marker takes one slot, so cap real entries at cap-1.
  let dropped = 0;
  while (working.length > ROTATION_HISTORY_CAP - 1) {
    working.shift();
    dropped += 1;
  }
  const totalTruncated = existingTruncated + dropped;
  return {
    history: [{ truncated_count: totalTruncated }, ...working],
    truncated: dropped > 0,
  };
}

export type AccountBindingPaths = AccountRegistryPaths;
