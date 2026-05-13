import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeBackend } from '../backend/claude.js';
import { errorFromEvent } from '../backend/common.js';
import { ProcessManager } from '../processManager.js';
import { RunStore } from '../runStore.js';
import type { EarlyEventInterceptor, EarlyEventInterceptorOutcome, WorkerInvocation } from '../backend/WorkerBackend.js';
import type { TerminalRunStatus, WorkerEvent, WorkerResult } from '../contract.js';

/**
 * D-COR-Resume-Layer step 1 verification (T-COR-Resume-Layer Step 1).
 *
 * Drives `ProcessManager.start` directly with a hand-built
 * `EarlyEventInterceptor` so the kill+discard+respawn cycle is exercised in
 * isolation from the orchestrator-side rotation wiring (T-COR2 / T-COR4).
 */

class MarkTerminalCounterStore extends RunStore {
  public readonly terminalCounts = new Map<string, number>();

  override async markTerminal(
    runId: string,
    status: TerminalRunStatus,
    errors: { message: string; context?: Record<string, unknown> }[] = [],
    result?: WorkerResult,
    terminal?: Parameters<RunStore['markTerminal']>[4],
  ): Promise<ReturnType<RunStore['markTerminal']> extends Promise<infer R> ? R : never> {
    this.terminalCounts.set(runId, (this.terminalCounts.get(runId) ?? 0) + 1);
    return super.markTerminal(runId, status, errors, result, terminal) as never;
  }
}

async function writeFakeClaude(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
}

interface ClaudeInvocationOptions {
  cli: string;
  cwd: string;
  interceptor?: EarlyEventInterceptor;
}

function claudeInvocation(opts: ClaudeInvocationOptions): WorkerInvocation {
  return {
    command: opts.cli,
    args: [],
    cwd: opts.cwd,
    stdinPayload: 'go',
    earlyEventInterceptor: opts.interceptor,
  };
}

/** Reuse the production classifier so the test wires the same logic the
 *  OrchestratorService will wire in step 2. Returning `retry_with_start` only
 *  on `session_not_found` mirrors the plan-spec contract. */
function buildClassify(): (event: { type: string; payload: Record<string, unknown> }) => EarlyEventInterceptorOutcome {
  return (event) => {
    if (event.type !== 'error') return 'continue';
    const err = errorFromEvent(event.payload, 'claude');
    return err?.category === 'session_not_found' ? 'retry_with_start' : 'continue';
  };
}

async function readEvents(store: RunStore, runId: string): Promise<WorkerEvent[]> {
  const result = await store.readEvents(runId, 0, 10_000);
  return result.events;
}

