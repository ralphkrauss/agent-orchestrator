import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BackendStatusReportSchema, ObservabilitySnapshotSchema, RunLatestErrorSchema, RunSummarySchema, RunTerminalReasonSchema, StartRunInputSchema, SendFollowupInputSchema, WorkerResultSchema, wrapErr, wrapOk, orchestratorError } from '../contract.js';
import { deriveObservedResult } from '../backend/resultDerivation.js';

describe('contract schemas and envelopes', () => {
  it('accepts known-good run summaries and worker results', () => {
    RunSummarySchema.parse({
      run_id: '01HX0000000000000000000000',
      backend: 'codex',
      status: 'running',
      parent_run_id: null,
      session_id: null,
      model: null,
      cwd: '/tmp/repo',
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      worker_pid: null,
      worker_pgid: null,
      daemon_pid_at_spawn: null,
      git_snapshot_status: 'not_a_repo',
      git_snapshot: null,
      metadata: {},
    });

    WorkerResultSchema.parse({
      status: 'completed',
      summary: 'done',
      files_changed: ['a.txt'],
      commands_run: ['echo hi'],
      artifacts: [{ name: 'result.json', path: '/tmp/result.json' }],
      errors: [],
    });

    BackendStatusReportSchema.parse({
      frontend_version: '0.1.1-beta.0',
      daemon_version: '0.1.1-beta.0',
      version_match: true,
      daemon_pid: 123,
      platform: 'linux',
      node_version: 'v22.0.0',
      posix_supported: true,
      run_store: {
        path: '/home/test/.agent-orchestrator',
        accessible: true,
      },
      backends: [{
        name: 'codex',
        binary: 'codex',
        status: 'auth_unknown',
        path: '/usr/bin/codex',
        version: 'codex 1.0.0',
        auth: {
          status: 'unknown',
          hint: 'authenticate codex',
        },
        checks: [{ name: 'codex binary on PATH', ok: true }],
        hints: ['authenticate codex'],
      }],
    });
  });

  it('rejects malformed worker result status', () => {
    assert.throws(() => WorkerResultSchema.parse({
      status: 'cancelled',
      summary: '',
      files_changed: [],
      commands_run: [],
      artifacts: [],
      errors: [],
    }));
  });

  it('defaults older run summaries without model metadata to null', () => {
    const parsed = RunSummarySchema.parse({
      run_id: '01HX0000000000000000000000',
      backend: 'codex',
      status: 'running',
      parent_run_id: null,
      session_id: null,
      cwd: '/tmp/repo',
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      worker_pid: null,
      worker_pgid: null,
      daemon_pid_at_spawn: null,
      git_snapshot_status: 'not_a_repo',
      git_snapshot: null,
      metadata: {},
    });
    assert.equal(parsed.model, null);
    assert.equal(parsed.model_source, 'legacy_unknown');
    assert.deepStrictEqual(parsed.model_settings, { reasoning_effort: null, service_tier: null, mode: null });
    assert.equal(parsed.worker_invocation, null);
    assert.equal(parsed.requested_session_id, null);
    assert.equal(parsed.observed_session_id, null);
    assert.equal(parsed.observed_model, null);
    assert.equal(parsed.last_activity_at, null);
    assert.equal(parsed.last_activity_source, null);
    assert.equal(parsed.idle_timeout_seconds, null);
    assert.equal(parsed.execution_timeout_seconds, null);
    assert.equal(parsed.timeout_reason, null);
    assert.equal(parsed.terminal_reason, null);
    assert.equal(parsed.terminal_context, null);
    assert.equal(parsed.latest_error, null);
    assert.deepStrictEqual(parsed.display, {
      session_title: null,
      session_summary: null,
      prompt_title: null,
      prompt_summary: null,
    });
  });

  it('accepts activity, timeout, and latest error metadata additively', () => {
    const now = new Date().toISOString();
    const latestError = RunLatestErrorSchema.parse({
      message: 'authentication failed',
      category: 'auth',
      source: 'stderr',
      backend: 'codex',
      retryable: false,
      fatal: true,
      context: { code: 'AUTH_FAILED' },
    });
    const parsed = RunSummarySchema.parse({
      run_id: '01HX0000000000000000000000',
      backend: 'codex',
      status: 'timed_out',
      parent_run_id: null,
      session_id: null,
      cwd: '/tmp/repo',
      created_at: now,
      started_at: now,
      finished_at: now,
      last_activity_at: now,
      last_activity_source: 'stderr',
      worker_pid: null,
      worker_pgid: null,
      daemon_pid_at_spawn: null,
      git_snapshot_status: 'not_a_repo',
      git_snapshot: null,
      idle_timeout_seconds: 1200,
      execution_timeout_seconds: 7200,
      timeout_reason: 'idle_timeout',
      terminal_reason: 'backend_fatal_error',
      terminal_context: { idle_seconds: 1201 },
      latest_error: latestError,
      metadata: {},
    });

    assert.equal(parsed.last_activity_source, 'stderr');
    assert.equal(parsed.idle_timeout_seconds, 1200);
    assert.equal(parsed.timeout_reason, 'idle_timeout');
    assert.equal(parsed.latest_error?.category, 'auth');
  });

  it('parses known and future terminal reasons in run summaries', () => {
    assert.equal(RunTerminalReasonSchema.parse('backend_fatal_error'), 'backend_fatal_error');
    assert.equal(RunTerminalReasonSchema.parse('future_terminal_reason'), 'future_terminal_reason');
  });

  it('accepts idle timeout input for starts and follow-ups', () => {
    assert.equal(
      StartRunInputSchema.parse({
        backend: 'codex',
        prompt: 'do work',
        cwd: '/tmp/repo',
        idle_timeout_seconds: 1200,
      }).idle_timeout_seconds,
      1200,
    );
    assert.equal(
      SendFollowupInputSchema.parse({
        run_id: 'run',
        prompt: 'continue',
        idle_timeout_seconds: 1800,
      }).idle_timeout_seconds,
      1800,
    );
  });

  it('accepts observability snapshots', () => {
    ObservabilitySnapshotSchema.parse({
      generated_at: new Date().toISOString(),
      daemon_pid: 123,
      store_root: '/tmp/store',
      backend_status: null,
      sessions: [{
        session_key: 'codex:session-1',
        session_id: 'session-1',
        root_run_id: 'run-1',
        backend: 'codex',
        cwd: '/tmp/repo',
        workspace: {
          cwd: '/tmp/repo',
          repository_root: '/tmp/repo',
          repository_name: 'repo',
          branch: 'main',
          dirty_count: 0,
          label: 'repo:main',
        },
        title: 'Implement feature',
        summary: 'working on observability',
        status: 'running',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        run_count: 1,
        running_count: 1,
        models: [{ name: 'gpt-5.2', source: 'explicit' }],
        settings: [{ reasoning_effort: 'xhigh', service_tier: 'fast', mode: null }],
        warnings: [],
        prompts: [{
          run_id: 'run-1',
          status: 'running',
          title: 'Implement feature',
          summary: 'working on observability',
          preview: 'raw prompt preview',
          model: { name: 'gpt-5.2', source: 'explicit' },
          settings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null },
          created_at: new Date().toISOString(),
          last_activity_at: null,
        }],
      }],
      runs: [{
        run: {
          run_id: 'run-1',
          backend: 'codex',
          status: 'running',
          parent_run_id: null,
          session_id: 'session-1',
          model: 'gpt-5.2',
          model_source: 'explicit',
          requested_session_id: null,
          observed_session_id: 'session-1',
          observed_model: 'gpt-5.2',
          display: {
            session_title: 'Implement feature',
            session_summary: 'working on observability',
            prompt_title: 'Implement feature',
            prompt_summary: 'working on observability',
          },
          cwd: '/tmp/repo',
          created_at: new Date().toISOString(),
          started_at: null,
          finished_at: null,
          worker_pid: null,
          worker_pgid: null,
          daemon_pid_at_spawn: null,
          worker_invocation: {
            command: '/usr/local/bin/codex',
            args: ['exec', '--model', 'gpt-5.2', '-'],
          },
          git_snapshot_status: 'not_a_repo',
          git_snapshot: null,
          model_settings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null },
          metadata: {},
        },
        prompt: {
          title: 'Implement feature',
          summary: 'working on observability',
          preview: 'raw prompt preview',
          text: null,
          path: '/tmp/store/runs/run-1/prompt.txt',
          bytes: 18,
        },
        response: {
          status: 'completed',
          summary: 'Implemented feature',
          path: '/tmp/store/runs/run-1/result.json',
          bytes: 120,
        },
        model: { name: 'gpt-5.2', source: 'explicit', requested_name: 'gpt-5.2', observed_name: 'gpt-5.2' },
        settings: { reasoning_effort: 'xhigh', service_tier: 'fast', mode: null },
        session: {
          requested_session_id: null,
          observed_session_id: 'session-1',
          effective_session_id: 'session-1',
          status: 'new_session',
          warnings: [],
        },
        activity: {
          last_event_sequence: 0,
          last_event_at: null,
          last_event_type: null,
          last_interaction_preview: null,
          event_count: 0,
          recent_errors: [],
          recent_events: [],
        },
        artifacts: [{ name: 'prompt.txt', path: '/tmp/store/runs/run-1/prompt.txt', exists: true, bytes: 18 }],
        duration_seconds: null,
      }],
    });
  });

  it('wraps ok and error envelopes', () => {
    assert.deepStrictEqual(wrapOk({ run_id: 'r1' }), { ok: true, run_id: 'r1' });
    assert.deepStrictEqual(
      wrapErr(orchestratorError('UNKNOWN_RUN', 'missing')),
      { ok: false, error: { code: 'UNKNOWN_RUN', message: 'missing' } },
    );
    assert.deepStrictEqual(
      wrapErr(orchestratorError('DAEMON_VERSION_MISMATCH', 'mismatch', { frontend_version: 'new', daemon_version: 'old' })),
      { ok: false, error: { code: 'DAEMON_VERSION_MISMATCH', message: 'mismatch', details: { frontend_version: 'new', daemon_version: 'old' } } },
    );
  });
});

