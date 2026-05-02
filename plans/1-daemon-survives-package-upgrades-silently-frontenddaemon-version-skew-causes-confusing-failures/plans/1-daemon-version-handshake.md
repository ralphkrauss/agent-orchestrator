# Daemon Version Handshake

Branch: `1-daemon-survives-package-upgrades-silently-frontenddaemon-version-skew-causes-confusing-failures`
Plan Slug: `daemon-version-handshake`
Parent Issue: #1
Created: 2026-05-02
Status: completed

## Context

Issue #1 reports that the stdio MCP frontend can update while the long-lived daemon keeps running old code. The observed failures are confusing because the frontend advertises new tools while the stale daemon still validates an older `RpcMethodSchema`, causing errors such as `Invalid enum value ... received 'get_backend_status'`, missing `session_id`, and follow-up rejection because the parent run has no backend session id. The issue's preferred fix is a structured version handshake that reports both frontend and daemon versions with a recovery hint.

Current code already has an IPC `PROTOCOL_VERSION` in `src/contract.ts` and checks it in `src/ipc/protocol.ts`, but that version only represents frame/schema compatibility. It does not encode the package build version, and stale daemons with the same numeric protocol can still accept or reject methods in confusing ways. `src/server.ts` auto-starts the daemon when `ping` fails, but it treats a responding old daemon as healthy. `src/orchestratorService.ts` currently returns `ping` with only `pong` and `daemon_pid`. `get_backend_status` in `src/diagnostics.ts` reports backend CLI health but not frontend/daemon package skew. The daemon CLI in `src/daemon/daemonCli.ts` has `start`, `stop`, `status`, and `prune`, while `justfile` already has a local `orchestrator-restart` workaround.

Sources read:

- GitHub issue #1 and its 2026-05-02 owner comment.
- `AGENTS.md`
- `.agents/rules/node-typescript.md`
- `.agents/rules/mcp-tool-configs.md`
- `.agents/rules/ai-workspace-projections.md`
- `package.json`
- `tsconfig.json`
- `README.md`
- `docs/development/mcp-tooling.md`
- `justfile`
- `src/contract.ts`
- `src/ipc/protocol.ts`
- `src/ipc/client.ts`
- `src/ipc/server.ts`
- `src/server.ts`
- `src/cli.ts`
- `src/daemon/daemonMain.ts`
- `src/daemon/daemonCli.ts`
- `src/orchestratorService.ts`
- `src/diagnostics.ts`
- `src/__tests__/ipc.test.ts`
- `src/__tests__/contract.test.ts`
- `src/__tests__/diagnostics.test.ts`
- `src/__tests__/integration/orchestrator.test.ts`

Relevant commands:

