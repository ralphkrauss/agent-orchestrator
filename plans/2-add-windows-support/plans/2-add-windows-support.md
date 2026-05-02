# Add Windows Support

Branch: `2-add-windows-support`
Plan Slug: `add-windows-support`
Parent Issue: #2
Created: 2026-05-02
Status: implemented-verification-blocked

## Context

Issue #2 is open with the title "Add windows support" and no issue body or
comments. The current branch name matches the issue scope.

Context sources read:

- `AGENTS.md`: use `pnpm` scripts, keep public behavior stable, add focused
  tests for daemon lifecycle, run-store persistence, backend invocation, MCP
  contracts, and release behavior when those areas change.
- `.agents/rules/node-typescript.md`: keep Node.js 22 compatibility, use
  existing scripts, prefer Node built-ins, update schemas/docs/tests for MCP
  contract changes.
- `.agents/rules/ai-workspace-projections.md`: relevant only if `.agents/`
  files change; no projection edits are planned.
- `.agents/rules/mcp-tool-configs.md`: relevant only if MCP config files or
  secret-bearing scripts change; no config or secret behavior changes are
  planned.
- `package.json`: affected commands are `pnpm build`, `pnpm test`, and likely
  `pnpm verify` before release-quality completion.
- `README.md`: currently documents POSIX-only support, Unix sockets, POSIX
  process groups, `daemon.sock`, and POSIX cleanup commands.
- `docs/development/mcp-tooling.md`: documents local dogfood daemon usage and
  MCP guardrails.
- `src/daemon/paths.ts`: daemon paths currently include `daemon.sock`,
  `daemon.pid`, and `daemon.log` under `AGENT_ORCHESTRATOR_HOME`.
- `src/daemon/daemonMain.ts`: exits immediately on `win32`, cleans stale Unix
  socket files with ownership checks, binds the socket under restrictive umask,
  and cleans pid/socket files on exit.
- `src/daemon/daemonCli.ts` and `src/server.ts`: auto-start and manual daemon
  lifecycle both connect through `paths.socket`.
- `src/ipc/client.ts`, `src/ipc/server.ts`, and `src/ipc/protocol.ts`: IPC is
  framed JSON-RPC over `node:net`, but endpoint handling is a raw path string.
- `src/processManager.ts`: worker spawning uses `detached: true`; cancellation
  sends signals to negative POSIX process-group IDs.
- `src/diagnostics.ts` and `src/contract.ts`: diagnostics expose
  `posix_supported` and currently mark every backend unsupported on Windows.
- `src/runStore.ts`: store root and pid/lock files use Node path APIs and
  mostly need best-effort Windows permission behavior, not a redesign.
- `src/backend/codex.ts`, `src/backend/claude.ts`, `src/backend/common.ts`:
  backend invocation already avoids shells and uses `path.delimiter`; no major
  Windows-specific invocation changes are expected.
- Tests read: `src/__tests__/ipc.test.ts`, `src/__tests__/diagnostics.test.ts`,
  `src/__tests__/processManager.test.ts`,
  `src/__tests__/integration/orchestrator.test.ts`,
  `src/__tests__/backendInvocation.test.ts`.

