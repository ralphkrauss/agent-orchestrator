import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StartRunInputSchema, UpsertWorkerProfileInputSchema } from '../contract.js';
import {
  createWorkerCapabilityCatalog,
  inspectWorkerProfiles,
  type WorkerProfileManifest,
} from '../harness/capabilities.js';

describe('StartRunInputSchema claude account fields', () => {
  it('accepts claude backend with claude_account and matching priority', () => {
    const result = StartRunInputSchema.safeParse({
      backend: 'claude',
      prompt: 'hi',
      cwd: '/tmp',
      claude_account: 'work',
      claude_accounts: ['work', 'alt'],
    });
    assert.equal(result.success, true);
  });

  it('rejects claude_account when backend is not claude', () => {
    const result = StartRunInputSchema.safeParse({
      backend: 'codex',
      prompt: 'hi',
      cwd: '/tmp',
      claude_account: 'work',
    });
    assert.equal(result.success, false);
  });

  it('rejects claude_account when profile is supplied', () => {
    const result = StartRunInputSchema.safeParse({
      profile: 'live-implementation',
      prompt: 'hi',
      cwd: '/tmp',
      claude_account: 'work',
    });
    assert.equal(result.success, false);
  });

  it('rejects claude_account that is not a member of claude_accounts', () => {
    const result = StartRunInputSchema.safeParse({
      backend: 'claude',
      prompt: 'hi',
      cwd: '/tmp',
      claude_account: 'work',
      claude_accounts: ['alt', 'team'],
    });
    assert.equal(result.success, false);
  });

  it('rejects empty / duplicate claude_accounts', () => {
    const empty = StartRunInputSchema.safeParse({ backend: 'claude', prompt: 'p', cwd: '/tmp', claude_accounts: [] });
    assert.equal(empty.success, false);
    const duplicate = StartRunInputSchema.safeParse({ backend: 'claude', prompt: 'p', cwd: '/tmp', claude_accounts: ['a', 'a'] });
    assert.equal(duplicate.success, false);
  });

  it('rejects path-traversal-shaped account names at the schema layer', () => {
    const cases = ['..', '../escape', './x', '.hidden', 'has space', 'a/b'];
    for (const value of cases) {
      const result = StartRunInputSchema.safeParse({ backend: 'claude', prompt: 'p', cwd: '/tmp', claude_account: value });
      assert.equal(result.success, false, `expected ${JSON.stringify(value)} to be rejected`);
    }
  });
});

describe('UpsertWorkerProfileInputSchema claude account fields', () => {
  it('accepts claude profile with claude_account_priority and cooldown override', () => {
    const result = UpsertWorkerProfileInputSchema.safeParse({
      profile: 'rotate',
      backend: 'claude',
      claude_account: 'work',
      claude_account_priority: ['work', 'alt'],
      claude_cooldown_seconds: 300,
    });
    assert.equal(result.success, true);
  });

  it('rejects claude_cooldown_seconds above the 24h cap', () => {
    const result = UpsertWorkerProfileInputSchema.safeParse({
      profile: 'rotate',
      backend: 'claude',
      claude_cooldown_seconds: 24 * 60 * 60 + 1,
    });
    assert.equal(result.success, false);
  });

  it('rejects claude_cooldown_seconds <= 0', () => {
    const zero = UpsertWorkerProfileInputSchema.safeParse({ profile: 'rotate', backend: 'claude', claude_cooldown_seconds: 0 });
    assert.equal(zero.success, false);
    const negative = UpsertWorkerProfileInputSchema.safeParse({ profile: 'rotate', backend: 'claude', claude_cooldown_seconds: -1 });
    assert.equal(negative.success, false);
  });

  it('rejects claude_account_priority on non-claude backends', () => {
    const result = UpsertWorkerProfileInputSchema.safeParse({
      profile: 'rotate',
      backend: 'codex',
      claude_account_priority: ['a', 'b'],
    });
    assert.equal(result.success, false);
  });
});