- `pnpm build`
- `pnpm test`
- Narrow pass while developing: `pnpm build && node --test dist/__tests__/ipc.test.js dist/__tests__/contract.test.js dist/__tests__/diagnostics.test.js`

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Version source | Add a small shared package metadata helper that reads the installed root `package.json` at runtime and exposes the package version to both frontend and daemon code. | Avoids hard-coded versions like the current MCP server `0.1.0`, keeps packed npm installs and local builds aligned, and does not require new dependencies or TypeScript config changes. | Build-time replacement; duplicating version constants in multiple files; importing JSON with `resolveJsonModule` changes. |
| 2 | Handshake shape | Keep `PROTOCOL_VERSION` as the numeric wire format version, and add a package version handshake using a request `frontend_version` plus daemon-side `daemon_version` comparison. | Package upgrades are not always wire-format changes. Separating protocol and package versions avoids unnecessary protocol bumps while still detecting stale daemon code. | Bump `PROTOCOL_VERSION` for every package release; rely only on new method failures; compare process paths. |
| 3 | Old daemon compatibility | Make the frontend preflight `ping` require a daemon version before forwarding tool calls. If a responding daemon omits `daemon_version`, return `DAEMON_VERSION_MISMATCH` with `daemon_version: null` and a restart hint. | New frontend cannot force old daemon code to validate a new field, but it can classify an old `ping` response before calling newer tools. | Let the old daemon fail with `INTERNAL`; auto-stop any daemon that omits version; only document manual restart. |
| 4 | Error contract | Add `DAEMON_VERSION_MISMATCH` to `OrchestratorErrorCodeSchema` and include details for `frontend_version`, `daemon_version`, `daemon_pid` when known, and `recovery_hint`. | Preserves the existing `{ ok: false, error }` operational failure envelope and gives clients actionable data. | Use MCP `isError: true`; overload `PROTOCOL_VERSION_MISMATCH`; return plain strings from CLI/server code. |
| 5 | Diagnostic shape | Extend `BackendStatusReportSchema` with top-level orchestrator version fields: `frontend_version`, `daemon_version`, `version_match`, and `daemon_pid`. | `get_backend_status` is the current health surface; these fields let current-version clients prove the daemon matches and inspect the running daemon PID. | Add a separate `get_daemon_status` tool; bury the fields under backend-specific diagnostics; expose only CLI status. |
| 6 | Restart behavior | Add a first-class `agent-orchestrator-mcp-daemon restart [--force]` command, but do not auto-restart from the MCP frontend in this pass. | Restart is useful and discoverable, while automatic restart requires careful active-run policy and should not surprise users by orphaning or cancelling work. | Always auto-restart on mismatch; add only README workaround; make restart always forceful. |
| 7 | Documentation | Document the long-lived daemon upgrade behavior, mismatch error, `restart`, and `npx --package ... agent-orchestrator-mcp-daemon restart` recovery path. | The issue is operational; users need a clear remediation path even before automatic recovery exists. | Only update tests/code; only mention local `just orchestrator-restart`. |

## Scope

### In Scope

- Add package version metadata available to the MCP frontend, daemon, IPC layer, diagnostics, and CLI help/status output.
- Include the frontend package version in IPC requests.
- Have the daemon reject package version mismatches with structured `DAEMON_VERSION_MISMATCH`.
- Have the new frontend classify old daemons that respond to `ping` without version data as `DAEMON_VERSION_MISMATCH`.
- Add daemon version data to `ping` and `get_backend_status`.
- Add a `restart [--force]` daemon CLI command with safe default behavior.
- Update README and local development docs for upgrade/restart guidance.
- Add focused tests for contract schema, IPC mismatch behavior, diagnostics version fields, and stale-daemon frontend classification.

### Out Of Scope

