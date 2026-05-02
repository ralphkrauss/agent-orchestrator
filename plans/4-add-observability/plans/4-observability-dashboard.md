# Observability Snapshot And Terminal Dashboard

Branch: `4-add-observability`
Plan Slug: `observability-dashboard`
Parent Issue: #4
Created: 2026-05-02
Status: implementation complete; verified

## Context

Issue #4 asks for a way to see whether the orchestrator is healthy, which models are being used, which sessions are running, how large runs are, what they are about, the last interaction, and whether follow-ups resume existing backend sessions instead of starting new sessions.

Sources read:

- `AGENTS.md`
- `.agents/rules/node-typescript.md`
- `.agents/rules/mcp-tool-configs.md`
- `.agents/rules/ai-workspace-projections.md`
- GitHub issue #4 and issue comments
- `package.json`
- `README.md`
- `docs/development/mcp-tooling.md`
- `src/contract.ts`
- `src/orchestratorService.ts`
- `src/runStore.ts`
- `src/processManager.ts`
- `src/server.ts`
- `src/cli.ts`
- `src/daemon/daemonCli.ts`
- `src/daemon/daemonMain.ts`
- `src/daemon/paths.ts`
- `src/diagnostics.ts`
- `src/toolTimeout.ts`
- `src/backend/WorkerBackend.ts`
- `src/backend/codex.ts`
- `src/backend/claude.ts`
- `src/backend/resultDerivation.ts`
- `src/__tests__/contract.test.ts`
- `src/__tests__/runStore.test.ts`
- `src/__tests__/diagnostics.test.ts`
- `src/__tests__/integration/orchestrator.test.ts`

Existing architecture already has durable run metadata, event logs, stdout/stderr artifacts, MCP run tools, backend diagnostics, and daemon lifecycle commands. The missing layer is a user-oriented summary that derives operational status, activity, size, model, and session-resume signals from those primitives.

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Primary display | Terminal-first observability with a persistent `watch` dashboard mode. | Fits the existing daemon CLI, works over SSH, avoids browser security and dependency complexity, and directly answers the request to leave a dashboard open. | Web dashboard as the first slice; raw run-store docs only. |
| 2 | Data source | Create one shared observability snapshot contract used by CLI, watch mode, and MCP. | Keeps human and agent views consistent and testable. | Build CLI formatting directly from ad hoc store reads; separate MCP and CLI data models. |
| 3 | Dashboard interaction | Implement `watch` as an interactive terminal dashboard with periodic snapshot polling, arrow-key navigation, Enter-to-open run details, Backspace/Escape-to-return, and `q` to quit. | Gives users a leave-open dashboard and a way to dive into active runs without introducing a browser server or UI dependency. | Static refresh-only watch mode; streaming IPC subscriptions; curses-style dependency; web sockets. |
| 4 | Backend diagnostics in watch mode | Keep expensive backend diagnostics out of the default refresh path; allow explicit `--diagnostics` for one-shot or slow refresh use. | Current diagnostics shell out to backend CLIs and should not run every dashboard tick by default. | Always run `getBackendStatus()` on every refresh. |
| 5 | Raw prompt visibility | Persist raw start/follow-up prompts in each private run directory and show them in run detail views. | Users explicitly need to inspect what was asked of each agent. The existing run store is local, user-owned, and permission-restricted, so this fits the package's trusted-local model. | Only derive safe topics from metadata; omit prompts from observability entirely. |
| 6 | Model visibility | Add additive model/source metadata where needed and display `model` plus source: explicit, inherited, backend default/unknown, or legacy unknown. | The issue explicitly asks to verify model usage; requested model and inheritance must be distinguishable. | Only show the current nullable `model` field. |
| 7 | Session resume visibility | Add additive requested/observed session tracking and warnings for mismatches. | Current `session_id` is enough to resume, but it cannot prove whether a follow-up emitted the same backend session because follow-up runs start with `session_id` already set. | Infer resume correctness from parent/child links only. |
| 8 | Size indicators | Show event count and artifact byte sizes for `events.jsonl`, `stdout.log`, `stderr.log`, and `result.json`; treat token/context sizes as opportunistic only when backend events expose them. | These sizes are available today and useful for detecting runaway runs. Token counts are not guaranteed across Codex and Claude streams. | Promise exact model context/token size in v1. |
| 9 | Public API stability | Add new fields/tools/methods without changing existing tool behavior. | Keeps package behavior stable while expanding observability. | Rename or repurpose existing `list_runs`/`get_run_status` responses. |
| 10 | TUI implementation style | Use Node built-ins for raw-mode key handling and ANSI rendering. | Avoids dependency changes and keeps the package aligned with the repository's plain TypeScript style. | Add Ink/Blessed/curses dependency in the first slice. |
| 11 | Human-readable metadata | Standardize display metadata from `metadata.title`, `metadata.summary`, `metadata.session_title`, `metadata.session_summary`, `metadata.prompt_title`, and `metadata.prompt_summary`, with raw-prompt fallbacks when fields are missing. | Gives each prompt/run a readable title and summary while letting supervisors provide better labels without changing existing MCP input shape. | Add many new top-level input fields; require a model call to generate summaries. |
| 12 | Session summaries | Derive session groups from backend session IDs and parent/child run chains, then show per-session prompt history with updated prompt titles, summaries, statuses, models, and last activity. | Users need to understand what is happening across an entire resumed session, not just isolated run IDs. | Treat every run as independent in the dashboard. |

