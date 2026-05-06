import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCOUNT_NAME_PATTERN,
  AccountNameError,
  accountSecretKey,
  isValidAccountName,
  resolveAccountPath,
} from '../claude/accountValidation.js';

describe('claude account name validation', () => {
  it('accepts plausible names and rejects edge cases', () => {
    const accept = ['work', 'alt-key', 'A', 'x1.y2', 'team_personal', 'a-b_c.1'];
    const reject = ['', '.', '..', '../escape', './x', '.hidden', '-leading', '/abs', 'has space', 'a..b', 'utfé', 'a/b', 'a\nb', 'a'.repeat(65)];
    for (const name of accept) {
      assert.ok(isValidAccountName(name), `expected ${JSON.stringify(name)} to be accepted`);
      assert.match(name, ACCOUNT_NAME_PATTERN);
    }
    for (const name of reject) {
      assert.equal(isValidAccountName(name), false, `expected ${JSON.stringify(name)} to be rejected`);
    }
  });

  it('resolveAccountPath enforces containment and rejects escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-accounts-'));
    assert.equal(resolveAccountPath(root, 'good'), join(root, 'good'));
    assert.throws(() => resolveAccountPath(root, '..'), AccountNameError);
    assert.throws(() => resolveAccountPath(root, '../escape'), AccountNameError);
    assert.throws(() => resolveAccountPath(root, '.'), AccountNameError);
    assert.throws(() => resolveAccountPath(root, '/etc/passwd'), AccountNameError);
  });

  it('accountSecretKey produces deterministic, distinct keys for slug-collisions', () => {
    const altKey = accountSecretKey('alt-key');
    const altUnderscore = accountSecretKey('alt_key');
    assert.match(altKey, /^ANTHROPIC_API_KEY__alt_key__[A-Z2-7]{8}$/);
    assert.match(altUnderscore, /^ANTHROPIC_API_KEY__alt_key__[A-Z2-7]{8}$/);
    assert.notEqual(altKey, altUnderscore, 'slug-and-hash must distinguish slug-collisions');
    // Idempotent
    assert.equal(accountSecretKey('alt-key'), altKey);
  });

  it('accountSecretKey output satisfies the userSecrets isValidKey pattern', () => {
    const value = accountSecretKey('work.account-1');
    assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it('accountSecretKey rejects invalid names', () => {
    assert.throws(() => accountSecretKey('..'), AccountNameError);
    assert.throws(() => accountSecretKey(''), AccountNameError);
  });
});

import { appendRotationEntry, ROTATION_HISTORY_CAP, type ClaudeRotationHistoryEntry } from '../claude/accountBinding.js';

describe('appendRotationEntry truncation', () => {
  function makeEntry(index: number): ClaudeRotationHistoryEntry {
    // T-COR3: mix `resumed` values across the loop so the truncation
    // regression also exercises the new optional field. true / false /
    // undefined cover all observable shapes.
    const resumedRotation = index % 3;
    const resumed = resumedRotation === 0 ? true : resumedRotation === 1 ? false : undefined;
    const entry: ClaudeRotationHistoryEntry = {
      parent_run_id: `run-${index}`,
      prior_account: 'a',
      new_account: 'b',
      parent_error_category: 'rate_limit',
      rotated_at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    };
    if (resumed !== undefined) {
      entry.resumed = resumed;
    }
    return entry;
  }

  it('does not truncate when total length stays at cap', () => {
    let history: Array<ClaudeRotationHistoryEntry | { truncated_count: number }> = [];
    for (let i = 1; i <= ROTATION_HISTORY_CAP; i += 1) {
      const result = appendRotationEntry(history, makeEntry(i));
      history = result.history;
      assert.equal(result.truncated, false);
    }
    assert.equal(history.length, ROTATION_HISTORY_CAP);
    // No marker should appear yet.
    const head = history[0];
    assert.ok(head && !('truncated_count' in (head as Record<string, unknown>)));
  });

  it('drops oldest entries and emits a truncation marker once the cap is exceeded', () => {
    // 32 plain entries already, then push 3 more so the marker reflects 4 drops.
    let history: Array<ClaudeRotationHistoryEntry | { truncated_count: number }> = [];
    for (let i = 1; i <= ROTATION_HISTORY_CAP + 3; i += 1) {
      const result = appendRotationEntry(history, makeEntry(i));
      history = result.history;
    }
    assert.equal(history.length, ROTATION_HISTORY_CAP, 'final length must equal cap');
    const marker = history[0];
    assert.ok(
      marker && typeof marker === 'object' && 'truncated_count' in (marker as Record<string, unknown>),
      'leading entry must be the truncation marker',
    );
    assert.ok((marker as { truncated_count: number }).truncated_count > 0);
    // Last entry must be the most recently appended one.
    const last = history[history.length - 1] as ClaudeRotationHistoryEntry;
    assert.equal(last.parent_run_id, `run-${ROTATION_HISTORY_CAP + 3}`);
  });

  it('terminates without infinite-looping for 100+ appends and tracks cumulative drops', () => {
    let history: Array<ClaudeRotationHistoryEntry | { truncated_count: number }> = [];
    const totalAppends = 100;
    for (let i = 1; i <= totalAppends; i += 1) {
      const result = appendRotationEntry(history, makeEntry(i));
      history = result.history;
    }
    assert.equal(history.length, ROTATION_HISTORY_CAP);
    const marker = history[0] as { truncated_count: number };
    assert.ok('truncated_count' in marker);
    // Real entries occupy cap-1 slots; marker counts every dropped entry.
    const expectedDropped = totalAppends - (ROTATION_HISTORY_CAP - 1);
    assert.equal(marker.truncated_count, expectedDropped);
  });
});