- Automatic frontend-driven daemon restart on mismatch.
- Any npm publishing, package version bump, dist-tag change, or release workflow change.
- Changes to worker backend result derivation except where tests confirm the original symptom is now preempted by version mismatch detection.
- New external dependencies.
- Windows named-pipe support or broader daemon transport changes.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | New frontend talks to an old daemon that does not know `frontend_version`. | Require `daemon_version` in the frontend `ping` preflight and synthesize `DAEMON_VERSION_MISMATCH` when missing. | IPC/server tests with an old-style ping response. |
| 2 | Old frontend talks to a new daemon without `frontend_version`. | Daemon treats missing frontend version as a mismatch with `frontend_version: null` and returns a structured error. | IPC request validation tests. |
| 3 | Frontend and daemon versions differ but the method is otherwise valid. | Daemon validates version before dispatching to `OrchestratorService`. | IPC mismatch tests for a known method such as `list_runs`. |
| 4 | Numeric IPC protocol mismatch still occurs. | Keep existing `PROTOCOL_VERSION_MISMATCH` behavior separate from package version mismatch. | Existing IPC protocol test plus any adjusted response parsing tests. |
| 5 | `get_backend_status` cannot execute against a truly old daemon. | Return the mismatch envelope from the frontend before dispatch; document that status fields are available after daemon restart or when the daemon is current enough to support the contract. | Server/tool response tests and README note. |
| 6 | `restart` is run while active worker runs exist. | Default `restart` uses non-force stop semantics and refuses with active run IDs; `restart --force` follows existing forced shutdown behavior. | CLI lifecycle tests or documented manual verification if direct CLI tests are too brittle. |
| 7 | Runtime package version lookup fails in an unusual install layout. | Helper falls back to a clear `unknown` value; mismatch messages still show `unknown` and recovery guidance. | Unit test for helper fallback if helper is injectable, otherwise contract/diagnostic tests cover normal path. |
| 8 | Existing clients parse `BackendStatusReport` strictly. | Add fields in a backward-compatible way at the top level while preserving existing backend fields. | Contract schema test updates. |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T1 | Add package metadata helper and contract fields | None | completed | A shared helper exposes the package version without new dependencies or `tsconfig` loosening; MCP server metadata uses the package version; `OrchestratorErrorCodeSchema` includes `DAEMON_VERSION_MISMATCH`; `BackendStatusReportSchema` accepts orchestrator version fields. |
| T2 | Implement IPC package version handshake | T1 | completed | `createRpcRequest` includes `frontend_version`; request validation detects missing or different frontend versions before method dispatch; mismatch errors include frontend and daemon versions plus a recovery hint; existing protocol mismatch behavior remains distinct. |
| T3 | Classify stale daemon from the MCP frontend | T1, T2 | completed | `ensureDaemon` verifies `ping` includes a matching `daemon_version`; a live old daemon that omits version data is reported as `{ ok: false, error: { code: "DAEMON_VERSION_MISMATCH", ... } }`; frontend does not call newer tools after mismatch detection. |
| T4 | Expose daemon/frontend versions in status surfaces | T1, T2 | completed | `ping` returns daemon version and PID; `get_backend_status` returns `frontend_version`, `daemon_version`, `version_match`, and `daemon_pid`; `formatBackendStatus` prints version match details; direct `OrchestratorService.dispatch` tests can pass or omit frontend context deterministically. |
| T5 | Add daemon restart CLI ergonomics | T1 | completed | `agent-orchestrator-mcp-daemon restart` stops then starts the daemon; default restart refuses active runs through existing stop semantics; `restart --force` force-stops first; help output in `src/cli.ts` and daemon CLI usage include restart; status output includes daemon version when available. |
| T6 | Update documentation | T3, T5 | completed | `README.md` documents long-lived daemon upgrade behavior, the mismatch error, and restart commands for installed and `npx` usage; `docs/development/mcp-tooling.md` points local developers at `just orchestrator-restart` and first-class daemon restart. |
| T7 | Add focused tests and run quality gates | T1, T2, T3, T4, T5, T6 | completed | Tests cover contract schema changes, IPC mismatch and old-daemon classification, diagnostics version fields, and CLI restart/status behavior where practical; `pnpm build` and the narrow node test command pass; `pnpm test` passes before handoff. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | Daemon/client IPC contracts should include both wire protocol compatibility and package/build version diagnostics. | `.agents/rules/node-typescript.md` or a new daemon lifecycle rule covering `src/ipc/**`, `src/daemon/**`, and `src/server.ts`. | After this issue lands and the pattern is stable. |

## Quality Gates

- [x] `pnpm build` passes. Evidence: command exited 0 on 2026-05-02.
- [x] `node --test dist/__tests__/ipc.test.js dist/__tests__/contract.test.js dist/__tests__/diagnostics.test.js dist/__tests__/daemonCli.test.js` passes after `pnpm build`. Evidence: 19 tests passed, command exited 0 on 2026-05-02.
- [x] `pnpm test` passes. Evidence: 39 tests passed, command exited 0 on 2026-05-02.
- [x] Relevant `.agents/rules/` checks are satisfied: used `pnpm`, added no dependencies, kept Node 22-compatible TypeScript, updated schemas/docs/tests for MCP contract changes, and verified CLI behavior with tests plus `node dist/cli.js doctor` and `node dist/cli.js doctor --json`.
- [x] `git diff --check` passes. Evidence: command exited 0 on 2026-05-02.

