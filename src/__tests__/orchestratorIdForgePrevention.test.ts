import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stampOrchestratorIdInMetadata } from '../orchestratorService.js';

// Issue #40, Decision 10 / R8 — forge-prevention invariant:
// the model never authors metadata.orchestrator_id. The daemon strips any
// caller-supplied orchestrator_id (including parent-inherited ones in
// send_followup) and re-adds it only from RpcPolicyContext.orchestrator_id.

describe('metadata.orchestrator_id forge prevention (issue #40, D10 / R8)', () => {
  it('strips a model-supplied orchestrator_id when there is no pinned policy', () => {
    const result = stampOrchestratorIdInMetadata(
      { orchestrator_id: 'forged-by-model', other: 'preserved' },
      undefined,
    );
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'orchestrator_id'), false);
    assert.equal(result.other, 'preserved');
  });

  it('strips a model-supplied orchestrator_id when policy_context is set but has no orchestrator_id', () => {
    const result = stampOrchestratorIdInMetadata(
      { orchestrator_id: 'forged-by-model' },
      { writable_profiles_file: '/tmp/profiles.json' },
    );
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'orchestrator_id'), false);
  });

  it('replaces a model-supplied orchestrator_id with the pinned policy id', () => {
    const result = stampOrchestratorIdInMetadata(
      { orchestrator_id: 'forged-by-model', notes: 'kept' },
      { orchestrator_id: '01PINNEDORCHESTRATORID00000' },
    );
    assert.equal(result.orchestrator_id, '01PINNEDORCHESTRATORID00000');
    assert.equal(result.notes, 'kept');
  });

  it('strips a parent-inherited orchestrator_id when the follow-up has no pinned policy', () => {
    // Simulates the send_followup flow: parent metadata is merged in by
    // metadataForFollowup() before being passed to stampOrchestratorIdInMetadata.
    // The stamping function must drop the inherited orchestrator_id.
    const inheritedFromParent = { orchestrator_id: '01PARENTORCH0000000000000ZZ', notes: 'kept' };
    const result = stampOrchestratorIdInMetadata(inheritedFromParent, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'orchestrator_id'), false);
    assert.equal(result.notes, 'kept');
  });

  it('replaces a parent-inherited orchestrator_id with a different pinned policy id', () => {
    const inheritedFromParent = { orchestrator_id: '01PARENTORCH0000000000000ZZ' };
    const result = stampOrchestratorIdInMetadata(
      inheritedFromParent,
      { orchestrator_id: '01OTHERORCH00000000000000ZZ' },
    );
    assert.equal(result.orchestrator_id, '01OTHERORCH00000000000000ZZ');
  });

  it('preserves all other metadata fields verbatim regardless of pin status', () => {
    const meta = { foo: 1, bar: { nested: true }, list: [1, 2, 3] };
    const stripped = stampOrchestratorIdInMetadata(meta, undefined);
    assert.deepStrictEqual(stripped, meta);

    const stamped = stampOrchestratorIdInMetadata(meta, { orchestrator_id: '01XX' });
    assert.equal(stamped.orchestrator_id, '01XX');
    assert.deepStrictEqual({ foo: stamped.foo, bar: stamped.bar, list: stamped.list }, meta);
  });
});