## Scope

### In Scope

- Add a typed observability snapshot schema and RPC/MCP method.
- Add run activity summaries: last event, last interaction preview, event count, artifact sizes, duration, and recent error count.
- Persist raw prompts for start and follow-up runs as private run artifacts.
- Add standardized human-readable display metadata for sessions and individual prompts/runs.
- Add session-level grouping with updated summaries of prompts in each session.
- Add model visibility with source information where the orchestrator can know it.
- Add requested and observed backend session IDs for resume auditing.
- Add terminal CLI observability commands, including a persistent watch/dashboard mode.
- Add interactive terminal navigation for the dashboard: session list, run/prompt list, detail view, raw prompt, recent events, and artifact paths.
- Add JSON output for scriptable CLI observability commands.
- Update README usage and MCP tool documentation.
- Add focused tests for contract schema, store-derived snapshot data, resume/session metadata, CLI formatting, and MCP registration.

### Out Of Scope

- Browser/web dashboard.
- Authentication, permissions, or secret handling changes.
- Persisting non-prompt secret-bearing request bodies or environment data.
- Exact token/context-size accounting unless already present in backend event payloads.
- Changing follow-up session selection behavior based on observed session mismatches.
- Cross-worktree isolation or concurrent edit prevention.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | Large event logs make dashboard refresh slow. | Use sequence files and tail-oriented reads where possible; allow `--limit`; avoid loading stdout/stderr contents. | RunStore/observability tests with many events. |
| 2 | Backend diagnostics are too expensive for frequent watch refreshes. | Do not run diagnostics by default in watch mode; add explicit opt-in. | CLI tests and docs. |
| 3 | Terminal output flickers or unreadable on narrow terminals. | Use plain, compact tables; clear/repaint only when TTY; fall back to repeated snapshots when not TTY. | CLI formatter tests plus manual smoke. |
| 4 | Existing runs lack new metadata fields. | Add schema defaults such as `unknown`/`null` and derive best-effort warnings. | Contract backward-compat tests. |
| 5 | Follow-up backend emits a different session ID. | Record observed session separately and show a warning without changing resume behavior. | Integration test with mock CLI session mismatch. |
| 6 | Prompt-derived topic leaks sensitive data in list views. | Keep raw prompts in detail views and explicit JSON/detail payloads; use compact prompt previews or metadata titles in list views. | Formatter tests and docs review. |
| 7 | Daemon stopped while dashboard is open. | Show stopped/unavailable state and retry on next refresh. | CLI watch helper tests or manual smoke. |
| 8 | MCP contract drift after adding a new tool. | Update `RpcMethodSchema`, server tool list, README table, and tests in one change. | Contract and MCP registration tests. |
| 9 | Raw-mode terminal is left in a bad state after errors or Ctrl-C. | Centralize TTY setup/cleanup and restore raw mode/cursor state in `finally` and signal handlers. | TUI helper tests plus manual smoke. |
| 10 | Detail view leaks too much raw event data. | Show bounded recent events and previews by default; expose artifact paths for full stdout/stderr/events inspection. | Formatter tests and docs. |
| 11 | Raw prompts can contain secrets or sensitive instructions. | Store prompts only in the existing `0700`/`0600` run store, show them intentionally in detail views, document the behavior clearly, and do not include environment variables or other secret-bearing process data. | Store permission tests, docs review, and formatter tests. |
| 12 | A run has no observed backend session ID yet. | Group it under its root run chain until the backend reports a session ID, then present the canonical session ID when available. | Snapshot derivation tests for pre-session and post-session runs. |
| 13 | Human metadata is missing or inconsistent across follow-ups. | Use run metadata when present; inherit session title/summary from parent/root when absent; fall back to raw prompt first line and run ID. | Metadata derivation tests. |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| OBS-1 | Define observability contract | none | implemented; verified | `src/contract.ts` includes additive schemas/types for snapshot input/output, model source, session audit state, prompt metadata, session metadata, artifact sizes, and run activity; older run summaries parse with defaults; no existing tool response contracts are broken. |
| OBS-2 | Record prompts, display metadata, model source, and session audit metadata | OBS-1 | implemented; verified | `startRun` and `sendFollowup` persist raw prompts in private per-run artifacts; run metadata is normalized into prompt/run title, prompt/run summary, session title, and session summary fields; `startRun` records explicit vs backend-default model source; `sendFollowup` records explicit vs inherited/default model source; process event parsing records observed backend session ID separately from requested session ID; mismatches are representable without changing existing `session_id` behavior. |
| OBS-3 | Add store-derived observability snapshot builder | OBS-1, OBS-2 | implemented; verified | A module derives run summaries and session summaries with last event/activity, duration, event count, artifact byte sizes, raw prompt/detail prompt preview, prompt title/summary, session title/summary, per-session prompt history, recent errors, model display, and session warnings from `RunStore`; it handles missing/legacy files gracefully. |
| OBS-4 | Expose snapshot through daemon RPC and MCP | OBS-3 | implemented; verified | `get_observability_snapshot` is added to `RpcMethodSchema`, `OrchestratorService.dispatch`, `src/server.ts`, timeout handling as needed, and README MCP tool docs; MCP response uses the standard `{ ok: true }`/`{ ok: false }` envelope. |
| OBS-5 | Add human CLI commands and JSON output | OBS-4 | implemented; verified | CLI supports compact session/run/status views and `--json`; commands show daemon state, active sessions, active prompts/runs, prompt titles/summaries, model/source, session audit state, last activity, size, and recent errors; stopped daemon state is handled cleanly. |
| OBS-6 | Add interactive terminal dashboard mode | OBS-5 | implemented; verified | A `watch` command repeatedly refreshes the snapshot, supports interval and limit options, can be left open, handles Ctrl-C, supports arrow-key selection across sessions and prompts, Enter opens a run detail view with the raw prompt and recent activity, Backspace/Escape returns to the previous list, `q` exits, and stdout falls back sensibly when not a TTY. |
| OBS-7 | Update docs and examples | OBS-5, OBS-6 | implemented; verified | README documents observability commands, dashboard mode, JSON output, raw prompt storage/visibility, metadata fields for session/prompt titles and summaries, and model/session interpretation. |
| OBS-8 | Add focused tests | OBS-1, OBS-2, OBS-3, OBS-4, OBS-5 | implemented; verified | Tests cover schema defaults, prompt persistence, prompt write failure atomicity, display metadata, session grouping, full session history counts under detail limits, observed model mismatch warnings, snapshot derivation, artifact sizing, model inheritance, observed session mismatch recording, lightweight event summaries, MCP tool registration, and CLI formatter behavior. |
| OBS-9 | Verify affected checks | OBS-8 | complete | `pnpm build` passes; `pnpm test` passes; `git diff --check` passes. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | Raw prompt observability must be documented and stored only in the private run store. | Repository observability/privacy convention. | After OBS-7 if this pattern becomes a recurring design rule. |

