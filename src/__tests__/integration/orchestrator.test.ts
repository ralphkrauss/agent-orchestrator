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

  it('forge prevention: model-supplied metadata.orchestrator_id is stripped in start_run and send_followup unless pinned (D10/R8)', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    // 1. start_run with model-supplied orchestrator_id and NO pinned policy:
    // metadata must be cleansed of the forged value.
    const start = await service.dispatch(
      'start_run',
      { backend: 'codex', prompt: 'forge', cwd: repo, metadata: { orchestrator_id: 'forged-from-model', other: 'kept' } },
      {},
    ) as { ok: boolean; run_id?: string };
    assert.equal(start.ok, true);
    const runId = start.run_id!;
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const startMeta = await service.store.loadMeta(runId);
    assert.equal(Object.prototype.hasOwnProperty.call(startMeta.metadata, 'orchestrator_id'), false, 'forged orchestrator_id must be stripped');
    assert.equal(startMeta.metadata.other, 'kept');

    // 2. start_run WITH pinned policy: pinned id wins over model-supplied.
    const pinned = await service.dispatch(
      'start_run',
      { backend: 'codex', prompt: 'pinned', cwd: repo, metadata: { orchestrator_id: 'forged-from-model' } },
      { policy_context: { orchestrator_id: '01PINNEDORCH0000000000000ZZ' } },
    ) as { ok: boolean; run_id?: string };
    assert.equal(pinned.ok, true);
    await service.waitForRun({ run_id: pinned.run_id!, wait_seconds: 5 });
    const pinnedMeta = await service.store.loadMeta(pinned.run_id!);
    assert.equal(pinnedMeta.metadata.orchestrator_id, '01PINNEDORCH0000000000000ZZ');

    // 3. send_followup with no pinned policy: parent-inherited orchestrator_id
    // must NOT bleed through.
    const followNoPin = await service.dispatch(
      'send_followup',
      { run_id: pinned.run_id!, prompt: 'continue', metadata: { orchestrator_id: 'forged-followup' } },
      {},
    ) as { ok: boolean; run_id?: string };
    assert.equal(followNoPin.ok, true);
    await service.waitForRun({ run_id: followNoPin.run_id!, wait_seconds: 5 });
    const followMeta = await service.store.loadMeta(followNoPin.run_id!);
    assert.equal(Object.prototype.hasOwnProperty.call(followMeta.metadata, 'orchestrator_id'), false, 'parent orchestrator_id must not be inherited without a pinned policy');
  });

  it('orchestrator status flow: supervisor events + owned worker run drive aggregate state (issue #40)', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    // Register an orchestrator the way the Claude launcher would.
    const reg = await service.registerSupervisor({
      label: 'demo',
      cwd: repo,
      client: 'claude',
      orchestrator_id: '01TESTORCHESTRATOR0001IMPLZ',
    });
    assert.equal(reg.ok, true);
    const orchestratorId = '01TESTORCHESTRATOR0001IMPLZ';

    // 1. Idle baseline.
    let status = await service.getOrchestratorStatus({ orchestrator_id: orchestratorId });
    assert.equal(status.ok, true);
    assert.equal((status as unknown as { status: { state: string } }).status.state, 'idle');

    // 2. Supervisor turn → in_progress.
    await service.signalSupervisorEvent({ orchestrator_id: orchestratorId, event: 'turn_started' });
    status = await service.getOrchestratorStatus({ orchestrator_id: orchestratorId });
    assert.equal((status as unknown as { status: { state: string } }).status.state, 'in_progress');

    // 3. Notification (sticky waiting_for_user) — no children yet → waiting_for_user.
    await service.signalSupervisorEvent({ orchestrator_id: orchestratorId, event: 'turn_stopped' });
    await service.signalSupervisorEvent({ orchestrator_id: orchestratorId, event: 'waiting_for_user' });
    status = await service.getOrchestratorStatus({ orchestrator_id: orchestratorId });
    assert.equal((status as unknown as { status: { state: string } }).status.state, 'waiting_for_user');

    // 4. Start a worker run that is stamped with the orchestrator id via
    // policy_context. AC8 invariant: aggregate must be in_progress while the
    // child runs, even though the sticky waiting_for_user flag is still set.
    const start = await service.dispatch('start_run', {
      backend: 'codex',
      prompt: 'work',
      cwd: repo,
    }, { policy_context: { orchestrator_id: orchestratorId } }) as { ok: boolean; run_id?: string };
    assert.equal(start.ok, true);
    const childRunId = start.run_id!;

    // While the child is running, aggregate is in_progress (AC8).
    status = await service.getOrchestratorStatus({ orchestrator_id: orchestratorId });
    assert.equal((status as unknown as { status: { state: string; running_child_count: number; waiting_for_user: boolean } }).status.state, 'in_progress');
    assert.equal((status as unknown as { status: { running_child_count: number } }).status.running_child_count, 1);
    assert.equal((status as unknown as { status: { waiting_for_user: boolean } }).status.waiting_for_user, true, 'sticky waiting_for_user must remain set on the snapshot');

    // 5. Wait for the child to finish — aggregate transitions back to
    // waiting_for_user (sticky flag still set, no running children).
    await service.waitForRun({ run_id: childRunId, wait_seconds: 5 });
    status = await service.getOrchestratorStatus({ orchestrator_id: orchestratorId });
    assert.equal((status as unknown as { status: { state: string; running_child_count: number } }).status.state, 'waiting_for_user');
    assert.equal((status as unknown as { status: { running_child_count: number } }).status.running_child_count, 0);

    // 6. SessionEnd → stale.
    await service.signalSupervisorEvent({ orchestrator_id: orchestratorId, event: 'session_ended' });
    status = await service.getOrchestratorStatus({ orchestrator_id: orchestratorId });
    assert.equal((status as unknown as { status: { state: string } }).status.state, 'stale');

    // 7. Verify the worker run was stamped with the orchestrator id (D10).
    const runResult = await service.getRunResult({ run_id: childRunId });
    const runMeta = (runResult as unknown as { run_summary: { metadata: Record<string, unknown> } }).run_summary;
    assert.equal(runMeta.metadata.orchestrator_id, orchestratorId);

    // 8. Unregister cleans up.
    const unreg = await service.unregisterSupervisor({ orchestrator_id: orchestratorId });
    assert.equal(unreg.ok, true);
    const after = await service.getOrchestratorStatus({ orchestrator_id: orchestratorId });
    assert.equal(after.ok, false);
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

    // Issue #58: pin worker_posture: 'restricted' so this test continues to
    // exercise the v1 codex isolated argv shape (with --ignore-user-config).
    // The new 'trusted' default has its own argv shape; covered separately.
    const start = await service.startRun({
      backend: 'codex',
      prompt: 'hello',
      cwd: repo,
      model: 'gpt-5.2',
      reasoning_effort: 'xhigh',
      service_tier: 'fast',
      worker_posture: 'restricted',
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
    // Issue #31 (OD1=B locked): codex_network defaults to 'isolated' when the
    // direct-mode start_run does not set it; mode is derived from
    // codex_network ('isolated' => 'normal'), not from service_tier.
    assert.deepStrictEqual(parent.ok && (parent as unknown as { run_summary: { model_settings: unknown } }).run_summary.model_settings, { reasoning_effort: 'xhigh', service_tier: 'fast', mode: 'normal', codex_network: 'isolated', worker_posture: 'restricted' });
    assert.deepStrictEqual(childInherited.ok && (childInherited as unknown as { run_summary: { model_settings: unknown } }).run_summary.model_settings, { reasoning_effort: 'xhigh', service_tier: 'fast', mode: 'normal', codex_network: 'isolated', worker_posture: 'restricted' });
    // Inverse-bug regression sibling (P5): service_tier='normal' alone (no
    // codex_network override) under OD1=B still resolves through
    // codex_network='isolated' so mode='normal' and --ignore-user-config is
    // present, but for the new reason. service_tier='normal' continues to be
    // suppressed in serialization because it is the codex CLI default.
    assert.deepStrictEqual(childOverridden.ok && (childOverridden as unknown as { run_summary: { model_settings: unknown } }).run_summary.model_settings, { reasoning_effort: 'medium', service_tier: null, mode: 'normal', codex_network: 'isolated', worker_posture: 'restricted' });
    assert.deepStrictEqual(
      parent.ok && (parent as unknown as { run_summary: { worker_invocation: { args: string[] } } }).run_summary.worker_invocation.args,
      ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--cd', repo, '--model', 'gpt-5.2', '-c', 'model_reasoning_effort="xhigh"', '-c', 'service_tier="fast"', '-'],
    );
    assert.equal(parent.ok && (parent as unknown as { run_summary: { display: { session_title: string; prompt_title: string } } }).run_summary.display.session_title, 'Model session');
    assert.equal(childInherited.ok && (childInherited as unknown as { run_summary: { display: { session_title: string; prompt_title: string } } }).run_summary.display.prompt_title, 'Inherited model prompt');
    assert.equal(await service.store.readPrompt(parentId), 'hello');

    const args = await readJsonLines<string[]>(join(repo, 'codex-args.jsonl'));
    assert.deepStrictEqual(args[0], ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--cd', repo, '--model', 'gpt-5.2', '-c', 'model_reasoning_effort="xhigh"', '-c', 'service_tier="fast"', '-']);
    assert.deepStrictEqual(args[1], ['exec', 'resume', '--json', '--skip-git-repo-check', '--ignore-user-config', '--model', 'gpt-5.2', '-c', 'model_reasoning_effort="xhigh"', '-c', 'service_tier="fast"', 'codex-session-1', '-']);
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
    // Issue #31: profile-mode codex starts default codex_network='isolated'
    // when the profile does not set it, so --ignore-user-config is present.
    assert.deepStrictEqual(args[0], ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--cd', repo, '--model', 'gpt-5.2', '-c', 'model_reasoning_effort="high"', '-']);
    assert.deepStrictEqual(args[1], ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--cd', repo, '--model', 'gpt-5.4', '-c', 'model_reasoning_effort="medium"', '-']);
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

  it('issue #58 (review Major 6): send_followup with worker_posture + incompatible model on Claude rejects with backend validation', async () => {
    // Regression for the validation bypass: previously a follow-up that set
    // `worker_posture` short-circuited the ternary before
    // validateInheritedModelSettingsForBackend could check the merged
    // settings, so a `worker_posture + model` follow-up on Claude could
    // persist an invalid reasoning_effort/model pair. The fix runs the
    // validator unconditionally for `parsed.data.model || backend === 'cursor'`
    // against the merged settings (including the new posture).
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const parent = await service.startRun({
      backend: 'claude',
      prompt: 'hello',
      cwd: repo,
      model: 'claude-opus-4-7',
      reasoning_effort: 'xhigh',
    });
    assert.equal(parent.ok, true);
    const parentId = (parent as unknown as { run_id: string }).run_id;
    await service.waitForRun({ run_id: parentId, wait_seconds: 5 });

    // Parent's reasoning_effort='xhigh' is inherited. The follow-up overrides
    // the model to claude-sonnet-4-6 (which does not support xhigh) and also
    // toggles worker_posture; pre-fix this slipped past the validator.
    const followup = await service.sendFollowup({
      run_id: parentId,
      prompt: 'rotate posture',
      model: 'claude-sonnet-4-6',
      worker_posture: 'restricted',
    });
    assertInvalidInput(followup, /Claude xhigh effort requires claude-opus-4-7/);
  });

  it('issue #58 (review Major 6): send_followup with worker_posture alone succeeds and persists the override', async () => {
    // Happy-path guard: the validator pass-through must not regress
    // posture-only follow-ups, where there is no model override and the
    // parent's inherited settings should flow through unchanged except for
    // the posture flip.
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const parent = await service.startRun({
      backend: 'claude',
      prompt: 'hello',
      cwd: repo,
      model: 'claude-opus-4-7',
    });
    assert.equal(parent.ok, true);
    const parentId = (parent as unknown as { run_id: string }).run_id;
    await service.waitForRun({ run_id: parentId, wait_seconds: 5 });

    const followup = await service.sendFollowup({
      run_id: parentId,
      prompt: 'flip posture only',
      worker_posture: 'restricted',
    });
    assert.equal(followup.ok, true);
    const childId = (followup as unknown as { run_id: string }).run_id;
    await service.waitForRun({ run_id: childId, wait_seconds: 5 });

    const child = await service.getRunStatus({ run_id: childId });
    const summary = child.ok
      ? (child as unknown as { run_summary: { model_settings: { worker_posture: string } } }).run_summary
      : null;
    assert.equal(summary?.model_settings.worker_posture, 'restricted');
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

  // Issue #31 — OD1=B / OD2=B / C12 end-to-end coverage.
  it('issue #31 (T9 / OD2=B): direct-mode codex_network=workspace flows into the codex argv', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    // Pin restricted posture: this test verifies the issue #31 argv shape
    // for codex_network='workspace', which under trusted no longer includes
    // --ignore-user-config (issue #58 Decision 9).
    const start = await service.startRun({
      backend: 'codex',
      prompt: 'fetch zen',
      cwd: repo,
      model: 'gpt-5.5',
      reasoning_effort: 'xhigh',
      codex_network: 'workspace',
      worker_posture: 'restricted',
    });
    assert.equal(start.ok, true);
    const runId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const status = await service.getRunStatus({ run_id: runId });
    assert.equal(status.ok, true);
    const summary = (status as unknown as { run_summary: { model_settings: { codex_network: string; mode: string | null }; worker_invocation: { args: string[] } } }).run_summary;
    assert.equal(summary.model_settings.codex_network, 'workspace');
    assert.equal(summary.model_settings.mode, null);
    assert.ok(summary.worker_invocation.args.includes('--ignore-user-config'));
    assert.ok(summary.worker_invocation.args.includes('-c'));
    assert.ok(summary.worker_invocation.args.includes('sandbox_workspace_write.network_access=true'));
  });

  it('issue #31 (T9 / OD2=B): start_run profile + codex_network is rejected as INVALID_INPUT', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    const profilesFile = join(fixture.root, 'profiles.json');
    await writeProfilesFile(profilesFile, 'gpt-5.5', 'high');

    const rejected = await service.startRun({
      profile: 'live-implementation',
      profiles_file: profilesFile,
      prompt: 'hello',
      cwd: repo,
      codex_network: 'workspace',
    });
    assertInvalidInput(rejected, /Profile mode cannot be mixed with direct backend\/model\/reasoning_effort\/service_tier\/codex_network\/worker_posture settings/);
  });

  it('issue #31 (T9): codex_network is rejected on non-codex direct-mode start_run', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const rejected = await service.startRun({
      backend: 'claude',
      prompt: 'hello',
      cwd: repo,
      model: 'claude-opus-4-7',
      codex_network: 'workspace',
    });
    assertInvalidInput(rejected, /codex_network is only supported on the codex backend/);
  });

  it('issue #31 (T10 / S3 / R8): send_followup inherits codex_network from the parent and accepts an explicit override', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    // Pin restricted posture so this test's argv assertions (including
    // --ignore-user-config under codex_network=isolated) continue to match
    // the v1 codex argv shape.
    const start = await service.startRun({
      backend: 'codex',
      prompt: 'parent',
      cwd: repo,
      model: 'gpt-5.5',
      codex_network: 'workspace',
      worker_posture: 'restricted',
    });
    const parentId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: parentId, wait_seconds: 5 });

    const inherited = await service.sendFollowup({ run_id: parentId, prompt: 'inherit' });
    const inheritedId = inherited.ok ? (inherited as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: inheritedId, wait_seconds: 5 });
    const inheritedStatus = await service.getRunStatus({ run_id: inheritedId });
    const inheritedSummary = (inheritedStatus as unknown as { run_summary: { model_settings: { codex_network: string }; worker_invocation: { args: string[] } } }).run_summary;
    assert.equal(inheritedSummary.model_settings.codex_network, 'workspace', 'follow-up must inherit parent codex_network when no override is provided');
    assert.ok(inheritedSummary.worker_invocation.args.includes('sandbox_workspace_write.network_access=true'));

    const overridden = await service.sendFollowup({
      run_id: parentId,
      prompt: 'override',
      codex_network: 'isolated',
    });
    const overriddenId = overridden.ok ? (overridden as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: overriddenId, wait_seconds: 5 });
    const overriddenStatus = await service.getRunStatus({ run_id: overriddenId });
    const overriddenSummary = (overriddenStatus as unknown as { run_summary: { model_settings: { codex_network: string; mode: string | null }; worker_invocation: { args: string[] } } }).run_summary;
    assert.equal(overriddenSummary.model_settings.codex_network, 'isolated', 'explicit codex_network argument must override inherited value');
    assert.equal(overriddenSummary.model_settings.mode, 'normal');
    assert.ok(overriddenSummary.worker_invocation.args.includes('--ignore-user-config'));
    assert.equal(overriddenSummary.worker_invocation.args.includes('sandbox_workspace_write.network_access=true'), false);
  });

  it('issue #31 (T9 / OD2=B): send_followup rejects codex_network on profile-mode parents', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    const profilesFile = join(fixture.root, 'profiles.json');
    await writeProfilesFile(profilesFile, 'gpt-5.5', 'high');

    const start = await service.startRun({ profile: 'live-implementation', profiles_file: profilesFile, prompt: 'hello', cwd: repo });
    const parentId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: parentId, wait_seconds: 5 });

    const rejected = await service.sendFollowup({
      run_id: parentId,
      prompt: 'override after profile',
      codex_network: 'workspace',
    });
    assertInvalidInput(rejected, /Profile-mode follow-ups cannot override codex_network/);
  });

  it('issue #58 (review High): default trusted codex run emits the trusted-default sandbox argv (no --ignore-user-config) and persists codex_network: null', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    // Direct-mode codex run with neither codex_network nor worker_posture set.
    // Trusted is the default; under trusted+absent codex_network the daemon
    // must spawn with -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true
    // and persist codex_network: null on the run record (so the run's effective
    // posture is unambiguously the trusted default).
    const start = await service.startRun({ backend: 'codex', prompt: 'default trusted run', cwd: repo, model: 'gpt-5.5' });
    const runId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });

    const status = await service.getRunStatus({ run_id: runId });
    const summary = (status as unknown as { run_summary: { model_settings: { codex_network: string | null; worker_posture: string }; worker_invocation: { args: string[] } } }).run_summary;
    assert.equal(summary.model_settings.worker_posture, 'trusted', 'default posture is trusted');
    assert.equal(summary.model_settings.codex_network, null, 'trusted + absent codex_network persists as null');
    const args = summary.worker_invocation.args;
    assert.equal(args.includes('--ignore-user-config'), false, 'trusted must NOT emit --ignore-user-config');
    assert.equal(args.includes('--sandbox'), false, 'shared sandboxArgs helper must NOT emit --sandbox (resume-unsafe)');
    assert.ok(args.includes('-c'));
    assert.ok(args.includes('sandbox_mode="workspace-write"'), 'trusted default includes sandbox_mode override');
    assert.ok(args.includes('sandbox_workspace_write.network_access=true'), 'trusted default opens workspace network');
  });

  it('issue #58 (review High): profile-mode codex with no codex_network and no worker_posture spawns with the trusted-default argv', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    const profilesFile = join(fixture.root, 'trusted-profiles.json');
    // Profile sets neither codex_network nor worker_posture: trusted default
    // applies, and codex_network resolution leaves null on the run record.
    await writeFile(profilesFile, JSON.stringify({
      version: 1,
      profiles: {
        'codex-trusted-default': {
          backend: 'codex',
          model: 'gpt-5.5',
          reasoning_effort: 'high',
        },
      },
    }, null, 2));

    const start = await service.startRun({ profile: 'codex-trusted-default', profiles_file: profilesFile, prompt: 'hello', cwd: repo });
    const runId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });

    const status = await service.getRunStatus({ run_id: runId });
    const summary = (status as unknown as { run_summary: { model_settings: { codex_network: string | null; worker_posture: string }; worker_invocation: { args: string[] } } }).run_summary;
    assert.equal(summary.model_settings.worker_posture, 'trusted');
    assert.equal(summary.model_settings.codex_network, null);
    const args = summary.worker_invocation.args;
    assert.equal(args.includes('--ignore-user-config'), false);
    assert.ok(args.includes('sandbox_mode="workspace-write"'));
    assert.ok(args.includes('sandbox_workspace_write.network_access=true'));
  });

  it('issue #31 (T11 / C12): a restricted codex run that defaulted codex_network emits exactly one non-blocking warning event', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    // Pin worker_posture: 'restricted' — issue #58 review follow-up suppresses
    // the warning under trusted because the trusted default is the intended
    // product direction, not a surprise breaking change. The warning still
    // fires under restricted (preserves the pre-#58 OD1=B closed-by-default).
    const defaulted = await service.startRun({ backend: 'codex', prompt: 'no codex_network', cwd: repo, model: 'gpt-5.5', worker_posture: 'restricted' });
    const defaultedId = defaulted.ok ? (defaulted as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: defaultedId, wait_seconds: 5 });
    const defaultedRun = await service.store.loadRun(defaultedId);
    const defaultedWarnings = (defaultedRun?.events ?? []).filter((event) => event.type === 'lifecycle' && (event.payload as { state?: string }).state === 'codex_network_defaulted');
    assert.equal(defaultedWarnings.length, 1, 'exactly one warning event must fire when codex_network is defaulted under restricted');
    assert.match(String(defaultedWarnings[0]?.payload.warning ?? ''), /codex_network not set/);
    assert.match(String(defaultedWarnings[0]?.payload.warning ?? ''), /docs\/development\/codex-backend\.md/);
    assert.equal((defaultedWarnings[0]?.payload as { worker_posture?: string }).worker_posture, 'restricted');
    // The warning must not block the run.
    assert.equal(defaultedRun?.meta.status, 'completed');

    // Explicit codex_network must NOT emit the warning.
    const explicit = await service.startRun({ backend: 'codex', prompt: 'explicit', cwd: repo, model: 'gpt-5.5', codex_network: 'workspace', worker_posture: 'restricted' });
    const explicitId = explicit.ok ? (explicit as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: explicitId, wait_seconds: 5 });
    const explicitRun = await service.store.loadRun(explicitId);
    const explicitWarnings = (explicitRun?.events ?? []).filter((event) => event.type === 'lifecycle' && (event.payload as { state?: string }).state === 'codex_network_defaulted');
    assert.equal(explicitWarnings.length, 0, 'no warning event must fire when codex_network is set explicitly');
  });

  it('issue #58 (review Medium 1): trusted codex with absent codex_network does NOT emit the codex_network_defaulted warning', async () => {
    // Under trusted, the trusted-default sandbox (workspace-write + network on)
    // is the intended product behavior. There is no explicit codex_network
    // value that preserves the same argv, so an unsilenceable warning would
    // be permanently noisy. The warning is therefore suppressed under
    // trusted+absent.
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const trusted = await service.startRun({ backend: 'codex', prompt: 'trusted absent', cwd: repo, model: 'gpt-5.5' });
    const trustedId = trusted.ok ? (trusted as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: trustedId, wait_seconds: 5 });
    const trustedRun = await service.store.loadRun(trustedId);
    const warnings = (trustedRun?.events ?? []).filter((event) => event.type === 'lifecycle' && (event.payload as { state?: string }).state === 'codex_network_defaulted');
    assert.equal(warnings.length, 0, 'trusted + absent codex_network must NOT emit a defaulted warning');
  });

  it('issue #31 (T11 / C12): profile-mode codex run that omits codex_network names the profile in the warning', async () => {
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    const profilesFile = join(fixture.root, 'profiles.json');
    await writeProfilesFile(profilesFile, 'gpt-5.5', 'high');

    const start = await service.startRun({ profile: 'live-implementation', profiles_file: profilesFile, prompt: 'hello', cwd: repo });
    const runId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const run = await service.store.loadRun(runId);
    const warnings = (run?.events ?? []).filter((event) => event.type === 'lifecycle' && (event.payload as { state?: string }).state === 'codex_network_defaulted');
    assert.equal(warnings.length, 1);
    assert.equal((warnings[0]?.payload as { profile: string }).profile, 'live-implementation');
    assert.match(String(warnings[0]?.payload.warning ?? ''), /profile live-implementation/);
  });

  it('issue #31 (T9 / B1): chained send_followup of a profile-mode run still rejects codex_network on the second hop', async () => {
    // Reviewer round 3 B1: `metadataForFollowup` strips worker_profile, so
    // checking only the immediate parent leaves a bypass: profile -> followup
    // (no override) -> followup (codex_network: workspace) used to slip
    // through. The orchestrator now walks parent_run_id back to the chain
    // root and consults that root's metadata.worker_profile flag.
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    const profilesFile = join(fixture.root, 'profiles.json');
    await writeProfilesFile(profilesFile, 'gpt-5.5', 'high');

    const start = await service.startRun({ profile: 'live-implementation', profiles_file: profilesFile, prompt: 'hello', cwd: repo });
    const parentId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: parentId, wait_seconds: 5 });

    const noOpFollow = await service.sendFollowup({ run_id: parentId, prompt: 'noop' });
    assert.equal(noOpFollow.ok, true, 'middle follow-up without overrides must succeed');
    const middleId = noOpFollow.ok ? (noOpFollow as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: middleId, wait_seconds: 5 });

    const rejected = await service.sendFollowup({
      run_id: middleId,
      prompt: 'override after chained follow-up',
      codex_network: 'workspace',
    });
    assertInvalidInput(rejected, /Profile-mode follow-ups cannot override codex_network/);
  });

  it('issue #31 (T5 / B2): legacy parent with codex_network=null produces a child whose persisted codex_network is the resolved isolated default', async () => {
    // Reviewer round 3 B2: a follow-up to a legacy codex run record (the
    // ones written before issue #31, which load with codex_network: null
    // because the schema applies that default) used to inherit null
    // verbatim. The plan invariant is "effective codex_network lands in
    // run_summary.model_settings"; sandboxArgs() defensively passes
    // --ignore-user-config for null, so the runtime is correct, but the
    // persisted record now also reflects the effective posture.
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    // Synthesize a legacy parent: a completed codex run whose stored
    // model_settings.codex_network is null (matches what runStore.ts loads
    // for pre-issue-#31 records via the schema default).
    const legacy = await service.store.createRun({
      backend: 'codex',
      cwd: repo,
      prompt: 'legacy parent',
      model: 'gpt-5.5',
      model_source: 'explicit',
      session_id: 'codex-session-1',
      observed_session_id: 'codex-session-1',
      // worker_posture: 'restricted' pins the issue #31 argv shape the
      // test's assertions encode. The legacy-null normalization path for
      // codex_network is what this test exercises.
      model_settings: { reasoning_effort: 'high', service_tier: null, mode: null, codex_network: null, worker_posture: 'restricted' },
    });
    await service.store.markTerminal(legacy.run_id, 'completed', [], {
      status: 'completed',
      summary: 'legacy ok',
      files_changed: [],
      commands_run: [],
      artifacts: [],
      errors: [],
    });

    const follow = await service.sendFollowup({ run_id: legacy.run_id, prompt: 'continue with no override' });
    assert.equal(follow.ok, true);
    const childId = follow.ok ? (follow as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: childId, wait_seconds: 5 });
    const childMeta = await service.store.loadMeta(childId);
    assert.equal(childMeta.model_settings.codex_network, 'isolated', 'codex follow-up must persist the effective isolated default, not legacy null');
    assert.equal(childMeta.model_settings.mode, 'normal', 'mode breadcrumb must be re-derived from the resolved codex_network');
    assert.equal(childMeta.model_settings.worker_posture, 'restricted', 'restricted posture inherits from the legacy parent');
    assert.ok(childMeta.worker_invocation?.args.includes('--ignore-user-config'));
  });

  it('issue #31 (T5 / B2): non-codex follow-ups must keep codex_network as null (never carry the field)', async () => {
    // B2 negative regression: claude / cursor follow-ups never carry
    // codex_network. The legacy-null normalization path must be codex-only.
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const start = await service.startRun({ backend: 'claude', prompt: 'parent', cwd: repo, model: 'claude-opus-4-7' });
    const parentId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: parentId, wait_seconds: 5 });
    const follow = await service.sendFollowup({ run_id: parentId, prompt: 'continue' });
    const childId = follow.ok ? (follow as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: childId, wait_seconds: 5 });
    const childMeta = await service.store.loadMeta(childId);
    assert.equal(childMeta.model_settings.codex_network, null, 'non-codex follow-ups must keep codex_network: null');
  });

  it('issue #31 (T2 / B3): orchestrator-level inverse-bug regression — service_tier=normal + codex_network=user-config produces argv WITHOUT --ignore-user-config', async () => {
    // Reviewer round 3 B3: B3 wanted the inverse-bug pinned at the
    // orchestrator service layer, not just at the codex backend's argv
    // builder. This test calls the service end-to-end and inspects the
    // recorded worker_invocation argv. The original foot-gun lived in
    // modelSettingsForBackend's service_tier -> mode -> --ignore-user-config
    // chain; the explicit codex_network: 'user-config' must override.
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);

    const start = await service.startRun({
      backend: 'codex',
      prompt: 'inverse bug regression',
      cwd: repo,
      model: 'gpt-5.5',
      reasoning_effort: 'high',
      service_tier: 'normal',
      codex_network: 'user-config',
    });
    assert.equal(start.ok, true);
    const runId = start.ok ? (start as unknown as { run_id: string }).run_id : '';
    await service.waitForRun({ run_id: runId, wait_seconds: 5 });
    const status = await service.getRunStatus({ run_id: runId });
    const summary = (status as unknown as { run_summary: { model_settings: { codex_network: string; mode: string | null; service_tier: string | null }; worker_invocation: { args: string[] } } }).run_summary;
    assert.equal(summary.model_settings.codex_network, 'user-config');
    assert.equal(summary.model_settings.mode, null, 'mode must be null when codex_network=user-config; legacy service_tier=normal must not re-derive mode');
    assert.equal(
      summary.worker_invocation.args.includes('--ignore-user-config'),
      false,
      '--ignore-user-config must NOT appear when codex_network=user-config, even though service_tier=normal historically forced it',
    );
  });

  it('issue #31 (T4 / B4): real upsertWorkerProfile + listWorkerProfiles round-trip preserves codex_network across reload', async () => {
    // Reviewer round 3 B4: drive the actual orchestrator service surface
    // (not direct schema parsing). Create a codex profile with
    // codex_network: 'workspace', simulate a daemon restart by constructing a
    // fresh OrchestratorService over the same store/profiles file, and
    // confirm listWorkerProfiles reads the field back intact.
    const fixture = await createFixture();
    const repo = await createGitRepo(fixture.root);
    const service = await createService(fixture.home);
    const profilesFile = join(fixture.root, 'profiles.json');
    await writeFile(profilesFile, JSON.stringify({ version: 1, profiles: {} }, null, 2));

    const upsert = await service.upsertWorkerProfile({
      profiles_file: profilesFile,
      cwd: repo,
      profile: 'pr-comment-reviewer',
      backend: 'codex',
      model: 'gpt-5.5',
      reasoning_effort: 'xhigh',
      codex_network: 'workspace',
      description: 'Needs network for gh api',
    });
    assert.equal(upsert.ok, true);
    const upsertPayload = upsert as unknown as { profile: { id: string; codex_network: string | null } };
    assert.equal(upsertPayload.profile.id, 'pr-comment-reviewer');
    assert.equal(upsertPayload.profile.codex_network, 'workspace');

    // Simulate a daemon restart: a fresh service over the same on-disk
    // store/profiles file. listWorkerProfiles re-reads the manifest from
    // disk via loadInspectedWorkerProfilesFromFile, so this path exercises
    // the full reload code.
    const restarted = await createService(fixture.home);
    const listed = await restarted.listWorkerProfiles({ profiles_file: profilesFile, cwd: repo });
    assert.equal(listed.ok, true);
    const listedPayload = listed as unknown as { profiles: Array<{ id: string; codex_network: string | null }> };
    const persisted = listedPayload.profiles.find((profile) => profile.id === 'pr-comment-reviewer');
    assert.ok(persisted, 'profile must round-trip across reload');
    assert.equal(persisted?.codex_network, 'workspace');

    // upsertWorkerProfile must reject codex_network for non-codex backends
    // with a clear error mentioning codex_network.
    const claudeRejected = await service.upsertWorkerProfile({
      profiles_file: profilesFile,
      cwd: repo,
      profile: 'claude-bogus',
      backend: 'claude',
      model: 'claude-opus-4-7',
      codex_network: 'workspace',
    });
    assertInvalidInput(claudeRejected, /codex_network which is only supported on the codex backend/);
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
  // Issue #58: pin worker_posture: 'restricted' so the codex argv assertions
  // in callers continue to match the v1 shape (with --ignore-user-config).
  // Trusted codex argv is covered by `backendInvocation.test.ts`.
  await writeFile(path, JSON.stringify({
    version: 1,
    profiles: {
      'live-implementation': {
        backend: 'codex',
        model,
        reasoning_effort: reasoningEffort,
        worker_posture: 'restricted',
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
