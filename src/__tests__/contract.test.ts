import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BackendStatusReportSchema, WorkerResultSchema, RunSummarySchema, wrapErr, wrapOk, orchestratorError } from '../contract.js';
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
