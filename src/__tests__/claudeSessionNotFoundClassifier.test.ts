import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBackendError, errorFromEvent } from '../backend/common.js';
import { RunErrorCategorySchema } from '../contract.js';

describe('T-COR-Classifier — session_not_found classifier', () => {
  it('classifies a stream-json error event with subtype=session_not_found', () => {
    const error = errorFromEvent(
      { type: 'error', subtype: 'session_not_found', message: 'session not found' },
      'claude',
    );
    assert.ok(error);
    assert.equal(error.category, 'session_not_found');
    assert.equal(error.context?.subtype, 'session_not_found');
    assert.equal(error.retryable, false);
  });

  it('classifies a stream-json error event with code=session_not_found', () => {
    const error = errorFromEvent(
      { type: 'error', code: 'session_not_found', message: 'no such session' },
      'claude',
    );
    assert.ok(error);
    assert.equal(error.category, 'session_not_found');
    assert.equal(error.context?.code, 'session_not_found');
  });

  it('classifies stderr line "session not found" via the fallback regex', () => {
    const error = classifyBackendError({
      backend: 'claude',
      source: 'stderr',
      message: 'Error: session not found',
    });
    assert.equal(error.category, 'session_not_found');
  });

  it('classifies stderr line "no such session" via the fallback regex', () => {
    const error = classifyBackendError({
      backend: 'claude',
      source: 'stderr',
      message: 'fatal: no such session abc123',
    });
    assert.equal(error.category, 'session_not_found');
  });

  it('does NOT classify backend_event message containing the phrase "session not found"', () => {
    // Backend events carry user-supplied prompt content; the structured
    // subtype/code branch is the only path that should fire on them.
    const error = classifyBackendError({
      backend: 'claude',
      source: 'backend_event',
      message: 'the user wrote: "session not found" in their prompt',
    });
    assert.notEqual(error.category, 'session_not_found');
  });

  it('preserves the existing rate_limit category while capturing subtype', () => {
    const error = errorFromEvent(
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          subtype: 'rate_limit_exceeded',
          message: 'rate limit exceeded',
        },
      },
      'claude',
    );
    assert.ok(error);
    assert.equal(error.category, 'rate_limit');
    // Regression: today's classifier dropped subtype; T-COR-Classifier preserves it.
    assert.equal(error.context?.subtype, 'rate_limit_exceeded');
  });

  it('parses session_not_found as a valid RunErrorCategory schema value', () => {
    assert.equal(RunErrorCategorySchema.parse('session_not_found'), 'session_not_found');
  });
});
