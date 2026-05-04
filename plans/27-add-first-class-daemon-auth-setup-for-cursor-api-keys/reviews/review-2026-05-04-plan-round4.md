# Plan Review Round 4: Daemon Auth Setup

Reviewed: 2026-05-04
Reviewer: Codex
Scope: current `plans/27-add-first-class-daemon-auth-setup-for-cursor-api-keys/plans/27-daemon-auth-setup.md`

## Findings

### F1: Round-three daemon-load test blocker is still present

Severity: Medium

The plan still says the daemon-load test can prove file loading by running a cursor invocation and asserting the runtime does not return `SPAWN_FAILED` / `category: 'auth'`. That remains a false-positive risk: if the spawned daemon uses the real default Cursor adapter and `@cursor/sdk` is missing or broken, the runtime returns `WORKER_BINARY_MISSING` before checking `CURSOR_API_KEY`, so the assertion can pass without proving `daemonMain.ts` loaded the secrets file.

The plan also still says the precedence variant can use a fake `CursorSdkAdapter` to capture `apiKey`, but the current spawned daemon path constructs `createBackendRegistry(store)` directly and has no injection seam for that fake adapter.

Revise D11/T6 to require a concrete hermetic seam, such as a testable daemon startup function that accepts a fake cursor runtime/adapter in-process while still exercising startup secret loading. The assertion should be on captured `apiKey`: file-only equals the file value; env+file equals the spawn-env sentinel.

### F2: D13 still contradicts D5

Severity: Low

The out-of-scope section is fixed, but the D13 decision row still says "This plan does not: change the MCP tool contract." D5/T7 intentionally add optional `source_kind` / `source_path` fields.

Revise D13 to say no breaking MCP contract changes; the additive D5 fields are in scope.

## Notes

The summary in the latest request describes earlier fixes, but the current plan file still contains these two issues.