## Quality Gates

- [x] `pnpm build` passes.
- [x] `pnpm test` passes.
- [x] Relevant `.agents/rules/` checks are satisfied.
- [x] `git diff --check` passes.
- [ ] `pnpm verify` passes before release-quality handoff or PR if requested.

## Execution Log

### OBS-1: Define observability contract

- **Status:** implemented; verified
- **Evidence:** Added additive schemas/types in `src/contract.ts` for model source, run display metadata, observability snapshots, session audit state, prompt/activity/artifact/session summaries, and `get_observability_snapshot`.
- **Notes:** Backward-compatible defaults are covered by source tests and `pnpm build`/`pnpm test` pass.

### OBS-2: Record prompts, display metadata, model source, and session audit metadata

- **Status:** implemented; verified
- **Evidence:** Updated `src/runStore.ts`, `src/orchestratorService.ts`, and `src/processManager.ts` to write `prompt.txt` during run creation, persist display metadata/model source/requested session ID, and record observed backend session IDs from worker events.
- **Notes:** `send_followup` now accepts additive `metadata` for per-prompt titles/summaries and inherits session display fields from the parent. Run metadata is written last so a prompt write failure does not publish a durable `running` run without its raw prompt.

### OBS-3: Add store-derived observability snapshot builder

- **Status:** implemented; verified
- **Evidence:** Added `src/observability.ts` to derive sessions, runs, prompts, model/source data, session audit warnings, artifact sizes, durations, recent events, and recent errors from `RunStore`.
- **Notes:** Snapshot builder reads prompt previews by default and includes full raw prompt text only when requested. Dashboard snapshots now use `RunStore.readEventSummary()` so refreshes avoid loading full event logs for visible runs. Session prompt counts are derived from the full run metadata set even when detailed runs are limited.

