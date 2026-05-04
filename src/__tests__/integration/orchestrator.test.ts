import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBackendRegistry } from '../../backend/registry.js';
import { OrchestratorService } from '../../orchestratorService.js';
import { RunStore } from '../../runStore.js';

const execFileAsync = promisify(execFile);
let originalPath = process.env.PATH;

describe('agent orchestrator integration with mock CLIs', () => {
  beforeEach(() => {
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('runs Codex with git-based files_changed and captures session/result', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const start = await service.startRun({ backend: 'codex', prompt: 'edit files', cwd: repo });
    assert.equal(start.ok, true);
    const runId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    const waited = await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    assert.equal(waited.ok, true);
    assert.equal(waited.ok && (waited as unknown as { status: string }).status, 'completed');
    const result = await service.getRunResult({ run_id: runId });
    assert.equal(result.ok, true);
    const payload = result.ok ? (result as unknown as { result: { files_changed: string[]; summary: string } }).result : null;
    assert.ok(payload?.files_changed.includes('existing.txt'));
    assert.ok(payload?.files_changed.includes('new.txt'));
    assert.equal((result.ok ? (result as unknown as { run_summary: { session_id: string } }).run_summary : null)?.session_id, 'codex-session-1');
  });

  it('get_run_result falls back to the last assistant message for older empty-summary results', async () => {
    const fixture = await createFixture();
    const store = new RunStore(fixture.home);
    const service = new OrchestratorService(store, createBackendRegistry(store));
    await service.initialize();
    const run = await store.createRun({ backend: 'codex', cwd: fixture.root });
    await store.appendEvent(run.run_id, { type: 'assistant_message', payload: { text: 'Stored final answer.' } });
    await store.markTerminal(run.run_id, 'completed', [], {
      status: 'completed',
      summary: '',
      files_changed: [],
      commands_run: [],
      artifacts: [],
      errors: [],
    });

    const result = await service.getRunResult({ run_id: run.run_id });
    assert.equal(result.ok, true);
    const payload = result.ok ? (result as unknown as { result: { summary: string } }).result : null;
    assert.equal(payload?.summary, 'Stored final answer.');
  });

  it('runs Claude in a non-git cwd with event-derived files_changed fallback', async () => {
    const fixture = await createFixture();
    const cwd = await mkdtemp(join(tmpdir(), 'agent-non-git-'));
    const service = await createService(fixture.home);

    const start = await service.startRun({ backend: 'claude', prompt: 'event-file', cwd });
    const runId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    assert.equal(result.ok, true);
    const summary = result.ok ? (result as unknown as { run_summary: { git_snapshot_status: string } }).run_summary : null;
    const worker = result.ok ? (result as unknown as { result: { files_changed: string[] } }).result : null;
    assert.equal(summary?.git_snapshot_status, 'not_a_repo');
    assert.ok(worker?.files_changed.includes('event.txt'));
  });

  it('links follow-up runs and reuses captured session id', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const start = await service.startRun({ backend: 'claude', prompt: 'hello', cwd: repo });
    const parentId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: parentId, wait_seconds: 5 });
    const follow = await service.sendFollowup({ run_id: parentId, prompt: 'follow up' });
    assert.equal(follow.ok, true);
    const childId = follow.ok ? (follow as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: childId, wait_seconds: 5 });
    const child = await service.getRunStatus({ run_id: childId });
    assert.equal(child.ok, true);
    const summary = child.ok ? (child as unknown as { run_summary: { parent_run_id: string; session_id: string } }).run_summary : null;
    assert.equal(summary?.parent_run_id, parentId);
    assert.equal(summary?.session_id, 'claude-session-1');
  });

  it('passes model selections to workers and inherits parent models for follow-ups', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const start = await service.startRun({
      backend: 'codex',
      prompt: 'hello',
      cwd: repo,
      model: 'gpt-5.2',
      reasoning_effort: 'xhigh',
      service_tier: 'fast',
      metadata: {
        session_title: 'Model session',
        prompt_title: 'Initial model prompt',
      },
    });
    const parentId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: parentId, wait_seconds: 5 });

    const inherited = await service.sendFollowup({
      run_id: parentId,
      prompt: 'follow up',
      metadata: { prompt_title: 'Inherited model prompt' },
    });
    const inheritedId = inherited.ok ? (inherited as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: inheritedId, wait_seconds: 5 });

    const overridden = await service.sendFollowup({
      run_id: parentId,
      prompt: 'follow up override',
      model: 'gpt-5.4',
      reasoning_effort: 'medium',
      service_tier: 'normal',
    });
    const overriddenId = overridden.ok ? (overridden as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: overriddenId, wait_seconds: 5 });

    const parent = await service.getRunStatus({ run_id: parentId });
    const childInherited = await service.getRunStatus({ run_id: inheritedId });
    const childOverridden = await service.getRunStatus({ run_id: overriddenId });
    assert.equal(parent.ok && (parent as unknown as { run_summary: { model: string } }).run_summary.model, 'gpt-5.2');
    assert.equal(childInherited.ok && (childInherited as unknown as { run_summary: { model: string } }).run_summary.model, 'gpt-5.2');
    assert.equal(childOverridden.ok && (childOverridden as unknown as { run_summary: { model: string } }).run_summary.model, 'gpt-5.4');
    assert.equal(parent.ok && (parent as unknown as { run_summary: { model_source: string; display: { session_title: string; prompt_title: string }; observed_session_id: string } }).run_summary.model_source, 'explicit');
    assert.equal(childInherited.ok && (childInherited as unknown as { run_summary: { model_source: string; requested_session_id: string; display: { session_title: string; prompt_title: string } } }).run_summary.model_source, 'inherited');
    assert.equal(childInherited.ok && (childInherited as unknown as { run_summary: { requested_session_id: string } }).run_summary.requested_session_id, 'codex-session-1');
    assert.deepStrictEqual(parent.ok && (parent as unknown as { run_summary: { model_settings: unknown } }).run_summary.model_settings, { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null });
    assert.deepStrictEqual(childInherited.ok && (childInherited as unknown as { run_summary: { model_settings: unknown } }).run_summary.model_settings, { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null });
    assert.deepStrictEqual(childOverridden.ok && (childOverridden as unknown as { run_summary: { model_settings: unknown } }).run_summary.model_settings, { reasoning_effort: 'medium', service_tier: null, mode: 'normal' });
    assert.deepStrictEqual(
      parent.ok && (parent as unknown as { run_summary: { worker_invocation: { args: string[] } } }).run_summary.worker_invocation.args,
      ['exec', '--json', '--skip-git-repo-check', '--cd', repo, '--model', 'gpt-5.2', '-c', 'model_reasoning_effort="xhigh"', '-c', 'service_tier="fast"', '-'],
    );
    assert.equal(parent.ok && (parent as unknown as { run_summary: { display: { session_title: string; prompt_title: string } } }).run_summary.display.session_title, 'Model session');
    assert.equal(childInherited.ok && (childInherited as unknown as { run_summary: { display: { session_title: string; prompt_title: string } } }).run_summary.display.prompt_title, 'Inherited model prompt');
    assert.equal(await service.store.readPrompt(parentId), 'hello');

    const args = await readJsonLines<string[]>(join(repo, 'codex-args.jsonl'));
    assert.deepStrictEqual(args[0], ['exec', '--json', '--skip-git-repo-check', '--cd', repo, '--model', 'gpt-5.2', '-c', 'model_reasoning_effort="xhigh"', '-c', 'service_tier="fast"', '-']);
    assert.deepStrictEqual(args[1], ['exec', 'resume', '--json', '--skip-git-repo-check', '--model', 'gpt-5.2', '-c', 'model_reasoning_effort="xhigh"', '-c', 'service_tier="fast"', 'codex-session-1', '-']);
    assert.deepStrictEqual(args[2], ['exec', 'resume', '--json', '--skip-git-repo-check', '--ignore-user-config', '--model', 'gpt-5.4', '-c', 'model_reasoning_effort="medium"', 'codex-session-1', '-']);
  });

  it('resolves profile aliases from the live profiles file when starting workers', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    const profilesFile = join(fixture.root, 'profiles.json');

    await writeProfilesFile(profilesFile, 'gpt-5.2', 'high');
    const first = await service.startRun({
      profile: 'live-implementation',
      profiles_file: profilesFile,
      prompt: 'hello',
      cwd: repo,
    });
    assert.equal(first.ok, true);
    const firstId = first.ok ? (first as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: firstId, wait_seconds: 5 });

    await writeProfilesFile(profilesFile, 'gpt-5.4', 'medium');
    const second = await service.startRun({
      profile: 'live-implementation',
      profiles_file: profilesFile,
      prompt: 'hello again',
      cwd: repo,
    });
    assert.equal(second.ok, true);
    const secondId = second.ok ? (second as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: secondId, wait_seconds: 5 });

    const firstStatus = await service.getRunStatus({ run_id: firstId });
    const secondStatus = await service.getRunStatus({ run_id: secondId });
    assert.equal(firstStatus.ok && (firstStatus as unknown as { run_summary: { model: string } }).run_summary.model, 'gpt-5.2');
    assert.equal(secondStatus.ok && (secondStatus as unknown as { run_summary: { model: string } }).run_summary.model, 'gpt-5.4');
    assert.deepStrictEqual(
      secondStatus.ok && (secondStatus as unknown as { run_summary: { metadata: { worker_profile: unknown } } }).run_summary.metadata.worker_profile,
      { mode: 'profile', profile: 'live-implementation', profiles_file: profilesFile },
    );

    const followup = await service.sendFollowup({
      run_id: secondId,
      prompt: 'follow profile parent',
    });
    assert.equal(followup.ok, true);
    const followupId = followup.ok ? (followup as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: followupId, wait_seconds: 5 });
    const followupStatus = await service.getRunStatus({ run_id: followupId });
    assert.equal(followupStatus.ok, true);
    const followupMetadata = (followupStatus as unknown as { run_summary: { metadata: Record<string, unknown> } }).run_summary.metadata;
    assert.equal(Object.hasOwn(followupMetadata, 'worker_profile'), false);

    const explicitMetadata = await service.sendFollowup({
      run_id: secondId,
      prompt: 'follow profile parent with metadata',
      metadata: { worker_profile: { mode: 'explicit-child' } },
    });
    assert.equal(explicitMetadata.ok, true);
    const explicitMetadataId = explicitMetadata.ok ? (explicitMetadata as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: explicitMetadataId, wait_seconds: 5 });
    const explicitMetadataStatus = await service.getRunStatus({ run_id: explicitMetadataId });
    assert.equal(explicitMetadataStatus.ok, true);
    assert.deepStrictEqual(
      (explicitMetadataStatus as unknown as { run_summary: { metadata: { worker_profile: unknown } } }).run_summary.metadata.worker_profile,
      { mode: 'explicit-child' },
    );

    const args = await readJsonLines<string[]>(join(repo, 'codex-args.jsonl'));
    assert.deepStrictEqual(args[0], ['exec', '--json', '--skip-git-repo-check', '--cd', repo, '--model', 'gpt-5.2', '-c', 'model_reasoning_effort="high"', '-']);
    assert.deepStrictEqual(args[1], ['exec', '--json', '--skip-git-repo-check', '--cd', repo, '--model', 'gpt-5.4', '-c', 'model_reasoning_effort="medium"', '-']);
  });

  it('rejects live profile aliases when backend diagnostics report unavailable CLIs', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    const profilesFile = join(fixture.root, 'profiles.json');
    await writeProfilesFile(profilesFile, 'gpt-5.2', 'high');

    process.env.PATH = join(fixture.root, 'missing-bin');

    const listed = await service.listWorkerProfiles({ profiles_file: profilesFile, cwd: repo });
    assert.equal(listed.ok, true);
    const listedProfiles = listed as unknown as { invalid_profiles: Array<{ id: string; errors: string[] }>; profiles: unknown[]; diagnostics: string[] };
    assert.deepStrictEqual(listedProfiles.profiles, []);
    assert.equal(listedProfiles.invalid_profiles[0]?.id, 'live-implementation');
    assert.ok(listedProfiles.invalid_profiles[0]?.errors.some((error) => /profile live-implementation uses unavailable backend codex \(missing\)/.test(error)));
    assert.ok(listedProfiles.diagnostics.some((error) => /profile live-implementation uses unavailable backend codex \(missing\)/.test(error)));

    const start = await service.startRun({
      profile: 'live-implementation',
      profiles_file: profilesFile,
      prompt: 'hello',
      cwd: repo,
    });
    assert.equal(start.ok, false);
    assert.match(
      start.ok ? '' : start.error.message,
      /profile live-implementation uses unavailable backend codex \(missing\)/,
    );
    assert.deepStrictEqual(await service.store.listRuns(), []);
  });

  it('keeps valid live profiles usable when another profile is invalid', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    const profilesFile = join(fixture.root, 'profiles.json');
    await writeFile(profilesFile, JSON.stringify({
      version: 1,
      profiles: {
        'live-implementation': {
          backend: 'codex',
          model: 'gpt-5.2',
          reasoning_effort: 'high',
        },
        'broken-cursor': {
          backend: 'cursor',
          model: 'composer-2',
          reasoning_effort: 'high',
        },
      },
    }, null, 2));

    const listed = await service.listWorkerProfiles({ profiles_file: profilesFile, cwd: repo });
    assert.equal(listed.ok, true);
    const payload = listed as unknown as {
      profiles: Array<{ id: string; backend: string }>;
      invalid_profiles: Array<{ id: string; errors: string[] }>;
    };
    assert.deepStrictEqual(payload.profiles.map((profile) => profile.id), ['live-implementation']);
    assert.equal(payload.invalid_profiles[0]?.id, 'broken-cursor');
    assert.ok(payload.invalid_profiles[0]?.errors.some((error) => /reasoning_effort/.test(error)));

    const start = await service.startRun({
      profile: 'live-implementation',
      profiles_file: profilesFile,
      prompt: 'hello despite invalid peer',
      cwd: repo,
    });
    assert.equal(start.ok, true);
    const runId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });

    const broken = await service.startRun({
      profile: 'broken-cursor',
      profiles_file: profilesFile,
      prompt: 'should not launch',
      cwd: repo,
    });
    assertInvalidInput(broken, /Worker profile broken-cursor is invalid/);
  });

  it('upserts one worker profile through the daemon while preserving unrelated invalid profile diagnostics', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    const profilesFile = join(fixture.root, 'profiles.json');
    await writeFile(profilesFile, JSON.stringify({
      version: 1,
      profiles: {
        implementation: {
          backend: 'codex',
          model: 'openai/gpt-5.2',
          reasoning_effort: 'high',
        },
        unrelated: {
          backend: 'cursor',
          model: 'composer-2',
          reasoning_effort: 'high',
        },
      },
    }, null, 2));

    const repaired = await service.upsertWorkerProfile({
      profiles_file: profilesFile,
      cwd: repo,
      profile: 'implementation',
      backend: 'codex',
      model: 'gpt-5.4',
      reasoning_effort: 'medium',
      description: 'Implementation worker',
    });
    assert.equal(repaired.ok, true);
    const repairedPayload = repaired as unknown as {
      profile: { id: string; model: string; reasoning_effort: string };
      previous_profile: { model: string };
      invalid_profiles: Array<{ id: string; errors: string[] }>;
    };
    assert.equal(repairedPayload.profile.id, 'implementation');
    assert.equal(repairedPayload.profile.model, 'gpt-5.4');
    assert.equal(repairedPayload.profile.reasoning_effort, 'medium');
    assert.equal(repairedPayload.previous_profile.model, 'openai/gpt-5.2');
    assert.equal(repairedPayload.invalid_profiles[0]?.id, 'unrelated');

    const file = JSON.parse(await readFile(profilesFile, 'utf8')) as {
      profiles: Record<string, Record<string, unknown>>;
    };
    assert.deepStrictEqual(file.profiles.implementation, {
      backend: 'codex',
      model: 'gpt-5.4',
      reasoning_effort: 'medium',
      description: 'Implementation worker',
    });
    assert.equal(file.profiles.unrelated?.reasoning_effort, 'high');

    const listed = await service.listWorkerProfiles({ profiles_file: profilesFile, cwd: repo });
    assert.equal(listed.ok, true);
    const listedPayload = listed as unknown as {
      profiles: Array<{ id: string; model: string }>;
      invalid_profiles: Array<{ id: string }>;
    };
    assert.deepStrictEqual(listedPayload.profiles.map((profile) => profile.id), ['implementation']);
    assert.equal(listedPayload.invalid_profiles[0]?.id, 'unrelated');
  });

  it('enforces per-request writable-profiles policy context inside the daemon write path', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    const pinnedFile = join(fixture.root, 'pinned.json');
    const otherFile = join(fixture.root, 'other.json');
    await writeFile(pinnedFile, JSON.stringify({ version: 1, profiles: {} }, null, 2));
    await writeFile(otherFile, JSON.stringify({ version: 1, profiles: {} }, null, 2));

    // Pinned-path upsert with matching policy context succeeds.
    const allowed = await service.dispatch('upsert_worker_profile', {
      profiles_file: pinnedFile,
      cwd: repo,
      profile: 'planner',
      backend: 'codex',
      model: 'gpt-5.4',
      reasoning_effort: 'medium',
    }, { policy_context: { writable_profiles_file: pinnedFile } });
    const allowedRes = allowed as { ok: boolean };
    assert.equal(allowedRes.ok, true, 'pinned-path upsert with matching policy must succeed');

    // Non-pinned upsert with policy context is denied by the daemon write path.
    const denied = await service.dispatch('upsert_worker_profile', {
      profiles_file: otherFile,
      cwd: repo,
      profile: 'planner',
      backend: 'codex',
      model: 'gpt-5.4',
      reasoning_effort: 'medium',
    }, { policy_context: { writable_profiles_file: pinnedFile } });
    const deniedRes = denied as { ok: false; error: { code: string; message: string } };
    assert.equal(deniedRes.ok, false);
    assert.equal(deniedRes.error.code, 'INVALID_INPUT');
    assert.match(deniedRes.error.message, /restricted to the harness-pinned profiles manifest/);
    const otherContent = JSON.parse(await readFile(otherFile, 'utf8')) as { profiles: Record<string, unknown> };
    assert.deepStrictEqual(otherContent.profiles, {}, 'denied upsert must not write to non-pinned manifest');

    // Generic client without policy context can write any path.
    const generic = await service.dispatch('upsert_worker_profile', {
      profiles_file: otherFile,
      cwd: repo,
      profile: 'planner',
      backend: 'codex',
      model: 'gpt-5.4',
      reasoning_effort: 'medium',
    });
    const genericRes = generic as { ok: boolean };
    assert.equal(genericRes.ok, true, 'generic client (no policy context) keeps current behavior');
  });

  it('serializes concurrent upserts to the same manifest so neither change is lost', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    const profilesFile = join(fixture.root, 'profiles.json');
    await writeFile(profilesFile, JSON.stringify({ version: 1, profiles: {} }, null, 2));

    const [a, b] = await Promise.all([
      service.upsertWorkerProfile({
        profiles_file: profilesFile,
        cwd: repo,
        profile: 'one',
        backend: 'codex',
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
      }),
      service.upsertWorkerProfile({
        profiles_file: profilesFile,
        cwd: repo,
        profile: 'two',
        backend: 'codex',
        model: 'gpt-5.4',
        reasoning_effort: 'high',
      }),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    const persisted = JSON.parse(await readFile(profilesFile, 'utf8')) as {
      profiles: Record<string, { reasoning_effort?: string }>;
    };
    assert.equal(persisted.profiles.one?.reasoning_effort, 'medium', 'first concurrent upsert must persist');
    assert.equal(persisted.profiles.two?.reasoning_effort, 'high', 'second concurrent upsert must persist');
  });

  it('writes profiles atomically so concurrent readers never observe a partial manifest', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    const profilesFile = join(fixture.root, 'profiles.json');
    const originalManifest = {
      version: 1,
      profiles: {
        seed: { backend: 'codex', model: 'gpt-5.4', reasoning_effort: 'low' },
      },
    };
    await writeFile(profilesFile, `${JSON.stringify(originalManifest, null, 2)}\n`);

    let stop = false;
    const observed: string[] = [];
    const reader = (async () => {
      while (!stop) {
        try {
          const text = await readFile(profilesFile, 'utf8');
          observed.push(text);
        } catch (error) {
          const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
          // ENOENT would mean a truncate/replace race made the live file
          // disappear, which is exactly what the atomic rename prevents.
          assert.ok(code === 'ENOENT' ? false : true, `unexpected read error ${code}`);
        }
      }
    })();

    const writes: Array<Promise<unknown>> = [];
    for (let i = 0; i < 8; i += 1) {
      writes.push(
        service.upsertWorkerProfile({
          profiles_file: profilesFile,
          cwd: repo,
          profile: `p${i}`,
          backend: 'codex',
          model: 'gpt-5.4',
          reasoning_effort: i % 2 === 0 ? 'medium' : 'high',
        }),
      );
    }
    const results = await Promise.all(writes);
    for (const result of results) {
      assert.equal((result as { ok: boolean }).ok, true);
    }
    stop = true;
    await reader;

    // Every observed snapshot during the write storm must be parseable JSON
    // with the manifest shape; a truncated file would throw at JSON.parse.
    assert.ok(observed.length > 0, 'reader should have observed at least one snapshot');
    for (const snapshot of observed) {
      const parsed = JSON.parse(snapshot) as { version?: number; profiles?: Record<string, unknown> };
      assert.equal(parsed.version, 1, 'every observed snapshot must have manifest version 1');
      assert.equal(typeof parsed.profiles, 'object');
    }
  });

  it('rejects model settings that a backend cannot apply', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const claudeTier = await service.startRun({
      backend: 'claude',
      prompt: 'hello',
      cwd: repo,
      model: 'claude-opus-4-7',
      service_tier: 'fast',
    });
    assertInvalidInput(claudeTier, /Claude does not support service_tier/);

    const claudeAlias = await service.startRun({
      backend: 'claude',
      prompt: 'hello',
      cwd: repo,
      model: 'opus',
    });
    assertInvalidInput(claudeAlias, /Claude model must be a direct model id/);

    const claudeUnknownEffortModel = await service.startRun({
      backend: 'claude',
      prompt: 'hello',
      cwd: repo,
      model: 'claude-sonnet-4-5',
      reasoning_effort: 'high',
    });
    assertInvalidInput(claudeUnknownEffortModel, /Claude effort levels are documented/);

    const claudeXhighFallback = await service.startRun({
      backend: 'claude',
      prompt: 'hello',
      cwd: repo,
      model: 'claude-sonnet-4-6',
      reasoning_effort: 'xhigh',
    });
    assertInvalidInput(claudeXhighFallback, /Claude xhigh effort requires claude-opus-4-7/);

    const claudeProviderPrefixedXhigh = await service.startRun({
      backend: 'claude',
      prompt: 'hello',
      cwd: repo,
      model: 'anthropic/claude-opus-4-7',
      reasoning_effort: 'xhigh',
    });
    assertInvalidInput(claudeProviderPrefixedXhigh, /Claude xhigh effort requires claude-opus-4-7/);

    const claudePaddedXhigh = await service.startRun({
      backend: 'claude',
      prompt: 'hello',
      cwd: repo,
      model: 'foo-claude-opus-4-7-bar',
      reasoning_effort: 'xhigh',
    });
    assertInvalidInput(claudePaddedXhigh, /Claude xhigh effort requires claude-opus-4-7/);

    const claudeMax = await service.startRun({
      backend: 'claude',
      prompt: 'hello',
      cwd: repo,
      model: 'claude-opus-4-7',
      reasoning_effort: 'max',
    });
    assert.equal(claudeMax.ok, true);
    if (claudeMax.ok) {
      await service.waitForRun({ run_id: (claudeMax as unknown as { run_id: string }).run_id, wait_seconds: 5 });
    }

    const claudeOneMillionXhigh = await service.startRun({
      backend: 'claude',
      prompt: 'hello',
      cwd: repo,
      model: 'claude-opus-4-7[1m]',
      reasoning_effort: 'xhigh',
    });
    assert.equal(claudeOneMillionXhigh.ok, true);
    if (claudeOneMillionXhigh.ok) {
      await service.waitForRun({ run_id: (claudeOneMillionXhigh as unknown as { run_id: string }).run_id, wait_seconds: 5 });
    }

    const codexMax = await service.startRun({
      backend: 'codex',
      prompt: 'hello',
      cwd: repo,
      model: 'gpt-5.5',
      reasoning_effort: 'max',
    });
    assertInvalidInput(codexMax, /Codex reasoning_effort must be one of/);
  });

  it('records requested and observed backend session ids separately for resume auditing', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const start = await service.startRun({ backend: 'claude', prompt: 'hello', cwd: repo });
    const parentId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: parentId, wait_seconds: 5 });

    const follow = await service.sendFollowup({ run_id: parentId, prompt: 'session-mismatch' });
    const childId = follow.ok ? (follow as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: childId, wait_seconds: 5 });

    const child = await service.getRunStatus({ run_id: childId });
    assert.equal(child.ok, true);
    const summary = child.ok ? (child as unknown as {
      run_summary: {
        session_id: string;
        requested_session_id: string;
        observed_session_id: string;
      };
    }).run_summary : null;
    assert.equal(summary?.session_id, 'claude-session-1');
    assert.equal(summary?.requested_session_id, 'claude-session-1');
    assert.equal(summary?.observed_session_id, 'claude-session-mismatch');

    const followObserved = await service.sendFollowup({ run_id: childId, prompt: 'continue observed session' });
    const observedChildId = followObserved.ok ? (followObserved as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: observedChildId, wait_seconds: 5 });

    const observedChild = await service.getRunStatus({ run_id: observedChildId });
    assert.equal(observedChild.ok, true);
    const observedSummary = observedChild.ok ? (observedChild as unknown as {
      run_summary: {
        session_id: string;
        requested_session_id: string;
        observed_session_id: string;
        worker_invocation: { args: string[] };
      };
    }).run_summary : null;
    assert.equal(observedSummary?.session_id, 'claude-session-mismatch');
    assert.equal(observedSummary?.requested_session_id, 'claude-session-mismatch');
    assert.equal(observedSummary?.observed_session_id, 'claude-session-mismatch');
    assert.deepStrictEqual(
      observedSummary?.worker_invocation.args.slice(0, 3),
      ['-p', '--resume', 'claude-session-mismatch'],
    );
  });

  it('normalizes event-derived absolute files under cwd before unioning with git files', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const start = await service.startRun({ backend: 'claude', prompt: 'absolute-event-file', cwd: repo });
    const runId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    assert.equal(result.ok, true);
    const files = result.ok ? (result as unknown as { result: { files_changed: string[] } }).result.files_changed : [];
    assert.deepStrictEqual(files.filter((file) => file.endsWith('absolute-event.txt')), ['absolute-event.txt']);
  });

  it('cancels and times out running processes through the terminal state machine', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const cancelStart = await service.startRun({ backend: 'codex', prompt: 'slow-grandchild', cwd: repo, execution_timeout_seconds: 30 });
    const cancelId = cancelStart.ok ? (cancelStart as unknown as { run_id: string }).run_id : '';
    await waitForFile(join(repo, 'grandchild.pid'));
    const cancel = await service.cancelRun({ run_id: cancelId });
    assert.equal(cancel.ok, true);
    await service.waitForRun({ run_id: cancelId, wait_seconds: 10 });
    const cancelled = await service.getRunStatus({ run_id: cancelId });
    assert.equal(cancelled.ok && ((cancelled as unknown as { run_summary: { status: string } }).run_summary).status, 'cancelled');
    const grandchildPid = Number.parseInt(await readFile(join(repo, 'grandchild.pid'), 'utf8'), 10);
    assert.equal(isPidAlive(grandchildPid), false);

    const timeoutStart = await service.startRun({ backend: 'codex', prompt: 'slow', cwd: repo, execution_timeout_seconds: 1 });
    const timeoutId = timeoutStart.ok ? (timeoutStart as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: timeoutId, wait_seconds: 5 });
    const timedOut = await service.getRunStatus({ run_id: timeoutId });
    const timeoutSummary = timedOut.ok ? (timedOut as unknown as {
      run_summary: {
        status: string;
        timeout_reason: string;
        terminal_reason: string;
        latest_error: { category: string; source: string } | null;
      };
    }).run_summary : null;
    assert.equal(timeoutSummary?.status, 'timed_out');
    assert.equal(timeoutSummary?.timeout_reason, 'execution_timeout');
    assert.equal(timeoutSummary?.terminal_reason, 'execution_timeout');
    assert.equal(timeoutSummary?.latest_error?.category, 'timeout');
    assert.equal(timeoutSummary?.latest_error?.source, 'watchdog');
    const cancelAfterTimeout = await service.cancelRun({ run_id: timeoutId });
    assert.equal(cancelAfterTimeout.ok, false);
    const stillTimedOut = await service.getRunStatus({ run_id: timeoutId });
    assert.equal(stillTimedOut.ok && ((stillTimedOut as unknown as { run_summary: { status: string } }).run_summary).status, 'timed_out');
  });

  it('uses idle timeout for silent workers but keeps active long workers alive', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const idleStart = await service.startRun({ backend: 'codex', prompt: 'slow', cwd: repo, idle_timeout_seconds: 1 });
    const idleId = idleStart.ok ? (idleStart as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: idleId, wait_seconds: 5 });
    const idleStatus = await service.getRunStatus({ run_id: idleId });
    const idleSummary = idleStatus.ok ? (idleStatus as unknown as {
      run_summary: {
        status: string;
        timeout_reason: string;
        terminal_reason: string;
        latest_error: { category: string; source: string } | null;
      };
    }).run_summary : null;
    assert.equal(idleSummary?.status, 'timed_out');
    assert.equal(idleSummary?.timeout_reason, 'idle_timeout');
    assert.equal(idleSummary?.terminal_reason, 'idle_timeout');
    assert.equal(idleSummary?.latest_error?.category, 'timeout');

    const activeStart = await service.startRun({ backend: 'codex', prompt: 'active-slow', cwd: repo, idle_timeout_seconds: 1 });
    const activeId = activeStart.ok ? (activeStart as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: activeId, wait_seconds: 5 });
    const activeStatus = await service.getRunStatus({ run_id: activeId });
    const activeSummary = activeStatus.ok ? (activeStatus as unknown as {
      run_summary: {
        status: string;
        idle_timeout_seconds: number;
        execution_timeout_seconds: number | null;
        timeout_reason: string | null;
      };
    }).run_summary : null;
    assert.equal(activeSummary?.status, 'completed');
    assert.equal(activeSummary?.idle_timeout_seconds, 1);
    assert.equal(activeSummary?.execution_timeout_seconds, null);
    assert.equal(activeSummary?.timeout_reason, null);
  });

  it('migrates generated timeout config and preserves customized hard caps', async () => {
    const generated = await createFixture();
    await mkdir(generated.home, { recursive: true });
    await writeFile(join(generated.home, 'config.json'), JSON.stringify({
      default_execution_timeout_seconds: 1800,
      max_execution_timeout_seconds: 14400,
    }, null, 2));
    await createService(generated.home);
    assert.deepStrictEqual(JSON.parse(await readFile(join(generated.home, 'config.json'), 'utf8')), {
      default_idle_timeout_seconds: 1200,
      max_idle_timeout_seconds: 7200,
      default_execution_timeout_seconds: null,
      max_execution_timeout_seconds: 14400,
    });

    const customized = await createFixture();
    await mkdir(customized.home, { recursive: true });
    await writeFile(join(customized.home, 'config.json'), JSON.stringify({
      default_execution_timeout_seconds: 42,
      max_execution_timeout_seconds: 60,
    }, null, 2));
    await createService(customized.home);
    assert.deepStrictEqual(JSON.parse(await readFile(join(customized.home, 'config.json'), 'utf8')), {
      default_execution_timeout_seconds: 42,
      max_execution_timeout_seconds: 60,
      default_idle_timeout_seconds: 1200,
      max_idle_timeout_seconds: 7200,
    });
  });

  it('records missing binary as a failed run and sweeps running runs as orphaned', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    process.env.PATH = join(fixture.root, 'missing-bin');

    const start = await service.startRun({ backend: 'codex', prompt: 'hello', cwd: repo });
    assert.equal(start.ok, true);
    const runId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const result = await service.getRunResult({ run_id: runId });
    assert.equal(result.ok, true);
    const worker = result.ok ? (result as unknown as { result: { errors: { context?: { code?: string } }[] } }).result : null;
    assert.equal(worker?.errors[0]?.context?.code, 'WORKER_BINARY_MISSING');

    process.env.PATH = originalPath;
    const store = new RunStore(fixture.home);
    const running = await store.createRun({ backend: 'codex', cwd: repo });
    await store.updateMeta(running.run_id, (meta) => ({ ...meta, started_at: new Date().toISOString(), worker_pid: 12345, daemon_pid_at_spawn: 99999 }));
    await writeFile(join(store.runDir(running.run_id), '.lock'), `${JSON.stringify({ pid: 999_999_999, acquired_at: new Date(0).toISOString() })}\n`);
    const logMessages: string[] = [];
    const restarted = new OrchestratorService(store, createBackendRegistry(store), (message) => logMessages.push(message));
    await restarted.initialize();
    const swept = await store.loadRun(running.run_id);
    assert.equal(swept?.meta.status, 'orphaned');
    assert.equal(swept?.events.at(-1)?.payload.status, 'orphaned');
    assert.ok(logMessages.some((message) => message.includes(`orphaned run ${running.run_id}`)));
  });
});