No existing `plans/` directory was present before this plan.

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Windows target | Add native Windows support for the daemon and stdio MCP server. | Issue #2 asks for Windows support, and the repo already has a Windows-aware `scripts/run-npx-mcp.mjs`, so treating WSL as the answer would leave the package behavior unchanged. | Document WSL-only support; keep daemon POSIX-only. |
| 2 | IPC transport | Keep the framed JSON-RPC protocol and `node:net`, but introduce an endpoint abstraction that returns a Unix socket path on POSIX and a Windows named pipe path on `win32`. | This preserves the existing protocol and isolates platform differences to endpoint/path handling. Node supports named pipes through the same `net.Server.listen()` and `net.connect()` APIs. | Replace IPC with TCP localhost; add an HTTP server; special-case Windows throughout callers. |
| 3 | Named pipe identity | Derive a stable per-store named pipe from `AGENT_ORCHESTRATOR_HOME`/store root, for example by hashing the resolved store root into a `\\\\.\\pipe\\agent-orchestrator-<hash>` name. | The current Unix socket is scoped to the store root. A hashed pipe keeps parallel stores isolated without exposing long or invalid Windows path text in the pipe name. | Use one global pipe for all stores; place the pipe under the home directory; require a user-configured pipe path. |
| 4 | Stale endpoint cleanup | Keep Unix socket ownership cleanup on POSIX; make Windows endpoint cleanup a no-op and rely on named pipes disappearing when the server closes. | Windows named pipes are not filesystem entries, so `lstat`, `rm`, and ownership checks do not apply. A live pipe conflict should surface as daemon already running or bind failure. | Try to delete named pipe paths as files; remove stale socket ownership checks for POSIX. |
| 5 | Process tree cancellation | Add a platform-specific process terminator: POSIX continues killing `-pid`; Windows uses `taskkill /PID <pid> /T` and escalates with `/F` when needed. | The current negative PGID strategy is invalid on Windows. `taskkill` is the built-in way to terminate a process tree without adding dependencies. | Kill only the direct child; use a shell; add a dependency for job objects. |
| 6 | Diagnostics compatibility | Keep `posix_supported` for backward compatibility, but stop using it as the backend availability gate. Add only additive diagnostics if needed, such as transport or platform support details. | Removing or repurposing an existing MCP field would be a public contract break. Windows support should make backends diagnosable instead of immediately unsupported. | Rename `posix_supported`; remove it; leave Windows backends unsupported. |
| 7 | Store permissions | Preserve current `0700`/`0600` calls as best effort and document that Windows ACL enforcement is platform-native rather than POSIX mode exact. | Node accepts mode parameters on Windows but POSIX permission semantics do not fully apply. The store should remain usable and avoid claiming Unix-mode guarantees on Windows. | Build custom Windows ACL management; remove permission hardening everywhere. |
| 8 | Test strategy | Add deterministic platform-unit coverage by injecting or isolating platform decisions where practical, plus keep POSIX integration tests unchanged. | CI may not have Windows runners yet, so tests should validate path/diagnostic/process-command decisions on Linux while allowing future Windows CI to run the same suite. | Require a Windows machine for every test; rely only on manual testing. |

## Scope

### In Scope

- Remove the hard Windows daemon startup block.
- Add cross-platform daemon IPC endpoint generation and use it from daemon,
  daemon CLI, MCP server, IPC client, and IPC tests.
- Support Windows named pipes while preserving Unix socket behavior and stale
  Unix socket cleanup.
- Add platform-specific worker process-tree cancellation and timeout handling.
- Update diagnostics so Windows is supported at the daemon/platform layer and
  backend checks run normally when `codex` or `claude` are present.
- Update README and development docs from POSIX-only language to
  cross-platform behavior with Windows caveats.
- Add focused tests for endpoint selection, diagnostics, IPC behavior, and
  process cancellation command selection.

### Out Of Scope

- Installing Codex, Claude, Node, Git, or other host prerequisites.
- Adding new runtime dependencies.
- Changing MCP tool request or response envelopes beyond compatible additive
  diagnostics.