describe('D-COR-Resume-Layer / claudeResumeInterceptor', () => {
  it('Test 1 — fires on early session_not_found, replays via retryInvocation, single lifecycle marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cor-resume-1-'));
    const failingCli = join(root, 'fail.js');
    const successCli = join(root, 'ok.js');
    await writeFakeClaude(failingCli, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'error', subtype: 'session_not_found', message: 'session not found' }));
  setInterval(() => {}, 1000);
});`);
    await writeFakeClaude(successCli, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-retry' }));
  console.log(JSON.stringify({ type: 'assistant', session_id: 'sid-retry', message: { content: [{ type: 'text', text: 'ok-after-retry' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok-after-retry', session_id: 'sid-retry' }));
  process.exit(0);
});`);

    const store = new MarkTerminalCounterStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    const manager = new ProcessManager(store);

    const retryInvocation = claudeInvocation({ cli: successCli, cwd: root });
    const interceptor: EarlyEventInterceptor = {
      thresholdEvents: 50,
      thresholdMs: 5_000,
      classify: buildClassify(),
      retryInvocation,
    };
    const invocation = claudeInvocation({ cli: failingCli, cwd: root, interceptor });

    const managed = await manager.start(run.run_id, new ClaudeBackend(), invocation);
    const meta = await managed.completion;

    const events = await readEvents(store, run.run_id);
    const lifecycleMarkers = events.filter(
      (event) => event.type === 'lifecycle' && event.payload.subtype === 'session_not_found_in_run_retry',
    );
    assert.equal(lifecycleMarkers.length, 1, 'exactly one session_not_found_in_run_retry lifecycle event');
    const marker = lifecycleMarkers[0]!;
    assert.equal(typeof marker.payload.killed_pid, 'number');
    assert.equal(typeof marker.payload.resume_attempt_duration_ms, 'number');
    assert.equal(marker.payload.observed_events, 1);

    // The cancelled attempt's stream events MUST NOT have been appended:
    // the only `lifecycle/status:'started'` event in the file is the retry's,
    // emitted AFTER the lifecycle marker.
    const startedEvents = events.filter(
      (event) => event.type === 'lifecycle' && event.payload.status === 'started',
    );
    assert.equal(startedEvents.length, 1, 'cancelled attempt started event must not be persisted');
    const markerSeq = marker.seq;
    assert.ok(startedEvents[0]!.seq > markerSeq, 'retry started event must follow lifecycle marker');

    // No `error` events from the cancelled attempt landed.
    const errorEvents = events.filter((event) => event.type === 'error');
    assert.equal(errorEvents.length, 0, 'cancelled attempt error event must not be persisted');

    assert.equal(meta.status, 'completed');
    assert.equal(store.terminalCounts.get(run.run_id), 1);
  });

  it('Test 2 — late session_not_found is ignored after thresholdEvents disengages the interceptor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cor-resume-2-'));
    const cli = join(root, 'late.js');
    // Emit 60 benign assistant events then a late session_not_found, then exit.
    await writeFakeClaude(cli, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  for (let i = 0; i < 60; i++) {
    console.log(JSON.stringify({ type: 'assistant', session_id: 'sid-late', message: { content: [{ type: 'text', text: 'msg-' + i }] } }));
  }
  console.log(JSON.stringify({ type: 'error', subtype: 'session_not_found', message: 'too late' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'late-finish', session_id: 'sid-late' }));
  process.exit(0);
});`);

    const store = new MarkTerminalCounterStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    const manager = new ProcessManager(store);

    const retryCli = join(root, 'never.js');
    await writeFakeClaude(retryCli, `process.exit(99);`);
    const retryInvocation = claudeInvocation({ cli: retryCli, cwd: root });

    let classifyCalls = 0;
    const interceptor: EarlyEventInterceptor = {
      thresholdEvents: 50,
      thresholdMs: 60_000,
      classify: (event) => {
        classifyCalls += 1;
        return buildClassify()(event);
      },
      retryInvocation,
    };
    const invocation = claudeInvocation({ cli, cwd: root, interceptor });
    const managed = await manager.start(run.run_id, new ClaudeBackend(), invocation);
    const meta = await managed.completion;

    const events = await readEvents(store, run.run_id);
    const lifecycleMarkers = events.filter(
      (event) => event.type === 'lifecycle' && event.payload.subtype === 'session_not_found_in_run_retry',
    );
    assert.equal(lifecycleMarkers.length, 0, 'no retry should have fired past the threshold');
    // classify should NOT have been invoked beyond `thresholdEvents` (50).
    assert.ok(classifyCalls <= 50, `classify was invoked ${classifyCalls} times; expected <= 50`);
    // The terminal status reflects the underlying error category (session_not_found
    // is fatal under the existing classifier).
    assert.equal(meta.latest_error?.category, 'session_not_found');
    assert.equal(store.terminalCounts.get(run.run_id), 1);
  });

  it('Test 3 — time-based threshold expiry disengages the interceptor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cor-resume-3-'));
    const cli = join(root, 'stall.js');
    // Stall 600ms then emit session_not_found and exit.
    await writeFakeClaude(cli, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  setTimeout(() => {
    console.log(JSON.stringify({ type: 'error', subtype: 'session_not_found', message: 'stalled' }));
    process.exit(2);
  }, 600);
});`);

    const store = new MarkTerminalCounterStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    const manager = new ProcessManager(store);

    const retryCli = join(root, 'never.js');
    await writeFakeClaude(retryCli, `process.exit(99);`);

    const interceptor: EarlyEventInterceptor = {
      thresholdEvents: 100,
      thresholdMs: 100, // expires well before the 600ms stall
      classify: buildClassify(),
      retryInvocation: claudeInvocation({ cli: retryCli, cwd: root }),
    };
    const invocation = claudeInvocation({ cli, cwd: root, interceptor });
    const managed = await manager.start(run.run_id, new ClaudeBackend(), invocation);
    const meta = await managed.completion;

    const events = await readEvents(store, run.run_id);
    const lifecycleMarkers = events.filter(
      (event) => event.type === 'lifecycle' && event.payload.subtype === 'session_not_found_in_run_retry',
    );
    assert.equal(lifecycleMarkers.length, 0, 'time-expired interceptor must not retry');
    assert.equal(meta.latest_error?.category, 'session_not_found');
    assert.equal(store.terminalCounts.get(run.run_id), 1);
  });

  it('Test 4 — single-shot enforcement: retry worker emitting session_not_found does NOT trigger a second retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cor-resume-4-'));
    const failingCli = join(root, 'fail1.js');
    const failingCli2 = join(root, 'fail2.js');
    await writeFakeClaude(failingCli, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'error', subtype: 'session_not_found', message: 'sid not found 1' }));
  setInterval(() => {}, 1000);
});`);
    await writeFakeClaude(failingCli2, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'error', subtype: 'session_not_found', message: 'sid not found 2' }));
  process.exit(2);
});`);

    const store = new MarkTerminalCounterStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    const manager = new ProcessManager(store);

    // The retry invocation also fires session_not_found. Even if a caller
    // accidentally sets earlyEventInterceptor on the retry, ProcessManager.start
    // strips it before re-spawning.
    const interceptor: EarlyEventInterceptor = {
      thresholdEvents: 50,
      thresholdMs: 5_000,
      classify: buildClassify(),
      retryInvocation: claudeInvocation({ cli: failingCli2, cwd: root }),
    };
    const invocation = claudeInvocation({ cli: failingCli, cwd: root, interceptor });
    const managed = await manager.start(run.run_id, new ClaudeBackend(), invocation);
    const meta = await managed.completion;

    const events = await readEvents(store, run.run_id);
    const lifecycleMarkers = events.filter(
      (event) => event.type === 'lifecycle' && event.payload.subtype === 'session_not_found_in_run_retry',
    );
    assert.equal(lifecycleMarkers.length, 1, 'exactly one lifecycle marker — second session_not_found must flow to terminal');
    assert.equal(meta.latest_error?.category, 'session_not_found');
    assert.equal(store.terminalCounts.get(run.run_id), 1);
  });

  it('Test 5 — classify returning continue on a non-matching error: no retry, terminal carries underlying category', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cor-resume-5-'));
    const cli = join(root, 'protocol.js');
    await writeFakeClaude(cli, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  // status: 400 maps to category: 'protocol' under the existing classifier.
  console.log(JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'bad request shape' } }));
  process.exit(1);
});`);

    const store = new MarkTerminalCounterStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    const manager = new ProcessManager(store);

    const retryCli = join(root, 'never.js');
    await writeFakeClaude(retryCli, `process.exit(99);`);

    let classifyCalls = 0;
    const interceptor: EarlyEventInterceptor = {
      thresholdEvents: 50,
      thresholdMs: 5_000,
      classify: (event) => {
        classifyCalls += 1;
        return buildClassify()(event);
      },
      retryInvocation: claudeInvocation({ cli: retryCli, cwd: root }),
    };
    const invocation = claudeInvocation({ cli, cwd: root, interceptor });
    const managed = await manager.start(run.run_id, new ClaudeBackend(), invocation);
    const meta = await managed.completion;

    const events = await readEvents(store, run.run_id);
    const lifecycleMarkers = events.filter(
      (event) => event.type === 'lifecycle' && event.payload.subtype === 'session_not_found_in_run_retry',
    );
    assert.equal(lifecycleMarkers.length, 0, 'continue outcomes must not retry');
    assert.ok(classifyCalls >= 1, 'classify must have been invoked on the protocol error');
    assert.equal(meta.latest_error?.category, 'protocol');
    assert.equal(store.terminalCounts.get(run.run_id), 1);
  });

  it('Test 6 — backward compatibility: undefined interceptor preserves today\'s event flow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cor-resume-6-'));
    const cli = join(root, 'normal.js');
    await writeFakeClaude(cli, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-back' }));
  console.log(JSON.stringify({ type: 'assistant', session_id: 'sid-back', message: { content: [{ type: 'text', text: 'baseline' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'baseline', session_id: 'sid-back' }));
  process.exit(0);
});`);

    const store = new MarkTerminalCounterStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    const manager = new ProcessManager(store);

    // No interceptor → identical behaviour to today.
    const invocation = claudeInvocation({ cli, cwd: root });
    const managed = await manager.start(run.run_id, new ClaudeBackend(), invocation);
    const meta = await managed.completion;

    const events = await readEvents(store, run.run_id);
    const lifecycleMarkers = events.filter(
      (event) => event.type === 'lifecycle' && event.payload.subtype === 'session_not_found_in_run_retry',
    );
    assert.equal(lifecycleMarkers.length, 0, 'non-rotation runs must never see the retry lifecycle marker');
    const startedEvents = events.filter(
      (event) => event.type === 'lifecycle' && event.payload.status === 'started',
    );
    assert.equal(startedEvents.length, 1, 'one started lifecycle event for the single attempt');
    assert.equal(meta.status, 'completed');
    assert.equal(store.terminalCounts.get(run.run_id), 1);
  });

  it('Test 7 — cancelled attempt events are NOT appended; only retry events + lifecycle marker land', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cor-resume-7-'));
    const failingCli = join(root, 'preroll.js');
    const successCli = join(root, 'ok2.js');
    await writeFakeClaude(failingCli, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  // 3 normal events emitted before the session_not_found trigger.
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-pre' }));
  console.log(JSON.stringify({ type: 'assistant', session_id: 'sid-pre', message: { content: [{ type: 'text', text: 'pre-1' }] } }));
  console.log(JSON.stringify({ type: 'assistant', session_id: 'sid-pre', message: { content: [{ type: 'text', text: 'pre-2' }] } }));
  console.log(JSON.stringify({ type: 'error', subtype: 'session_not_found', message: 'session not found mid-run' }));
  setInterval(() => {}, 1000);
});`);
    await writeFakeClaude(successCli, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-final' }));
  console.log(JSON.stringify({ type: 'assistant', session_id: 'sid-final', message: { content: [{ type: 'text', text: 'final' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'final', session_id: 'sid-final' }));
  process.exit(0);
});`);

    const store = new MarkTerminalCounterStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    const manager = new ProcessManager(store);

    const retryInvocation = claudeInvocation({ cli: successCli, cwd: root });
    const interceptor: EarlyEventInterceptor = {
      thresholdEvents: 50,
      thresholdMs: 5_000,
      classify: buildClassify(),
      retryInvocation,
    };
    const invocation = claudeInvocation({ cli: failingCli, cwd: root, interceptor });
    const managed = await manager.start(run.run_id, new ClaudeBackend(), invocation);
    const meta = await managed.completion;

    const events = await readEvents(store, run.run_id);
    const markerIndex = events.findIndex(
      (event) => event.type === 'lifecycle' && event.payload.subtype === 'session_not_found_in_run_retry',
    );
    assert.ok(markerIndex >= 0, 'lifecycle marker must be present');

    // BEFORE the marker we must NOT see any of the cancelled attempt's
    // assistant_message / tool / error / result lifecycle events. The only
    // pre-marker entries permitted are the cancelled attempt's
    // `lifecycle/status:'started'` — but D-COR-Resume-Layer specifies the
    // cancelled attempt's started event must also be discarded.
    const preMarker = events.slice(0, markerIndex);
    assert.equal(preMarker.length, 0, 'no cancelled-attempt events must precede the lifecycle marker');

    // AFTER the marker we expect the retry attempt's started event and its
    // own assistant_message + result-event lifecycle.
    const postMarker = events.slice(markerIndex + 1);
    assert.ok(postMarker.some((event) => event.type === 'lifecycle' && event.payload.status === 'started'), 'retry started event present');
    assert.ok(postMarker.some((event) => event.type === 'assistant_message'), 'retry assistant_message present');

    assert.equal(meta.status, 'completed');
    const result = await store.loadResult(run.run_id);
    assert.equal(result?.summary, 'final');
    assert.equal(store.terminalCounts.get(run.run_id), 1);
  });

  it('Reviewer fix #1 — interceptor engaged, worker closes cleanly within threshold: buffered events flushed to events.jsonl', async () => {
    // The fake-claude emits started/assistant/result and exits — well under
    // thresholdEvents=50 and thresholdMs=5000. The interceptor classifies
    // each event as 'continue' (none are session_not_found). Pre-fix the
    // buffered events were dropped on close. Post-fix they're flushed.
    const root = await mkdtemp(join(tmpdir(), 'cor-resume-flush-'));
    const cli = join(root, 'ok.js');
    await writeFakeClaude(cli, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-quick' }));
  console.log(JSON.stringify({ type: 'assistant', session_id: 'sid-quick', message: { content: [{ type: 'text', text: 'hello-quick' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'hello-quick', session_id: 'sid-quick' }));
  process.exit(0);
});`);

    const store = new MarkTerminalCounterStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    const manager = new ProcessManager(store);

    // Retry invocation that should NEVER fire (the resume worker exits 0).
    const retryInvocation = claudeInvocation({ cli, cwd: root });
    const interceptor: EarlyEventInterceptor = {
      thresholdEvents: 50,
      thresholdMs: 5_000,
      classify: buildClassify(),
      retryInvocation,
    };
    const invocation = claudeInvocation({ cli, cwd: root, interceptor });
    const managed = await manager.start(run.run_id, new ClaudeBackend(), invocation);
    const meta = await managed.completion;

    assert.equal(meta.status, 'completed');
    assert.equal(store.terminalCounts.get(run.run_id), 1);

    const events = await readEvents(store, run.run_id);
    // Buffered-then-flushed events must include the started lifecycle, an
    // assistant_message, and the result-event lifecycle. Lifecycle types from
    // ClaudeBackend.parseEvent: 'system' → lifecycle, 'result' → lifecycle
    // with state: 'result_event'. Plus the daemon-emitted started lifecycle
    // (which goes through the buffer too).
    assert.ok(
      events.some((event) => event.type === 'lifecycle' && event.payload.status === 'started'),
      'started lifecycle event must be flushed to events.jsonl',
    );
    assert.ok(
      events.some((event) => event.type === 'assistant_message'),
      'assistant_message must be flushed to events.jsonl',
    );
    assert.ok(
      events.some((event) => event.type === 'lifecycle' && event.payload.state === 'result_event'),
      'result_event lifecycle must be flushed to events.jsonl',
    );
    // No retry-related lifecycle marker should appear (no retry happened).
    assert.ok(
      !events.some((event) => event.type === 'lifecycle' && event.payload.subtype === 'session_not_found_in_run_retry'),
      'no retry lifecycle marker for a clean-close run',
    );
  });

  it('Reviewer fix #2b — onRetryFired hook invoked between lifecycle marker and retry spawn', async () => {
    // The orchestrator passes an `onRetryFired` callback that downgrades the
    // run's terminal_context BEFORE the retry attempt's `markTerminal` runs,
    // closing the race window. This test verifies the hook is invoked once,
    // strictly between the lifecycle marker append and the retry's
    // 'started' event append.
    const root = await mkdtemp(join(tmpdir(), 'cor-resume-hook-'));
    const failingCli = join(root, 'fail.js');
    const successCli = join(root, 'ok.js');
    await writeFakeClaude(failingCli, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'error', subtype: 'session_not_found', message: 'session not found' }));
  setInterval(() => {}, 1000);
});`);
    await writeFakeClaude(successCli, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-hook' }));
  console.log(JSON.stringify({ type: 'assistant', session_id: 'sid-hook', message: { content: [{ type: 'text', text: 'after-hook' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'after-hook', session_id: 'sid-hook' }));
  process.exit(0);
});`);

    const store = new MarkTerminalCounterStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    const manager = new ProcessManager(store);

    let onRetryFiredCount = 0;
    let observedAtHook: WorkerEvent[] = [];
    const retryInvocation = claudeInvocation({ cli: successCli, cwd: root });
    const interceptor: EarlyEventInterceptor = {
      thresholdEvents: 50,
      thresholdMs: 5_000,
      classify: buildClassify(),
      retryInvocation,
      onRetryFired: async () => {
        onRetryFiredCount += 1;
        observedAtHook = await readEvents(store, run.run_id);
      },
    };
    const invocation = claudeInvocation({ cli: failingCli, cwd: root, interceptor });
    const managed = await manager.start(run.run_id, new ClaudeBackend(), invocation);
    await managed.completion;

    assert.equal(onRetryFiredCount, 1, 'onRetryFired must be invoked exactly once');
    // At the moment the hook fires, the lifecycle marker must already be on
    // disk (so its update can race nothing) but the retry's started event
    // must NOT yet be there.
    assert.ok(
      observedAtHook.some((event) => event.type === 'lifecycle' && event.payload.subtype === 'session_not_found_in_run_retry'),
      'lifecycle marker must be present at hook-fire time',
    );
    assert.ok(
      !observedAtHook.some((event) => event.type === 'assistant_message'),
      'retry assistant_message must NOT be present at hook-fire time',
    );
  });

  it('Test 8 — retry path emits exactly one worker_posture event (issue #58 review follow-up Medium 3)', async () => {
    // Both the first attempt and the retry invocation carry their own
    // initialEvents (the realistic shape — `backend.start()` populates
    // it per invocation). The first attempt's event is buffered and
    // dropped along with the cancelled-attempt stream; the retry's
    // event must land so the run ends with exactly one posture event.
    const root = await mkdtemp(join(tmpdir(), 'cor-resume-posture-'));
    const failingCli = join(root, 'fail.js');
    const successCli = join(root, 'ok.js');
    await writeFakeClaude(failingCli, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'error', subtype: 'session_not_found', message: 'session not found' }));
  setInterval(() => {}, 1000);
});`);
    await writeFakeClaude(successCli, `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-posture' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 'sid-posture' }));
  process.exit(0);
});`);

    const store = new MarkTerminalCounterStore(root);
    const run = await store.createRun({ backend: 'claude', cwd: root });
    const manager = new ProcessManager(store);

    const retryInvocation: WorkerInvocation = {
      ...claudeInvocation({ cli: successCli, cwd: root }),
      initialEvents: [{
        type: 'lifecycle',
        payload: { state: 'worker_posture', backend: 'claude', worker_posture: 'trusted', attempt: 'retry' },
      }],
    };
    const interceptor: EarlyEventInterceptor = {
      thresholdEvents: 50,
      thresholdMs: 5_000,
      classify: buildClassify(),
      retryInvocation,
    };
    const invocation: WorkerInvocation = {
      ...claudeInvocation({ cli: failingCli, cwd: root, interceptor }),
      initialEvents: [{
        type: 'lifecycle',
        payload: { state: 'worker_posture', backend: 'claude', worker_posture: 'trusted', attempt: 'first' },
      }],
    };

    const managed = await manager.start(run.run_id, new ClaudeBackend(), invocation);
    await managed.completion;

    const events = await readEvents(store, run.run_id);
    const postureEvents = events.filter((event) => event.type === 'lifecycle' && (event.payload as { state?: string }).state === 'worker_posture');
    assert.equal(postureEvents.length, 1, 'retry path must end with exactly one worker_posture event');
    // The surviving event MUST be the retry's, not the cancelled first attempt's.
    assert.equal((postureEvents[0]!.payload as { attempt?: string }).attempt, 'retry', 'cancelled first-attempt posture event was dropped; only the retry event survives');
  });
});
