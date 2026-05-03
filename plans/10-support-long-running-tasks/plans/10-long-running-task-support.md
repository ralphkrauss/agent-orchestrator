# Long-Running Task Support

Branch: `10-support-long-running-tasks`
Plan Slug: `long-running-task-support`
Parent Issue: #10
Created: 2026-05-02
Status: implemented; dependency verification blocked

## Context

Issue #10 asks to support long-running tasks. The user clarified that the goal is not simply to make timeouts very long. The orchestrator supervisor should understand that some worker tasks can take a long time, should check in on a cadence that depends on the task, should check early to catch startup failures, should back off when the worker is healthy, and should not kill a worker that is still getting work done.

Before writing this plan, `origin/main` was fetched and merged into this branch at merge commit `11c1df6` to pick up the package rename from `@ralphkrauss/agent-orchestrator-mcp` to `@ralphkrauss/agent-orchestrator`. The merge conflicts in `package.json` and `src/cli.ts` were resolved by preserving the renamed command surface and the branch's OpenCode orchestration entry point. `git diff --cached --check` passed before completing the merge. `pnpm build` was attempted after the merge but could not run because `node_modules` is missing and `tsc` is unavailable; no package install was performed.

Sources read:

- `AGENTS.md`
- `.agents/rules/node-typescript.md`
- `.agents/rules/ai-workspace-projections.md`
- `.agents/rules/mcp-tool-configs.md`
- GitHub issue #10
- `package.json`
- `README.md`
- `docs/development/mcp-tooling.md`
- `.agents/skills/orchestrate-create-plan/SKILL.md`
- `src/contract.ts`
- `src/mcpTools.ts`
- `src/orchestratorService.ts`
- `src/processManager.ts`
- `src/runStore.ts`
- `src/observability.ts`
- `src/opencode/config.ts`
- `src/toolTimeout.ts`
- `src/__tests__/integration/orchestrator.test.ts`
- `src/__tests__/toolTimeout.test.ts`
- `src/__tests__/opencodeHarness.test.ts`

Current behavior:

- `start_run` and `send_followup` accept `execution_timeout_seconds`.
- The daemon defaults to a 30 minute hard wall-clock timeout and rejects values above 4 hours.
- `wait_for_run` is intentionally bounded to 1-300 seconds and the MCP frontend extends IPC timeout only for that bounded wait.
- Run observability already exposes recent events, `last_event_at`, artifact sizes, and session grouping.
- The OpenCode supervisor prompt tells the agent to start, wait, evaluate, and follow up, but it does not describe an adaptive long-running check-in strategy.
- The daemon currently kills a run when the wall-clock execution timer fires even if the worker has recently produced events or output.
- `CodexBackend` and `ClaudeBackend` already parse structured JSON error events into run errors, and `ProcessManager` records stderr chunks containing "error", but there is no shared backend error taxonomy, no latest-error metadata, and no fail-fast path for known fatal backend errors such as authentication, invalid model, quota/rate-limit, malformed request, or backend protocol errors.

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Timeout model | Separate hard wall-clock execution caps from idle-progress timeouts. Keep explicit hard caps available, but make default supervision activity-aware. | This matches the requirement to avoid killing workers that are still getting work done while still detecting stuck runs. | Raising the hard timeout; making all runs unbounded; repurposing `execution_timeout_seconds` in a breaking way. |
| 2 | Default behavior | Default new/generated daemon config to `default_idle_timeout_seconds: 1200` with `max_idle_timeout_seconds: 7200`, and no default hard wall-clock cap unless explicitly configured. | Long tasks should survive as long as activity continues, but silent stuck runs should still be stopped. A 20 minute idle default catches most stuck runs without treating multi-hour active work as failed. | Keeping the current generated 30 minute hard cap; setting a very long default hard cap. |
| 3 | Legacy config migration | If an existing `config.json` exactly matches the old generated defaults, migrate it to the new generated defaults. If it has user-customized hard timeout values, preserve them and add idle defaults. | Avoids leaving most users on the old accidental hard-kill behavior while respecting intentional local customization. | Blindly overwriting user config; never migrating old generated config. |
| 4 | Activity source | Treat worker lifecycle events, parsed backend events, stdout data, stderr data, and terminalization as activity, with throttled metadata writes. | Backend event streams may be sparse or backend-specific; raw output is a useful fallback signal. Throttling avoids excessive run-store writes. | Only using parsed worker events; polling file mtimes from the watchdog. |
| 5 | Watchdog implementation | Replace the single fixed run timer with a watchdog that checks idle deadline and optional hard deadline. | A recalculated watchdog can keep active workers alive and still terminate idle or explicitly capped runs. | Re-arming one timeout on every output event without persisted activity metadata; relying only on supervisor polling. |
| 6 | Supervisor check-ins | Keep `wait_for_run` bounded and guide the OpenCode supervisor to poll in adaptive rounds: first wait around 30 seconds, then roughly 2 minutes, 5 minutes, and a 10-15 minute cap while activity advances. | Long MCP calls are fragile. Bounded waits plus status/event checks are easier to recover from across client restarts, and the short first wait catches startup failures quickly. | Allowing hour-long `wait_for_run` calls; adding streaming subscriptions in this slice. |
| 7 | Cancellation policy | The supervisor should cancel only for terminal user decisions, clear idle/stall evidence, or explicit stop/restart force paths. | The user explicitly does not want workers killed while they are progressing. | Cancelling based on elapsed wall-clock time alone; never cancelling stuck workers. |
| 8 | API compatibility | Add fields and inputs additively; preserve existing tool names and response envelopes. | Existing MCP clients and scripts should keep working. | Renaming tools; changing the meaning of existing statuses. |
| 9 | Observability | Surface idle timeout settings, last activity, idle duration, and timeout reason in status/snapshot output. | Operators and supervisors need to know whether a run is healthy, quiet, idle-expired, or hard-capped. | Leaving timeout decisions hidden in daemon logs only. |
| 10 | Backend error surfacing | Add backend-specific error classifiers for Codex and Claude that normalize category, source, retryability, and fatality; fatal backend errors fail the run promptly, while nonfatal errors are visible immediately as events and latest-error metadata. | Long-running support must not hide real backend failures behind long polling windows. The supervisor needs actionable errors as soon as they appear. | Treating all stderr as fatal; waiting for idle timeout after known auth/model/quota failures; leaving errors only in raw stdout/stderr artifacts. |