- Adding TCP or remote daemon access.
- Implementing Windows service registration or background startup at login.
- Changing MCP config secret handling.
- Publishing, tagging, or changing package release automation.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | Named pipe path collides across store roots or users. | Hash the normalized store root into the pipe name and include a stable package prefix. | Endpoint unit tests. |
| 2 | Existing Unix socket cleanup logic runs on Windows and fails. | Gate cleanup by endpoint transport; no filesystem cleanup for named pipes. | Daemon endpoint tests and IPC tests. |
| 3 | Windows cancellation kills only the worker CLI and leaves grandchildren running. | Use `taskkill /T` for the tree and `/F` on escalation. | Process terminator tests; manual Windows lifecycle smoke. |
| 4 | POSIX cancellation regresses while adding Windows support. | Keep the existing negative-PGID path and current integration test for grandchild cleanup. | Existing integration test plus process-manager tests. |
| 5 | Diagnostics still report every backend as unsupported on Windows. | Decouple backend support checks from `posix_supported`; add tests for simulated `win32` decisions. | Diagnostics tests. |
| 6 | Documentation overstates Windows permission guarantees. | Document store files as user-local and mode hardening as POSIX-specific where needed. | Docs review. |
| 7 | Tests bake in `/tmp` paths or POSIX commands and fail on Windows CI. | Replace hard-coded `/tmp` and `mkdir -p`/`sleep` in touched tests with Node helpers or platform skips where process-group behavior is POSIX-only. | Test updates and future Windows CI. |
| 8 | Backward compatibility breaks existing clients reading `posix_supported`. | Keep the field and avoid changing its type or removing it. | Contract tests. |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T1 | Add daemon IPC endpoint abstraction | none | implemented | A module exposes endpoint transport/name/path data; POSIX endpoint remains `<store>/daemon.sock`; Windows endpoint is a stable named pipe derived from the store root; unit tests cover both platform branches without requiring Windows. |
| T2 | Wire endpoint abstraction through daemon, CLI, server, and IPC tests | T1 | implemented | `daemonPaths()` or equivalent callers use the new endpoint; `IpcClient` and `IpcServer` still receive a `net` endpoint string; Unix stale socket cleanup only runs for socket-file endpoints; existing IPC tests pass on POSIX. |
| T3 | Enable Windows daemon startup and lifecycle | T2 | implemented | `daemonMain` no longer exits on `win32`; pid/log/store setup still works; manual daemon CLI start/status/stop paths use the named pipe on Windows and the socket on POSIX; tests cover Windows cleanup no-op behavior where possible. |
| T4 | Add platform-specific process-tree termination | none | implemented | `ProcessManager.cancel()` uses existing negative PGID behavior on POSIX and a Windows terminator using `taskkill /PID <pid> /T` plus forced escalation; timeout and cancellation final statuses remain unchanged; tests validate both command paths without killing real Windows processes on POSIX. |
| T5 | Update diagnostics and contract tests | T1, T3 | implemented | `getBackendStatus()` no longer marks all Windows backends unsupported solely because `process.platform === 'win32'`; `posix_supported` remains present; any additive diagnostics fields are added to `contract.ts`, tests, README, and formatting output. |
| T6 | Harden tests for cross-platform execution | T1, T2, T4, T5 | implemented | Touched tests avoid hard-coded `/tmp` daemon paths and POSIX shell commands where a Node alternative exists; POSIX-specific grandchild-kill assertions are retained or explicitly skipped only on Windows; `pnpm test` passes on the local platform. |
| T7 | Update user and development docs | T1, T3, T4, T5 | implemented | README prerequisites, architecture, run-store layout, security behavior, diagnostics, daemon lifecycle, and cleanup guidance describe Unix sockets on POSIX and named pipes on Windows; development MCP docs remain accurate. |
| T8 | Run focused and release-quality verification | T2, T3, T4, T5, T6, T7 | blocked | `pnpm build` passes; `pnpm test` passes; `pnpm verify` is run before claiming release readiness, or any failure is recorded with concrete output and follow-up. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | Cross-platform daemon changes must isolate platform decisions behind small helpers and cover both branches with tests. | Future daemon/process lifecycle work. | After implementation, only if the pattern proves reusable across multiple files. |

## Quality Gates

