// Issue #31 (locked 2026-05-05): codex_network and the OD1=B / OD2=B
// behaviors. These tests are deliberately collected in one file so the breaking
// change is searchable from a single regression entry point.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CodexNetworkSchema,
  RunModelSettingsSchema,
  StartRunInputSchema,
  SendFollowupInputSchema,
  UpsertWorkerProfileInputSchema,
} from '../contract.js';
import {
  createWorkerCapabilityCatalog,
  parseWorkerProfileManifest,
  validateWorkerProfiles,
  WorkerProfileSchema,
} from '../harness/capabilities.js';
import { buildOpenCodeHarnessConfig } from '../opencode/config.js';
import { buildClaudeHarnessConfig } from '../claude/config.js';
import { resolveMonitorPin } from '../claude/monitorPin.js';
import { buildObservabilitySnapshot } from '../observability.js';
import { RunStore } from '../runStore.js';

describe('issue #31 codex_network schema and contracts', () => {
  it('CodexNetworkSchema accepts the three documented values and rejects unknown ones', () => {
    assert.deepStrictEqual([...CodexNetworkSchema.options].sort(), ['isolated', 'user-config', 'workspace']);
    assert.equal(CodexNetworkSchema.parse('isolated'), 'isolated');
    assert.throws(() => CodexNetworkSchema.parse('open'));
  });

  it('RunModelSettingsSchema persists codex_network and defaults legacy records to null', () => {
    const parsed = RunModelSettingsSchema.parse({ reasoning_effort: 'xhigh', service_tier: 'fast', mode: null });
    assert.equal(parsed.codex_network, null);
    const explicit = RunModelSettingsSchema.parse({ codex_network: 'workspace' });
    assert.equal(explicit.codex_network, 'workspace');
  });

  it('UpsertWorkerProfileInputSchema accepts codex_network as an optional field', () => {
    const upsert = UpsertWorkerProfileInputSchema.parse({
      profile: 'pr-comment-reviewer',
      backend: 'codex',
      model: 'gpt-5.5',
      codex_network: 'workspace',
    });
    assert.equal(upsert.codex_network, 'workspace');
  });

  it('WorkerProfileSchema accepts codex_network on a codex profile and validates the value set', () => {
    const ok = parseWorkerProfileManifest({
      version: 1,
      profiles: {
        reviewer: { backend: 'codex', model: 'gpt-5.5', codex_network: 'workspace' },
      },
    });
    assert.equal(ok.ok, true);
    const validated = validateWorkerProfiles(ok.ok ? ok.value : assert.fail(), createWorkerCapabilityCatalog());
    assert.equal(validated.ok, true);
    assert.equal(validated.ok && validated.value.profiles.reviewer?.codex_network, 'workspace');

    const bogus = parseWorkerProfileManifest({
      version: 1,
      profiles: {
        reviewer: { backend: 'codex', model: 'gpt-5.5', codex_network: 'open' },
      },
    });
    assert.equal(bogus.ok, true, 'manifest schema accepts any non-empty string; capability layer enforces enum');
    const rejected = validateWorkerProfiles(bogus.ok ? bogus.value : assert.fail(), createWorkerCapabilityCatalog());
    assert.equal(rejected.ok, false);
    assert.ok(!rejected.ok && rejected.errors.some((error) => /unsupported codex_network open/.test(error)));
  });

  it('codex_network is rejected on non-codex profiles', () => {
    const claudeManifest = parseWorkerProfileManifest({
      version: 1,
      profiles: {
        reviewer: { backend: 'claude', model: 'claude-opus-4-7', codex_network: 'workspace' },
      },
    });
    assert.equal(claudeManifest.ok, true);
    const claudeResult = validateWorkerProfiles(claudeManifest.ok ? claudeManifest.value : assert.fail(), createWorkerCapabilityCatalog());
    assert.equal(claudeResult.ok, false);
    assert.ok(!claudeResult.ok && claudeResult.errors.some((error) => /codex_network which is only supported on the codex backend/.test(error)));

    const cursorManifest = parseWorkerProfileManifest({
      version: 1,
      profiles: {
        reviewer: { backend: 'cursor', model: 'composer-2', codex_network: 'workspace' },
      },
    });
    assert.equal(cursorManifest.ok, true);
    const cursorResult = validateWorkerProfiles(cursorManifest.ok ? cursorManifest.value : assert.fail(), createWorkerCapabilityCatalog());
    assert.equal(cursorResult.ok, false);
    assert.ok(!cursorResult.ok && cursorResult.errors.some((error) => /codex_network which is only supported on the codex backend/.test(error)));
  });

  it('capability catalog advertises codex network_modes but no others', () => {
    const catalog = createWorkerCapabilityCatalog();
    const codex = catalog.backends.find((backend) => backend.backend === 'codex');
    assert.deepStrictEqual(codex?.settings.network_modes, ['isolated', 'workspace', 'user-config']);
    const claude = catalog.backends.find((backend) => backend.backend === 'claude');
    assert.deepStrictEqual(claude?.settings.network_modes, []);
    const cursor = catalog.backends.find((backend) => backend.backend === 'cursor');
    assert.deepStrictEqual(cursor?.settings.network_modes, []);
  });

  it('OD2=B (T9): StartRunInputSchema rejects profile + codex_network as INVALID_INPUT', () => {
    const rejected = StartRunInputSchema.safeParse({
      profile: 'reviewer',
      prompt: 'p',
      cwd: '/tmp/repo',
      codex_network: 'workspace',
    });
    assert.equal(rejected.success, false);
    assert.ok(!rejected.success && rejected.error.issues.some((issue) =>
      /Profile mode cannot be mixed with direct backend\/model\/reasoning_effort\/service_tier\/codex_network settings/.test(issue.message)));
  });

  it('OD2=B (T9): StartRunInputSchema accepts codex_network in direct mode for codex', () => {
    const accepted = StartRunInputSchema.safeParse({
      backend: 'codex',
      prompt: 'p',
      cwd: '/tmp/repo',
      codex_network: 'workspace',
    });
    assert.equal(accepted.success, true);
    assert.equal(accepted.success && accepted.data.codex_network, 'workspace');
  });

  it('OD2=B (T9): SendFollowupInputSchema accepts codex_network as an optional field', () => {
    const accepted = SendFollowupInputSchema.safeParse({
      run_id: 'r1',
      prompt: 'continue',
      codex_network: 'user-config',
    });
    assert.equal(accepted.success, true);
    assert.equal(accepted.success && accepted.data.codex_network, 'user-config');
  });
});