## Scope

### In Scope

- Add additive contract fields for run activity and timeout policy.
- Add optional `idle_timeout_seconds` inputs for `start_run` and `send_followup`.
- Preserve `execution_timeout_seconds` as an explicit hard wall-clock cap.
- Add daemon config fields for default/max idle timeout and optional default/max hard execution timeout.
- Migrate generated legacy daemon config safely.
- Persist and expose `last_activity_at`, activity source, idle timeout, hard timeout, and timeout reason.
- Update process management so worker output and backend events refresh activity.
- Update watchdog behavior so workers are timed out for idleness, not for long elapsed time while active.
- Normalize backend errors from Codex and Claude structured events, stderr, and process exit context into clear categories.
- Fail fast for known fatal backend errors and expose nonfatal errors immediately.
- Update OpenCode supervisor prompt and `orchestrate-*` skill guidance with adaptive check-in cadence.
- Update README and MCP docs with long-running supervision guidance.
- Add focused tests for contracts, config migration, process activity tracking, backend error classification, fail-fast handling, idle watchdog behavior, MCP schema, observability output, and OpenCode prompt guidance.

### Out Of Scope

- Streaming MCP subscriptions or push notifications.
- Reattaching to in-flight worker processes after daemon restart.
- Changing the bounded 300 second maximum for `wait_for_run`.
- Cross-worktree locking or concurrent edit prevention.
- Live Codex, Claude, or OpenCode model-call tests.
- Publishing, tagging, or changing npm release behavior.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | Worker produces no parseable backend events but still writes stdout/stderr. | Refresh activity on raw stdout and stderr chunks before backend parsing. | Process manager unit/integration tests with mock CLIs. |
| 2 | Worker is alive but silent for a legitimate long computation. | Keep idle timeout configurable per run and in daemon config; document profile/task selection should choose larger idle windows for known quiet tasks. | Contract tests and docs. |
| 3 | Output floods cause frequent meta writes. | Throttle persisted activity updates while keeping in-memory activity fresh for the watchdog. | Process manager tests with repeated output. |
| 4 | Existing generated config still has the old hard 30 minute default. | Detect exact old generated defaults and migrate to new generated idle-based defaults. | Config migration tests. |
| 5 | User-customized config is overwritten. | Preserve customized hard timeout fields and only add missing idle fields. | Config migration tests. |
| 6 | Hard cap and idle timeout fire close together. | Prefer the earliest deadline and include timeout reason/context in terminal result. | Watchdog tests. |
| 7 | Supervisor keeps waiting even though a run is stuck. | Prompt and skill guidance require comparing activity sequence/timestamps between check-ins and escalating when no progress is observed. | OpenCode prompt tests and skill/projection checks. |
| 8 | Supervisor cancels a run just because it is old. | Guidance says age alone is not a cancel reason when activity advances. | Prompt/skill tests and docs review. |
| 9 | Daemon restart or package mismatch interrupts monitoring. | Existing durable run store and daemon version checks remain; docs instruct supervisors to recover by status/snapshot polling. | Existing daemon tests plus docs. |
| 10 | Terminal dashboards show confusing timeout state. | Add timeout policy and timeout reason to observability formatting. | Observability formatter tests. |
| 11 | Backend emits a clear fatal error but the process remains alive or quiet. | Backend classifiers mark known fatal errors; `ProcessManager` records them, terminates the process group, and finalizes the run as `failed` with actionable context. | Backend and process manager tests. |
| 12 | Backend emits a recoverable or informational error event during otherwise successful work. | Error classifiers include severity/fatality; nonfatal errors remain visible without forcing terminal failure. | Backend parser tests with nonfatal event fixtures. |
| 13 | CLI writes an error without JSON structure. | Stderr classifier recognizes common Codex/Claude auth, model, quota, rate-limit, permission, and protocol patterns and preserves raw text in context. | Stderr classification tests. |
| 14 | Supervisor misses an early startup failure. | OpenCode prompt directs a short first check-in and latest-error inspection before backing off. | OpenCode prompt tests. |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| LRT-1 | Define timeout and activity contract | none | implemented; verification blocked by missing dependencies | `src/contract.ts` adds additive schema fields for `last_activity_at`, `last_activity_source`, `idle_timeout_seconds`, optional hard `execution_timeout_seconds`, and terminal timeout reason/context; `start_run` and `send_followup` accept optional `idle_timeout_seconds`; legacy run summaries parse with defaults. |
| LRT-2 | Add daemon config parsing and migration | LRT-1 | implemented; verification blocked by missing dependencies | `OrchestratorService.loadConfig()` supports default/max idle timeout and optional default/max hard execution timeout; generated defaults are `default_idle_timeout_seconds: 1200`, `max_idle_timeout_seconds: 7200`, and no default hard wall-clock cap; exact old generated config migrates to new defaults; customized configs are preserved; invalid config values fall back safely and are documented. |
| LRT-3 | Persist activity from process management | LRT-1 | implemented; verification blocked by missing dependencies | `ProcessManager` records activity on run start, stdout chunks, stderr chunks, parsed backend events, errors, and terminalization; activity meta writes are throttled; run-store tests cover activity persistence. |
| LRT-4 | Replace fixed execution timer with activity-aware watchdog | LRT-2, LRT-3 | implemented; verification blocked by missing dependencies | Active runs are not timed out while activity continues; idle runs transition to `timed_out` with idle timeout context; explicit hard caps still time out by elapsed wall-clock; `cancel_run` and force shutdown still cancel immediately. |
| LRT-5 | Harden backend error detection and fail-fast surfacing | LRT-1, LRT-3 | implemented; verification blocked by missing dependencies | Codex and Claude backends classify structured error events and stderr text into categories such as auth, rate_limit, quota, invalid_model, permission, protocol, backend_unavailable, and unknown; errors include source, backend, retryable, and fatal context; known fatal errors are appended as error events, exposed in run metadata, terminate the worker process group, and finalize as `failed` without waiting for idle timeout. |
| LRT-6 | Expose activity, timeout, and latest error state through tools and observability | LRT-1, LRT-3, LRT-4, LRT-5 | implemented; verification blocked by missing dependencies | `get_run_status`, `list_runs`, `get_run_result`, and `get_observability_snapshot` expose last activity, timeout policy, latest error, and timeout/error reason; dashboard formatting shows idle duration and latest actionable error without loading full logs. |
| LRT-7 | Update OpenCode supervisor long-run check-in guidance | LRT-6 | implemented; projection check passed | `src/opencode/config.ts` tells the supervisor to use bounded waits, perform an initial check-in around 30 seconds, inspect latest errors before backing off, then back off toward 2 minutes, 5 minutes, and 10-15 minutes while progress continues; it compares activity between check-ins and avoids cancelling active workers solely due to elapsed time. |
| LRT-8 | Update orchestration skill guidance and projections | LRT-7 | implemented; projection check passed | `.agents/skills/orchestrate-create-plan/SKILL.md` and generated `.claude/skills/orchestrate-create-plan/SKILL.md` reflect adaptive check-in behavior and latest-error inspection; `node scripts/sync-ai-workspace.mjs --check` passed after regeneration. |
| LRT-9 | Update docs and MCP tool descriptions | LRT-1, LRT-6, LRT-7 | implemented; verification blocked by missing dependencies | README, MCP tooling docs, and `src/mcpTools.ts` document `idle_timeout_seconds`, explicit hard caps, latest error fields, backend fatal error behavior, the 30 second -> 2 minute -> 5 minute -> 10-15 minute recommended check-in cadence, and cancellation guidance using the renamed `agent-orchestrator` commands. |
| LRT-10 | Add focused tests | LRT-1, LRT-2, LRT-3, LRT-4, LRT-5, LRT-6, LRT-7, LRT-8, LRT-9 | implemented; execution blocked by missing dependencies | Tests cover schema defaults, MCP registration/schema, config migration, activity tracking, backend error classification, fatal error fast failure, idle watchdog reset, hard cap timeout, cancellation precedence, observability formatting, OpenCode prompt text, skill projection drift, and integration behavior with mock CLIs. |
| LRT-11 | Verify affected checks | LRT-10 | blocked by missing dependencies | `git diff --check` and `node scripts/sync-ai-workspace.mjs --check` passed. `pnpm build` failed because `node_modules` is absent and `tsc` is unavailable; no package install was performed because repository instructions require explicit user approval. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | Long-running worker support should use activity-aware idle supervision instead of long default hard caps. | Daemon lifecycle and MCP run supervision. | After LRT-4 if the pattern is stable. |
| 2 | Orchestration skills should use bounded waits and adaptive status/event checks for long-running worker runs. | Project-owned `orchestrate-*` skill guidance. | After LRT-7 if more orchestration skills are added. |

