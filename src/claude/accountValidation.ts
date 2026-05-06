import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';

/**
 * Account-name regex per plan D4: must start with an alphanumeric, allow
 * `[A-Za-z0-9._-]`, max 64 chars, no leading dot/dash, no embedded `/`,
 * no whitespace.
 */
export const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Maximum cooldown TTL — 24 hours in seconds (D4 / D6).
 */
export const MAX_COOLDOWN_SECONDS = 24 * 60 * 60;

/**
 * Daemon-side default cooldown when no per-profile override is supplied.
 */
export const DEFAULT_COOLDOWN_SECONDS = 15 * 60;

/**
 * Format-only validation for account names. Used at the contract boundary by
 * Zod refinements; the registry layer additionally calls
 * {@link assertAccountPathSafe} before any filesystem operation.
 */
export function isValidAccountName(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (value === '.' || value === '..') return false;
  if (value.includes('..')) return false;
  return ACCOUNT_NAME_PATTERN.test(value);
}

/**
 * Defensive resolved-path containment check (D4). Treated as a security-class
 * error rather than a typo. Returns the resolved absolute account directory
 * when it stays inside `accountsRoot`, otherwise throws.
 */
export function resolveAccountPath(accountsRoot: string, name: string): string {
  if (!isValidAccountName(name)) {
    throw new AccountNameError(`invalid account name: ${JSON.stringify(name)}`);
  }
  const root = resolve(accountsRoot);
  const candidate = resolve(root, name);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) {
    throw new AccountNameError(`account name ${JSON.stringify(name)} escapes accounts root`);
  }
  if (candidate === root) {
    throw new AccountNameError(`account name ${JSON.stringify(name)} resolves to accounts root itself`);
  }
  return candidate;
}

export class AccountNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountNameError';
  }
}

/**
 * Slug-and-hash transform from D11 producing a deterministic
 * `userSecrets`-compatible key for an `api_env` account secret.
 *
 * Implemented in this module so contract / capabilities / auth CLI / service
 * layers all agree on the same key shape.
 */
export function accountSecretKey(name: string): string {
  if (!isValidAccountName(name)) {
    throw new AccountNameError(`invalid account name: ${JSON.stringify(name)}`);
  }
  const slug = name.replace(/[^A-Za-z0-9_]/g, '_');
  const suffix = base32Sha256Prefix(name, 8);
  return `ANTHROPIC_API_KEY__${slug}__${suffix}`;
}

/**
 * Base32 (RFC 4648, alphabet A-Z2-7) encoding of the SHA-256 hash of `value`,
 * truncated to `length` characters. Returns uppercase. Pure userland — no
 * external dependency.
 */
function base32Sha256Prefix(value: string, length: number): string {
  const digest = createHash('sha256').update(value, 'utf8').digest();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of digest) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      bits -= 5;
      out += alphabet[(acc >> bits) & 0x1f];
    }
    if (out.length >= length) break;
  }
  return out;
}
