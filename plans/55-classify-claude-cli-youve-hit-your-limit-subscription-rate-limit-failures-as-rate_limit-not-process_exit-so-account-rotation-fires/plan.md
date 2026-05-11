# Plan Index

Branch: `55-classify-claude-cli-youve-hit-your-limit-subscription-rate-limit-failures-as-rate_limit-not-process_exit-so-account-rotation-fires`
Updated: 2026-05-11

## Sub-Plans

| Plan | Scope | Status | File |
|---|---|---|---|
| Classify Claude subscription-cap banners as `rate_limit` | Detect the Claude CLI "You've hit your limit · resets HH:MM (TZ)" banner inside the streamed JSON `result` event (and **only** that envelope; plain non-JSON stdout banners are explicitly out of scope for v1). Promote the terminal `latest_error.category` from `process_exit` to `rate_limit` (with `source: 'backend_event'`, `context.subkind: 'claude_cli_banner'`). The fatal classification routes through `recordObservedError`'s existing `cancel('failed', { reason: 'backend_fatal_error', ... })` path, so the run's `terminal_reason` becomes `backend_fatal_error` — matching how every structured rate-limit failure already terminates today (see `src/__tests__/processManager.test.ts:428–554`). | planning | [plans/55-classify-claude-cli-rate-limit-banner.md](plans/55-classify-claude-cli-rate-limit-banner.md) |
