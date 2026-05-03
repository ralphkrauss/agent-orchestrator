# Claude Code Support

Branch: `13-add-support-for-claude-code`
Plan Slug: `claude-code-support`
Parent Issue: #13
Created: 2026-05-03
Status: planning

## Context

Issue #13 ("Add support for claude code") asks for an orchestrator client with
Claude Code analogous to the existing OpenCode integration. The clarification
comment from the issue owner (2026-05-03) reframes the priority: the load-bearing
problem is that the supervisor/main thread today has to remain blocked polling
`wait_for_run` per active run. There is no way for several runs to be in flight
while the supervisor returns control to the user, and no notification path so
the main thread learns that a run reached terminal/error without polling.

This issue therefore covers two interleaved deliverables, sequenced **B then A**
within a single plan:

- **B. Monitor / notification core (daemon-owned, backend-agnostic).** Add
  durable per-run notification records, request/response APIs that subscribe
  across many runs at once, and a monitor CLI that blocks against the daemon
  until terminal so a Claude Code (or any) supervisor can launch it as a
  background process and be notified by the surrounding harness when the
  background process exits.
- **A. Claude Code supervisor harness.** A non-invasive launcher analogous to
  `src/opencode/` that wires the agent-orchestrator MCP server into the Claude
  Code CLI plus a supervisor agent prompt, without mutating the target
  workspace's `.claude/` or `.mcp.json`.

Already in place (verified by reading the code, not assumed):

- `src/backend/claude.ts` registers a Claude Code worker backend with
  stream-json parsing, model + reasoning effort flags, and `--resume`. Treat
  this as a worker-side dependency only — it does **not** satisfy issue #13.
- `src/orchestratorService.ts` already runs workers as long-lived background
  processes with durable run state, idle/execution timeouts, activity
  tracking, latest-error metadata, and bounded `wait_for_run` (1-300 s).
- `src/opencode/{capabilities,config,launcher,skills}.ts` shows the established
  harness pattern: generate a config in memory, pass it via env to the spawned
  CLI, never write into the target workspace.
- `LRT-7` already steers the OpenCode supervisor prompt toward bounded waits
  with adaptive cadence; that complements but does not replace the new
  notification path.

Sources read:

- `AGENTS.md`, `CLAUDE.md`
- `.agents/rules/node-typescript.md`, `.agents/rules/ai-workspace-projections.md`,
  `.agents/rules/mcp-tool-configs.md`
