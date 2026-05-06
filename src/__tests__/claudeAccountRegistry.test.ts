import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountRegistryPaths,
  CLAUDE_ACCOUNT_ENV_POLICY,
  CLAUDE_ENV_SCRUB_GLOBS,
  CLAUDE_ENV_SCRUB_KEYS,
  clearExpiredCooldowns,
  describeAccounts,
  loadAccountRegistry,
  markAccountCooledDown,
  pickHealthyAccount,
  removeAccount,
  upsertAccount,
} from '../claude/accountRegistry.js';

async function freshRegistry(): Promise<{ home: string }> {
  const home = await mkdtemp(join(tmpdir(), 'claude-registry-'));
  return { home };
}

describe('claude account registry CRUD', () => {
  it('returns an empty registry when the file is absent', async () => {
    const { home } = await freshRegistry();
    const loaded = await loadAccountRegistry(accountRegistryPaths(home));
    assert.ok(loaded.ok);
    if (loaded.ok) {
      assert.deepStrictEqual(loaded.file.accounts, []);
      assert.equal(loaded.recovered, 'absent');
    }
  });

  it('upserts and reads back an api_env account', async () => {
    const { home } = await freshRegistry();
    const paths = accountRegistryPaths(home);
    const result = await upsertAccount(paths, { name: 'work', mode: 'api_env', secretKey: 'ANTHROPIC_API_KEY__work__ABCDEFGH' });
    assert.equal(result.created, true);
    assert.equal(result.account.name, 'work');
    assert.equal(result.account.mode, 'api_env');
    const loaded = await loadAccountRegistry(paths);
    assert.ok(loaded.ok);
    if (loaded.ok) assert.equal(loaded.file.accounts.length, 1);
    // Registry stores only the secret_key reference, never raw secrets.
    const onDisk = await readFile(paths.registry, 'utf8');
    assert.ok(!onDisk.includes('sk-'), 'registry must not contain raw secret material');
  });

  it('rejects schema-version mismatch with INVALID_STATE-style outcome', async () => {
    const { home } = await freshRegistry();
    const paths = accountRegistryPaths(home);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.registry, JSON.stringify({ version: 99, accounts: [] }, null, 2));
    const loaded = await loadAccountRegistry(paths);
    assert.equal(loaded.ok, false);
    if (!loaded.ok) {
      assert.equal(loaded.reason, 'version_mismatch');
      assert.equal(loaded.observed_version, 99);
    }
  });

  it('recovers from corrupt JSON by treating it as empty', async () => {
    const { home } = await freshRegistry();
    const paths = accountRegistryPaths(home);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.registry, '{ this is not json');
    const loaded = await loadAccountRegistry(paths);
    assert.ok(loaded.ok);
    if (loaded.ok) {
      assert.equal(loaded.recovered, 'corrupt');
      assert.deepStrictEqual(loaded.file.accounts, []);
    }
  });

  it('removes an account by name', async () => {
    const { home } = await freshRegistry();
    const paths = accountRegistryPaths(home);
    await upsertAccount(paths, { name: 'work', mode: 'api_env' });
    const removed = await removeAccount(paths, 'work');
    assert.equal(removed.removed, true);
    assert.equal(removed.previous?.name, 'work');
    const loaded = await loadAccountRegistry(paths);
    assert.ok(loaded.ok && loaded.file.accounts.length === 0);
  });

  it('marks accounts cooled-down with TTL and clears expired entries', async () => {
    const { home } = await freshRegistry();
    const paths = accountRegistryPaths(home);
    await upsertAccount(paths, { name: 'work', mode: 'api_env' });
    const t0 = 1_000_000;
    const marked = await markAccountCooledDown(paths, {
      name: 'work',
      cooldownSeconds: 30,
      errorCategory: 'rate_limit',
      now: t0,
    });
    assert.equal(marked?.cooldown_until_ms, t0 + 30_000);
    assert.equal(marked?.last_error_category, 'rate_limit');
    const cleared = await clearExpiredCooldowns(paths, t0 + 60_000);
    assert.equal(cleared, 1);
    const loaded = await loadAccountRegistry(paths);
    assert.ok(loaded.ok);
    if (loaded.ok) assert.equal(loaded.file.accounts[0]!.cooldown_until_ms, undefined);
  });

  it('serializes concurrent upserts via the per-registry lock', async () => {
    const { home } = await freshRegistry();
    const paths = accountRegistryPaths(home);
    await Promise.all([
      upsertAccount(paths, { name: 'a', mode: 'api_env' }),
      upsertAccount(paths, { name: 'b', mode: 'api_env' }),
      upsertAccount(paths, { name: 'c', mode: 'api_env' }),
    ]);
    const loaded = await loadAccountRegistry(paths);
    assert.ok(loaded.ok);
    if (loaded.ok) {
      const names = loaded.file.accounts.map((entry) => entry.name).sort();
      assert.deepStrictEqual(names, ['a', 'b', 'c']);
    }
  });
});

describe('claude env scrub policy', () => {
  it('exposes the verified deny list (D12 / D19) without modification', () => {
    assert.deepStrictEqual([...CLAUDE_ENV_SCRUB_KEYS], [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'CLAUDE_CONFIG_DIR',
      'CLAUDECODE',
    ]);
    assert.deepStrictEqual([...CLAUDE_ENV_SCRUB_GLOBS], [
      'ANTHROPIC_*',
      '*_API_KEY',
      '*_AUTH_TOKEN',
      '*_ACCESS_TOKEN',
      '*_SECRET_KEY',
      '*_BEARER_TOKEN',
      '*_SESSION_TOKEN',
    ]);
    assert.deepStrictEqual(CLAUDE_ACCOUNT_ENV_POLICY.scrub, [...CLAUDE_ENV_SCRUB_KEYS]);
    assert.deepStrictEqual(CLAUDE_ACCOUNT_ENV_POLICY.scrubGlobs, [...CLAUDE_ENV_SCRUB_GLOBS]);
  });
});

describe('claude account picker', () => {
  it('skips cooled-down accounts and returns the cooldown summary', () => {
    const now = 100_000;
    const result = pickHealthyAccount([
      { name: 'a', mode: 'api_env', registered_at: 'now', cooldown_until_ms: now + 1_000 },
      { name: 'b', mode: 'api_env', registered_at: 'now' },
    ], ['a', 'b'], now);
    assert.equal(result.picked?.name, 'b');
    assert.equal(result.cooldownSummary.a, now + 1_000);
  });

  it('returns null when every account in the priority is cooled-down', () => {
    const now = 100_000;
    const result = pickHealthyAccount([
      { name: 'a', mode: 'api_env', registered_at: 'now', cooldown_until_ms: now + 1_000 },
    ], ['a'], now);
    assert.equal(result.picked, null);
  });
});

describe('claude account describeAccounts', () => {
  it('marks api_env accounts incomplete when no secret is available', async () => {
    const { home } = await freshRegistry();
    const paths = accountRegistryPaths(home);
    await upsertAccount(paths, { name: 'work', mode: 'api_env' });
    const entries = await describeAccounts(paths);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.account.name, 'work');
    assert.equal(entries[0]!.status, 'incomplete');
  });
});