async function createFixture(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-orch-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  await writeFile(join(root, 'placeholder'), '');
  await mkMockCli(bin, 'codex', 'codex-session-1');
  await mkMockCli(bin, 'claude', 'claude-session-1');
  process.env.PATH = prependPath(bin, originalPath);
  return { root, home };
}

async function createService(home: string): Promise<OrchestratorService> {
  const store = new RunStore(home);
  const service = new OrchestratorService(store, createBackendRegistry(store));
  await service.initialize();
  return service;
}

async function createGitRepo(root: string): Promise<string> {
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await execFileAsync('git', ['init'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await writeFile(join(repo, 'existing.txt'), 'foo\n');
  await execFileAsync('git', ['add', 'existing.txt'], { cwd: repo });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
  return repo;
}

async function writeProfilesFile(path: string, model: string, reasoningEffort: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    version: 1,
    profiles: {
      'live-implementation': {
        backend: 'codex',
        model,
        reasoning_effort: reasoningEffort,
      },
    },
  }, null, 2));
}

async function mkMockCli(binDir: string, name: string, sessionId: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const diagnosticArgs = process.argv.slice(2).join(' ');
if (diagnosticArgs === '--version') {
  console.log('${name} 1.2.3');
  process.exit(0);
}
if (${JSON.stringify(name)} === 'codex' && diagnosticArgs === 'exec --help') {
  console.log('Usage: codex exec --json --cd --skip-git-repo-check --model -');
  process.exit(0);
}
if (${JSON.stringify(name)} === 'codex' && diagnosticArgs === 'exec resume --help') {
  console.log('Usage: codex exec resume --json --skip-git-repo-check --model <session> -');
  process.exit(0);
}
if (${JSON.stringify(name)} === 'claude' && diagnosticArgs === '--help') {
  console.log('Usage: claude -p --output-format stream-json --resume --model <session>');
  process.exit(0);
}
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  process.on('SIGTERM', () => process.exit(0));
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  const activeSessionId = prompt.includes('session-mismatch') ? '${sessionId.replace('-1', '-mismatch')}' : resumedSessionId(args) ?? '${sessionId}';
  fs.appendFileSync(path.join(cwd, '${name}-args.jsonl'), JSON.stringify(args) + '\\n');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: activeSessionId }));
  if (prompt.includes('event-file') && !prompt.includes('absolute-event-file')) {
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'event.txt' } }] } }));
  }
  if (prompt.includes('edit')) {
    fs.writeFileSync(path.join(cwd, 'new.txt'), 'hi\\n');
    fs.writeFileSync(path.join(cwd, 'existing.txt'), 'bar\\n');
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'write files' } }] } }));
  }
  if (prompt.includes('absolute-event-file')) {
    const target = path.join(cwd, 'absolute-event.txt');
    fs.writeFileSync(target, 'absolute\\n');
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: target } }] } }));
  }
  if (prompt.includes('slow-grandchild')) {
    process.removeAllListeners('SIGTERM');
    process.on('SIGTERM', () => {});
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(cwd, 'grandchild.pid'), String(grandchild.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes('active-slow')) {
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
      console.log(JSON.stringify({ type: 'turn.started', tick: ticks }));
      if (ticks >= 5) {
        clearInterval(interval);
        console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'active slow done', session_id: activeSessionId }));
        process.exit(0);
      }
    }, 300);
    return;
  }
  if (prompt.includes('slow')) {
    setTimeout(() => {
      console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'slow done', session_id: activeSessionId }));
      process.exit(0);
    }, 10000);
    return;
  }
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: activeSessionId }));
});

function resumedSessionId(args) {
  const resumeFlag = args.indexOf('--resume');
  if (resumeFlag >= 0 && args[resumeFlag + 1]) return args[resumeFlag + 1];
  const resumeCommand = args.indexOf('resume');
  const promptDash = args.lastIndexOf('-');
  if (resumeCommand >= 0 && promptDash > resumeCommand + 1) return args[promptDash - 1];
  return null;
}
`;

  if (process.platform === 'win32') {
    const scriptPath = join(binDir, `${name}.js`);
    await writeFile(scriptPath, script);
    await writeFile(join(binDir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`);
    return;
  }

  const path = join(binDir, name);
  await writeFile(path, script);
  await chmod(path, 0o755);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, 'utf8');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function prependPath(entry: string, current: string | undefined): string {
  return current ? `${entry}${delimiter}${current}` : entry;
}

function assertInvalidInput(result: unknown, message: RegExp): void {
  const response = result as { ok: boolean; error?: { code: string; message: string } };
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, 'INVALID_INPUT');
  assert.match(response.error?.message ?? '', message);
}
