import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OrchestratorRegistry } from '../daemon/orchestratorRegistry.js';

describe('OrchestratorRegistry', () => {
  it('registers an orchestrator with a generated id when none is supplied', () => {
    const registry = new OrchestratorRegistry();
    const record = registry.register({
      client: 'claude',
      label: 'test',
      cwd: '/tmp/repo',
    });
    assert.match(record.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(record.label, 'test');
    assert.equal(record.cwd, '/tmp/repo');
    assert.ok(registry.has(record.id));
  });

  it('honors a launcher-supplied orchestrator id', () => {
    const registry = new OrchestratorRegistry();
    const record = registry.register({
      client: 'claude',
      label: 'test',
      cwd: '/tmp/repo',
      orchestrator_id: '01TESTORCHESTRATORID0001ZZ',
    });
    assert.equal(record.id, '01TESTORCHESTRATORID0001ZZ');
  });

  it('applies turn_started / turn_stopped / waiting_for_user / session_active / session_ended', () => {
    const registry = new OrchestratorRegistry();
    const record = registry.register({ client: 'claude', label: 'l', cwd: '/c' });
    const id = record.id;

    let state = registry.applyEvent(id, 'turn_started');
    assert.ok(state);
    assert.equal(state?.supervisor_turn_active, true);
    assert.equal(state?.waiting_for_user, false);

    state = registry.applyEvent(id, 'waiting_for_user');
    assert.equal(state?.waiting_for_user, true);

    state = registry.applyEvent(id, 'turn_stopped');
    assert.equal(state?.supervisor_turn_active, false);
    assert.equal(state?.waiting_for_user, false, 'turn_stopped clears the sticky waiting flag');

    state = registry.applyEvent(id, 'session_ended');
    assert.equal(state?.session_ended, true);
    assert.equal(state?.supervisor_turn_active, false);

    state = registry.applyEvent(id, 'session_active');
    assert.equal(state?.session_ended, false);
  });

  it('returns null when applying events to an unknown id (forge prevention)', () => {
    const registry = new OrchestratorRegistry();
    assert.equal(registry.applyEvent('01XXXXXXXXXXXXXXXXXXXXXXXX', 'turn_started'), null);
  });

  it('unregister removes the orchestrator', () => {
    const registry = new OrchestratorRegistry();
    const record = registry.register({ client: 'claude', label: 'l', cwd: '/c' });
    assert.equal(registry.unregister(record.id), true);
    assert.equal(registry.has(record.id), false);
    assert.equal(registry.unregister(record.id), false, 'second unregister is a no-op');
  });

  it('updates last_supervisor_event_at on each applied event', () => {
    const registry = new OrchestratorRegistry();
    const record = registry.register({ client: 'claude', label: 'l', cwd: '/c' });
    const before = registry.get(record.id)?.record.last_supervisor_event_at;
    assert.equal(before, null);
    const after = registry.applyEvent(record.id, 'turn_started');
    assert.ok(after?.record.last_supervisor_event_at);
  });
});