## Quality Gates

- [ ] `pnpm build` passes. Blocked locally: `tsc` is unavailable because `node_modules` is missing.
- [ ] Targeted tests for contract, run store, process manager, orchestrator integration, MCP tools, OpenCode harness, and observability formatting pass. Blocked until build dependencies are installed.
- [x] `node scripts/sync-ai-workspace.mjs --check` passes if `.agents/` guidance changes.
- [ ] `pnpm test` passes. Blocked until build dependencies are installed and `dist/` exists.
- [x] Relevant `.agents/rules/` checks are satisfied.
- [ ] `pnpm verify` passes before release-quality handoff or PR if requested. Blocked until dependencies are installed.

## Execution Log

### LRT-1: Define timeout and activity contract
- **Status:** implemented; dependency verification blocked
- **Evidence:** Added additive schemas and defaults in `src/contract.ts`; added create-run metadata fields in `src/runStore.ts`; added contract coverage in `src/__tests__/contract.test.ts`; `git diff --check` passed.
- **Notes:** `pnpm build` is blocked because `node_modules` is missing and `tsc` is unavailable.

### LRT-2: Add daemon config parsing and migration
- **Status:** implemented; dependency verification blocked
- **Evidence:** Updated `src/orchestratorService.ts` with idle timeout config defaults, optional hard execution timeout defaults, exact old generated config migration, and per-run idle timeout resolution; added integration coverage for generated config migration and customized hard-cap preservation.
- **Notes:** Build/test execution is blocked until dependencies are installed.

