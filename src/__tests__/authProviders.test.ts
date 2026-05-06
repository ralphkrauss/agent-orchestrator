import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_PROVIDERS, getProvider } from '../auth/providers.js';

describe('auth providers registry', () => {
  it('exposes cursor and claude as wired and codex as reserved', () => {
    const cursor = getProvider('cursor');
    const claude = getProvider('claude');
    const codex = getProvider('codex');
    assert.equal(cursor?.status, 'wired');
    assert.equal(claude?.status, 'wired');
    assert.equal(codex?.status, 'reserved');
    assert.deepStrictEqual(AUTH_PROVIDERS.map((provider) => provider.id), ['cursor', 'claude', 'codex']);
  });

  it('cursor primaryEnvVar is CURSOR_API_KEY', () => {
    const cursor = getProvider('cursor');
    assert.equal(cursor?.primaryEnvVar, 'CURSOR_API_KEY');
    assert.deepStrictEqual(cursor?.envVars, ['CURSOR_API_KEY']);
  });

  it('returns undefined for unknown providers', () => {
    assert.equal(getProvider('opencode'), undefined);
  });
});

describe('cursor key validation', () => {
  const cursor = getProvider('cursor');
  assert.ok(cursor);

  const goodKeys = [
    'a'.repeat(16),
    'A1b2C3-D4_e5.F6:G7H8',
    'sk_cursor_' + 'x'.repeat(40),
    'X'.repeat(512),
  ];
  for (const key of goodKeys) {
    it(`accepts plausible key (length=${key.length})`, () => {
      assert.deepStrictEqual(cursor!.validate(key), { ok: true });
    });
  }

  it('rejects empty/whitespace-only', () => {
    const r1 = cursor!.validate('');
    assert.equal(r1.ok, false);
    const r2 = cursor!.validate('   ');
    assert.equal(r2.ok, false);
  });

  it('rejects values shorter than 16 chars', () => {
    const r = cursor!.validate('short');
    assert.equal(r.ok, false);
  });

  it('rejects values longer than 512 chars', () => {
    const r = cursor!.validate('A'.repeat(513));
    assert.equal(r.ok, false);
  });

  it('rejects whitespace inside the value', () => {
    const r = cursor!.validate('abcdef ghijkl mnop');
    assert.equal(r.ok, false);
  });

  it('rejects values with invalid characters', () => {
    const r = cursor!.validate('valid_key_chars_but/with-slash');
    assert.equal(r.ok, false);
  });

  it('rejects leading/trailing whitespace explicitly', () => {
    const r = cursor!.validate(' ' + 'a'.repeat(20));
    assert.equal(r.ok, false);
  });
});
