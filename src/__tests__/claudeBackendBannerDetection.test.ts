import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeBackend } from '../backend/claude.js';

describe('ClaudeBackend.parseEvent — subscription-cap banner detection (issue #55)', () => {
  const backend = new ClaudeBackend();

  it('synthesises a rate_limit error for is_error=true result events carrying the banner', () => {
    const parsed = backend.parseEvent({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: "You've hit your limit · resets 12:20pm (UTC)",
      session_id: 'session-banner-1',
    });

    assert.equal(parsed.errors.length, 1);
    const error = parsed.errors[0]!;
    assert.equal(error.category, 'rate_limit');
    assert.equal(error.source, 'backend_event');
    assert.equal(error.backend, 'claude');
    assert.equal(error.retryable, true);
    assert.equal(error.fatal, true);
    assert.equal(error.context?.subkind, 'claude_cli_banner');
    assert.equal(error.context?.banner, "You've hit your limit · resets 12:20pm (UTC)");
    assert.equal(parsed.resultEvent?.summary, "You've hit your limit · resets 12:20pm (UTC)");
  });

  it('synthesises a rate_limit error when only snake_case stop_reason signals failure', () => {
    const parsed = backend.parseEvent({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'rate_limit_error',
      result: "You've reached your limit",
      session_id: 'session-banner-2',
    });

    assert.equal(parsed.errors.length, 1);
    assert.equal(parsed.errors[0]!.category, 'rate_limit');
    assert.equal(parsed.errors[0]!.context?.subkind, 'claude_cli_banner');
  });

  it('synthesises a rate_limit error when only camelCase stopReason signals failure', () => {
    const parsed = backend.parseEvent({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stopReason: 'rate_limit_error',
      result: "You've hit your usage limit",
      session_id: 'session-banner-3',
    });

    assert.equal(parsed.errors.length, 1);
    assert.equal(parsed.errors[0]!.category, 'rate_limit');
  });

  it('matches the alternate resets clause shape "resets HH:MM (TZ)"', () => {
    const parsed = backend.parseEvent({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: "You've hit your limit · resets 14:00 (PT)",
      session_id: 'session-banner-4',
    });

    assert.equal(parsed.errors.length, 1);
    assert.equal(parsed.errors[0]!.category, 'rate_limit');
  });

  it('does NOT synthesise an error for "You\'ve hit your limit of 5 retries" (F1 regression)', () => {
    const parsedSnake = backend.parseEvent({
      type: 'result',
      subtype: 'error',
      is_error: true,
      stop_reason: 'rate_limit_error',
      result: "You've hit your limit of 5 retries",
      session_id: 'session-banner-5a',
    });
    assert.equal(parsedSnake.errors.length, 0, 'tail-anchor must reject continuations like " of N retries"');
    assert.equal(parsedSnake.resultEvent?.summary, "You've hit your limit of 5 retries");

    const parsedCamel = backend.parseEvent({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stopReason: 'rate_limit_error',
      result: "You've hit your limit of 5 retries",
      session_id: 'session-banner-5b',
    });
    assert.equal(parsedCamel.errors.length, 0, 'F1 fix must hold across every gate-firing path');
    assert.equal(parsedCamel.resultEvent?.summary, "You've hit your limit of 5 retries");
  });

  it('does NOT synthesise an error on a successful result event with banner-shaped text', () => {
    const parsed = backend.parseEvent({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      result: "You've hit your limit · resets 12:20pm (UTC)",
      session_id: 'session-banner-6',
    });

    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.resultEvent?.summary, "You've hit your limit · resets 12:20pm (UTC)");
  });

  it('does NOT synthesise an error when an error-shaped result event lacks banner phrasing', () => {
    const parsed = backend.parseEvent({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'something else broke',
      session_id: 'session-banner-7',
    });

    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.resultEvent?.summary, 'something else broke');
  });

  it('does NOT mis-tag generic rate-limit phrasing as the claude_cli_banner path', () => {
    // The shared classifier's rate-limit branch also matches `too many
    // requests`, `429`, and `rate_limit_error`. If parseEvent gated on
    // `classifyBackendError(...).category === 'rate_limit'`, these would be
    // mis-tagged with `subkind: 'claude_cli_banner'` even though the actual
    // tail-anchored banner regex never matched. The gate is the banner regex
    // itself via `matchesClaudeCliBanner`, so these MUST produce no
    // banner-tagged synthesis.
    const generics = [
      'too many requests',
      'simulated rate limit',
      '429 rate limit exceeded',
      'rate_limit_error',
    ];
    for (const text of generics) {
      const parsed = backend.parseEvent({
        type: 'result',
        subtype: 'error',
        is_error: true,
        stop_reason: 'rate_limit_error',
        result: text,
        session_id: `session-banner-generic-${text.length}`,
      });

      // Stronger contract: regex refusal must leave `parsed.errors`
      // unchanged. parseEvent does not generate any other errors from a
      // `result` event today, so the expected size is exactly zero.
      assert.equal(
        parsed.errors.length,
        0,
        `generic rate-limit phrasing ${JSON.stringify(text)} must produce no synthesised errors`,
      );
      const bannerErrors = parsed.errors.filter(
        (error) => (error.context as { subkind?: string } | undefined)?.subkind === 'claude_cli_banner',
      );
      assert.equal(
        bannerErrors.length,
        0,
        `generic rate-limit phrasing ${JSON.stringify(text)} must not be tagged as claude_cli_banner`,
      );
    }
  });
});