### LRT-3: Persist activity from process management
- **Status:** implemented; dependency verification blocked
- **Evidence:** Added `RunStore.recordActivity()`; `ProcessManager` records start, stdout, stderr, backend event, error, and terminal activity with throttled persisted writes; run-store/process-manager tests assert activity metadata.
- **Notes:** Build/test execution is blocked until dependencies are installed.

### LRT-4: Replace fixed execution timer with activity-aware watchdog
- **Status:** implemented; dependency verification blocked
- **Evidence:** Replaced fixed run timer in `src/orchestratorService.ts` with a watchdog that recalculates idle deadlines from `ManagedRun.lastActivityMs()` and honors optional hard execution deadlines; integration tests cover silent idle timeout, active idle reset, and hard timeout context.
- **Notes:** Build/test execution is blocked until dependencies are installed.

### LRT-5: Harden backend error detection and fail-fast surfacing
- **Status:** implemented; dependency verification blocked
- **Evidence:** Added backend error classification in `src/backend/common.ts`; structured Codex/Claude errors now include category/source/backend/retryable/fatal fields; stderr fatal errors update `latest_error`, append error events, and cancel the worker promptly; process-manager and backend-classification tests cover invalid model, auth, quota, rate limit, and unknown stderr behavior.
- **Notes:** Build/test execution is blocked until dependencies are installed.

