# Plan Review Round 3: Daemon Auth Setup

Reviewed: 2026-05-04
Reviewer: Codex
Scope: revised `plans/27-add-first-class-daemon-auth-setup-for-cursor-api-keys/plans/27-daemon-auth-setup.md`

## Findings

### F1: Daemon-load runtime test can pass without proving daemon auth was loaded

Severity: Medium

D11/T6 now correctly avoids using `doctor --json`, but the proposed runtime-path assertion is still under-specified. It says to start a cursor invocation and assert the runtime did not return `SPAWN_FAILED` / `category: 'auth'`. If the spawned daemon uses the real default Cursor adapter and `@cursor/sdk` is missing or broken, the runtime returns `WORKER_BINARY_MISSING` before it checks `CURSOR_API_KEY`. That would satisfy "not auth failure" even if `daemonMain.ts` never loaded the secrets file.

The precedence variant also mentions a fake `CursorSdkAdapter` capturing `apiKey`, but the current daemon process constructs `createBackendRegistry(store)` directly and has no injection path for a fake adapter. Existing Cursor tests inject fakes by constructing `CursorSdkRuntime` in-process, not by spawning `daemonMain.ts`.

Revise T6/D11 to require a hermetic daemon-process test seam. For example:

- extract a testable `createDaemonService(store, log, options?)`/`main(options?)` path that can receive a fake cursor runtime/adapter in-process while still exercising the daemon startup secret load, or
- add an explicit test-only SDK importer/adapter hook that the spawned daemon can use without network/real SDK dependency.

The acceptance criterion should assert the captured `apiKey` equals the file value for file-only and the spawn-env sentinel for env+file, not merely "not the auth failure".

### F2: D13 decision row still says no MCP contract change

Severity: Low

The out-of-scope section is now fixed, but the D13 decision row still says "This plan does not: change the MCP tool contract." That contradicts D5, scope, T7, and the quality gates, which all intentionally add optional `source_kind` / `source_path` fields.

Revise D13 to match the out-of-scope section: no breaking MCP contract changes; the additive D5 fields are in scope.

## Notes

The prior round-two findings are otherwise addressed. The product plan is ready once the daemon-load test seam is made explicit enough to avoid a false positive.