### OBS-4: Expose snapshot through daemon RPC and MCP

- **Status:** implemented; verified
- **Evidence:** Added `get_observability_snapshot` to `RpcMethodSchema`, `OrchestratorService.dispatch`, and `src/server.ts`; updated `send_followup` MCP schema with additive `metadata`; extracted MCP tool definitions to `src/mcpTools.ts`.
- **Notes:** Snapshot uses the existing standard tool response envelope and has focused registration coverage in `src/__tests__/mcpTools.test.ts`.

### OBS-5: Add human CLI commands and JSON output

- **Status:** implemented; verified
- **Evidence:** Updated `src/daemon/daemonCli.ts` with `status --verbose`, `runs`, `runs --json`, `--prompts`, and local-store fallback when the daemon is stopped; extracted formatter helpers to `src/daemon/observabilityFormat.ts`.
- **Notes:** `src/cli.ts` help and `justfile` development recipes now include the new observability commands. Formatter behavior is covered by `src/__tests__/observabilityFormat.test.ts`.

### OBS-6: Add interactive terminal dashboard mode

- **Status:** implemented; verified
- **Evidence:** Added `agent-orchestrator-daemon watch` with periodic snapshot polling, raw-mode arrow navigation, Enter detail drill-down, Backspace/Escape return, `q` exit, and non-TTY fallback.
- **Notes:** Implementation uses Node built-ins and ANSI output only.

### OBS-7: Update docs and examples

- **Status:** implemented; verified
- **Evidence:** Updated `README.md` with observability commands, raw prompt storage behavior, metadata fields, session grouping semantics, and MCP tool docs; updated `docs/development/mcp-tooling.md`.
- **Notes:** Docs explicitly warn that raw prompts are stored in the private run store.

### OBS-8: Add focused tests

- **Status:** implemented; verified
- **Evidence:** Updated `src/__tests__/contract.test.ts`, `src/__tests__/runStore.test.ts`, and `src/__tests__/integration/orchestrator.test.ts`; added `src/__tests__/observability.test.ts`, `src/__tests__/mcpTools.test.ts`, and `src/__tests__/observabilityFormat.test.ts`.
- **Notes:** Tests cover schema defaults, prompt persistence, prompt write failure atomicity, display metadata, session grouping, full session history counts under detail limits, observed model mismatch warnings, snapshot derivation, artifact sizing, model inheritance, observed session mismatch recording, lightweight event summaries, MCP tool registration, and CLI formatter behavior.

### OBS-9: Verify affected checks

- **Status:** complete
- **Evidence:** `pnpm build` passed. `pnpm test` passed with 70 tests total, 69 passed and 1 skipped. `git diff --check` passed.
- **Notes:** Hardening pass addressed prompt creation atomicity, event-summary refresh cost, MCP tool registration tests, CLI formatter tests, full prompt history counts under limited snapshots, and observed model mismatch warnings.