### LRT-6: Expose activity, timeout, and latest error state through tools and observability
- **Status:** implemented; dependency verification blocked
- **Evidence:** Run metadata now carries last activity, timeout policy, timeout reason, terminal reason/context, and latest error; observability snapshot and daemon dashboard formatting show idle duration, timeout policy, and latest actionable error; tests cover observability and formatter output.
- **Notes:** Build/test execution is blocked until dependencies are installed.

### LRT-7: Update OpenCode supervisor long-run check-in guidance
- **Status:** implemented; projection check passed
- **Evidence:** `src/opencode/config.ts` now instructs the supervisor to use bounded waits, a short first check-in, latest-error inspection, adaptive backoff, and cancellation only for user request, idle evidence, fatal error, or recovery paths; OpenCode harness test asserts the prompt guidance.
- **Notes:** `node scripts/sync-ai-workspace.mjs --check` passed.

### LRT-8: Update orchestration skill guidance and projections
- **Status:** implemented; projection check passed
- **Evidence:** Updated `.agents/skills/orchestrate-create-plan/SKILL.md`; regenerated `.claude/skills/orchestrate-create-plan/SKILL.md`; `node scripts/sync-ai-workspace.mjs` and `node scripts/sync-ai-workspace.mjs --check` passed.
- **Notes:** No manual edits were made to generated projections.

### LRT-9: Update docs and MCP tool descriptions
- **Status:** implemented; dependency verification blocked
- **Evidence:** Updated `src/mcpTools.ts`, `README.md`, and `docs/development/mcp-tooling.md` with `idle_timeout_seconds`, optional hard caps, latest-error fields, fatal backend behavior, adaptive check-in cadence, and cancellation guidance.
- **Notes:** Build/test execution is blocked until dependencies are installed.

### LRT-10: Add focused tests
- **Status:** implemented; execution blocked by missing dependencies
- **Evidence:** Added or updated tests in `src/__tests__/backendErrorClassification.test.ts`, `codexBackend.test.ts`, `contract.test.ts`, `integration/orchestrator.test.ts`, `mcpTools.test.ts`, `observability.test.ts`, `observabilityFormat.test.ts`, `opencodeHarness.test.ts`, `processManager.test.ts`, and `runStore.test.ts`.
- **Notes:** Tests could not be executed because `pnpm build` cannot run without installed dependencies.

### LRT-11: Verify affected checks
- **Status:** blocked by missing dependencies
- **Evidence:** `git diff --check` passed. `node scripts/sync-ai-workspace.mjs` passed. `node scripts/sync-ai-workspace.mjs --check` passed. `pnpm build` failed with `sh: 1: tsc: not found` and pnpm warned that `node_modules` is missing.
- **Notes:** Per repository instructions, no package install was performed without explicit user approval.

## Completion Notes

- **Implemented:** activity-aware idle supervision, optional hard execution caps, config migration, activity persistence, latest-error metadata, fatal backend fail-fast handling, observability formatting, supervisor guidance, orchestration skill guidance, docs, and focused tests.
- **Post-review fixes:** skipped generic `worker result event missing` validation errors for deliberate terminal overrides, and awaited stream-side activity/error persistence before terminal finalization so stderr fatal-error events are visible immediately after completion.
- **Verified locally:** `git diff --check`; `node scripts/sync-ai-workspace.mjs`; `node scripts/sync-ai-workspace.mjs --check`.
- **Blocked locally:** `pnpm build`, targeted test execution, `pnpm test`, and `pnpm verify` require installing dependencies because this worktree has no `node_modules` and `tsc` is unavailable.