describe('result derivation mapping', () => {
  it('covers completed, needs-input, blocked, failed, cancelled, timed-out, and orphaned rows', () => {
    assert.deepStrictEqual(deriveObservedResult({ exitCode: 0, resultEventPresent: true, resultEventValid: true, stopReason: 'end_turn' }), {
      runStatus: 'completed',
      workerStatus: 'completed',
    });
    assert.deepStrictEqual(deriveObservedResult({ exitCode: 0, resultEventPresent: true, resultEventValid: true, stopReason: 'awaiting_input' }).workerStatus, 'needs_input');
    assert.deepStrictEqual(deriveObservedResult({ exitCode: 0, resultEventPresent: true, resultEventValid: true, stopReason: 'refusal' }).workerStatus, 'blocked');
    assert.deepStrictEqual(deriveObservedResult({ exitCode: 1, resultEventPresent: true, resultEventValid: true, stopReason: 'end_turn' }).runStatus, 'failed');
    assert.deepStrictEqual(deriveObservedResult({ exitCode: 0, resultEventPresent: false, resultEventValid: false, stopReason: null }).runStatus, 'failed');
    assert.deepStrictEqual(deriveObservedResult({ exitCode: 0, resultEventPresent: true, resultEventValid: true, stopReason: 'end_turn', runStatusOverride: 'cancelled' }).runStatus, 'cancelled');
    assert.deepStrictEqual(deriveObservedResult({ exitCode: 0, resultEventPresent: true, resultEventValid: true, stopReason: 'end_turn', runStatusOverride: 'timed_out' }).runStatus, 'timed_out');
    assert.deepStrictEqual(deriveObservedResult({ exitCode: 0, resultEventPresent: true, resultEventValid: true, stopReason: 'end_turn', runStatusOverride: 'orphaned' }).runStatus, 'orphaned');
  });
});
