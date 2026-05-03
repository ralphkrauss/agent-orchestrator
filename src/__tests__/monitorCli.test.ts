import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMonitorCliArgs,
  MONITOR_EXIT_ARGUMENT_ERROR,
  MONITOR_EXIT_FATAL_ERROR,
  MONITOR_EXIT_TERMINAL_CANCELLED,
  MONITOR_EXIT_TERMINAL_COMPLETED,
  MONITOR_EXIT_TERMINAL_FAILED,
  MONITOR_EXIT_TERMINAL_TIMED_OUT,
} from '../monitorCli.js';

describe('monitor CLI', () => {
  it('parses run id, --json-line, and --since flags', () => {
    const parsed = parseMonitorCliArgs(['run-1', '--json-line', '--since', '00000-x']);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.runId, 'run-1');
      assert.equal(parsed.value.jsonLine, true);
      assert.equal(parsed.value.sinceNotificationId, '00000-x');
    }
  });

  it('rejects missing run id and unknown options', () => {
    const missing = parseMonitorCliArgs(['--json-line']);
    assert.equal(missing.ok, false);
    const unknown = parseMonitorCliArgs(['run-1', '--unknown']);
    assert.equal(unknown.ok, false);
  });

  it('exposes the documented monitor exit codes', () => {
    assert.equal(MONITOR_EXIT_TERMINAL_COMPLETED, 0);
    assert.equal(MONITOR_EXIT_TERMINAL_FAILED, 1);
    assert.equal(MONITOR_EXIT_TERMINAL_CANCELLED, 2);
    assert.equal(MONITOR_EXIT_TERMINAL_TIMED_OUT, 3);
    assert.equal(MONITOR_EXIT_ARGUMENT_ERROR, 6);
    assert.equal(MONITOR_EXIT_FATAL_ERROR, 10);
  });
});
