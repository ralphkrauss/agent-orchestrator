import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enforceWritableProfilesPolicy, harnessPolicyContext } from '../serverPolicy.js';

describe('enforceWritableProfilesPolicy', () => {
  it('returns null when the env pin is not set so non-Claude clients are unaffected', () => {
    const result = enforceWritableProfilesPolicy(
      'upsert_worker_profile',
      { profiles_file: '/anywhere/profiles.json' },
      { HOME: '/h' },
      '/repo',
    );
    assert.equal(result, null);
  });

  it('returns null for tools other than upsert_worker_profile even when the pin is set', () => {
    const result = enforceWritableProfilesPolicy(
      'list_worker_profiles',
      { profiles_file: '/anywhere/profiles.json' },
      { HOME: '/h', AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE: '/state/profiles.json' },
      '/repo',
    );
    assert.equal(result, null);
  });

  it('allows upsert_worker_profile when the requested path resolves to the pinned manifest', () => {
    const result = enforceWritableProfilesPolicy(
      'upsert_worker_profile',
      { profiles_file: '/state/profiles.json' },
      { HOME: '/h', AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE: '/state/profiles.json' },
      '/repo',
    );
    assert.equal(result, null);
  });

  it('allows upsert_worker_profile when no profiles_file is provided but the default resolves to the pin', () => {
    // The pinned path is the default profile path, so passing no profiles_file
    // should resolve to the same canonical location.
    const result = enforceWritableProfilesPolicy(
      'upsert_worker_profile',
      {},
      { HOME: '/h', XDG_CONFIG_HOME: '/h/.config', AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE: '/h/.config/agent-orchestrator/profiles.json' },
      '/repo',
    );
    assert.equal(result, null);
  });

  it('rejects upsert_worker_profile that targets a different absolute path', () => {
    const result = enforceWritableProfilesPolicy(
      'upsert_worker_profile',
      { profiles_file: '/etc/passwd' },
      { HOME: '/h', AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE: '/state/profiles.json' },
      '/repo',
    );
    assert.ok(result, 'expected an error');
    assert.equal(result?.code, 'INVALID_INPUT');
    assert.match(result?.message ?? '', /restricted to the harness-pinned profiles manifest/);
    assert.equal((result?.details as { profiles_file: string } | undefined)?.profiles_file, '/etc/passwd');
    assert.equal((result?.details as { allowed_profiles_file: string } | undefined)?.allowed_profiles_file, '/state/profiles.json');
  });

  it('rejects upsert_worker_profile that uses a different relative path', () => {
    const result = enforceWritableProfilesPolicy(
      'upsert_worker_profile',
      { profiles_file: 'other.json', cwd: '/some/cwd' },
      { HOME: '/h', AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE: '/state/profiles.json' },
      '/repo',
    );
    assert.ok(result, 'expected an error');
    assert.equal(result?.code, 'INVALID_INPUT');
  });

  it('treats the pin as resolved against process cwd when relative', () => {
    const result = enforceWritableProfilesPolicy(
      'upsert_worker_profile',
      { profiles_file: '/repo/profiles.json' },
      { HOME: '/h', AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE: 'profiles.json' },
      '/repo',
    );
    assert.equal(result, null, 'relative pin should resolve against the supplied cwd');
  });
});

describe('harnessPolicyContext', () => {
  it('returns undefined when the env pin is not set so generic clients send no policy context', () => {
    assert.equal(harnessPolicyContext('upsert_worker_profile', { HOME: '/h' }), undefined);
  });

  it('returns undefined for unrelated tools even when the pin is set', () => {
    assert.equal(
      harnessPolicyContext('list_worker_profiles', { AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE: '/state/profiles.json' }),
      undefined,
    );
  });

  it('exposes the pinned writable profiles file for upsert_worker_profile when the pin is set', () => {
    assert.deepStrictEqual(
      harnessPolicyContext('upsert_worker_profile', { AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE: '/state/profiles.json' }),
      { writable_profiles_file: '/state/profiles.json' },
    );
  });

  it('resolves a relative pin against the supplied cwd so frontend and daemon agree on the canonical path', () => {
    assert.deepStrictEqual(
      harnessPolicyContext(
        'upsert_worker_profile',
        { AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE: 'profiles.json' },
        '/repo',
      ),
      { writable_profiles_file: '/repo/profiles.json' },
    );
  });
});
