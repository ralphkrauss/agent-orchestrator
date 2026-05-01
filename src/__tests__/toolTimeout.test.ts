import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultIpcTimeoutMs, ipcTimeoutForTool, waitForRunIpcTimeoutMarginMs } from '../toolTimeout.js';

describe('tool IPC timeout selection', () => {
  it('extends wait_for_run IPC timeout to cover the requested wait plus margin', () => {
    assert.equal(
      ipcTimeoutForTool('wait_for_run', { run_id: 'run', wait_seconds: 180 }),
      180_000 + waitForRunIpcTimeoutMarginMs,
    );
    assert.equal(
      ipcTimeoutForTool('wait_for_run', { run_id: 'run', wait_seconds: 300 }),
      300_000 + waitForRunIpcTimeoutMarginMs,
    );
  });

  it('keeps the default timeout for other tools and invalid wait input', () => {
    assert.equal(ipcTimeoutForTool('get_run_status', { run_id: 'run' }), defaultIpcTimeoutMs);
    assert.equal(ipcTimeoutForTool('wait_for_run', { run_id: 'run', wait_seconds: 0 }), defaultIpcTimeoutMs);
    assert.equal(ipcTimeoutForTool('wait_for_run', { run_id: 'run', wait_seconds: 301 }), defaultIpcTimeoutMs);
  });
});