- [ ] Affected build command passes: `pnpm build` blocked because `node_modules` is absent and `tsc` is not installed locally.
- [ ] Affected tests pass: `pnpm test` returned exit 0 but discovered 0 tests because `dist/` is absent; not accepted as meaningful verification.
- [ ] Release-quality check considered or run: `pnpm verify` blocked at `pnpm build` for missing `tsc`.
- [ ] Native Windows IPC round-trip smoke: Windows-only test added; local execution remains pending until a Windows runtime or Windows CI runner is available.
- [x] Dependency-free diff check passes: `git diff --check`.
- [x] Relevant `.agents/rules/` checks are satisfied for source/docs changes; no installs, commits, secrets, hooks, or external writes were performed.

## Execution Log

### T1: Add daemon IPC endpoint abstraction
- **Status:** implemented
- **Evidence:** Added `DaemonIpcEndpoint`/`daemonIpcEndpoint()` in `src/daemon/paths.ts`; added `src/__tests__/daemonPaths.test.ts` for POSIX socket and Windows named-pipe branches.
- **Notes:** Verification blocked until dependencies are installed.

### T2: Wire endpoint abstraction through daemon, CLI, server, and IPC tests
- **Status:** implemented
- **Evidence:** Replaced daemon, daemon CLI, MCP server, and IPC tests with `paths.ipc.path`; POSIX cleanup now uses `paths.ipc.cleanupPath` and no-ops for Windows named pipes.
- **Notes:** Verification blocked until dependencies are installed.

### T3: Enable Windows daemon startup and lifecycle
- **Status:** implemented
- **Evidence:** Removed the `win32` daemon startup exit in `src/daemon/daemonMain.ts`; made daemon listen with umask only for Unix sockets; `ensureSecureRoot()` now skips POSIX UID/mode checks on Windows.
- **Notes:** Verification blocked until dependencies are installed.

### T4: Add platform-specific process-tree termination
- **Status:** implemented
- **Evidence:** Added `terminateProcessTree()` and `prepareWorkerSpawn()` in `src/processManager.ts`; POSIX sends `SIGTERM`/`SIGKILL` to `-pid`, Windows uses `taskkill /PID <pid> /T` with `/F` on escalation; tests cover both branches.
- **Notes:** Also added explicit `.cmd`/`.bat` wrapping through the Windows command processor for resolved worker CLI shims.

### T5: Update diagnostics and contract tests
- **Status:** implemented
- **Evidence:** `getBackendStatus()` now accepts an optional platform for deterministic tests and no longer gates backend diagnostics on `posix_supported`; diagnostics command execution uses `prepareWorkerSpawn()` so `.cmd` shims can run on Windows.
- **Notes:** No contract schema change was needed; `posix_supported` remains present.

### T6: Harden tests for cross-platform execution
- **Status:** implemented
- **Evidence:** IPC tests use `daemonIpcEndpoint()`; diagnostics/integration/git tests use `path.delimiter`; integration mocks avoid `mkdir -p`, `/tmp` PATH sentinels, and `sleep`; Windows mock CLI shims are generated as `.cmd` wrappers.
- **Notes:** Symlink fingerprint test is skipped on Windows because Windows symlink creation can require privileges.

### T7: Update user and development docs
- **Status:** implemented
- **Evidence:** Updated `README.md` and `docs/development/mcp-tooling.md` to describe POSIX Unix sockets, Windows named pipes, Windows `taskkill`, and POSIX-specific permission/socket cleanup behavior.
- **Notes:** No MCP config or secret docs changed.

### T8: Run focused and release-quality verification
- **Status:** blocked
- **Evidence:** `git diff --check` passed. `pnpm build` failed with `sh: 1: tsc: not found` and the pnpm warning that `node_modules` is missing. `pnpm test` returned exit 0 but found 0 tests because `dist/` is absent. `pnpm verify` failed at `pnpm build` with the same missing `tsc` error. Native Windows IPC round-trip smoke has been added as a Windows-only test but remains unexecuted locally until a Windows runtime or Windows CI runner is available.
- **Notes:** Repository rules require explicit permission before installing packages; `pnpm install --frozen-lockfile` was not run.
