# Plan Review Round 5: Daemon Auth Setup

Reviewed: 2026-05-04
Reviewer: Codex
Scope: current `plans/27-add-first-class-daemon-auth-setup-for-cursor-api-keys/plans/27-daemon-auth-setup.md`

## Findings

No blocking findings.

## Notes

D15 now provides a concrete hermetic seam for daemon-load verification: `bootDaemon(...)` can receive a fake `CursorSdkAdapter`, and T6/D11 assert the captured `apiKey` value rather than relying on the absence of a runtime auth failure. D13 also now correctly limits only breaking MCP contract changes while allowing the additive D5 fields.

During implementation, make `bootDaemon(...)` return enough state for tests to clean up the in-process IPC server/service without using the production `shutdown` path, since the current service shutdown schedules `process.exit(0)`.