describe('issue #31 supervisor system-prompt formatters (B1 / T13)', () => {
  function profilesForBackends(): ReturnType<typeof validateWorkerProfiles> {
    const manifest = parseWorkerProfileManifest({
      version: 1,
      profiles: {
        'codex-default': { backend: 'codex', model: 'gpt-5.5' },
        'codex-explicit-workspace': { backend: 'codex', model: 'gpt-5.5', codex_network: 'workspace' },
        'codex-explicit-user-config': { backend: 'codex', model: 'gpt-5.5', codex_network: 'user-config' },
        'claude-no-network': { backend: 'claude', model: 'claude-opus-4-7' },
      },
    });
    if (!manifest.ok) assert.fail('manifest must parse');
    return validateWorkerProfiles(manifest.value, createWorkerCapabilityCatalog());
  }

  it('opencode formatProfiles renders explicit and defaulted codex_network for codex profiles only', () => {
    const validated = profilesForBackends();
    assert.equal(validated.ok, true);
    const config = buildOpenCodeHarnessConfig({
      targetCwd: '/repo',
      skillRoots: ['/repo/.agents/skills'],
      skillRoot: '/repo/.agents/skills',
      mcpCliPath: '/pkg/dist/cli.js',
      profiles: validated.ok ? validated.value : undefined,
      profileDiagnostics: [],
      orchestrationSkillNames: [],
      catalog: createWorkerCapabilityCatalog(),
      manifestPath: '/repo/.agents/orchestration/profiles.json',
    });
    const agent = config.agent['agent-orchestrator'] as { prompt: string };
    // Defaulted codex profile renders the OD1=B effective default in the prompt.
    assert.match(agent.prompt, /codex-default: backend=codex, model=gpt-5\.5, codex_network=isolated \(default\)/);
    // Explicit codex profiles render the manifest value verbatim.
    assert.match(agent.prompt, /codex-explicit-workspace:[^\n]*codex_network=workspace/);
    assert.match(agent.prompt, /codex-explicit-user-config:[^\n]*codex_network=user-config/);
    // Claude profile must NOT get a codex_network line.
    assert.doesNotMatch(agent.prompt, /claude-no-network:[^\n]*codex_network=/);
    // Catalog renders network_modes for codex.
    assert.match(agent.prompt, /- codex \(Codex CLI\)[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n {2}network_modes=isolated, workspace, user-config/);
    // No network_modes line for claude (negative regression).
    const claudeBlock = agent.prompt.match(/- claude \(Claude CLI\)[\s\S]*?(?=\n- |$)/);
    assert.ok(claudeBlock);
    assert.doesNotMatch(claudeBlock?.[0] ?? '', /network_modes=/);
  });

  it('claude formatProfiles renders explicit and defaulted codex_network for codex profiles only', () => {
    const validated = profilesForBackends();
    assert.equal(validated.ok, true);
    const monitorPin = resolveMonitorPin({ AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' });
    const config = buildClaudeHarnessConfig({
      targetCwd: '/tmp/work',
      manifestPath: '/tmp/work/profiles.json',
      ephemeralSkillRoot: '/tmp/skills',
      orchestrationSkillNames: [],
      orchestrationSkills: [],
      runtimeSkillRoot: '/tmp/home/.claude/skills',
      runtimeSkillNames: [],
      catalog: createWorkerCapabilityCatalog(),
      profiles: validated.ok ? validated.value : undefined,
      profileDiagnostics: [],
      mcpCliPath: '/opt/agent-orchestrator/dist/cli.js',
      monitorPin,
    });
    assert.match(config.systemPrompt, /codex-default:[^\n]*codex_network=isolated \(default\)/);
    assert.match(config.systemPrompt, /codex-explicit-workspace:[^\n]*codex_network=workspace/);
    assert.doesNotMatch(config.systemPrompt, /claude-no-network:[^\n]*codex_network=/);
    assert.match(config.systemPrompt, / {2}network_modes=isolated, workspace, user-config/);
  });
});

describe('issue #31 observability dedup (T5 / P6)', () => {
  it('two runs identical except for codex_network appear as two distinct settings rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-network-observability-'));
    const store = new RunStore(root);
    await store.createRun({
      backend: 'codex',
      cwd: root,
      prompt: 'one',
      session_id: 'session-a',
      observed_session_id: 'session-a',
      model: 'gpt-5.5',
      model_source: 'explicit',
      model_settings: { reasoning_effort: 'high', service_tier: null, mode: null, codex_network: 'isolated' },
    });
    await store.createRun({
      backend: 'codex',
      cwd: root,
      prompt: 'two',
      session_id: 'session-a',
      observed_session_id: 'session-a',
      model: 'gpt-5.5',
      model_source: 'explicit',
      model_settings: { reasoning_effort: 'high', service_tier: null, mode: null, codex_network: 'workspace' },
    });

    const snapshot = await buildObservabilitySnapshot(store, {
      limit: 50,
      includePrompts: false,
      recentEventLimit: 0,
      daemonPid: null,
      backendStatus: null,
    });

    const session = snapshot.sessions.find((s) => s.session_id === 'session-a');
    assert.ok(session, 'session must be present');
    assert.equal(session?.settings.length, 2, 'two distinct codex_network values must produce two settings rows');
    const networks = session!.settings.map((s) => s.codex_network).sort();
    assert.deepStrictEqual(networks, ['isolated', 'workspace']);
  });
});

