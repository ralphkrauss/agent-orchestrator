import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
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

let originalPath: string | undefined;
let originalAnthropic: string | undefined;
let originalSecrets: string | undefined;

beforeEach(() => {
  originalPath = process.env.PATH;
  originalAnthropic = process.env.ANTHROPIC_API_KEY;
  originalSecrets = process.env.AGENT_ORCHESTRATOR_SECRETS_FILE;
});

afterEach(() => {
  process.env.PATH = originalPath ?? '';
  if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropic;
  if (originalSecrets === undefined) delete process.env.AGENT_ORCHESTRATOR_SECRETS_FILE;
  else process.env.AGENT_ORCHESTRATOR_SECRETS_FILE = originalSecrets;
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
  const { mkdir } = await import('node:fs/promises');
  await mkdir(binDir, { recursive: true });
  // Fake-claude variant that is also config_dir-aware (T-COR4 fixture):
  //   - When CLAUDE_CONFIG_DIR is set, every invocation writes a JSONL file at
  //     `<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<session_id>.jsonl` so the
  //     daemon's copy-on-rotate-resume helper has something to copy.
  //   - The session_id is derived deterministically from the prompt so the
  //     resume test can predict it; on `--resume <sid>`, we instead trust that
  //     the daemon copied the file over and look up that exact path.
  //   - On `--resume <sid>` argv: emit `{ type: "error", subtype:
  //     "session_not_found", ... }` + exit 1 if the JSONL is missing at the
  //     spawned worker's CLAUDE_CONFIG_DIR; otherwise emit a normal
  //     stream-json success with that resumed session id.
  //   - On `TRIGGER_RATE_LIMIT` in the prompt: write the JSONL first (so the
  //     daemon has something to copy on the rotation step), then emit a
  //     rate_limit error and exit 1.
  //   - When the prompt contains `SUPPRESS_SESSION_INIT`, skip the leading
  //     init event (used to construct a "no observed session id" parent).
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('claude 1.2.3 (rotation-test)');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log('Usage: claude -p --output-format stream-json --resume --model');
  process.exit(0);
}
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const cwd = process.cwd();
  fs.appendFileSync(path.join(cwd, 'claude-args.jsonl'), JSON.stringify({ args, env: filterEnv(process.env) }) + '\\n');

  // Detect a --resume <sid> argv pair, used by the daemon's copy-on-rotate
  // resume path (D-COR-Resume).
  let resumeSid = null;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--resume') { resumeSid = args[i + 1]; break; }
  }

  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const encodedCwd = cwd.replace(/\\//g, '-');

  if (resumeSid) {
    // Resume path: confirm the JSONL is present at the new CLAUDE_CONFIG_DIR.
    if (!configDir) {
      console.log(JSON.stringify({ type: 'error', subtype: 'session_not_found', message: 'no config dir on resume' }));
      console.log(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'session_not_found', session_id: resumeSid }));
      process.exit(1);
    }
    const expectedPath = path.join(configDir, 'projects', encodedCwd, resumeSid + '.jsonl');
    if (!fs.existsSync(expectedPath)) {
      console.log(JSON.stringify({ type: 'error', subtype: 'session_not_found', message: 'no such session' }));
      console.log(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'session_not_found', session_id: resumeSid }));
      process.exit(1);
    }
    // Test hook: prompt-driven session_not_found on resume even when the
    // JSONL exists, so e2e tests can drive the interceptor's retry path.
    if (prompt.includes('FORCE_SESSION_NOT_FOUND_EARLY')) {
      console.log(JSON.stringify({ type: 'error', subtype: 'session_not_found', message: 'forced early session_not_found' }));
      // Keep the worker alive briefly so the interceptor's kill-then-retry
      // takes effect; node will exit when the kill arrives.
      setInterval(() => {}, 1000);
      return;
    }
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: resumeSid }));
    console.log(JSON.stringify({ type: 'assistant', session_id: resumeSid, message: { content: [{ type: 'text', text: 'resumed-ok' }] } }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'resumed-ok', session_id: resumeSid }));
    process.exit(0);
  }

  // Deterministic session id derived from the prompt so the test can predict it.
  const sid = 'session-' + crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 16);

  // When config_dir mode is in play, write the session JSONL to the
  // daemon-owned account dir so the next rotation step has a source to copy.
  if (configDir) {
    try {
      const dir = path.join(configDir, 'projects', encodedCwd);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, sid + '.jsonl'), JSON.stringify({ role: 'assistant', text: 'hello' }) + '\\n', { mode: 0o600 });
    } catch (e) {
      // Best effort — fall through; the test will assert what matters.
    }
  }

  if (!prompt.includes('SUPPRESS_SESSION_INIT')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }));
  }
  if (prompt.includes('TRIGGER_RATE_LIMIT')) {
    console.log(JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'simulated rate limit' }
    }));
    console.log(JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      stop_reason: 'rate_limit_error',
      result: 'simulated rate limit',
      session_id: prompt.includes('SUPPRESS_SESSION_INIT') ? undefined : sid
    }));
    process.exit(1);
  }
  console.log(JSON.stringify({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'ok' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: sid }));
});
function filterEnv(env) {
  const out = {};
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTHROPIC_') || key === 'CLAUDE_CONFIG_DIR' || key === 'CLAUDECODE') {
      out[key] = env[key];
    }
  }
  return out;
}
`;
  await writeFile(join(binDir, 'claude'), script);
  await chmod(join(binDir, 'claude'), 0o755);
}

async function setupFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'agent-rot-'));
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  await writeFile(join(root, 'placeholder'), '');
  await chmod(root, 0o755);
  const bin = join(root, 'bin');
  await createFakeClaude(bin);
  process.env.PATH = prependPath(bin, originalPath);
  process.env.AGENT_ORCHESTRATOR_SECRETS_FILE = join(home, 'secrets.env');
  // Required: the cwd has to exist before startRun's access(...) check.
  await chmod(root, 0o700).catch(() => undefined);
  await writeFile(join(root, 'mark'), '');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(cwd, { recursive: true }));
  await import('node:fs/promises').then(({ mkdir }) => mkdir(home, { recursive: true }));
  const store = new RunStore(home);
  const service = new OrchestratorService(store, createBackendRegistry(store));
  await service.initialize();
  return { home, cwd, service };
}

describe('claude account-bound spawn env scrubbing (end-to-end through fake claude)', () => {
  it('strips ambient ANTHROPIC_* / token globs and injects only the bound account env', async () => {
    const fixture = await setupFixture();
    const paths = accountRegistryPaths(fixture.home);
    const { saveUserSecret } = await import('../auth/userSecrets.js');
    const { accountSecretKey } = await import('../claude/accountValidation.js');
    await saveUserSecret(accountSecretKey('work'), 'sk-bound-secret', { path: process.env.AGENT_ORCHESTRATOR_SECRETS_FILE });
    await upsertAccount(paths, { name: 'work', mode: 'api_env', secretKey: accountSecretKey('work') });

    // Pollute the daemon env with values from the deny list and broader globs;
    // the fake claude binary writes whatever it sees to claude-args.jsonl.
    process.env.ANTHROPIC_API_KEY = 'AMBIENT-DAEMON-SHOULD-BE-SCRUBBED';
    process.env.ANTHROPIC_AUTH_TOKEN = 'AMBIENT-AUTH';
    process.env.ANTHROPIC_BASE_URL = 'https://ambient.example';
    process.env.ANTHROPIC_MODEL = 'AMBIENT-MODEL';
    process.env.CLAUDE_CONFIG_DIR = '/should/not/leak';
    process.env.CLAUDECODE = '1';
    process.env.SOMEVENDOR_API_KEY = 'GLOB-API';
    process.env.SOMEVENDOR_AUTH_TOKEN = 'GLOB-AUTH';

    const start = await fixture.service.startRun({
      backend: 'claude',
      prompt: 'env scrub check',
      cwd: fixture.cwd,
      model: 'claude-opus-4-7',
      claude_account: 'work',
    });
    const response = start as unknown as { ok: boolean; run_id?: string };
    assert.equal(response.ok, true);
    await fixture.service.waitForRun({ run_id: response.run_id!, wait_seconds: 5 });

    const { readFile } = await import('node:fs/promises');
    const lines = (await readFile(join(fixture.cwd, 'claude-args.jsonl'), 'utf8')).trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, 'fake claude should record at least one invocation');
    const last = JSON.parse(lines[lines.length - 1]!) as { env: Record<string, string> };
    assert.equal(last.env.ANTHROPIC_API_KEY, 'sk-bound-secret', 'spawned worker must see the bound account secret');
    assert.notEqual(last.env.ANTHROPIC_API_KEY, 'AMBIENT-DAEMON-SHOULD-BE-SCRUBBED');
    for (const denied of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CONFIG_DIR', 'CLAUDECODE', 'SOMEVENDOR_API_KEY', 'SOMEVENDOR_AUTH_TOKEN']) {
      assert.equal(last.env[denied], undefined, `${denied} must be scrubbed from the spawned worker env`);
    }
  });
});

describe('claude rotation on rate_limit', () => {
  it('rotates to the next account on send_followup with terminal_context.kind = fresh_chat_after_rotation', async () => {
    const fixture = await setupFixture();
    const paths = accountRegistryPaths(fixture.home);
    // Register two api_env accounts; secrets stored in the secrets file via saveUserSecret directly.
    const { saveUserSecret } = await import('../auth/userSecrets.js');
    const { accountSecretKey } = await import('../claude/accountValidation.js');
    await saveUserSecret(accountSecretKey('work'), 'sk-work-key', { path: process.env.AGENT_ORCHESTRATOR_SECRETS_FILE });
    await saveUserSecret(accountSecretKey('alt'), 'sk-alt-key', { path: process.env.AGENT_ORCHESTRATOR_SECRETS_FILE });
    await upsertAccount(paths, { name: 'work', mode: 'api_env', secretKey: accountSecretKey('work') });
    await upsertAccount(paths, { name: 'alt', mode: 'api_env', secretKey: accountSecretKey('alt') });

    const start = await fixture.service.startRun({
      backend: 'claude',
      prompt: 'TRIGGER_RATE_LIMIT please',
      cwd: fixture.cwd,
      model: 'claude-opus-4-7',
      claude_account: 'work',
      claude_accounts: ['work', 'alt'],
    });
    assert.equal(start.ok, true, `startRun should succeed (got ${JSON.stringify(start)})`);
    const parentId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    const waited = await fixture.service.waitForRun({ run_id: parentId, wait_seconds: 5 });
    assert.equal(waited.ok, true);
    const parent = (await fixture.service.getRunStatus({ run_id: parentId })) as unknown as { run_summary: { metadata: Record<string, unknown>; latest_error: { category: string } | null } };
    assert.equal(parent.run_summary.latest_error?.category, 'rate_limit');
    const rotationState = parent.run_summary.metadata.claude_rotation_state as { accounts: string[] } | undefined;
    assert.deepStrictEqual(rotationState?.accounts, ['work', 'alt']);
    assert.equal(parent.run_summary.metadata.claude_account_used, 'work');

    const followup = await fixture.service.sendFollowup({ run_id: parentId, prompt: 'follow up after rotate' });
    assert.equal(followup.ok, true, `sendFollowup should succeed (got ${JSON.stringify(followup)})`);
    const childId = followup.ok ? (followup as unknown as { run_id: string }).run_id : '';
    await fixture.service.waitForRun({ run_id: childId, wait_seconds: 5 });
    const child = (await fixture.service.getRunStatus({ run_id: childId })) as unknown as { run_summary: { metadata: Record<string, unknown>; terminal_context: Record<string, unknown> | null; parent_run_id: string | null; session_id: string | null; requested_session_id: string | null } };
    assert.equal(child.run_summary.parent_run_id, parentId);
    assert.equal(child.run_summary.metadata.claude_account_used, 'alt');
    assert.equal((child.run_summary.terminal_context as { kind?: string } | null)?.kind, 'fresh_chat_after_rotation');
    // Rotation MUST start fresh, not resume — child should not carry the parent's session id.
    assert.equal(child.run_summary.requested_session_id, null);

    // Cooldown: prior account should be marked cooled-down.
    const loaded = await loadAccountRegistry(paths);
    assert.ok(loaded.ok);
    if (loaded.ok) {
      const work = loaded.file.accounts.find((entry) => entry.name === 'work');
      assert.ok(work?.cooldown_until_ms && work.cooldown_until_ms > Date.now() - 1000);
      assert.equal(work?.last_error_category, 'rate_limit');
    }
  });

  it('returns INVALID_STATE when every priority account is cooled-down', async () => {
    const fixture = await setupFixture();
    const paths = accountRegistryPaths(fixture.home);
    const { saveUserSecret } = await import('../auth/userSecrets.js');
    const { accountSecretKey } = await import('../claude/accountValidation.js');
    await saveUserSecret(accountSecretKey('only'), 'sk-only', { path: process.env.AGENT_ORCHESTRATOR_SECRETS_FILE });
    await upsertAccount(paths, { name: 'only', mode: 'api_env', secretKey: accountSecretKey('only') });
    // Pre-cool the account
    const { markAccountCooledDown } = await import('../claude/accountRegistry.js');
    await markAccountCooledDown(paths, { name: 'only', cooldownSeconds: 600, errorCategory: 'rate_limit' });

    const start = await fixture.service.startRun({
      backend: 'claude',
      prompt: 'hello',
      cwd: fixture.cwd,
      model: 'claude-opus-4-7',
      claude_accounts: ['only'],
    });
    const response = start as unknown as { ok: boolean; error?: { code: string; message: string } };
    assert.equal(response.ok, false);
    assert.equal(response.error?.code, 'INVALID_STATE');
    assert.match(response.error?.message ?? '', /cooled-down/);
  });

  it('rejects api_env accounts whose secret is missing without falling back', async () => {
    const fixture = await setupFixture();
    const paths = accountRegistryPaths(fixture.home);
    const { accountSecretKey } = await import('../claude/accountValidation.js');
    await upsertAccount(paths, { name: 'phantom', mode: 'api_env', secretKey: accountSecretKey('phantom') });
    // No secret saved.
    process.env.ANTHROPIC_API_KEY = 'should-not-be-used';

    const start = await fixture.service.startRun({
      backend: 'claude',
      prompt: 'hello',
      cwd: fixture.cwd,
      model: 'claude-opus-4-7',
      claude_account: 'phantom',
    });
    const response = start as unknown as { ok: boolean; error?: { code: string; message: string; details?: Record<string, unknown> } };
    assert.equal(response.ok, false);
    assert.equal(response.error?.code, 'INVALID_STATE');
    assert.equal(response.error?.details?.reason, 'missing_account_secret');
  });

  it('persists cooldown at terminal of the rotation-eligible parent so the next start_run skips the cooled account', async () => {
    const fixture = await setupFixture();
    const paths = accountRegistryPaths(fixture.home);
    const { saveUserSecret } = await import('../auth/userSecrets.js');
    const { accountSecretKey } = await import('../claude/accountValidation.js');
    await saveUserSecret(accountSecretKey('work'), 'sk-work', { path: process.env.AGENT_ORCHESTRATOR_SECRETS_FILE });
    await saveUserSecret(accountSecretKey('alt'), 'sk-alt', { path: process.env.AGENT_ORCHESTRATOR_SECRETS_FILE });
    await upsertAccount(paths, { name: 'work', mode: 'api_env', secretKey: accountSecretKey('work') });
    await upsertAccount(paths, { name: 'alt', mode: 'api_env', secretKey: accountSecretKey('alt') });

    // First start_run rate-limits on `work`. terminal handling must persist
    // the cooldown for `work` before any send_followup is called.
    const start = await fixture.service.startRun({
      backend: 'claude',
      prompt: 'TRIGGER_RATE_LIMIT please',
      cwd: fixture.cwd,
      model: 'claude-opus-4-7',
      claude_accounts: ['work', 'alt'],
    });
    const startResponse = start as unknown as { ok: boolean; run_id?: string };
    assert.equal(startResponse.ok, true);
    await fixture.service.waitForRun({ run_id: startResponse.run_id!, wait_seconds: 5 });

    // Give the post-completion handler a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const afterTerminal = await loadAccountRegistry(paths);
    assert.ok(afterTerminal.ok);
    if (afterTerminal.ok) {
      const work = afterTerminal.file.accounts.find((entry) => entry.name === 'work');
      assert.ok(work?.cooldown_until_ms && work.cooldown_until_ms > Date.now() - 1000, 'work must be cooled-down at terminal time');
      assert.equal(work?.last_error_category, 'rate_limit');
    }

    // Subsequent start_run with the same priority must skip `work`.
    const next = await fixture.service.startRun({
      backend: 'claude',
      prompt: 'second start',
      cwd: fixture.cwd,
      model: 'claude-opus-4-7',
      claude_accounts: ['work', 'alt'],
    });
    const nextResponse = next as unknown as { ok: boolean; run_id?: string };
    assert.equal(nextResponse.ok, true);
    await fixture.service.waitForRun({ run_id: nextResponse.run_id!, wait_seconds: 5 });
    const child = (await fixture.service.getRunStatus({ run_id: nextResponse.run_id! })) as unknown as {
      run_summary: { metadata: Record<string, unknown> };
    };
    assert.equal(child.run_summary.metadata.claude_account_used, 'alt', 'cooldown registry must steer the next start_run away from work');
  });

  it('does not write cooldown for unbound (non-rotation) claude runs even on rate_limit', async () => {
    const fixture = await setupFixture();
    process.env.ANTHROPIC_API_KEY = 'sk-fallback';
    const start = await fixture.service.startRun({
      backend: 'claude',
      prompt: 'TRIGGER_RATE_LIMIT please',
      cwd: fixture.cwd,
      model: 'claude-opus-4-7',
    });
    const startResponse = start as unknown as { ok: boolean; run_id?: string };
    assert.equal(startResponse.ok, true);
    await fixture.service.waitForRun({ run_id: startResponse.run_id!, wait_seconds: 5 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const loaded = await loadAccountRegistry(accountRegistryPaths(fixture.home));
    assert.ok(loaded.ok);
    if (loaded.ok) {
      assert.deepStrictEqual(loaded.file.accounts, [], 'unbound runs must not write to the account registry');
    }
  });

  it('refuses to spawn a config_dir account whose stored config_dir_path no longer matches accountsRoot', async () => {
    const fixture = await setupFixture();
    const paths = accountRegistryPaths(fixture.home);
    const { mkdir, writeFile } = await import('node:fs/promises');
    // Register a config_dir account at the legitimate location.
    await mkdir(join(paths.accountsRoot, 'work'), { recursive: true, mode: 0o700 });
    await upsertAccount(paths, {
      name: 'work',
      mode: 'config_dir',
      configDirPath: join(paths.accountsRoot, 'work'),
    });
    // Tamper: rewrite accounts.json so config_dir_path points outside accountsRoot.
    const tamperedDir = join('/tmp', `tampered-${Date.now()}`);
    await mkdir(tamperedDir, { recursive: true });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.registry, JSON.stringify({
      version: 1,
      accounts: [
        {
          name: 'work',
          mode: 'config_dir',
          config_dir_path: tamperedDir,
          registered_at: new Date().toISOString(),
        },
      ],
    }, null, 2), { mode: 0o600 });

    const start = await fixture.service.startRun({
      backend: 'claude',
      prompt: 'hello',
      cwd: fixture.cwd,
      model: 'claude-opus-4-7',
      claude_account: 'work',
    });
    const response = start as unknown as { ok: boolean; error?: { code: string; details?: Record<string, unknown> } };
    assert.equal(response.ok, false);
    assert.equal(response.error?.code, 'INVALID_STATE');
    assert.equal(response.error?.details?.reason, 'tampered_account_config_dir');
  });
});

/**
 * T-COR4 — End-to-end copy-on-rotate-resume tests.
 *
 * Uses the config_dir-aware fake-claude variant declared above:
 *  - When CLAUDE_CONFIG_DIR is set the fake binary writes a session JSONL at
 *    `<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<sid>.jsonl`, so the parent
 *    leaves a real source the daemon can copy.
 *  - On `--resume <sid>` it asserts the JSONL exists at the new
 *    `CLAUDE_CONFIG_DIR`, otherwise it emits `session_not_found` and exits 1.
 *
 * Existing coverage NOT duplicated here:
 *  - Encoder + unit-level copy edge cases — claudeSessionCopy.test.ts.
 *  - Interceptor mechanics (cases 11/11b/11c) — claudeResumeInterceptor.test.ts.
 *  - Concurrency + restart durability — claudeRotationRace.test.ts.
 *  - Classifier — claudeSessionNotFoundClassifier.test.ts.
 *  - Existing api_env rotation — earlier suite in this file.
 */

async function registerConfigDirAccount(home: string, name: string): Promise<string> {
  const paths = accountRegistryPaths(home);
  const dir = join(paths.accountsRoot, name);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await upsertAccount(paths, { name, mode: 'config_dir', configDirPath: dir });
  return dir;
}

async function registerApiEnvAccount(home: string, name: string, secret: string): Promise<void> {
  const paths = accountRegistryPaths(home);
  const { saveUserSecret } = await import('../auth/userSecrets.js');
  const { accountSecretKey } = await import('../claude/accountValidation.js');
  await saveUserSecret(accountSecretKey(name), secret, { path: process.env.AGENT_ORCHESTRATOR_SECRETS_FILE });
  await upsertAccount(paths, { name, mode: 'api_env', secretKey: accountSecretKey(name) });
}

interface ParentSnapshot {
  runId: string;
  observedSessionId: string | null;
  metadata: Record<string, unknown>;
  terminalContext: Record<string, unknown> | null;
}

async function rateLimitParent(
  fixture: Fixture,
  opts: { firstAccount: string; priority: string[]; promptExtra?: string },
): Promise<ParentSnapshot> {
  const start = await fixture.service.startRun({
    backend: 'claude',
    prompt: `TRIGGER_RATE_LIMIT please${opts.promptExtra ? ` ${opts.promptExtra}` : ''}`,
    cwd: fixture.cwd,
    model: 'claude-opus-4-7',
    claude_account: opts.firstAccount,
    claude_accounts: opts.priority,
  });
  assert.equal(start.ok, true, `startRun should succeed (got ${JSON.stringify(start)})`);
  const runId = (start as unknown as { run_id: string }).run_id;
  const waited = await fixture.service.waitForRun({ run_id: runId, wait_seconds: 5 });
  assert.equal(waited.ok, true);
  const status = (await fixture.service.getRunStatus({ run_id: runId })) as unknown as {
    run_summary: {
      observed_session_id: string | null;
      metadata: Record<string, unknown>;
      terminal_context: Record<string, unknown> | null;
      latest_error: { category: string } | null;
    };
  };
  assert.equal(status.run_summary.latest_error?.category, 'rate_limit');
  return {
    runId,
    observedSessionId: status.run_summary.observed_session_id,
    metadata: status.run_summary.metadata,
    terminalContext: status.run_summary.terminal_context,
  };
}

async function followup(
  fixture: Fixture,
  parentRunId: string,
  prompt: string,
): Promise<{
  runId: string;
  parentRunId: string | null;
  metadata: Record<string, unknown>;
  terminalContext: Record<string, unknown> | null;
  requestedSessionId: string | null;
  sessionId: string | null;
  latestErrorCategory: string | null;
}> {
  const fu = await fixture.service.sendFollowup({ run_id: parentRunId, prompt });
  assert.equal(fu.ok, true, `sendFollowup should succeed (got ${JSON.stringify(fu)})`);
  const childId = (fu as unknown as { run_id: string }).run_id;
  await fixture.service.waitForRun({ run_id: childId, wait_seconds: 5 });
  const status = (await fixture.service.getRunStatus({ run_id: childId })) as unknown as {
    run_summary: {
      parent_run_id: string | null;
      metadata: Record<string, unknown>;
      terminal_context: Record<string, unknown> | null;
      requested_session_id: string | null;
      session_id: string | null;
      latest_error: { category: string } | null;
    };
  };
  return {
    runId: childId,
    parentRunId: status.run_summary.parent_run_id,
    metadata: status.run_summary.metadata,
    terminalContext: status.run_summary.terminal_context,
    requestedSessionId: status.run_summary.requested_session_id,
    sessionId: status.run_summary.session_id,
    latestErrorCategory: status.run_summary.latest_error?.category ?? null,
  };
}

function lastRotationHistory(metadata: Record<string, unknown>): Record<string, unknown> | null {
  const history = metadata.claude_rotation_history;
  if (!Array.isArray(history) || history.length === 0) return null;
  const last = history[history.length - 1];
  return typeof last === 'object' && last !== null ? (last as Record<string, unknown>) : null;
}

describe('T-COR4 — copy-on-rotate-resume end-to-end (config_dir accounts)', () => {
  it('happy path: parent rate-limits → JSONL copied → child resumes with terminal_context.kind = "resumed_after_rotation"', async () => {
    const fixture = await setupFixture();
    const aDir = await registerConfigDirAccount(fixture.home, 'A');
    const bDir = await registerConfigDirAccount(fixture.home, 'B');

    const parent = await rateLimitParent(fixture, { firstAccount: 'A', priority: ['A', 'B'] });

    // Pinned: parent observed a session id and the JSONL exists under A's projects/.
    assert.ok(parent.observedSessionId, 'parent must have observed a session id');
    const sid = parent.observedSessionId!;
    const encodedCwd = fixture.cwd.replace(/\//g, '-');
    const sourcePath = join(aDir, 'projects', encodedCwd, `${sid}.jsonl`);
    const { readFile, stat } = await import('node:fs/promises');
    const sourceBytesBefore = await readFile(sourcePath);
    assert.ok(sourceBytesBefore.length > 0, 'parent must leave a non-empty source JSONL');
    assert.equal(parent.metadata.claude_account_used, 'A');

    const child = await followup(fixture, parent.runId, 'follow up after rotate');

    // T-COR4 case 1 — terminal_context shape on resumed_after_rotation.
    const ctx = child.terminalContext ?? {};
    assert.equal(ctx.kind, 'resumed_after_rotation');
    assert.equal(ctx.prior_account, 'A');
    assert.equal(ctx.new_account, 'B');
    assert.equal(typeof ctx.resumed_session_id, 'string');
    assert.equal(ctx.resumed_session_id, sid);
    assert.equal(typeof ctx.source_path, 'string');
    assert.equal(typeof ctx.target_path, 'string');
    assert.equal(typeof ctx.copied_bytes, 'number');
    assert.ok((ctx.copied_bytes as number) >= 0);
    assert.equal(typeof ctx.copy_duration_ms, 'number');
    assert.ok((ctx.copy_duration_ms as number) >= 0);

    // T-COR4 case 22 — child's requested_session_id matches parent's observed.
    assert.equal(child.requestedSessionId, sid);

    // T-COR4 case 13 — claude_rotation_state preserved on the child.
    assert.deepStrictEqual(
      child.metadata.claude_rotation_state,
      parent.metadata.claude_rotation_state,
      'child must inherit parent\'s claude_rotation_state',
    );

    // metadata.claude_account_used moved to B; history entry marks resumed=true.
    assert.equal(child.metadata.claude_account_used, 'B');
    const lastHist = lastRotationHistory(child.metadata);
    assert.ok(lastHist, 'child must have a rotation history entry');
    assert.equal(lastHist!.resumed, true);
    assert.equal(lastHist!.prior_account, 'A');
    assert.equal(lastHist!.new_account, 'B');

    // Target JSONL is byte-equal to source.
    const targetPath = join(bDir, 'projects', encodedCwd, `${sid}.jsonl`);
    const targetBytes = await readFile(targetPath);
    assert.deepStrictEqual(targetBytes, sourceBytesBefore, 'target JSONL must be byte-equal to source');
    const targetStat = await stat(targetPath);
    assert.equal(targetStat.mode & 0o777, 0o600, 'target JSONL must have mode 0o600');

    // ctx.source_path / target_path point at the on-disk JSONLs.
    assert.equal(ctx.source_path, sourcePath);
    assert.equal(ctx.target_path, targetPath);
  });

  it('api_env target gate: A=config_dir → B=api_env triggers fresh-chat with copy_skip_reason "api_env_in_rotation_path"', async () => {
    const fixture = await setupFixture();
    await registerConfigDirAccount(fixture.home, 'A');
    await registerApiEnvAccount(fixture.home, 'B', 'sk-b-key');

    const parent = await rateLimitParent(fixture, { firstAccount: 'A', priority: ['A', 'B'] });
    const child = await followup(fixture, parent.runId, 'follow up after rotate');

    const ctx = child.terminalContext ?? {};
    assert.equal(ctx.kind, 'fresh_chat_after_rotation');
    assert.equal(ctx.copy_skip_reason, 'api_env_in_rotation_path');
    // No resume attempted on a fresh-chat rotation: requested_session_id stays null.
    assert.equal(child.requestedSessionId, null);
    const lastHist = lastRotationHistory(child.metadata);
    assert.ok(lastHist);
    assert.equal(lastHist!.resumed, false);
    assert.equal(child.metadata.claude_account_used, 'B');
  });

  it('api_env source gate: A=api_env → B=config_dir triggers fresh-chat with copy_skip_reason "api_env_in_rotation_path"', async () => {
    const fixture = await setupFixture();
    await registerApiEnvAccount(fixture.home, 'A', 'sk-a-key');
    await registerConfigDirAccount(fixture.home, 'B');

    const parent = await rateLimitParent(fixture, { firstAccount: 'A', priority: ['A', 'B'] });
    const child = await followup(fixture, parent.runId, 'follow up after rotate');

    const ctx = child.terminalContext ?? {};
    assert.equal(ctx.kind, 'fresh_chat_after_rotation');
    assert.equal(ctx.copy_skip_reason, 'api_env_in_rotation_path');
    assert.equal(child.requestedSessionId, null);
    const lastHist = lastRotationHistory(child.metadata);
    assert.ok(lastHist);
    assert.equal(lastHist!.resumed, false);
    assert.equal(child.metadata.claude_account_used, 'B');
  });

  it('A→B→A cycle: byte-equal JSONL collision yields collision_resolution "noop" and resume succeeds', async () => {
    // T-COR4 case 14 (A→B→A idempotent) through sendFollowup. Rotate A→B,
    // then send a second followup off the rotated child to rotate B→A. The
    // helper-level test (sessionCopy.test.ts) already asserts the byte-equal
    // path; this test wires the same outcome through the orchestrator.
    const fixture = await setupFixture();
    const aDir = await registerConfigDirAccount(fixture.home, 'A');
    const bDir = await registerConfigDirAccount(fixture.home, 'B');

    const parent = await rateLimitParent(fixture, { firstAccount: 'A', priority: ['A', 'B'] });
    assert.ok(parent.observedSessionId);
    const sid = parent.observedSessionId!;
    const encodedCwd = fixture.cwd.replace(/\//g, '-');
    const aSourcePath = join(aDir, 'projects', encodedCwd, `${sid}.jsonl`);
    const bTargetPath = join(bDir, 'projects', encodedCwd, `${sid}.jsonl`);
    void bTargetPath;

    // Pre-seed B's JSONL byte-equal to A's so the collision case fires when
    // we attempt the cycle. (A→B→A means re-rotating after a B→rate_limit
    // child terminates; faking it directly is simpler than orchestrating
    // a second rate-limit on B.)
    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    const aBytes = await readFile(aSourcePath);
    await mkdir(join(bDir, 'projects', encodedCwd), { recursive: true });
    await writeFile(join(bDir, 'projects', encodedCwd, `${sid}.jsonl`), aBytes, { mode: 0o600 });

    const child = await followup(fixture, parent.runId, 'follow up after rotate');

    // The byte-equal collision path returns ok:true with collision_resolution: 'noop',
    // so the rotation child should still resume successfully.
    const ctx = child.terminalContext ?? {};
    assert.equal(ctx.kind, 'resumed_after_rotation');
    assert.equal(ctx.collision_resolution, 'noop');
    assert.equal(ctx.copied_bytes, 0);
    assert.equal(child.requestedSessionId, sid);
  });

  it('A→B byte-different existing target: copy_skip_reason "session_jsonl_collision"', async () => {
    const fixture = await setupFixture();
    const aDir = await registerConfigDirAccount(fixture.home, 'A');
    const bDir = await registerConfigDirAccount(fixture.home, 'B');

    const parent = await rateLimitParent(fixture, { firstAccount: 'A', priority: ['A', 'B'] });
    assert.ok(parent.observedSessionId);
    const sid = parent.observedSessionId!;
    const encodedCwd = fixture.cwd.replace(/\//g, '-');
    void aDir;

    // Pre-seed B's JSONL with DIFFERENT contents so the collision-different
    // path fires.
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(bDir, 'projects', encodedCwd), { recursive: true });
    await writeFile(join(bDir, 'projects', encodedCwd, `${sid}.jsonl`), 'divergent body', { mode: 0o600 });

    const child = await followup(fixture, parent.runId, 'follow up after rotate');

    const ctx = child.terminalContext ?? {};
    assert.equal(ctx.kind, 'fresh_chat_after_rotation');
    assert.equal(ctx.copy_skip_reason, 'session_jsonl_collision');
    assert.equal(child.requestedSessionId, null);
    const lastHist = lastRotationHistory(child.metadata);
    assert.ok(lastHist);
    assert.equal(lastHist!.resumed, false);
  });

  it('Auth-files byte-identity: a successful rotated resume does not modify <new-account>/.claude.json or settings.json', async () => {
    const fixture = await setupFixture();
    const aDir = await registerConfigDirAccount(fixture.home, 'A');
    const bDir = await registerConfigDirAccount(fixture.home, 'B');
    void aDir;

    // Plant a few "auth-shaped" files in B's tree before rotation. The daemon
    // must touch ONLY projects/<encoded-cwd>/<sid>.jsonl during a rotated
    // resume; the rest of B's tree must be byte-identical before and after.
    const { writeFile, readFile, mkdir, readdir } = await import('node:fs/promises');
    const before: Map<string, Buffer> = new Map();
    for (const name of ['.claude.json', '.credentials.json', 'settings.json']) {
      const path = join(bDir, name);
      await writeFile(path, `pinned-${name}-bytes`, { mode: 0o600 });
      before.set(name, await readFile(path));
    }
    // Also a stray file in a sibling subdir; must remain untouched.
    await mkdir(join(bDir, 'plugins'), { recursive: true });
    await writeFile(join(bDir, 'plugins', 'pinned'), 'plugin-bytes', { mode: 0o600 });

    const parent = await rateLimitParent(fixture, { firstAccount: 'A', priority: ['A', 'B'] });
    const child = await followup(fixture, parent.runId, 'follow up');
    assert.equal((child.terminalContext ?? {}).kind, 'resumed_after_rotation');

    for (const [name, expected] of before.entries()) {
      const after = await readFile(join(bDir, name));
      assert.deepStrictEqual(after, expected, `${name} must be byte-identical after rotation`);
    }
    const pluginAfter = await readFile(join(bDir, 'plugins', 'pinned'));
    assert.deepStrictEqual(pluginAfter, Buffer.from('plugin-bytes'), 'plugins/pinned must be byte-identical');

    // Also confirm only `projects/` was touched under B (top-level entries unchanged shape).
    const topLevel = (await readdir(bDir)).sort();
    // Expected: .claude.json, .credentials.json, plugins, projects, settings.json
    assert.ok(topLevel.includes('projects'));
    assert.ok(topLevel.includes('.claude.json'));
    assert.ok(topLevel.includes('.credentials.json'));
    assert.ok(topLevel.includes('settings.json'));
    assert.ok(topLevel.includes('plugins'));
  });

  it('Early session_not_found on resume → interceptor fires → child terminates with kind: "fresh_chat_after_rotation" (e2e through sendFollowup)', async () => {
    // Reviewer gap: verify the orchestrator-level early-SNF terminal_context
    // outcome through sendFollowup (existing coverage was at the
    // ProcessManager unit level only).
    const fixture = await setupFixture();
    await registerConfigDirAccount(fixture.home, 'A');
    await registerConfigDirAccount(fixture.home, 'B');

    const parent = await rateLimitParent(fixture, { firstAccount: 'A', priority: ['A', 'B'] });
    assert.ok(parent.observedSessionId);

    // Followup prompt contains FORCE_SESSION_NOT_FOUND_EARLY. The fake-claude
    // detects it on the resume spawn and emits session_not_found. The
    // interceptor classifies, kills, and re-spawns via the
    // start-shape retry invocation (which lacks the forcing token in argv,
    // and the daemon strips earlyEventInterceptor from the retry, so the
    // start-shape fake-claude path runs and succeeds).
    const child = await followup(fixture, parent.runId, 'FORCE_SESSION_NOT_FOUND_EARLY please');
    const ctx = child.terminalContext ?? {};
    assert.equal(ctx.kind, 'fresh_chat_after_rotation', 'kind must be downgraded after the retry');
    assert.equal(ctx.resume_attempted, true);
    assert.equal(ctx.resume_failure_reason, 'session_not_found');
    // BI-COR6: claude_rotation_history[].resumed stays true (resume was attempted).
    const lastHist = lastRotationHistory(child.metadata);
    assert.ok(lastHist);
    assert.equal(lastHist!.resumed, true);
    assert.equal(child.metadata.claude_account_used, 'B');
  });

  it('Reviewer fix #2a: pre-spawn failure on a rotation child preserves rotation kind in terminal_context', async () => {
    // Construct a rotation child where the resume path is taken (kind:
    // "resumed_after_rotation" pre-set on meta), then trigger a pre-spawn
    // failure by wiping the cwd between createRun and runtime.resume.
    // The simplest hermetic trigger: remove the cwd directory after the
    // parent terminates but before sendFollowup runs. failPreSpawn must
    // merge the rotation marker into the failure terminal_context so the
    // supervisor still sees `kind: "resumed_after_rotation"`.
    const fixture = await setupFixture();
    await registerConfigDirAccount(fixture.home, 'A');
    await registerConfigDirAccount(fixture.home, 'B');

    const parent = await rateLimitParent(fixture, { firstAccount: 'A', priority: ['A', 'B'] });
    assert.ok(parent.observedSessionId);

    // Wipe the cwd so the rotation child's startManagedRun fails the
    // access(R_OK | W_OK) check and routes through failPreSpawn.
    const { rm } = await import('node:fs/promises');
    await rm(fixture.cwd, { recursive: true, force: true });

    const fu = await fixture.service.sendFollowup({ run_id: parent.runId, prompt: 'fu' });
    // sendFollowup returns ok with a run_id even when the spawn ultimately
    // fails — startManagedRun runs after createRun.
    assert.equal(fu.ok, true);
    const childId = (fu as unknown as { run_id: string }).run_id;
    await fixture.service.waitForRun({ run_id: childId, wait_seconds: 5 });

    const status = (await fixture.service.getRunStatus({ run_id: childId })) as unknown as {
      run_summary: { terminal_context: Record<string, unknown> | null; status: string };
    };
    assert.equal(status.run_summary.status, 'failed');
    const ctx = status.run_summary.terminal_context ?? {};
    // Rotation kind preserved alongside the failure context fields.
    assert.equal(ctx.kind, 'resumed_after_rotation', 'rotation kind must survive pre-spawn failure');
    assert.equal(ctx.prior_account, 'A');
    assert.equal(ctx.new_account, 'B');
  });

  it('source missing fallback: parent has no observed_session_id → fresh-chat with copy_skip_reason "no_observed_session_id"', async () => {
    // T-COR4 case 4 — we choose the `no_observed_session_id` arm of the
    // source-missing fallback rather than `source_missing` (JSONL-on-disk
    // missing) because mutating the parent's run meta to clear
    // `observed_session_id` is the cleanest way to reach the gate inside
    // OrchestratorService without coupling the fixture to the binary's exit
    // ordering. Plan T-COR4 case 4 explicitly allows either arm.
    const fixture = await setupFixture();
    await registerConfigDirAccount(fixture.home, 'A');
    await registerConfigDirAccount(fixture.home, 'B');

    const parent = await rateLimitParent(fixture, { firstAccount: 'A', priority: ['A', 'B'] });
    assert.ok(parent.observedSessionId, 'precondition: parent normally has observed_session_id');

    // Clear observed_session_id (and session_id, which fallback-reads for
    // observed when null) so the rotation gate evaluates the missing-id arm.
    const store = new RunStore(fixture.home);
    await store.updateMeta(parent.runId, (current) => ({
      ...current,
      observed_session_id: null,
      session_id: null,
    }));

    const child = await followup(fixture, parent.runId, 'follow up after rotate');

    const ctx = child.terminalContext ?? {};
    assert.equal(ctx.kind, 'fresh_chat_after_rotation');
    assert.equal(ctx.copy_skip_reason, 'no_observed_session_id');
    assert.equal(child.requestedSessionId, null);
    const lastHist = lastRotationHistory(child.metadata);
    assert.ok(lastHist);
    assert.equal(lastHist!.resumed, false);
    assert.equal(child.metadata.claude_account_used, 'B');
  });
});