## Execution Log

### T1: Add package metadata helper and contract fields
- **Status:** completed
- **Evidence:** Added `src/packageMetadata.ts`; exported package metadata helpers from `src/index.ts`; updated MCP server metadata in `src/server.ts`; added `DAEMON_VERSION_MISMATCH`, `daemonVersionMismatchError`, and backend status version fields in `src/contract.ts`; `pnpm build` exited 0.
- **Notes:** Package version is read from the installed root `package.json` with an `unknown` fallback and no dependency or `tsconfig` changes.

### T2: Implement IPC package version handshake
- **Status:** completed
- **Evidence:** Updated `src/ipc/protocol.ts`, `src/ipc/client.ts`, and `src/ipc/server.ts`; `src/__tests__/ipc.test.ts` covers mismatched frontend versions, lifecycle recovery bypass for `ping`/`shutdown`, and protocol mismatch separation; targeted node test command exited 0.
- **Notes:** Numeric `PROTOCOL_VERSION_MISMATCH` remains separate from package `DAEMON_VERSION_MISMATCH`; `ping` and `shutdown` intentionally bypass package mismatch so stale daemons can be diagnosed and stopped.

### T3: Classify stale daemon from the MCP frontend
- **Status:** completed
- **Evidence:** Added `src/daemonVersion.ts` and wired it into `src/server.ts`; startup allows list-tools to work on mismatch while tool calls return the structured mismatch envelope; `src/__tests__/ipc.test.ts` classifies old-style ping responses as `DAEMON_VERSION_MISMATCH`.
- **Notes:** Auto-restart remains out of scope; stale daemons are reported instead of being stopped automatically.

### T4: Expose daemon/frontend versions in status surfaces
- **Status:** completed
- **Evidence:** Updated `src/orchestratorService.ts` ping and `get_backend_status` dispatch; updated `src/diagnostics.ts` and `formatBackendStatus`; `src/__tests__/diagnostics.test.ts` verifies direct diagnostics and daemon-dispatch version fields; `node dist/cli.js doctor` and `node dist/cli.js doctor --json` both exited 0 and showed version fields.
- **Notes:** Direct `doctor` diagnostics show daemon version as not connected; daemon-mediated diagnostics report matching frontend and daemon versions.

### T5: Add daemon restart CLI ergonomics
- **Status:** completed
- **Evidence:** Added `restart [--force]` to `src/daemon/daemonCli.ts`, CLI help in `src/cli.ts`, and simplified `just orchestrator-restart`; `src/__tests__/daemonCli.test.ts` verifies help, restart from stopped state, status version match output, and restart of a stale daemon with mismatched package version.
- **Notes:** Default restart uses existing safe stop semantics; `restart --force` uses existing forced cancellation behavior. Status reports live mismatched daemons with `runs=unavailable` when `list_runs` is blocked by the handshake.

### T6: Update documentation
- **Status:** completed
- **Evidence:** Updated `README.md` diagnostics, architecture, daemon lifecycle, npx restart examples, and upgrade guidance; updated `docs/development/mcp-tooling.md` with local restart guidance.
- **Notes:** Documentation explicitly calls out long-lived daemon/package-upgrade version skew.

### T7: Add focused tests and run quality gates
- **Status:** completed
- **Evidence:** `pnpm build` exited 0; targeted command `node --test dist/__tests__/ipc.test.js dist/__tests__/contract.test.js dist/__tests__/diagnostics.test.js dist/__tests__/daemonCli.test.js` passed 19 tests; `node --test dist/__tests__/ipc.test.js dist/__tests__/daemonCli.test.js` passed 9 tests for the review finding fix; `pnpm test` passed 39 tests; `git diff --check` exited 0.
- **Notes:** Hardening pass checked IPC/server call sites, daemon CLI behavior, docs, and status/report surfaces.