describe('inspectWorkerProfiles claude account validation', () => {
  it('rejects manifests referencing unknown claude accounts when knownClaudeAccounts is supplied', () => {
    const manifest: WorkerProfileManifest = {
      version: 1,
      profiles: {
        rotator: {
          backend: 'claude',
          model: 'claude-opus-4-7',
          claude_account: 'work',
          claude_account_priority: ['work', 'alt'],
        },
      },
    };
    const catalog = createWorkerCapabilityCatalog({
      frontend_version: '0.0.0',
      daemon_version: '0.0.0',
      version_match: true,
      daemon_pid: 1,
      platform: 'linux',
      node_version: 'v22',
      posix_supported: true,
      run_store: { path: '/tmp', accessible: true },
      backends: [
        { name: 'claude', binary: 'claude', status: 'available', path: null, version: null, auth: { status: 'ready' }, checks: [], hints: [] },
        { name: 'codex', binary: 'codex', status: 'available', path: null, version: null, auth: { status: 'ready' }, checks: [], hints: [] },
        { name: 'cursor', binary: '@cursor/sdk', status: 'available', path: null, version: null, auth: { status: 'ready' }, checks: [], hints: [] },
      ],
    });
    const inspected = inspectWorkerProfiles(manifest, catalog, {
      knownClaudeAccounts: new Set(['work']),
    });
    assert.ok(inspected.errors.some((message) => /unknown claude account alt/.test(message)));
    assert.ok(inspected.invalid_profiles.rotator);
  });

  it('accepts manifests where every account name resolves', () => {
    const manifest: WorkerProfileManifest = {
      version: 1,
      profiles: {
        rotator: {
          backend: 'claude',
          model: 'claude-opus-4-7',
          claude_account: 'work',
          claude_account_priority: ['work', 'alt'],
        },
      },
    };
    const catalog = createWorkerCapabilityCatalog();
    const inspected = inspectWorkerProfiles(manifest, catalog, {
      knownClaudeAccounts: new Set(['work', 'alt']),
    });
    assert.deepStrictEqual(inspected.errors, []);
    assert.ok(inspected.profiles.rotator);
  });

  it('rejects claude_account fields on non-claude backends', () => {
    const manifest: WorkerProfileManifest = {
      version: 1,
      profiles: {
        bad: {
          backend: 'codex',
          model: 'gpt-5.2',
          claude_account: 'work',
        } as never,
      },
    };
    const catalog = createWorkerCapabilityCatalog();
    const inspected = inspectWorkerProfiles(manifest, catalog);
    assert.ok(inspected.errors.some((message) => /claude_account.*backend=claude/.test(message)));
  });
});

describe('inspectWorkerProfiles worker_posture validation (issue #58 review Medium 2)', () => {
  it('rejects manifests with an unsupported worker_posture so list_worker_profiles surfaces them as invalid', () => {
    const manifest: WorkerProfileManifest = {
      version: 1,
      profiles: {
        typo: {
          backend: 'codex',
          model: 'gpt-5.5',
          worker_posture: 'trustd',
        },
        good: {
          backend: 'codex',
          model: 'gpt-5.5',
          worker_posture: 'trusted',
        },
        also_good: {
          backend: 'claude',
          model: 'claude-opus-4-7',
          worker_posture: 'restricted',
        },
      },
    };
    const catalog = createWorkerCapabilityCatalog();
    const inspected = inspectWorkerProfiles(manifest, catalog);

    assert.ok(inspected.invalid_profiles.typo, 'profile with worker_posture: "trustd" must land in invalid_profiles');
    assert.ok(
      inspected.errors.some((message) => /worker_posture trustd/.test(message)),
      'invalid worker_posture must produce a clear diagnostic',
    );
    assert.ok(
      inspected.errors.some((message) => /trusted, restricted/.test(message)),
      'diagnostic must list the supported values',
    );
    assert.ok(inspected.profiles.good, 'profile with worker_posture: "trusted" stays valid');
    assert.ok(inspected.profiles.also_good, 'profile with worker_posture: "restricted" stays valid');
  });

  it('accepts profiles that omit worker_posture (the default is trusted)', () => {
    const manifest: WorkerProfileManifest = {
      version: 1,
      profiles: {
        defaulted: {
          backend: 'codex',
          model: 'gpt-5.5',
        },
      },
    };
    const catalog = createWorkerCapabilityCatalog();
    const inspected = inspectWorkerProfiles(manifest, catalog);
    assert.ok(inspected.profiles.defaulted);
    assert.deepStrictEqual(inspected.errors, []);
  });
});
