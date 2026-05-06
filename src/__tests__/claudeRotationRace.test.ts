import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackendRegistry } from '../backend/registry.js';
import { OrchestratorService } from '../orchestratorService.js';
import { RunStore } from '../runStore.js';
import {
  accountRegistryPaths,
  loadAccountRegistry,
  upsertAccount,
} from '../claude/accountRegistry.js';

/**
 * T-COR-Race verification: per-parent rotation lock + claimed-destinations
 * set, durable across daemon restart. Drives `OrchestratorService.sendFollowup`
 * in single- and multi-parent scenarios with three config_dir accounts so the
 * picker logic is exercised without exercising the copy/resume path (which is
 * covered by T-COR4).
 */

let originalPath: string | undefined;

beforeEach(() => {
  originalPath = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = originalPath ?? '';
});

function prependPath(entry: string, current: string | undefined): string {
  return current ? `${entry}${delimiter}${current}` : entry;
}

interface Fixture {
  home: string;
  cwd: string;
  service: OrchestratorService;
}

async function createFakeClaude(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('claude 1.2.3 (race-test)');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log('Usage: claude -p --output-format stream-json --resume --model');
  process.exit(0);
}
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-' + Date.now() }));
  if (prompt.includes('TRIGGER_RATE_LIMIT')) {
    console.log(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'simulated rate limit' } }));
    console.log(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, stop_reason: 'rate_limit_error', result: 'simulated rate limit', session_id: 'session-rl' }));
    process.exit(1);
  }
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 'session-ok' }));
});
`;
  await writeFile(join(binDir, 'claude'), script);
  await chmod(join(binDir, 'claude'), 0o755);
}

async function setupFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'agent-rot-race-'));
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  const bin = join(root, 'bin');
  await createFakeClaude(bin);
  process.env.PATH = prependPath(bin, originalPath);
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  const store = new RunStore(home);
  const service = new OrchestratorService(store, createBackendRegistry(store));
  await service.initialize();
  return { home, cwd, service };
}

async function registerConfigDirAccounts(home: string, names: string[]): Promise<void> {
  const paths = accountRegistryPaths(home);
  for (const name of names) {
    await mkdir(join(paths.accountsRoot, name), { recursive: true, mode: 0o700 });
    await upsertAccount(paths, { name, mode: 'config_dir', configDirPath: join(paths.accountsRoot, name) });
  }
}

interface ParentInfo {
  runId: string;
}

async function startParentThatRateLimits(fixture: Fixture, accounts: string[]): Promise<ParentInfo> {
  const start = await fixture.service.startRun({
    backend: 'claude',
    prompt: 'TRIGGER_RATE_LIMIT please',
    cwd: fixture.cwd,
    model: 'claude-opus-4-7',
    claude_accounts: accounts,
  });
  assert.equal(start.ok, true, `startRun should succeed (got ${JSON.stringify(start)})`);
  const runId = (start as unknown as { run_id: string }).run_id;
  await fixture.service.waitForRun({ run_id: runId, wait_seconds: 5 });
  return { runId };
}

async function getRunMetadata(fixture: Fixture, runId: string): Promise<Record<string, unknown>> {
  const status = await fixture.service.getRunStatus({ run_id: runId });
  return ((status as unknown as { run_summary: { metadata: Record<string, unknown> } }).run_summary.metadata) ?? {};
}

describe('claude rotation race (T-COR-Race)', () => {
  it('Test 1 — distinct destinations: parallel followups bind different accounts', async () => {
    const fixture = await setupFixture();
    await registerConfigDirAccounts(fixture.home, ['A', 'B', 'C']);
    const parent = await startParentThatRateLimits(fixture, ['A', 'B', 'C']);

    const [r1, r2] = await Promise.all([
      fixture.service.sendFollowup({ run_id: parent.runId, prompt: 'follow 1' }),
      fixture.service.sendFollowup({ run_id: parent.runId, prompt: 'follow 2' }),
    ]);
    assert.equal(r1.ok, true, `r1 should succeed (got ${JSON.stringify(r1)})`);
    assert.equal(r2.ok, true, `r2 should succeed (got ${JSON.stringify(r2)})`);
    const c1 = (r1 as unknown as { run_id: string }).run_id;
    const c2 = (r2 as unknown as { run_id: string }).run_id;

    const m1 = await getRunMetadata(fixture, c1);
    const m2 = await getRunMetadata(fixture, c2);
    const used = new Set([m1.claude_account_used as string, m2.claude_account_used as string]);
    assert.equal(used.size, 2, `parallel rotations must bind distinct accounts (got ${[...used].join(',')})`);
    for (const name of used) {
      assert.ok(['B', 'C'].includes(name), `expected only non-prior accounts; got ${name}`);
    }
  });

  it('Test 2 — priority exhausted: second concurrent call returns priority_exhausted_for_parent', async () => {
    const fixture = await setupFixture();
    await registerConfigDirAccounts(fixture.home, ['A', 'B']);
    const parent = await startParentThatRateLimits(fixture, ['A', 'B']);

    const [r1, r2] = await Promise.all([
      fixture.service.sendFollowup({ run_id: parent.runId, prompt: 'follow 1' }),
      fixture.service.sendFollowup({ run_id: parent.runId, prompt: 'follow 2' }),
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    const errs = [r1, r2].filter((r) => !r.ok) as unknown as Array<{ ok: false; error: { code: string; details?: Record<string, unknown> } }>;
    assert.equal(oks.length, 1, 'exactly one followup should succeed');
    assert.equal(errs.length, 1, 'exactly one followup should fail with exhaustion');
    assert.equal(errs[0]!.error.code, 'INVALID_STATE');
    assert.equal(errs[0]!.error.details?.reason, 'priority_exhausted_for_parent');
    assert.deepStrictEqual(errs[0]!.error.details?.claimed, ['B']);
    assert.deepStrictEqual(errs[0]!.error.details?.priority, ['A', 'B']);
  });

  it('Test 3 — sequential followups respect prior claims', async () => {
    const fixture = await setupFixture();
    await registerConfigDirAccounts(fixture.home, ['A', 'B', 'C']);
    const parent = await startParentThatRateLimits(fixture, ['A', 'B', 'C']);

    const r1 = await fixture.service.sendFollowup({ run_id: parent.runId, prompt: 'first followup' });
    assert.equal(r1.ok, true);
    const c1 = (r1 as unknown as { run_id: string }).run_id;
    await fixture.service.waitForRun({ run_id: c1, wait_seconds: 5 });
    const m1 = await getRunMetadata(fixture, c1);
    const firstBound = m1.claude_account_used as string;

    const r2 = await fixture.service.sendFollowup({ run_id: parent.runId, prompt: 'second followup' });
    assert.equal(r2.ok, true, `r2 should succeed (got ${JSON.stringify(r2)})`);
    const c2 = (r2 as unknown as { run_id: string }).run_id;
    const m2 = await getRunMetadata(fixture, c2);
    const secondBound = m2.claude_account_used as string;
    assert.notEqual(secondBound, firstBound, 'sequential rotations must not pick a prior-claim destination');
    assert.ok(['B', 'C'].includes(secondBound));
  });

  it('Test 4 — claimed survives terminal of bound child', async () => {
    const fixture = await setupFixture();
    await registerConfigDirAccounts(fixture.home, ['A', 'B', 'C']);
    const parent = await startParentThatRateLimits(fixture, ['A', 'B', 'C']);

    const r1 = await fixture.service.sendFollowup({ run_id: parent.runId, prompt: 'TRIGGER_RATE_LIMIT first followup' });
    assert.equal(r1.ok, true);
    const c1 = (r1 as unknown as { run_id: string }).run_id;
    await fixture.service.waitForRun({ run_id: c1, wait_seconds: 5 });
    // Give the post-completion cooldown handler a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const m1 = await getRunMetadata(fixture, c1);
    const first = m1.claude_account_used as string;

    const r2 = await fixture.service.sendFollowup({ run_id: parent.runId, prompt: 'second followup' });
    assert.equal(r2.ok, true, `r2 should succeed: ${JSON.stringify(r2)}`);
    const c2 = (r2 as unknown as { run_id: string }).run_id;
    const m2 = await getRunMetadata(fixture, c2);
    const second = m2.claude_account_used as string;
    assert.notEqual(second, first);
    assert.ok(['B', 'C'].includes(second));

    // Followup 3 should now find priority exhausted: A is prior, first/second
    // are both claimed (and likely cooled-down), leaving nothing.
    const r3 = await fixture.service.sendFollowup({ run_id: parent.runId, prompt: 'third followup' });
    assert.equal(r3.ok, false);
    const err = r3 as unknown as { error: { code: string; details?: Record<string, unknown> } };
    assert.equal(err.error.code, 'INVALID_STATE');
    assert.equal(err.error.details?.reason, 'priority_exhausted_for_parent');
  });

  it('Test 5 — different parents do not contend on the tracker', async () => {
    const fixture = await setupFixture();
    await registerConfigDirAccounts(fixture.home, ['A', 'B', 'X', 'Y']);
    // Two parents on disjoint priority lists so each can rate-limit and
    // rotate independently without their cooldown writes leaking onto the
    // other parent's pool. The lock test is about per-parent isolation.
    const p1 = await startParentThatRateLimits(fixture, ['A', 'B']);
    const p2 = await startParentThatRateLimits(fixture, ['X', 'Y']);

    const [r1, r2] = await Promise.all([
      fixture.service.sendFollowup({ run_id: p1.runId, prompt: 'p1 followup' }),
      fixture.service.sendFollowup({ run_id: p2.runId, prompt: 'p2 followup' }),
    ]);
    assert.equal(r1.ok, true, `r1 should succeed: ${JSON.stringify(r1)}`);
    assert.equal(r2.ok, true, `r2 should succeed: ${JSON.stringify(r2)}`);
    const c1 = (r1 as unknown as { run_id: string }).run_id;
    const c2 = (r2 as unknown as { run_id: string }).run_id;
    const m1 = await getRunMetadata(fixture, c1);
    const m2 = await getRunMetadata(fixture, c2);
    assert.equal(m1.claude_account_used, 'B', 'p1 picks B (A was prior)');
    assert.equal(m2.claude_account_used, 'Y', 'p2 picks Y (X was prior)');
  });

  it.skip('Test 6 — lock resolution timing (TODO: requires fake-clock plumbing)', async () => {
    // Deferred: exercising the deferred cooldown-write barrier requires
    // injecting a fake clock + a controllable cooldown-write deferred into
    // OrchestratorService, which is beyond the current test-helper surface.
    // Tests 1-5, 7, 8 cover the user-visible invariants of D-COR-Lock; this
    // test would only be a white-box check of the lock itself.
  });

  it('Test 7 — lock failure does not poison subsequent calls', async () => {
    const fixture = await setupFixture();
    await registerConfigDirAccounts(fixture.home, ['A', 'B', 'C']);
    const parent = await startParentThatRateLimits(fixture, ['A', 'B', 'C']);

    // Mid-picker throw: simulate by calling sendFollowup against a parent
    // whose registry was tampered post-spawn so loadAccountRegistry rejects
    // version mismatch (our actual error path inside evaluateRotation).
    // Easier alternative: just dispatch sendFollowup against a non-existent
    // run, then dispatch a real one. But that doesn't exercise the lock.
    //
    // Simplest deterministic path: use a parent_run_id that exists; inject
    // a transient registry corruption before the first followup, then heal
    // it before the second.
    const paths = accountRegistryPaths(fixture.home);
    const { writeFile } = await import('node:fs/promises');
    const { readFile } = await import('node:fs/promises');
    const goodRegistry = await readFile(paths.registry, 'utf8');

    // Tamper: set version to a bogus value so loadAccountRegistry returns
    // version_mismatch — that is the structured failure path inside
    // evaluateRotation, BEFORE any picker mutation. The subsequent retry
    // (after restoring the file) must succeed.
    await writeFile(paths.registry, JSON.stringify({ version: 999, accounts: [] }), { mode: 0o600 });
    const r1 = await fixture.service.sendFollowup({ run_id: parent.runId, prompt: 'will fail' });
    assert.equal(r1.ok, false);

    // Restore and retry.
    await writeFile(paths.registry, goodRegistry, { mode: 0o600 });
    const r2 = await fixture.service.sendFollowup({ run_id: parent.runId, prompt: 'should succeed now' });
    assert.equal(r2.ok, true, `r2 should succeed after registry healed (got ${JSON.stringify(r2)})`);
    const c2 = (r2 as unknown as { run_id: string }).run_id;
    const m2 = await getRunMetadata(fixture, c2);
    assert.ok(['B', 'C'].includes(m2.claude_account_used as string));
  });

  it('Test 8 — daemon restart durability of claimed set', async () => {
    const fixture = await setupFixture();
    await registerConfigDirAccounts(fixture.home, ['A', 'B', 'C']);
    const parent = await startParentThatRateLimits(fixture, ['A', 'B', 'C']);

    const r1 = await fixture.service.sendFollowup({ run_id: parent.runId, prompt: 'before restart' });
    assert.equal(r1.ok, true);
    const c1 = (r1 as unknown as { run_id: string }).run_id;
    await fixture.service.waitForRun({ run_id: c1, wait_seconds: 5 });
    const m1 = await getRunMetadata(fixture, c1);
    const firstBound = m1.claude_account_used as string;

    // "Restart" the OrchestratorService (drop the in-memory rotationTrackers
    // map) by instantiating a fresh service against the same RunStore.
    const freshStore = new RunStore(fixture.home);
    const freshService = new OrchestratorService(freshStore, createBackendRegistry(freshStore));
    await freshService.initialize();

    const r2 = await freshService.sendFollowup({ run_id: parent.runId, prompt: 'after restart' });
    assert.equal(r2.ok, true, `r2 should succeed after restart (got ${JSON.stringify(r2)})`);
    const c2 = (r2 as unknown as { run_id: string }).run_id;
    // Read meta from the fresh service.
    const status2 = await freshService.getRunStatus({ run_id: c2 });
    const m2 = ((status2 as unknown as { run_summary: { metadata: Record<string, unknown> } }).run_summary.metadata) ?? {};
    const secondBound = m2.claude_account_used as string;
    assert.notEqual(secondBound, firstBound, 'after restart, reconstruction must skip prior claim');
    assert.ok(['B', 'C'].includes(secondBound));

    // Variant: a third followup against a priority-exhausted set should
    // surface priority_exhausted_for_parent.
    const r3 = await freshService.sendFollowup({ run_id: parent.runId, prompt: 'third followup' });
    assert.equal(r3.ok, false);
    const err = r3 as unknown as { error: { code: string; details?: Record<string, unknown> } };
    assert.equal(err.error.code, 'INVALID_STATE');
    assert.equal(err.error.details?.reason, 'priority_exhausted_for_parent');

    // Also verify loadAccountRegistry shows expected cooldown state for A
    // (tested elsewhere). Just sanity-check the registry exists.
    const loaded = await loadAccountRegistry(accountRegistryPaths(fixture.home));
    assert.ok(loaded.ok);
  });
});
