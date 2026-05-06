import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OrchestratorHooksFileSchema } from '../contract.js';

describe('OrchestratorHooksFileSchema (v1, closed)', () => {
  it('accepts the documented Claude-parity shape', () => {
    const parsed = OrchestratorHooksFileSchema.parse({
      version: 1,
      hooks: {
        orchestrator_status_changed: [
          { type: 'command', command: 'echo hi', env: { FOO: 'bar' }, timeout_ms: 1500 },
        ],
      },
    });
    assert.equal(parsed.version, 1);
    assert.equal(parsed.hooks.orchestrator_status_changed?.[0]?.command, 'echo hi');
  });

  it('accepts arbitrary shell-metacharacter command strings (Claude parity)', () => {
    // Per H4: the daemon trusts user-authored shell strings the same way
    // Claude trusts ~/.claude/settings.json hooks. Metacharacters are not a
    // schema-level rejection.
    const parsed = OrchestratorHooksFileSchema.parse({
      version: 1,
      hooks: {
        orchestrator_status_changed: [
          { type: 'command', command: 'echo "$AGENT_ORCHESTRATOR_EVENT" >> /tmp/log; date | tee -a /tmp/log' },
        ],
      },
    });
    assert.equal(parsed.hooks.orchestrator_status_changed?.[0]?.type, 'command');
  });

  it('(a) rejects per-entry args field (closed-schema)', () => {
    const result = OrchestratorHooksFileSchema.safeParse({
      version: 1,
      hooks: {
        orchestrator_status_changed: [
          { type: 'command', command: 'tmux', args: ['rename-pane'] } as unknown,
        ],
      },
    });
    assert.equal(result.success, false);
  });

  it('(b) rejects per-entry filter field (closed-schema)', () => {
    const result = OrchestratorHooksFileSchema.safeParse({
      version: 1,
      hooks: {
        orchestrator_status_changed: [
          { type: 'command', command: 'echo hi', filter: { states: ['in_progress'] } } as unknown,
        ],
      },
    });
    assert.equal(result.success, false);
  });

  it('(c) rejects per-entry generic unknown key', () => {
    const result = OrchestratorHooksFileSchema.safeParse({
      version: 1,
      hooks: {
        orchestrator_status_changed: [
          { type: 'command', command: 'echo hi', env: {}, timeout_ms: 1500, extra: true } as unknown,
        ],
      },
    });
    assert.equal(result.success, false);
  });

  it('(d) rejects top-level unknown key and unknown key inside hooks object', () => {
    const r1 = OrchestratorHooksFileSchema.safeParse({
      version: 1,
      hooks: { orchestrator_status_changed: [] },
      extra_root: true,
    } as unknown);
    assert.equal(r1.success, false);

    const r2 = OrchestratorHooksFileSchema.safeParse({
      version: 1,
      hooks: {
        orchestrator_status_changed: [],
        other_event: [],
      },
    } as unknown);
    assert.equal(r2.success, false);
  });

  it('rejects timeout_ms above the cap (5000ms)', () => {
    const result = OrchestratorHooksFileSchema.safeParse({
      version: 1,
      hooks: {
        orchestrator_status_changed: [
          { type: 'command', command: 'echo hi', timeout_ms: 6_000 },
        ],
      },
    });
    assert.equal(result.success, false);
  });

  it('rejects type other than "command"', () => {
    const result = OrchestratorHooksFileSchema.safeParse({
      version: 1,
      hooks: {
        orchestrator_status_changed: [{ type: 'argv', command: 'echo hi' } as unknown],
      },
    });
    assert.equal(result.success, false);
  });
});