- GitHub issue #13 body and the 2026-05-03 clarification comment
- `package.json`
- `src/cli.ts`, `src/server.ts`, `src/contract.ts`, `src/mcpTools.ts`
- `src/orchestratorService.ts`, `src/processManager.ts`, `src/runStore.ts`
- `src/backend/{WorkerBackend,registry,claude,codex,common,resultDerivation}.ts`
- `src/opencode/{capabilities,config,launcher,skills}.ts`
- `src/opencodeCli.ts`, `src/workerRouting.ts`
- `plans/10-support-long-running-tasks/plans/10-long-running-task-support.md`
- `plans/11-add-robust-opencode-orchestration-harness-with-model-settings-and-orchestration-skills/plans/11-opencode-orchestration-harness.md`

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Scope for issue #13 | Cover both monitor/notification core (B) and Claude Code supervisor harness (A) in one plan. Sequence: B before A. Implementation may land across multiple PRs. | The clarification comment makes the notification path the load-bearing deliverable; the harness depends on it. Treating ClaudeBackend as completion of #13 is explicitly rejected. | Splitting into two issues; doing only A; doing only B; treating the existing worker backend as enough. |
| 2 | Notification model | Daemon-owned, backend-agnostic durable notification records keyed by `run_id` + `notification_id`. Each terminal/error/(later) milestone state transition produces one record. Records persist across daemon restart. | Polling-only is insufficient per the comment. MCP push notifications are not a guaranteed path on every client. A daemon-owned record store is portable, request/response compatible, replayable after disconnect, and supports many concurrent runs. | Relying on MCP `notifications/*` push as the only path; in-memory-only signalling that is lost across restart; per-backend bespoke notify hooks. |
| 3 | Subscribe API shape | Add `wait_for_any_run({ run_ids[], wait_seconds, after_notification_id? })` and `list_run_notifications({ run_ids?[], since_notification_id?, limit, include_acked? })` plus `ack_run_notification({ notification_id })`. All request/response-compatible. Existing `wait_for_run` and status APIs stay. | Many supervisors only need a single multi-run blocking call. The list/ack pair makes the daemon a durable queue across client restarts and lets the supervisor reconcile runs after returning control to the user. | Adding only `wait_for_any_run`; relying on streaming MCP subscriptions; reusing `wait_for_run` with a list parameter (breaks the schema and existing 300 s ceiling per run). |
| 4 | MCP push notifications | Optional, opportunistic. The daemon may emit `notifications/run/changed` over the MCP channel when a record is appended, but the supervisor is not required to consume them. Notification records remain authoritative. | The reviewer requires that the plan not rely solely on push. Push-as-hint plus durable records is robust whether the client surfaces push or not. | Making push the primary path; omitting push entirely; gating Claude Code support on MCP push behavior. |
| 5 | Monitor CLI | Add `agent-orchestrator monitor <run_id> [--json-line] [--since <notification_id>]` that blocks against the daemon until **either a `terminal` or a `fatal_error` notification** is appended for the run. Prints exactly one JSON line on stdout (`run_id`, `status`, `kind`, `terminal_reason`, `notification_id`, `latest_error`) and exits with the documented exit-code table (see CCS-5 acceptance criteria). | This is the cleanest way to leverage Claude Code's `Bash run_in_background: true` primitive: the supervisor launches one monitor per active run and the surrounding Claude Code harness signals the main thread when the bash exits. Waking on `fatal_error` as well as `terminal` matches the comment's "terminal or error state" requirement and lets the supervisor react to fatal backend failures without waiting for the worker process to terminate. | Server-only signalling (no CLI handle); using stderr instead of a clean json-line; mixing progress lines with the terminal record; waking only on `terminal` (would delay actionable error reporting). |
| 6 | OpenCode parity in this slice | Make the monitor/notification core backend-agnostic by construction. Update the OpenCode supervisor prompt to prefer `wait_for_any_run`. **Do not** spawn background-monitor processes from the OpenCode harness in this slice. | Reviewer says backend-agnostic core is required, but native OpenCode background-monitor parity is out of scope unless explicitly approved. The comment also flags OpenCode's notify story as unverified. | Building OpenCode background-monitor parity now; leaving OpenCode supervisor prompt untouched; making any of the new tools Claude-Code-only. |
| 7 | Claude Code harness footprint | Non-invasive runtime harness. New `src/claude/` package with `capabilities.ts`/`config.ts`/`launcher.ts`/`skills.ts` mirroring `src/opencode/`. Launcher writes generated config to a temp file under the daemon-owned state dir (or process env), spawns `claude` with `--mcp-config <temp>` and a project-scoped agent prompt, cleans up on exit. Do **not** write into the target workspace's `.claude/`, `.mcp.json`, or any user/global config. | Reviewer requires non-invasive harness with real launcher ergonomics. Mirroring the OpenCode pattern keeps the codebase coherent and avoids surprise mutations of user state. | Writing `.claude/agents/*` or `.mcp.json` into the target workspace; printing docs only with no launcher; mutating `~/.claude/`. |
| 8 | Claude Code supervisor surface | Generate a single supervisor system prompt + tool/permission configuration analogous to the OpenCode `agent-orchestrator` agent. Do not depend on Claude Code's experimental sub-agent / agent-team behavior. The prompt teaches the supervisor: start runs by profile via MCP, launch one `agent-orchestrator monitor <run_id>` per active run with `Bash run_in_background: true`, and use `wait_for_any_run` / `list_run_notifications` for reconciliation. | Robust on whatever Claude Code primitives are stable today. Sub-agents would be additive later. | Requiring sub-agents/agent-teams; relying on Claude Code's `Task` tool semantics being stable; baking model-specific Claude Code internals into the prompt. |
| 9 | Persistence layout | Single daemon-owned append-only journal `notifications.jsonl` under the run-store root acts as the authoritative source of order. Each entry carries a `notification_id` that **embeds a strictly increasing daemon-global sequence number** (see Decision 13). A per-run `notifications.jsonl` file may be written as a denormalized index/optimization, but the global journal is the source of truth used for cursor reads. Acknowledgement is recorded in a sidecar `acks.jsonl` (global) so the original notification is never mutated. | Append-only matches the existing run-store style and gives durability without schema migration risk. A single global journal removes any ambiguity about cross-run ordering. | Mutating notification records in place; storing notifications inside `meta.json`; adding a SQLite dependency; using only per-run files (forces order reconstruction at read time). |
| 10 | API compatibility | All new tools and contract fields are additive. Existing tool names, response envelopes, status enums, and bounded `wait_for_run` semantics are preserved. | Reviewer specifies request/response-compatible APIs. Breaking existing clients is rejected. | Renaming or repurposing `wait_for_run`; changing status enums; replacing the existing run schema. |
| 11 | Notification trigger surface | Emit notifications on terminal status transitions (`completed`, `failed`, `cancelled`, `timed_out`, `orphaned`) and on the first appended fatal `latest_error`. Reserve schema room for future progress milestones, but do not emit progress notifications in this slice. | Matches the comment's "terminal or error state" requirement and avoids notification spam. | Emitting on every event; emitting only on success; coupling to backend-specific events. |
| 12 | Wake semantics for consumers | `wait_for_any_run`, `list_run_notifications`, and the `monitor` CLI all wake on **both** `terminal` and `fatal_error` notification kinds by default. Filter parameters (`kinds?: ('terminal' \| 'fatal_error')[]`) are accepted additively for callers that want narrower wake conditions, but the default is the union. The `monitor` CLI's exit-code table distinguishes terminal-success / terminal-failure / fatal-error / timeout / cancelled / unknown / daemon-unavailable so a Claude Code `Bash run_in_background: true` consumer can branch on the exit code without parsing JSON. | Aligns with the comment: the supervisor must learn about a fatal backend error as soon as it surfaces, not only after the worker process has fully terminated. Default-union wake avoids a class of "supervisor stuck because it only listened for terminal" bugs. | Waking only on `terminal` by default; requiring an explicit kind filter to receive fatal errors; emitting fatal errors only over the optional MCP push hint. |
| 13 | Notification id and cursor scheme | `notification_id` is `${seq.toString().padStart(20, '0')}-${ulid()}`. The 20-digit zero-padded prefix is a **persisted daemon-global monotonic sequence** stored under the run-store root (e.g. `notifications.seq` written via fsync on increment, recovered on daemon start by scanning the global journal). The ULID suffix is for human-readable uniqueness and tie-breaking. Lexicographic comparison on `notification_id` is a total order matching insertion order. `since_notification_id` cursors compare lexicographically. | Reviewer required deterministic global ordering before implementation. A persisted daemon-global counter embedded in the id makes ordering total, cheap, restart-safe, and cursor reads O(1) on the global journal. The ULID suffix preserves human readability without weakening order. | Plain ULID (only loosely monotonic, requires daemon-global state to be inferred); per-run sequence (does not order across runs); SQLite autoincrement (new dependency); timestamp-only ids (collisions, clock skew). |
| 14 | MCP push payload | Push hint payload is `{ run_id, notification_id, kind, status }` only. No full record, no error context, no diff. | Locked by reviewer answer. Keeps push cheap, makes durable journal authoritative, avoids racing the disk write. | Embedding `latest_error`; embedding the full record; mixing terminal context into the hint. |
| 15 | `wait_for_any_run` ceiling | `wait_seconds` is bounded to 1-300, mirroring `wait_for_run`. | Locked by reviewer answer. Consistent client-side timeout policy. Lifting later remains additive. | Allowing unbounded waits; using a different per-tool ceiling. |
| 16 | Monitor CLI single-run v1 | Ship `agent-orchestrator monitor <run_id>` only. A `--any <run_id>...` mode is explicitly deferred. | Locked by reviewer answer. One background bash per run matches the Claude Code primitive cleanly. | Shipping multi-run mode in v1; replacing single-run with multi-run only. |
| 17 | Quality gates and dependencies | All quality gates run via repo scripts (`pnpm build`, `pnpm test`, `pnpm verify`, `node scripts/sync-ai-workspace.mjs --check`). Do not install packages or change dependency ranges without explicit user approval. | AGENTS.md rule: explicit user approval for installs. Prior plan (#10) ran into the same constraint. | Adding new dependencies opportunistically; skipping `sync-ai-workspace.mjs --check` when `.agents/` changes. |

## Scope

### In Scope

- New backend-agnostic notification record store inside the existing
  run-store directory: a durable, append-only daemon-global journal
  (`notifications.jsonl`) that is the authoritative source of cross-run
  ordering, plus an optional per-run index for cheap filtered reads, plus a
  global sidecar `acks.jsonl`. Ordering follows the `${seq:20}-${ulid}`
  scheme from Decision 13.
- New MCP tools and contract schemas: `wait_for_any_run`,
  `list_run_notifications`, `ack_run_notification`. All additive.
- Optional MCP push hint (`notifications/run/changed`) emitted alongside record
  append; the daemon does not require client subscription for correctness.
- New CLI subcommand `agent-orchestrator monitor <run_id>` with `--json-line`
  and `--since <notification_id>` options, exit-code semantics, and a single
  json-line stdout record for the wake notification (a `terminal` **or**
  `fatal_error` record, per Decision 12).
- New `src/claude/` package mirroring `src/opencode/`:
  `capabilities.ts`, `config.ts`, `launcher.ts`, `skills.ts`.
- New CLI entry `agent-orchestrator claude [...]` and
  `agent-orchestrator-claude` bin alias that mirrors the OpenCode launcher,
  spawns the `claude` CLI with a generated MCP config + supervisor prompt,
  cleans up temp files, and never writes into the target workspace.
- Supervisor prompt for the Claude Code harness that teaches starting runs by
  profile, launching one `agent-orchestrator monitor` background process per
  active run, reconciling via `wait_for_any_run` and `list_run_notifications`,
  and using bounded check-ins as a fallback.
- OpenCode supervisor prompt update to prefer `wait_for_any_run` for multi-run
  reconciliation while keeping today's adaptive bounded-poll guidance.
- Updates to `src/mcpTools.ts`, README, `docs/development/mcp-tooling.md`, and
  the orchestrate-* skill projections so consumers learn the new APIs and the
  Claude Code launcher.
- Focused tests for: notification store append/list/ack/durability across
  daemon restart, `wait_for_any_run` blocking and resume-from-cursor semantics,
  monitor CLI exit codes and json-line contract, Claude Code launcher arg
  parsing, generated supervisor prompt content, harness non-invasiveness,
  OpenCode prompt regression, and MCP schema/tool registration.

### Out Of Scope

- Native OpenCode background-monitor process parity (deferred unless
  explicitly approved by the user).
- Reattaching to in-flight worker processes after daemon restart.
- Streaming MCP subscriptions as the primary notification path.
- Mutating the target workspace's `.claude/`, `.mcp.json`, user-level
  `~/.claude/`, or any global config.
- New Claude Code sub-agents / agent-team / Task-tool integration.
- Live Claude Code or OpenCode model-call tests.
- Publishing, tagging, or release behavior changes.
- Cross-worktree locking or concurrent-edit prevention.
- Adding new runtime dependencies. Build-only dev dependencies are also
  out-of-scope without explicit approval.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | Daemon restarts mid-run; client reconnects and asks "what happened to my runs?" | Notifications are durable on disk and `list_run_notifications({ since_notification_id })` replays everything since the cursor. Existing `orphanRunningRuns` already produces a terminal record; this slice ensures it also appends a notification. | Notification persistence test + orphan-on-restart test. |
| 2 | Two supervisors share a daemon and both ack the same notification. | Acks are advisory: the record is never mutated, ack-marker is idempotent, and listing has `include_acked` to remain visible. | Notification ack test. |
| 3 | `wait_for_any_run` is invoked with a list mixing terminal and running runs. | Return immediately with the latest terminal notification(s) for already-terminal runs; otherwise block up to `wait_seconds`. | `wait_for_any_run` unit/integration tests. |
| 4 | Monitor CLI launched against an unknown or already-terminal run. | Exit immediately with terminal record on stdout for already-terminal; non-zero exit + structured stderr for unknown run. | Monitor CLI tests. |
| 5 | Monitor CLI orphaned by Claude Code (e.g., supervisor crash). | Process is stateless; no daemon resources are tied to it. The daemon's records are independent of monitor process lifetime. | Documented in monitor CLI design. |
| 6 | Notification-record file grows unbounded across long-lived sessions. | Reuse existing `prune_runs` to also prune notifications for terminal runs older than the configured horizon. | Pruning test. |
| 7 | MCP push notification arrives before client has subscribed. | Push is a hint only; the supervisor MUST reconcile via `list_run_notifications`. Documented in tool descriptions and prompts. | Documentation review + prompt tests. |
| 8 | Claude Code launcher accidentally mutates user state. | Unit test that runs the launcher against a tempdir target and asserts no writes outside the daemon-owned temp dir; assertion that `--print-config` does not touch disk. | Harness non-invasiveness test. |
| 9 | Generated supervisor prompt drifts from MCP tool capabilities. | Prompt is built from `WorkerCapabilityCatalog` and a tool-name allowlist; harness test asserts every tool referenced by the prompt is registered in `mcpTools.ts`. | Harness regression test. |
| 10 | OpenCode supervisor changes break the LRT-7 cadence guidance. | Update prompt additively and keep regression test for the existing 30 s / 2 min / 5 min / 10-15 min cadence. | OpenCode harness test. |
| 11 | Claude Code's stream-json schema or `--mcp-config` flag changes underfoot. | Capabilities probe via `claude --version` / config-print and degrade gracefully if the harness cannot launch; print actionable error and exit non-zero. | Launcher capability/error-path tests. |
| 12 | Notification id collisions across concurrent runs. | The `${seq}-${ulid}` scheme uses a persisted daemon-global monotonic counter; tests assert strictly increasing ids across concurrent appends. | Notification id test. |
| 13 | `monitor` CLI exit code conflated with `claude` Bash exit semantics. | Document exact exit-code table and assert it in tests; the json-line stdout is the source of truth, not the exit code alone. | Monitor CLI tests + docs. |
| 14 | Reviewer-flagged scope substitutions (treating ClaudeBackend as complete; bounded-poll-only; OpenCode-only; mutating .claude/). | Each is called out in Decisions/Out Of Scope above; PR reviewers should reject any of these substitutions. | This plan + PR review. |
| 15 | Supervisor only listens for `terminal` and misses a `fatal_error` that surfaces seconds before terminal. | Default wake semantics for `wait_for_any_run` and `monitor` CLI are the union of `terminal` and `fatal_error`. Tool docs and prompts emphasize the union default. | `wait_for_any_run` and monitor CLI tests asserting fatal-error wake. |
| 16 | Daemon crash mid-write to `notifications.seq` corrupts ordering. | Counter is recovered on start by scanning the global journal for the highest embedded sequence; `notifications.seq` is a hint persisted via fsync but never the only source. | Crash-recovery test: truncate `notifications.seq`, restart daemon, assert next id strictly exceeds the highest journal id. |
| 17 | Claude Code's stable surfaces (`--mcp-config`, generated supervisor prompt/config, permission/tool allowlist, `Bash run_in_background`) differ from the harness assumptions. | CCS-7a runs an explicit discovery/validation pass against the installed `claude` binary and produces a versioned compatibility report consumed by CCS-8/9. If the only stable path requires persistent `.claude/` or `.mcp.json` mutation, the harness work is paused and the user is asked for explicit approval before deviating from Decision 7. | CCS-7a discovery report + harness fail-fast behavior. |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| CCS-1 | Notification record contract and store | none | pending | `src/contract.ts` adds additive schemas: `RunNotificationKindSchema = z.enum(['terminal', 'fatal_error'])`, `RunNotification` (`notification_id`, `seq`, `run_id`, `kind`, `status`, `terminal_reason`, `latest_error`, `created_at`), input schemas for `wait_for_any_run` (`{ run_ids[], wait_seconds: 1..300, after_notification_id?, kinds?: RunNotificationKind[] }`), `list_run_notifications` (`{ run_ids?, since_notification_id?, kinds?, include_acked?, limit }`), `ack_run_notification`, and response schemas. `src/runStore.ts` gains append-only `appendNotification`, `listNotifications`, `markNotificationAcked` backed by a daemon-global `notifications.jsonl` journal plus an optional per-run index. `notification_id` follows the `${seq:20}-${ulid}` scheme from Decision 13; the persisted `notifications.seq` counter is recovered from the global journal on start. Records and counter survive daemon restart, including a corrupt/missing `notifications.seq` recovery path. |
| CCS-2 | Daemon emission on terminal/error transitions | CCS-1 | pending | `OrchestratorService` and `ProcessManager` append exactly one `terminal` notification per terminal transition (`completed`, `failed`, `cancelled`, `timed_out`, `orphaned`) and exactly one `fatal_error` notification when a fatal `latest_error` is first surfaced (deduplicated per run). Pre-spawn failures and orphan-on-restart emit one `terminal` notification (and a `fatal_error` first if a fatal error was captured). No duplicates on idempotent terminal writes. Emission order is observable via the global sequence. |
| CCS-3 | MCP tools `wait_for_any_run`, `list_run_notifications`, `ack_run_notification` | CCS-1, CCS-2 | pending | New tools registered in `src/mcpTools.ts` and routed in `OrchestratorService.dispatch`. **Default wake semantics**: `wait_for_any_run` returns when any of the supplied `run_ids` has a `terminal` **or** `fatal_error` notification newer than `after_notification_id` (or any if cursor omitted), otherwise blocks up to `wait_seconds` (1-300). `kinds` filter is additive and defaults to `['terminal', 'fatal_error']`. Already-terminal runs short-circuit. `list_run_notifications` supports `since_notification_id` (lexicographic cursor on the global ordering), `run_ids` filter, `kinds` filter, `include_acked`, and pagination by `limit`. `ack_run_notification` is idempotent. Schemas validated end-to-end. |
| CCS-4 | Optional MCP push hint | CCS-3 | pending | When a notification is appended, the MCP server emits a `notifications/run/changed` push (or equivalent SDK hook) with the locked minimal payload `{ run_id, notification_id, kind, status }`. Supervisor behavior remains correct without subscription. Push is documented as advisory; durable journal is authoritative. |
| CCS-5 | `agent-orchestrator monitor` CLI | CCS-1, CCS-3 | pending | New CLI subcommand wired in `src/cli.ts`. Blocks via repeated `wait_for_any_run` / `list_run_notifications` against the local daemon, **waking on both `terminal` and `fatal_error` by default**. Emits exactly one JSON line on stdout for the wake record (`{ run_id, notification_id, kind, status, terminal_reason, latest_error }`). Exit-code table documented and asserted: `0` for `terminal`+`completed`, `1` for `terminal`+`failed`/`orphaned`, `2` for `terminal`+`cancelled`, `3` for `terminal`+`timed_out`, `10` for `fatal_error` (run may still be running but supervisor must react), `4` for unknown run, `5` for daemon unavailable, `6` for argument error. `--json-line` and `--since <notification_id>` supported. Single-run only in v1 (Decision 16). |
| CCS-6 | OpenCode supervisor prompt update | CCS-3 | pending | `src/opencode/config.ts` prompt teaches `wait_for_any_run` (default-wake on terminal+fatal_error) and `list_run_notifications` for multi-run reconciliation while preserving LRT-7 adaptive cadence guidance as a fallback. Existing OpenCode harness regression tests pass; new assertions cover the new guidance. **Do not** add background-monitor process spawning to the OpenCode harness. |
| CCS-7a | Claude Code surface discovery and validation | CCS-1 | pending | New script + module (`src/claude/discovery.ts` and `scripts/probe-claude.mjs` or equivalent test) probe the installed `claude` binary and produce a structured compatibility report covering: (a) `--mcp-config <file>` accepted; (b) project-scoped MCP wiring without `.mcp.json` mutation; (c) supervisor system-prompt / config injection mechanism (CLI flag, env var, or file); (d) permission / tool allowlist behavior (`--allowed-tools`, `--dangerously-skip-permissions`, or settings); (e) `Bash` tool with `run_in_background: true` is reliably surfaced. Report includes detected `claude --version`, presence/absence of each surface, and the recommended harness path. **Acceptance**: a fixture-backed test asserts the report shape and a documented compatibility matrix. **Escalation rule**: if the only stable path requires persistent `.claude/` or `.mcp.json` mutation, CCS-8/9 are paused and the user is asked for explicit approval before continuing. |
| CCS-7 | Claude Code capability catalog | CCS-7a | pending | `src/claude/capabilities.ts` exposes a Claude-Code-supervisor-side catalog (analogous to `src/opencode/capabilities.ts`) that re-uses backend status and worker profile validation; no duplication of OpenCode logic — extract a shared core if needed. Consumes the discovery report from CCS-7a to gate availability. |
| CCS-8 | Claude Code supervisor config builder | CCS-7 | pending | `src/claude/config.ts` builds an in-memory MCP config + supervisor system prompt + permission/tool allowlist for Claude Code, using only the surfaces validated by CCS-7a. Prompt teaches: profile-mode `start_run`, launching `agent-orchestrator monitor <run_id>` via `Bash run_in_background: true`, **reacting on both `terminal` and `fatal_error` wake semantics**, reconciling via `wait_for_any_run` and `list_run_notifications`, bounded-wait fallback when monitors are unavailable. No experimental sub-agent / agent-team dependency. |
| CCS-9 | Claude Code launcher | CCS-8 | pending | `src/claude/launcher.ts` parses args (mirrors OpenCode launcher options), resolves the `claude` binary, generates config to a temp path under the daemon state dir, spawns `claude` with the discovery-validated MCP-config flag (or env-passed equivalent), cleans up temp files on exit. Asserts no writes outside the daemon-owned temp dir. Fails fast with an actionable error if the binary's surfaces no longer match the recorded discovery report. |
| CCS-10 | CLI/bin wiring | CCS-9, CCS-5 | pending | `src/cli.ts` adds `claude` and `monitor` subcommands. `src/claudeCli.ts` mirrors `src/opencodeCli.ts`. `package.json` adds `agent-orchestrator-claude` to `bin`. Help text updated. Backward compatibility preserved: existing `agent-orchestrator`, `-daemon`, `-opencode` bins behave identically. |
| CCS-11 | Pruning extension | CCS-1, CCS-2 | pending | `prune_runs` extended (additively) to prune notifications for runs that are pruned, with a dry-run report. Dry-run still reports counts without mutation. |
| CCS-12 | Docs and skill projections | CCS-3, CCS-5, CCS-9 | pending | README, `docs/development/mcp-tooling.md`, and `src/mcpTools.ts` document the new tools, the monitor CLI exit-code contract, and the Claude Code launcher. `.agents/skills/orchestrate-*/SKILL.md` updated where relevant. `node scripts/sync-ai-workspace.mjs --check` passes. |
| CCS-13 | Focused tests | CCS-1..CCS-12 | pending | Test coverage for: notification schema/defaults including `kind` enum, run-store append/list/ack/persistence-across-restart, **daemon-global ordering invariants under concurrent appends**, **`notifications.seq` recovery from a missing or corrupt counter**, daemon emission idempotency for both `terminal` and `fatal_error`, `wait_for_any_run` blocking + already-terminal short-circuit + **fatal-error wake** + cursor resume + `kinds` filter, push-hint payload exactly equals `{run_id, notification_id, kind, status}`, monitor CLI exit codes (including the new `10` fatal-error code) + json-line + fatal-error wake before terminal, harness non-invasiveness (no writes outside daemon temp dir; `.claude/`, `.mcp.json`, `~/.claude/` untouched), CCS-7a discovery report shape, generated Claude prompt assertions, OpenCode prompt regression for LRT-7 + new `wait_for_any_run` guidance, MCP tool registration, pruning of notifications. |
| CCS-14 | Verify quality gates | CCS-13 | pending | `pnpm build`, `pnpm test`, `node scripts/sync-ai-workspace.mjs --check`, `pnpm verify` all pass before review/PR. If `node_modules` is missing, request explicit user approval before running `pnpm install --frozen-lockfile`. Record concrete evidence in the Execution Log. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | Supervisors should treat MCP push notifications as advisory and reconcile via durable notification records. | Daemon/MCP contract guidance for orchestrator clients. | After CCS-4 lands and is observed to be stable. |
| 2 | Supervisor harnesses must not write into the target workspace `.claude/`, `.mcp.json`, or user-level config; they must use ephemeral configs under the daemon state dir. | Supervisor harness packages (`src/claude/`, `src/opencode/`). | After CCS-9 lands. |
| 3 | New backend-agnostic orchestration features must add daemon-owned support before per-backend specialization. | Cross-cutting daemon/MCP guidance. | After CCS-3 lands. |

## Quality Gates

- [ ] `pnpm build` passes (TypeScript strict; no relaxation of `tsconfig.json`).
- [ ] `pnpm test` passes (Node native test runner; targeted tests for all CCS-13 items).
- [ ] `node scripts/sync-ai-workspace.mjs --check` passes whenever `.agents/`
  guidance changes.
- [ ] `pnpm verify` passes before PR (release-quality gate).
- [ ] No new runtime or dev dependencies added without explicit user approval.
- [ ] Harness non-invasiveness test asserts no writes outside the daemon-owned
  temp dir during a `claude` launch.
- [ ] All MCP tool descriptions in `src/mcpTools.ts` match the contract
  schemas in `src/contract.ts`.
- [ ] Relevant `.agents/rules/` checks are satisfied (`node-typescript`,
  `mcp-tool-configs`, `ai-workspace-projections`).

## Execution Log

### CCS-1: Notification record contract and store
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### CCS-2: Daemon emission on terminal/error transitions
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### CCS-3: MCP tools `wait_for_any_run`, `list_run_notifications`, `ack_run_notification`
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### CCS-4: Optional MCP push hint
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### CCS-5: `agent-orchestrator monitor` CLI
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### CCS-6: OpenCode supervisor prompt update
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### CCS-7a: Claude Code surface discovery and validation
- **Status:** pending
- **Evidence:** pending
- **Notes:** Must complete with a passing compatibility report before CCS-7/8/9 begin. Escalate to user if persistent `.claude/` or `.mcp.json` mutation is the only stable path.

### CCS-7: Claude Code capability catalog
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### CCS-8: Claude Code supervisor config builder
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### CCS-9: Claude Code launcher
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### CCS-10: CLI/bin wiring
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### CCS-11: Pruning extension
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### CCS-12: Docs and skill projections
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### CCS-13: Focused tests
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### CCS-14: Verify quality gates
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

## Open Questions

Closed by reviewer feedback (recorded as locked Decisions above):

- **Wake semantics** — locked: `wait_for_any_run` and `monitor` CLI default to the
  union of `terminal` + `fatal_error` (Decision 12, CCS-3, CCS-5).
- **Global cursor / id scheme** — locked: persisted daemon-global monotonic
  sequence embedded in the id as `${seq:20}-${ulid}`; daemon-global
  `notifications.jsonl` is the authoritative ordering source; per-run files
  are an optional index (Decisions 9 and 13, CCS-1).
- **Claude Code surface validation** — locked as a real implementation task
  before harness wiring (CCS-7a). Escalation rule documented for the
  persistent-config fallback.
- **Push-hint payload** — locked at `{ run_id, notification_id, kind, status }`
  (Decision 14, CCS-4).
- **`wait_for_any_run` ceiling** — locked at 300 s (Decision 15, CCS-3).
- **Monitor CLI multi-run** — deferred; v1 is single-run only
  (Decision 16, CCS-5).

Remaining open items (none currently blocking implementation):

- None. If implementation surfaces a question that materially affects the
  contract or harness footprint, it must be raised before changing this plan;
  the plan author or implementer should not silently broaden scope or
  substitute a different surface.