describe('issue #31 manifest round-trip (T4)', () => {
  it('upsert+list returns codex_network for codex profiles and preserves null for non-codex', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-network-roundtrip-'));
    const profilesFile = join(root, 'profiles.json');
    await writeFile(profilesFile, JSON.stringify({ version: 1, profiles: {} }, null, 2));
    const manifest = parseWorkerProfileManifest({
      version: 1,
      profiles: {
        reviewer: { backend: 'codex', model: 'gpt-5.5', codex_network: 'workspace' },
        helper: { backend: 'claude', model: 'claude-opus-4-7' },
      },
    });
    assert.equal(manifest.ok, true);
    const validated = validateWorkerProfiles(manifest.ok ? manifest.value : assert.fail(), createWorkerCapabilityCatalog());
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    assert.equal(validated.value.profiles.reviewer?.codex_network, 'workspace');
    assert.equal(validated.value.profiles.helper?.codex_network, undefined, 'non-codex profiles must not carry codex_network');
    // Manifest schema preserves the field through serialization.
    await writeFile(profilesFile, `${JSON.stringify(validated.value.manifest, null, 2)}\n`);
    const reloadedRaw = JSON.parse(await readFile(profilesFile, 'utf8')) as { profiles: Record<string, { codex_network?: string }> };
    assert.equal(reloadedRaw.profiles.reviewer?.codex_network, 'workspace');
    assert.equal(reloadedRaw.profiles.helper?.codex_network, undefined);
  });
});
