# Worker Backend-Native Parity (Trusted Worker Posture)

Branch: `58-issue-with-setting-sources`
Plan Slug: `58-worker-project-mcp-access`
Parent Issue: #58
Created: 2026-05-12
Updated: 2026-05-12 (rev. 4 applies PR #60 review follow-ups per `plans/58-issue-with-setting-sources/resolution-map.md`; rev. 3 after `reviews/review-plan-rev2-2026-05-12.md`; rev. 2 after `reviews/review-plan-2026-05-12.md`)
Status: complete

## Context

Issue #58 reports that workers cannot reach project MCP servers (the trigger
was `coderabbit` in `.mcp.json`). After review (`review-plan-2026-05-12.md`,
including its Product Direction Addendum and Documentation Verification
Addendum), the product framing is:

> The orchestrator/supervisor is the restricted agent. Worker agents are
> trusted execution agents and should have the same practical access the user
> would get when launching the same backend manually in the project: normal
> network posture, normal project/user configuration, and normal MCP access.

This plan therefore is no longer scoped to "Claude MCP exception." It is
scoped to "restore backend-native worker parity across all three backends,
keeping the supervisor envelope curated, while expressing isolation as an
explicit profile opt-in."

A new worker-posture vocabulary makes the contract explicit:

- **`trusted` (new default)** — workers get backend-native parity with a
  manual run from the project worktree: normal project/user config, project
  MCP servers, normal network posture for that backend, normal CLAUDE.md /
  subagents / plugins discovery where applicable. Non-interactive
  approval/permission knobs are still pinned so the worker does not stall
  waiting for a human.
- **`restricted` (profile opt-in)** — the current closed-by-default
  isolation posture survives intact for callers who want it: `--setting-sources
  user`, `--ignore-user-config`, no project MCP, etc. Selected per profile,
  never by default for this plan's behavioral change.
- **Supervisor** — always restricted. The supervisor envelope
  (`src/claude/launcher.ts::buildClaudeSpawnArgs`) keeps its curated
  `--strict-mcp-config --mcp-config`, `--setting-sources user`, `--tools`
  allowlist, and `dontAsk` deny-by-default. Out of scope for #58.

Worker safety contracts that must continue to hold under `trusted`:

- `disableAllHooks: true` in the per-run settings file (issue #40, T5/T13;
  user confirmation: keep pinned). Hooks are typically interactive surfaces
  (notifications, prompts) and have no place in a non-interactive worker.
- `permissions.defaultMode: "bypassPermissions"` in the per-run settings file
  plus `--permission-mode bypassPermissions` on the spawn argv (issue #47;
  required for non-interactive workers).
- `--dangerously-skip-permissions` remains banned everywhere (#13 Decisions
  7/21).
- For Claude project MCP servers: workers cannot answer the project-MCP
  approval prompt, so the per-run settings file pins
  `enableAllProjectMcpServers: true`. (Profile-level opt-out lands later if
  ever needed — Decision 12.)

### Sources read

- Issue #58 body.
- `plans/58-issue-with-setting-sources/reviews/review-plan-2026-05-12.md`
  (full review including both addenda).
- `src/backend/claude.ts:50-84` — `CLAUDE_WORKER_SETTINGS_BODY`,
  `prepareWorkerIsolation`, `start`, `resume`.
- `src/backend/codex.ts:1-160` — codex argv shape; `sandboxArgs(codex_network)`.
- `src/backend/cursor/sdk.ts:126-143` — `CursorAgentCreateOptions` /
  `CursorAgentResumeOptions` shim; today it forwards only
  `apiKey | model | local.cwd | agentId | name`.
- `src/backend/cursor/runtime.ts:60-80` — runtime entry point and
  pre-spawn failures.
- `src/backend/runtime.ts:70-120` — `CliRuntime.buildStartInvocation()`
  pre-bake path; calls `backend.start()` for a retry-invocation that may
  never actually spawn (`src/orchestratorService.ts:973-1009`).
- `src/claude/launcher.ts:540-597` — supervisor envelope (out of scope; only
  referenced for parity reasoning).
- `src/claude/discovery.ts:11-64` — `--setting-sources` is a required
  detected surface; the value passed is not validated by discovery.
- `src/__tests__/claudeWorkerIsolation.test.ts:14-100` — existing T5/T13/#47
  worker isolation assertions.
- `plans/47-claude-workers-lose-bypass-permissions-under-generated-settings/plans/47-claude-worker-bypass-permissions.md`
  — Decisions 1/2/5 on the worker envelope.
- `plans/40-make-tmux-status-and-remote-control-reliable-for-claude-orchestrator-supervisors/plans/40-orchestrator-status-hooks.md`
  — Decisions 9/9b/26/T5/T13 on hook isolation.
- `docs/development/mcp-tooling.md` — per-client MCP file map.
- `docs/development/codex-backend.md` — `codex_network` semantics; `isolated`
  default for this backend (issue #31).
- `docs/development/cursor-backend.md` — Cursor SDK local-runtime contract.
- Local Cursor SDK 1.0.12 type defs
  (`node_modules/@cursor/sdk/dist/esm/options.d.ts`):
  `LocalAgentOptions.settingSources?: SettingSource[]` with values
  `"project" | "user" | "team" | "mdm" | "plugins" | "all"`;
  `AgentOptions.mcpServers?: Record<string, McpServerConfig>`.
- Local `codex exec --help` (codex-cli 0.130.0): `-c key=value`, `-p/--profile`,
  `-s/--sandbox <read-only|workspace-write|danger-full-access>`,
  `--add-dir`, `--skip-git-repo-check`, `--ignore-user-config`,
  `--ignore-rules`, `--dangerously-bypass-approvals-and-sandbox`. No
  `--config-file` or `--config-dir`.
- Local `claude --help` (Claude Code 2.1.139) and
  `cursor-agent --help` (2026.05.01-eea359f).
- `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml` repo fixtures.
- `AGENTS.md`, `CLAUDE.md`, `.agents/rules/node-typescript.md`,
  `.agents/rules/mcp-tool-configs.md`.

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Worker posture vocabulary | Add a `worker_posture: 'trusted' \| 'restricted'` field to `WorkerProfile` (and to the direct-mode `start_run` schema), defaulting to `'trusted'`. Each backend translates the posture to its own surface (Decisions 5/6/7). The supervisor stays restricted always. | Names the product contract the reviewer asked for ("trusted" / "manual-parity" vs "restricted"), and maps it consistently across three CLIs/SDKs that don't share one identical network switch. Operators no longer interpret "same access as a manual run" inconsistently per backend. | A single boolean `isolated` (rejected: ambiguous across backends, less self-documenting). Per-backend booleans (rejected: would proliferate over time as new backends land; one posture concept reused is cleaner). |
| 2 | Default posture | `'trusted'` for new and existing profiles that don't set `worker_posture`. Backward-compat default for legacy run records: `'trusted'`. | The user's #58 reads as "workers should have full access" and the review's Product Direction Addendum confirms it. Defaulting to `'trusted'` aligns the product with the issue. | Defaulting to `'restricted'` (rejected: contradicts the explicit product direction). Refusing to load profiles without `worker_posture` (rejected: breaks existing profile manifests; the new field must be optional). |
| 3 | Supervisor posture | Unchanged; supervisor envelope (`buildClaudeSpawnArgs`) is hard-coded restricted and never reads `worker_posture`. | Issue #58 says workers; review addendum says supervisor stays curated. Supervisor's `--strict-mcp-config --mcp-config <orchestrator-owned>`, `--tools` allowlist, and `dontAsk` deny-by-default are load-bearing for the tmux smoke contract and skill discovery. | Mapping `worker_posture` to supervisor too (rejected: widens blast radius, breaks supervisor invariants the harness relies on). |
| 4 | Blast radius accepted for Claude `'trusted'` | We are explicitly opting Claude workers back into normal project/user/local Claude Code scope behavior — settings, subagents, plugins, MCP servers, and CLAUDE.md — not only MCP. | Documented behavior of Claude Code's `--setting-sources`: scopes apply to all listed surfaces. The reviewer's High finding asked this be an explicit decision rather than an incidental side effect. Workers are full-access, trusted-local processes, so loading project subagents/plugins/memory in a worker is correct and matches what a manual run sees. | "MCP-only via `--mcp-config <cwd>/.mcp.json`" (rejected: contradicts the trusted-worker product direction; would still leave subagents/plugins missing under trusted posture). Conditional broadening keyed on `.mcp.json` (rejected: same behavior split across MCP-having vs MCP-not-having projects, which the reviewer flagged as inconsistent). |
| 5 | Claude `'trusted'` mapping | `--settings <per-run> --setting-sources user,project,local --permission-mode bypassPermissions`. Per-run settings body: `disableAllHooks: true`, `permissions.defaultMode: "bypassPermissions"`, `skipDangerousModePermissionPrompt: true`, **`enableAllProjectMcpServers: true`** (new), no `enabledMcpjsonServers` / `disabledMcpjsonServers` allowlists. | `user,project,local` mirrors Claude Code's documented precedence. CLI `--permission-mode` overrides settings-file values so project `permissionMode: "ask"` cannot stall the worker. `--settings <path>` overrides setting-sources merged keys so project hooks cannot run under workers. `enableAllProjectMcpServers: true` is required to avoid the project-MCP approval prompt that a non-interactive worker cannot answer (Claude docs on project-scoped MCP; user-confirmed). | Carrying through the user's saved per-project MCP approval state (rejected: requires reading and translating user state, differs per developer machine, less deterministic). Profile-level allowlist (rejected: postponed to Decision 12; no current caller; would add schema surface unused on day one). |
| 6 | Codex `'trusted'` mapping | `--cd <cwd>` (start only — codex `exec resume` does not accept `--cd`; unchanged from today) + **drop** `--ignore-user-config` + `-c sandbox_mode="workspace-write"` + `-c sandbox_workspace_write.network_access=true`. Project `.codex/config.toml` continues to be discovered by codex automatically (trusted-project loader); we no longer suppress user config. Both `-c` overrides are accepted by **both** `codex exec` and `codex exec resume` per local 0.130.0 help (review rev. 2 F1). | Matches what a developer launching `codex exec` in the project would get for MCP, model, profile, and auth: codex layers user config under project config under CLI overrides. Network is enabled because trusted workers run real work (e.g. PR comments, `gh` calls); a developer running codex manually with `workspace-write` would expect the same with the standard `network_access = true` override. Codex MCP servers live in `mcp_servers.*` tables under the discovered config files, so removing `--ignore-user-config` plus letting project discovery happen is the whole config-side fix. Using `-c sandbox_mode="workspace-write"` instead of `--sandbox workspace-write` keeps `sandboxArgs()` shared between `start()` and `resume()`; `--sandbox` is start-only in codex-cli 0.130.0 and would break follow-ups. | `--sandbox workspace-write` (rejected: not accepted by `codex exec resume`; would force splitting start/resume argv builders, contradicting `src/backend/codex.ts:8-33` shared `sandboxArgs()`). Defaulting to no sandbox override at all (rejected: per-machine and non-deterministic across operators; loses the determinism gains of the issue #31 plan). Switching to `danger-full-access` (rejected: that's the equivalent of `--dangerously-skip-permissions`; banned in spirit). |
| 7 | Cursor `'trusted'` mapping (revised after review rev. 2 F4) | Extend `CursorAgentCreateOptions` / `CursorAgentResumeOptions` shim (`src/backend/cursor/sdk.ts`) to include `local.settingSources` and `local.sandboxOptions`. For `'trusted'` runs, pass `local.settingSources: ['all']` so workers get full Cursor parity — `project`, `user`, `team`, `mdm`, and `plugins` settings layers — matching what a manual Cursor run on the same machine would load. Sandbox is left at SDK default unless a profile sets it. No `mcpServers` is forwarded by default (per SDK docs they don't persist across `Agent.resume()`; `settingSources` is the file-backed parity path). | Cursor SDK 1.0.12 (`node_modules/@cursor/sdk/dist/esm/options.d.ts`) defines `SettingSource = "project" \| "user" \| "team" \| "mdm" \| "plugins" \| "all"`. Manual Cursor runs honor `team` (organizational settings), `mdm` (managed-device settings), and `plugins`. Passing only `['project','user']` would silently exclude those layers and break the "manual parity" contract for orgs that use Cursor team/MDM features. `['all']` is the single SDK-documented value that means "everything ambient." | `['project','user']` (rejected: review rev. 2 F4 — drops team/MDM/plugins; not full parity). Switching to a `cursor-agent` CLI runtime (rejected: would add a second worker runtime alongside the SDK one; the SDK already exposes the needed surface). Passing inline `mcpServers` instead of `settingSources` (rejected: SDK doc warning about resume; would silently drift between start and resume). Enumerating `['project','user','team','mdm','plugins']` (rejected: brittle if Cursor SDK adds new sources later; `'all'` is the documented forward-compatible primitive). |
| 8 | `'restricted'` mapping (opt-in) | Preserves today's behavior verbatim per backend. Claude: `--setting-sources user`, no `enableAllProjectMcpServers`. Codex: `--ignore-user-config`, current `codex_network` flags. Cursor: SDK adapter passes no `settingSources` (current behavior). | Lets callers who need closed-by-default keep it via a single profile field. No behavior change for opt-in callers. | A separate "restricted" code path per backend with new code (rejected: re-uses the existing implementations, just under a profile flag). |
| 9 | Codex `codex_network` interaction (revised after review rev. 2 F3) | Decouple **config source** from **network posture** under `'trusted'`. `worker_posture` controls whether `--ignore-user-config` is emitted; `codex_network` controls only the sandbox/network argv. Concretely: under `'trusted'`, `--ignore-user-config` is **never** emitted regardless of `codex_network`. The sandbox argv is then `codex_network`-driven: absent → `-c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true` (Decision 6); explicit `'workspace'` → `-c sandbox_workspace_write.network_access=true` (no `--ignore-user-config`); explicit `'isolated'` → no `-c` overrides (codex defaults). Under `'restricted'`, today's argv shapes are preserved verbatim for backward compatibility: absent or `'isolated'` → `--ignore-user-config`; `'workspace'` → `--ignore-user-config -c sandbox_workspace_write.network_access=true`; `'user-config'` → no flags. Documented as a migration risk in `docs/development/codex-backend.md`: profiles that explicitly set `codex_network: 'workspace'` will now see user/project codex config under the new default trusted posture and must opt into `worker_posture: 'restricted'` if they relied on the old `--ignore-user-config` side effect. | Closes the review rev. 2 F3 hole: existing `'workspace'` profiles would otherwise still emit `--ignore-user-config` and silently miss the user MCP/config the trusted contract promises. Decoupling makes the contract single-axis: `worker_posture` = whose config loads; `codex_network` = sandbox/network shape. | Keeping `codex_network: 'workspace'` argv unchanged under trusted (rejected: hides user MCP from any caller that historically chose `'workspace'` for network, contradicting the trusted product direction). Mapping `codex_network` to imply a posture (rejected: re-couples the two axes and breaks #31's stable contract). |
| 10 | Lifecycle telemetry placement — CLI backends (review Medium 3) | Add `WorkerInvocation.initialEvents?: ParsedBackendEvent[]` (or equivalent array of lifecycle event payloads). Claude and Codex backends populate this from `start()` / `resume()`. `ProcessManager.start()` (the single spawn site for CLI backends) flushes them into the run event stream **only when the spawn actually fires**. `CliRuntime.buildStartInvocation()` discards `initialEvents` on the pre-bake retry path. Cursor uses a different mechanism — see Decision 18. | Closes the review rev. 1 Medium 3 false-telemetry hole: `buildStartInvocation` calls `backend.start()` purely to pre-bake a retry invocation that may never run; emitting from inside `prepareWorkerIsolation` would record state for a never-spawned attempt. Spawn-time flush keeps the event ordering correct relative to `ProcessManager`'s `status: started` marker. | Dropping the telemetry (rejected: operators need to confirm at run time which posture and settings-sources a worker actually used; otherwise debug regresses). Emitting from the orchestrator service before spawn (rejected: spreads the spawn ordering invariant across two callers). Reusing this mechanism for Cursor (rejected: Cursor doesn't produce a `WorkerInvocation` and doesn't go through `ProcessManager.start()` — review rev. 2 F5). |
| 11 | Diagnostics payload | One spawn-time event per worker: `{ type: 'lifecycle', payload: { state: 'worker_posture', backend, worker_posture, claude?: { setting_sources, enable_all_project_mcp_servers }, codex?: { ignore_user_config, sandbox, network_access }, cursor?: { setting_sources } } }`. Single event per spawn, per backend's own subset of fields. | Lets `get_run_events` answer "what did this worker actually see?" deterministically. Reuses the existing `lifecycle` event type so no contract/schema change is needed (per `.agents/rules/node-typescript.md` MCP contract rule). | Three distinct event types (rejected: schema bloat; `lifecycle.payload.state` already differentiates). Logging at `console.warn` level (rejected: invisible to non-interactive callers). |
| 12 | Profile-level MCP allowlist for Claude | Out of scope for this plan. If a future caller needs per-server granularity (`enabledMcpjsonServers` / `disabledMcpjsonServers`), file a follow-up issue. | `enableAllProjectMcpServers: true` is the documented blanket primitive and matches the "trusted worker" contract. Per-server allowlisting has no current caller in this repo. | Adding the allowlist now (rejected: schema surface for no caller, premature abstraction; #47 Decision 4 set the same precedent). |
| 13 | Codex audit acceptance phrasing (review Low) | Phrase Codex audit acceptance as "capture the codex config-loading surface, including whether any config-file/config-dir flag exists" — without expecting those flags. Local 0.130.0 confirmed they do not. | Matches the reviewer's Low; avoids future drift if codex CLI adds them later. | Hard-coding "no `--config-file`/`--config-dir`" (rejected: drift trap). |
| 14 | #58 closure rule (review Medium 4) | This plan may land in stages, but **#58 closes only when all three backends ship the trusted posture and the verify gate passes**. If a backend has to be split into a follow-up issue, #58 stays open with a comment linking the follow-up. | Issue #58 explicitly says "all backends, not just claude." Avoids appearing to close the issue with a Claude-only fix that the reviewer flagged. | Closing #58 on Claude-only fix with codex/cursor opened as follow-ups (rejected: the issue's text is explicit). |
| 15 | Final verify placement (review Medium 4 continued) | Move the single `pnpm verify` task to the **end** of the task list, after all backend implementations, audits if any, doc updates, and rule candidates. No intermediate `pnpm verify`. | A mid-plan verify is not a final gate. Keeping one verify at the end makes the gate authoritative. | Running `pnpm verify` after each backend (rejected: slower, doesn't materially de-risk versus the end-of-plan gate). |
| 16 | Trust boundary docs (review High 2 and Medium "approval") | Add an explicit "Trust boundary" subsection to `docs/development/mcp-tooling.md`: enabling project MCP on Claude workers (and project codex MCP on codex workers) means trusting `.mcp.json` / `.codex/config.toml` command entries as executable local config that runs in the worker environment. Secret-bearing entries must keep using `scripts/mcp-secret-bridge.mjs`. | The reviewer's High 2 finding is correct: stdio MCP servers spawn at MCP init outside the model tool path. Workers were already trusted-local but readers should be told this explicitly. | Implicit ("workers were always trusted") (rejected: explicit documentation prevents future surprise). |
| 17 | `worker_posture` persistence and follow-up inheritance (review rev. 2 F2) | Persist resolved `worker_posture` on `RunModelSettingsSchema` (sibling field to `codex_network`), backend-agnostic, default `null` for legacy records. Resolution rules: (a) `start_run` profile mode: posture comes from profile; profile + a direct `worker_posture` field is rejected with `INVALID_INPUT` (mirroring the existing `codex_network` direct-mode-only rule at `src/orchestratorService.ts:756-758`). (b) `start_run` direct mode: posture comes from the direct input, defaulting to `'trusted'` when absent. (c) `send_followup`: inherits `parent.meta.model_settings.worker_posture`. A `worker_posture` override on `send_followup` is rejected when the chain originated from profile mode (mirrors the `chainOriginatedFromProfileMode` check at `src/orchestratorService.ts:755-758`) and accepted in direct-mode chains. (d) Legacy parents with `worker_posture === null` are normalized to `'trusted'` on the child record at the same point `codex_network` is normalized for legacy parents (`src/orchestratorService.ts:813-821`). The child record's persisted posture must reflect the *effective* posture used at spawn, not the input shape, so `run_summary.model_settings.worker_posture` is always one of `'trusted' \| 'restricted'`. | Closes review rev. 2 F2's "underspecified persistence and inheritance" hole. Storing on `RunModelSettingsSchema` reuses the existing inheritance path (`src/orchestratorService.ts:794-808`) so `send_followup` already routes the value through the right merge function with one targeted addition. The profile/direct-mode rejection rule mirrors an already-shipped invariant (`codex_network` direct-mode-only) so operators do not need to learn a new mental model. Normalizing legacy `null` to `'trusted'` at child-write time, not read time, matches the issue #31 B2 pattern for `codex_network: null` → `'isolated'`. | Persisting posture on a separate sibling field outside `RunModelSettings` (rejected: doubles the inheritance plumbing; misses the existing legacy-normalization pattern). Defining `profile + worker_posture` precedence so the direct field wins (rejected: would diverge from the established `codex_network` precedent and let profile-mode runs silently drift from their manifest). Treating absence on `send_followup` as "reset to default" instead of "inherit from parent" (rejected: a `restricted` parent could silently spawn a `trusted` child on a follow-up that didn't intend to change posture). |
| 18 | Cursor lifecycle telemetry path (review rev. 2 F5) | Cursor does not produce a `WorkerInvocation` and does not flow through `ProcessManager.start()` (`src/backend/cursor/runtime.ts:60-208`); the runtime appends events directly via `store.appendEvent()` (`src/backend/cursor/runtime.ts:288,351`). For Cursor, the `worker_posture` lifecycle event is appended by `CursorSdkRuntime.spawn()` **after** `Agent.create` / `Agent.resume` succeeds and **before** the first SDK message is appended to the run, using the same `store.appendEvent(runId, { type: 'lifecycle', payload: ... })` channel as today's cursor lifecycle events. The append is wrapped in the existing pre-spawn-failure guard (`src/backend/cursor/runtime.ts:60-80`) so a failed `Agent.create` does not emit a `worker_posture` event for a worker that never started. | Closes review rev. 2 F5: the CLI-backend `initialEvents` mechanism cannot cover Cursor because the SDK runtime has no `WorkerInvocation`. Using `store.appendEvent()` directly matches the existing Cursor event-append pattern at `runtime.ts:288,351` and gates on actual SDK spawn success so we get the same "no false telemetry on never-spawned runs" property the CLI design has. | Forcing Cursor through a synthetic `WorkerInvocation` and `ProcessManager.start()` (rejected: would re-architect the in-process SDK runtime for a single telemetry event). Emitting before `Agent.create` resolves (rejected: SDK construction can fail with `WORKER_BINARY_MISSING`/`SPAWN_FAILED`; telemetry must follow the same "only on actual spawn" rule as CLI backends). |

## Open Human Decisions

None — the four product questions raised by this review were answered:
keep `disableAllHooks: true` pinned; drop `--ignore-user-config` + enable
workspace network for codex; extend cursor SDK shim with `settingSources`;
Claude project-MCP approval via `enableAllProjectMcpServers: true`.

## Reviewer Questions

To be revisited after implementation review. Review mappings:

- **Rev. 1 review** (`reviews/review-plan-2026-05-12.md`):
  Decision 4 (High 1 + High 6), Decision 16 (High 2 + Medium "approval"),
  Decision 10 (Medium 3), Decisions 14+15 (Medium 4), Decision 13 (Low),
  Decision 6 (High 7 — but see rev. 2 F1 revision), Decision 7 (High 8 — but
  see rev. 2 F4 revision), Decision 11 (Medium "network access posture
  vocabulary").
- **Rev. 2 review** (`reviews/review-plan-rev2-2026-05-12.md`):
  Decisions 6 + 9 + Risk 14 + T-Codex-1 (High F1 — codex resume argv
  compatibility), Decision 17 + Risks 16/19 + T-Persist-1 + T-Persist-2
  (High F2 — posture persistence and follow-up inheritance), Decision 9 +
  Risk 15 + T-Docs (Medium F3 — explicit `codex_network: "workspace"` was
  still suppressing user config), Decision 7 + Risk 17 + T-Cursor-1
  (Medium F4 — Cursor `['all']` for full parity), Decision 18 + Risk 18 +
  T-Cursor-2 (Medium F5 — Cursor lifecycle telemetry path), T-Profile-1
  scope expansion (Low F6 — `upsert_worker_profile`, `list_worker_profiles`,
  MCP tool descriptions, profile rendering).

## Scope

### In Scope

- `WorkerProfile` and the full profile management surface (review rev. 2 F6):
  add optional `worker_posture: 'trusted' | 'restricted'` field; default
  `'trusted'`; valid for all backends; preserve backward compat for manifests
  that omit it. Wire through `WorkerProfile`, `UpsertWorkerProfileInputSchema`
  (`src/contract.ts:439-485`), `workerProfileFromUpsert()` and
  `formatValidProfile()` (`src/orchestratorService.ts:2079-2115`), the MCP
  tool descriptions in `src/mcpTools.ts:65-82`, and `start_run` /
  `send_followup` direct-mode schemas. `upsert_worker_profile` and
  `list_worker_profiles` round-trip the field.
- `RunModelSettingsSchema` (`src/contract.ts:260-265`): add `worker_posture`
  sibling to `codex_network`; legacy `null` tolerated on read, normalized to
  a concrete posture on child-record write (review rev. 2 F2; Decision 17).
- `sendFollowup` (`src/orchestratorService.ts:740-822`) inherits parent's
  posture; rejects `worker_posture` overrides on profile-mode chains,
  accepts them on direct-mode chains (Decision 17).
- `src/backend/claude.ts::prepareWorkerIsolation` + `CLAUDE_WORKER_SETTINGS_BODY`:
  branch on `worker_posture`. Under `'trusted'`: emit `--setting-sources
  user,project,local` and add `enableAllProjectMcpServers: true` to the
  per-run settings body. Under `'restricted'`: today's `--setting-sources user`
  and current body. Both postures retain `disableAllHooks: true`, the bypass
  permission keys, and the CLI `--permission-mode bypassPermissions` flag.
- `src/backend/codex.ts::sandboxArgs` (`src/backend/codex.ts:144-160`) and
  the orchestrator-side default for `codex_network`: decouple config-source
  from sandbox/network per Decision 9. Under `'trusted'`, never emit
  `--ignore-user-config` regardless of `codex_network`; emit
  `-c sandbox_mode="workspace-write"` and
  `-c sandbox_workspace_write.network_access=true` when `codex_network` is
  absent. Under `'restricted'`, preserve today's argv shapes verbatim. All
  emitted argv must be accepted by **both** `codex exec` and `codex exec
  resume` (review rev. 2 F1) — never `--sandbox` or `--cd` in shared
  helpers. Explicit `codex_network` values keep their meaning within their
  posture (Decision 9).
- `src/backend/cursor/sdk.ts`: extend `CursorAgentCreateOptions` and
  `CursorAgentResumeOptions` to include `local.settingSources?: SettingSource[]`
  and `local.sandboxOptions?: { enabled: boolean }` matching the SDK 1.0.12
  shape. `src/backend/cursor/runtime.ts`: for `'trusted'` workers, pass
  `local.settingSources: ['all']` on `Agent.create` and `Agent.resume`
  (review rev. 2 F4 — full Cursor parity, not just project+user).
- `WorkerInvocation`: add optional `initialEvents` array (CLI backends only —
  Claude and Codex). `ProcessManager.start()` flushes them at spawn into the
  existing event stream; `CliRuntime.buildStartInvocation()` discards them
  (pre-bake path). Cursor uses a separate path (Decision 18).
- Claude's and Codex's `start()` / `resume()` populates `initialEvents` with
  one spawn-time `{ type: 'lifecycle', payload: { state: 'worker_posture', ... } }`
  per Decision 11.
- Cursor emits the same lifecycle event via `store.appendEvent()` directly
  from `CursorSdkRuntime.spawn()` after `Agent.create`/`Agent.resume` succeeds
  (Decision 18; review rev. 2 F5). No `initialEvents` field on the cursor
  runtime path.
- Tests (one focused set per backend; see Acceptance Criteria below). Adds
  fixtures for hostile project `.claude/settings.json` (hooks enabled,
  `permissionMode: "ask"`) and a sample `.mcp.json`.
- Documentation:
  - `src/backend/claude.ts`'s `CLAUDE_WORKER_SETTINGS_BODY` doc comment
    documents `enableAllProjectMcpServers: true` and the `trusted`/`restricted`
    branching.
  - `docs/development/mcp-tooling.md` gains two new subsections:
    "Workers and project MCP servers" (per-backend table) and "Trust boundary"
    (Decision 16).
  - `docs/development/codex-backend.md` updates `codex_network` defaults
    table to reflect Decision 9.
  - `docs/development/cursor-backend.md` documents the new SDK
    `settingSources` wiring.
- Rules under `.agents/rules/`: rule candidates listed below.

### Out Of Scope

- Supervisor envelope changes (`src/claude/launcher.ts`,
  `src/claude/permission.ts`) — Decision 3.
- Per-server Claude MCP allowlists (`enabledMcpjsonServers` /
  `disabledMcpjsonServers`) — Decision 12.
- Cursor `mcpServers` inline forwarding — Decision 7 (resume-safety reason).
- `cursor-agent` CLI worker runtime — Decision 7 (SDK already exposes the
  needed surface).
- `--strict-mcp-config` adoption on workers — supervisor-only by design.
- Changing the `--dangerously-skip-permissions` ban (#13 Decisions 7/21).
- New MCP tool surface, MCP contract changes, or schema additions beyond the
  `worker_posture` profile field and the `initialEvents` invocation field.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | Project `.claude/settings.json` defines hooks; broadened sources cause them to load and fire under a worker. | `disableAllHooks: true` in `--settings <per-run>` takes precedence over setting-sources merge. New regression test asserts hooks stay off with a hostile project fixture loaded. | T-Claude-3 |
| 2 | Project `.claude/settings.json` defines `permissionMode: "ask"` or `"plan"`; worker stalls awaiting an interactive prompt. | CLI `--permission-mode bypassPermissions` overrides settings-file values per documented Claude Code precedence. Regression test asserts the CLI flag is emitted and the resulting worker init reports `permissionMode: "bypassPermissions"`. | T-Claude-3 |
| 3 | Project `.mcp.json` requires approval that workers cannot answer. | `enableAllProjectMcpServers: true` in the per-run settings file. Test asserts it is on disk. | T-Claude-1 / T-Claude-3 |
| 4 | Project `.mcp.json` stdio entry executes a local command at MCP init outside the model tool path; secret-bearing entries leak credentials. | `docs/development/mcp-tooling.md` "Trust boundary" subsection states secret-bearing entries must keep using `scripts/mcp-secret-bridge.mjs`. The bridge is unchanged; no new secret-handling code. | T-Docs |
| 5 | Codex worker accidentally inherits a user `~/.codex/config.toml` that disables network or sets a different sandbox; trusted worker now stricter than intended. | Decision 6 explicitly sets `--sandbox workspace-write` and `-c sandbox_workspace_write.network_access=true` on the spawn argv. CLI overrides win in codex precedence, so user config can't quietly downshift the worker. | T-Codex-1 |
| 6 | Codex worker inherits user MCP servers that conflict with project MCP servers (same name, different command). | Codex's documented precedence is "CLI overrides > profile > project trusted > user > system > default." Project config wins over user config; documented behavior. Tested in T-Codex-2. | T-Codex-2 |
| 7 | Cursor `Agent.resume` after a `'trusted'` start drops the `settingSources` (SDK docs warn about inline state not persisting). | We pass `settingSources` on **both** `Agent.create` and `Agent.resume` so file-backed ambient settings reload. Test asserts both paths receive `settingSources: ['project', 'user']`. | T-Cursor-2 |
| 8 | A legacy run record without `worker_posture` is replayed (e.g. resumed across upgrade). | Default resolution applies `'trusted'`. Test exercises a meta record with no `worker_posture` field. | T-Profile-2 |
| 9 | Operator misreads the new defaults and assumes workers are still isolated. | Documented in `docs/development/mcp-tooling.md`, `codex-backend.md`, and `cursor-backend.md`. `worker_posture` event is emitted at spawn (Decision 11) so `get_run_events` shows the chosen posture per run. | T-Telemetry, T-Docs |
| 10 | `WorkerInvocation.initialEvents` populated on a `buildStartInvocation()` pre-bake retry that never spawns, recording false telemetry. | `ProcessManager.start()` is the single flusher; `CliRuntime.buildStartInvocation()` strips `initialEvents` from the returned invocation. Test asserts the pre-bake path emits zero spawn-time events. | T-Telemetry |
| 11 | `--setting-sources user,project,local` rejected by an older Claude CLI in the wild. | Plan pins to the discovered surface; `discoverClaudeSurface` reports `setting_sources_flag` presence already. `local` has been documented since the flag was introduced. If a future Claude version drops `local`, document the regression and adjust. Not gated. | T-Docs |
| 12 | `WorkerProfile` consumers that read the manifest as strict-shaped types break on the new optional field. | Field is optional; schema parsing must accept manifests without `worker_posture`. Test loads an existing-shape manifest and asserts it resolves to `'trusted'`. | T-Profile-1 |
| 13 | The plan ships Claude-only and #58 closes prematurely. | Decision 14: #58 closure requires all three backends to ship `'trusted'`. Plan tasks T-Codex-* and T-Cursor-* are in scope, not deferred to follow-ups. | Decision 14 |
| 14 | Codex resume invocation rejects argv produced by the shared `sandboxArgs()` helper (review rev. 2 F1). | Decision 6 forbids `--sandbox` and `--cd` in `sandboxArgs()` output and uses `-c` overrides that both `codex exec` and `codex exec resume` accept on codex-cli 0.130.0. T-Codex-1 asserts resume argv shape across the full posture × codex_network matrix. | T-Codex-1, Decision 6 |
| 15 | Existing `codex_network: 'workspace'` profile silently misses user MCP under trusted (review rev. 2 F3). | Decision 9 redefines: under trusted, `--ignore-user-config` is never emitted regardless of `codex_network`. Documented as a migration risk in `docs/development/codex-backend.md` so operators who relied on the old `--ignore-user-config` side effect know to set `worker_posture: 'restricted'`. | T-Codex-1, T-Docs |
| 16 | `worker_posture` not persisted; a restricted parent silently spawns a trusted child on follow-up (review rev. 2 F2). | Decision 17 + T-Persist-1 + T-Persist-2: posture lands on `RunModelSettingsSchema`, inherits like `codex_network`, and rejects `profile + worker_posture` mode-mixing on both `start_run` and `send_followup`. | T-Persist-1, T-Persist-2 |
| 17 | Cursor trusted workers miss team/MDM/plugins settings layers (review rev. 2 F4). | Decision 7 + T-Cursor-1 pass `local.settingSources: ['all']`, the SDK-documented forward-compatible primitive that includes every ambient source. | T-Cursor-1 |
| 18 | Cursor `worker_posture` telemetry never reaches `get_run_events` because `WorkerInvocation.initialEvents` is CLI-only (review rev. 2 F5). | Decision 18 + T-Cursor-2: Cursor emits the lifecycle event via `store.appendEvent()` directly from `CursorSdkRuntime.spawn()` after SDK spawn succeeds. Pre-spawn failures emit zero events. | T-Cursor-2 |
| 19 | Direct-mode follow-up override of `worker_posture` allowed on a chain that originated from profile mode, drifting silently from the profile's manifest. | Decision 17(c): `sendFollowup` rejects a `worker_posture` override with `INVALID_INPUT` when `chainOriginatedFromProfileMode(parent.meta)` is true, mirroring the existing `codex_network` rule at `src/orchestratorService.ts:756-758`. | T-Persist-2 |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T-Profile-1 | Add optional `worker_posture` field across all profile and direct-mode surfaces (review rev. 2 F6) | — | pending | New field is optional, accepts `'trusted' \| 'restricted'`, defaults to `'trusted'` when absent, accepted by every profile/direct-mode surface: `WorkerProfile` schema; `UpsertWorkerProfileInputSchema` (`src/contract.ts:439-485`); `workerProfileFromUpsert()` (`src/orchestratorService.ts:2079`); `formatValidProfile()` (`src/orchestratorService.ts:2094`) so `list_worker_profiles` exposes the field; `StartRunInputSchema` and `SendFollowupInputSchema` direct-mode shapes; MCP tool descriptions in `src/mcpTools.ts:65-82` and any supervisor profile-rendering text. Validation rejects other strings with a clear error. Round-trip test: `upsert_worker_profile` writes a manifest with `worker_posture`, `list_worker_profiles` returns it verbatim, `start_run` profile mode picks it up. Existing test profiles without the field continue to load. |
| T-Profile-2 | Backward-compat default resolution | T-Profile-1 | pending | A run record / meta entry without `worker_posture` resolves to `'trusted'` everywhere it's read. Unit test covers a legacy meta record (no field) and a fresh meta record. Also covers a legacy `RunModelSettings` with `worker_posture: null` flowing through `sendFollowup` inheritance. |
| T-Persist-1 | Persist resolved `worker_posture` on `RunModelSettingsSchema` (review rev. 2 F2) | T-Profile-1 | pending | `RunModelSettingsSchema` (`src/contract.ts:260-265`) gains `worker_posture: WorkerPostureSchema.nullable().optional().default(null)`. `defaultRunModelSettings` defaults to `null`. `modelSettingsForBackend()` and `validateInheritedModelSettingsForBackend()` propagate the value. `start_run` writes the *effective* resolved posture (never `null`) into `meta.model_settings.worker_posture` at the same place `codex_network` is normalized for codex (`src/orchestratorService.ts:813-821`). Legacy meta records with `null` are tolerated for read paths but child records always persist a non-null value. |
| T-Persist-2 | `send_followup` inherits posture; mode-mixing rejected (review rev. 2 F2) | T-Persist-1 | pending | `sendFollowup` (`src/orchestratorService.ts:740-822`): (a) inherits `parent.meta.model_settings.worker_posture` when the follow-up does not pass `worker_posture`; (b) when the follow-up passes `worker_posture` and `chainOriginatedFromProfileMode(parent.meta)` is true, returns `INVALID_INPUT` with a message mirroring the existing `codex_network` rejection at `src/orchestratorService.ts:756-758`; (c) when chain is direct-mode, the follow-up override is accepted and persisted on the child. `start_run` rejects `profile + worker_posture` in the same way `start_run` rejects `profile + codex_network` today (`src/contract.ts:361-390` schema-level `superRefine`). Tests cover: profile start, direct start, profile-mode follow-up (with and without override attempt), direct follow-up override, legacy parent (null posture). |
| T-Inv-1 | Add `WorkerInvocation.initialEvents?: ParsedBackendEvent[]` (or equivalent) | — | pending | Field is optional; existing call sites unchanged when absent. `WorkerInvocation` types updated, no other public-contract changes. |
| T-Inv-2 | `ProcessManager.start()` flushes `initialEvents` at spawn time | T-Inv-1 | pending | Events appear in `get_run_events` ordered before the next event written by the spawned process. `CliRuntime.buildStartInvocation()` strips `initialEvents` from the returned retry invocation. Unit test asserts: (a) normal `start()` emits events; (b) `buildStartInvocation()` path returns an invocation with `initialEvents` unset; (c) resume path emits events. |
| T-Claude-1 | Implement Claude `trusted` mapping in `prepareWorkerIsolation` + body | T-Profile-1, T-Profile-2, T-Inv-1 | pending | Under `'trusted'`: argv includes `--setting-sources user,project,local`, `--permission-mode bypassPermissions`, `--settings <per-run-path>`. Per-run settings body deep-equals `{ disableAllHooks: true, permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true, enableAllProjectMcpServers: true }`. Under `'restricted'`: argv and body match today's behavior exactly. Both `start()` and `resume()` paths exercise the new branching. |
| T-Claude-2 | Populate `initialEvents` with the Claude `worker_posture` lifecycle event | T-Claude-1, T-Inv-2 | pending | The event payload carries `state: 'worker_posture'`, `backend: 'claude'`, `worker_posture`, `claude.setting_sources`, `claude.enable_all_project_mcp_servers`. Test asserts the event flows through `ProcessManager.start()` only on the actual-spawn path. |
| T-Claude-3 | Safety-contract regression test with hostile project fixture | T-Claude-1 | pending | Fixture: `cwd/.mcp.json` (minimal valid) and `cwd/.claude/settings.json` with `disableAllHooks: false`, `permissions.defaultMode: "ask"`, and a synthetic `hooks.PreToolUse` block. Trusted worker still emits `--permission-mode bypassPermissions` and writes the per-run settings with the four required keys (incl. `enableAllProjectMcpServers: true`). Test asserts the on-disk per-run file body and the spawn argv. |
| T-Codex-1 | Implement Codex `trusted` mapping in `sandboxArgs` + default resolver (review rev. 2 F1, F3) | T-Profile-1, T-Profile-2, T-Persist-1, T-Inv-1 | pending | `sandboxArgs()` (`src/backend/codex.ts:144-160`) gains a `worker_posture` parameter and decouples config-source from sandbox/network per Decision 9. Argv contracts that must hold under **both** `start()` and `resume()` (shared helper): **trusted + absent** → `-c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true`, no `--ignore-user-config`. **trusted + 'workspace'** → `-c sandbox_workspace_write.network_access=true`, no `--ignore-user-config`. **trusted + 'isolated'** → no flags, no `--ignore-user-config`. **trusted + 'user-config'** → no flags, no `--ignore-user-config`. **restricted + absent or 'isolated'** → `--ignore-user-config` (today's behavior). **restricted + 'workspace'** → `--ignore-user-config -c sandbox_workspace_write.network_access=true` (today's behavior). **restricted + 'user-config'** → no flags (today's behavior). Critical resume-safety guard: argv emitted under any combination above MUST be accepted by `codex exec resume` (no `--sandbox`, no `--cd`). Test asserts argv shape on both `start()` and `resume()` invocations for every cell of the (`worker_posture` × `codex_network`) matrix. |
| T-Codex-2 | Populate `initialEvents` with the Codex `worker_posture` lifecycle event | T-Codex-1, T-Inv-2 | pending | Event payload carries `state: 'worker_posture'`, `backend: 'codex'`, `worker_posture`, `codex.ignore_user_config`, `codex.sandbox`, `codex.network_access`. Test asserts on the actual-spawn path. |
| T-Cursor-1 | Extend Cursor SDK shim with `local.settingSources` and `local.sandboxOptions` (review rev. 2 F4) | T-Profile-1, T-Profile-2, T-Persist-1 | pending | `CursorAgentCreateOptions` and `CursorAgentResumeOptions` in `src/backend/cursor/sdk.ts:126-143` accept `local.settingSources?: SettingSource[]` (`"project" \| "user" \| "team" \| "mdm" \| "plugins" \| "all"`) and `local.sandboxOptions?: { enabled: boolean }`. `CursorSdkRuntime.spawn()` forwards them to `Agent.create` / `Agent.resume`. **Trusted runs pass `local.settingSources: ['all']`** (full Cursor parity — project, user, team, MDM, plugins). Restricted runs omit the field (today's behavior). Both create and resume paths exercised; both received the same `settingSources` argument so resume parity holds. |
| T-Cursor-2 | Cursor-specific `worker_posture` lifecycle event via `store.appendEvent` (review rev. 2 F5) | T-Cursor-1 | pending | `CursorSdkRuntime.spawn()` calls `store.appendEvent(runId, { type: 'lifecycle', payload: { state: 'worker_posture', backend: 'cursor', worker_posture, cursor: { setting_sources } } })` **after** `Agent.create` / `Agent.resume` resolves successfully and **before** the first SDK stream message is appended (Decision 18). Pre-spawn failures (`WORKER_BINARY_MISSING`, `SPAWN_FAILED`) emit no `worker_posture` event. Test asserts: (a) successful create path emits one `worker_posture` event ordered before any backend stream event; (b) successful resume path emits one event; (c) pre-spawn failure path emits zero `worker_posture` events. Asserted via the run event log returned by `get_run_events`, not just by inspecting adapter call args. |
| T-Telemetry | Spawn-time telemetry plumbing tested in isolation | T-Inv-2 | pending | Unit test: a backend whose `start()` returns `initialEvents` flushes them through `ProcessManager.start()` once per actual spawn, never on `buildStartInvocation()` pre-bake. Covers the review Medium 3 hole. |
| T-Codex-Audit | Capture codex config-loading surface (review Low) | T-Codex-1 | pending | Plan execution log records the codex 0.130.0 `--help` surface, names the absence of `--config-file`/`--config-dir`, and confirms project `.codex/config.toml` is loaded by codex's own discovery when `--ignore-user-config` is removed. Phrased per Decision 13 (not gated on flags that don't exist). |
| T-Docs | Update docs | T-Claude-1, T-Codex-1, T-Cursor-1 | pending | `docs/development/mcp-tooling.md`: new "Workers and project MCP servers" subsection with per-backend table and the "Trust boundary" subsection (Decision 16). `docs/development/codex-backend.md`: updated `codex_network` defaults table reflecting Decision 9. `docs/development/cursor-backend.md`: `settingSources` wiring documented. `src/backend/claude.ts`'s `CLAUDE_WORKER_SETTINGS_BODY` doc comment documents `enableAllProjectMcpServers` and the `'trusted'`/`'restricted'` branching. |
| T-Rules | Capture rule candidates under `.agents/rules/` | T-Claude-1, T-Codex-1, T-Cursor-1, T-Docs | pending | Up to two new rule files under `.agents/rules/` per the Rule Candidates table below. Linked from the workspace projection regenerator (`scripts/sync-ai-workspace.mjs`); regeneration committed alongside if outputs differ. |
| T-Verify | Single `pnpm verify` end-to-end gate | all above | pending | `pnpm verify` exits zero on the final state of the branch. Evidence (subcommand summaries) captured in the plan execution log. This is the final task per Decision 15. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | "Workers default to backend-native parity (`worker_posture: 'trusted'`). The supervisor envelope is hard-restricted and must not read `worker_posture`. Isolation is profile-opt-in via `worker_posture: 'restricted'`." | `.agents/rules/worker-posture.md` | After T-Cursor-1 lands so all three backends honor the field. |
| 2 | "Worker safety contracts (`disableAllHooks: true`, `bypassPermissions`, no `--dangerously-skip-permissions`) hold under both postures; project settings cannot override them via setting-sources merging." | `.agents/rules/worker-safety.md` | After T-Claude-3 lands the regression coverage. |

## Quality Gates

- [ ] `pnpm build` passes on the branch (subsumed by T-Verify).
- [ ] `pnpm test` passes on the branch (subsumed by T-Verify).
- [ ] `pnpm verify` passes on the branch as the final gate (T-Verify).
- [ ] `.agents/rules/node-typescript.md` followed (no new deps; existing
      package scripts; TypeScript strictness preserved).
- [ ] `.agents/rules/mcp-tool-configs.md` followed (no real credentials in
      repo files; MCP contract: no schema additions beyond the optional
      `worker_posture` field and the optional `initialEvents` invocation
      field).
- [ ] `scripts/sync-ai-workspace.mjs` ran clean (if rule files changed, the
      `.claude/rules/` projection is regenerated and committed in the same
      change).
- [ ] Plan execution log contains evidence quotes for each acceptance
      criterion.
- [ ] #58 closure rule observed: all three backends ship `'trusted'`
      mappings, **or** #58 stays open with comments linking the
      backend-specific follow-up issues. No premature close.

## Execution Log

### T-Profile-1: Add optional `worker_posture` to profile + direct-mode schemas
- **Status:** complete
- **Evidence:** `src/contract.ts` (`WorkerPostureSchema`, plus `worker_posture` added to `RunModelSettingsSchema`, `StartRunInputSchema` + superRefine rejection, `SendFollowupInputSchema`, `UpsertWorkerProfileInputSchema`); `src/harness/capabilities.ts` (added to `WorkerProfileSchema`); `src/orchestratorService.ts` (`parseProfileModelSettings`, `workerProfileFromUpsert`, `formatValidProfile`); `src/mcpTools.ts` (descriptions on `start_run`, `upsert_worker_profile`, `send_followup`). Round-trip covered by integration tests at `src/__tests__/integration/orchestrator.test.ts`.
- **Notes:** Strict-shape `WorkerProfileSchema` accepted the optional addition without breaking existing manifests.

### T-Profile-2: Backward-compat default resolution
- **Status:** complete
- **Evidence:** `src/orchestratorService.ts::modelSettingsForBackend` resolves absent posture to `'trusted'`; `sendFollowup` normalizes legacy null on child write at the `persistedSettings` site (sibling of issue #31 B2 normalization for codex_network). `src/__tests__/claudeWorkerIsolation.test.ts` "legacy model_settings with worker_posture: null defaults to trusted" passes.
- **Notes:** Legacy `RunModelSettings.worker_posture === null` flows through `validateInheritedModelSettingsForBackend` untouched; the new normalization in `sendFollowup` is the single write-time boundary.

### T-Persist-1: Persist resolved `worker_posture` on `RunModelSettingsSchema`
- **Status:** complete
- **Evidence:** `src/contract.ts:260-275` adds `worker_posture: WorkerPostureSchema.nullable().optional().default(null)` and updates `defaultRunModelSettings`. `src/runStore.ts:174-180` fallback literal updated. Integration test assertion at `src/__tests__/integration/orchestrator.test.ts:265-272` confirms `run_summary.model_settings.worker_posture` flows through.
- **Notes:** Public schema additive; legacy meta records load as `worker_posture: null` and are normalized to a concrete value on the next child write.

### T-Persist-2: `send_followup` inherits posture; mode-mixing rejected
- **Status:** complete
- **Evidence:** `src/orchestratorService.ts::sendFollowup` adds the inheritance branch (`inheritedWorkerPosture` from parent meta) and the new `INVALID_INPUT` rejection at the same point that rejects `codex_network` overrides on profile-mode chains. `StartRunInputSchema.superRefine` now lists `worker_posture` alongside `codex_network` in the profile-mode mixing rejection. Integration tests confirm both branches (`orchestrator.test.ts` "passes model selections to workers..." + "issue #31 (T9 / OD2=B): start_run profile + codex_network is rejected as INVALID_INPUT" updated regex).
- **Notes:** Mirrors the existing `codex_network` mode-mixing pattern exactly.

### T-Inv-1: Add `WorkerInvocation.initialEvents` field
- **Status:** complete
- **Evidence:** `src/backend/WorkerBackend.ts:23-72` — optional `initialEvents?: Omit<WorkerEvent, 'seq' | 'ts'>[]`.
- **Notes:** Field is optional; existing call sites unchanged when absent.

### T-Inv-2: `ProcessManager.start()` flushes `initialEvents` at spawn
- **Status:** complete
- **Evidence:** `src/processManager.ts:240-249` flushes initialEvents through `appendEventBuffered` before the `status: started` marker. `src/backend/runtime.ts:111-118` strips `initialEvents` on the pre-bake retry path. Test at `src/__tests__/processManager.test.ts` "flushes WorkerInvocation.initialEvents before the status:started lifecycle marker on actual spawn" passes.
- **Notes:** Buffered-append path means D-COR retry interceptor still discards the events on a `retry_with_start` outcome (matches existing buffer behavior).

### T-Claude-1: Implement Claude `trusted` mapping
- **Status:** complete
- **Evidence:** `src/backend/claude.ts:50-128` — new `CLAUDE_TRUSTED_WORKER_SETTINGS_BODY` constant, `prepareWorkerIsolation` branches on `worker_posture`, both `start()` and `resume()` exercise the new code. Tests in `src/__tests__/claudeWorkerIsolation.test.ts` under "trusted posture" and "restricted posture" describe blocks pass.
- **Notes:** Trusted posture emits `--setting-sources user,project,local`; restricted preserves `--setting-sources user`. Per-run settings body for trusted adds `enableAllProjectMcpServers: true`.

### T-Claude-2: Claude `worker_posture` lifecycle event
- **Status:** complete
- **Evidence:** `src/backend/claude.ts::prepareWorkerIsolation` returns `initialEvents` carrying `{ state: 'worker_posture', backend: 'claude', worker_posture, claude: { setting_sources, enable_all_project_mcp_servers } }`. Test "Claude worker isolation — telemetry" describe block covers both postures.
- **Notes:** Legacy/no-runId path returns `initialEvents: []`; the test asserts the field stays undefined on the legacy invocation.

### T-Claude-3: Hostile project fixture regression
- **Status:** complete
- **Evidence:** `src/__tests__/claudeWorkerIsolation.test.ts` "Claude worker isolation — hostile project fixture (issue #58 T-Claude-3)" creates `cwd/.mcp.json` and `cwd/.claude/settings.json` with hooks/permissionMode=ask; asserts trusted worker still pins `disableAllHooks: true`, `bypassPermissions`, and `enableAllProjectMcpServers: true` on disk and emits CLI `--permission-mode bypassPermissions`.
- **Notes:** No live Claude binary required; wire-contract assertion holds under documented Claude Code precedence.

### T-Codex-1: Implement Codex `trusted` mapping
- **Status:** complete
- **Evidence:** `src/backend/codex.ts::sandboxArgs` rewritten to decouple `worker_posture` from `codex_network` per Decision 9. Trusted never emits `--ignore-user-config`. Uses `-c sandbox_mode="workspace-write"` and `-c sandbox_workspace_write.network_access=true` (resume-safe). Test "trusted posture: codex_network drives sandbox argv via -c overrides, no --ignore-user-config and no --sandbox" covers the full matrix, including explicit `resume()` assertions that `--sandbox` and `--cd` never appear.
- **Notes:** No `--sandbox` or `--cd` in shared helper output; codex-cli 0.130.0 `codex exec resume --help` confirmed both flags absent.

### T-Codex-2: Codex `worker_posture` lifecycle event
- **Status:** complete
- **Evidence:** `src/backend/codex.ts::posturEvent` synthesizes the lifecycle event from resolved argv. Both `start()` and `resume()` populate `initialEvents`. Test "codex backend populates initialEvents with a worker_posture lifecycle event" asserts payload shape on both trusted and restricted.
- **Notes:** Event payload carries `codex.ignore_user_config`, `codex.sandbox`, `codex.network_access`, and `codex.codex_network`.

### T-Cursor-1: Extend Cursor SDK shim with settingSources / sandboxOptions
- **Status:** complete
- **Evidence:** `src/backend/cursor/sdk.ts` — added `CursorSettingSource` union and extended `CursorAgentCreateOptions` / `CursorAgentResumeOptions` to include `local.settingSources` and `local.sandboxOptions`. `src/backend/cursor/runtime.ts::spawn` forwards `local.settingSources: ['all']` under trusted; omits under restricted. Test "trusted posture passes local.settingSources: ['all']..." asserts the SDK adapter receives the field; "Agent.resume receives the same settingSources value as Agent.create" covers resume parity.
- **Notes:** `['all']` is the SDK-documented forward-compatible primitive — adding new SettingSource values to the SDK later does not require code changes here.

### T-Cursor-2: Cursor `worker_posture` lifecycle event
- **Status:** complete
- **Evidence:** `src/backend/cursor/runtime.ts::spawn` calls `store.appendEvent` after `Agent.create`/`Agent.resume` succeeds. Test "pre-spawn failure (WORKER_BINARY_MISSING) does NOT emit a worker_posture event" asserts zero events on `WORKER_BINARY_MISSING`. Trusted and restricted both verified via `service.getRunEvents`.
- **Notes:** Decision 18 path; Cursor is the only backend that uses `store.appendEvent` directly because it never produces a `WorkerInvocation`.

### T-Telemetry: Spawn-time telemetry plumbing in isolation
- **Status:** complete
- **Evidence:** `src/__tests__/processManager.test.ts` adds a focused `ProcessManager.start()` test that flushes a synthetic `initialEvents` and asserts the event lands before `status: started`. A companion test on `CliRuntime.buildStartInvocation` asserts the field is stripped on the pre-bake retry path.
- **Notes:** Closes the review rev. 1 Medium 3 false-telemetry concern.

### T-Codex-Audit: Capture codex config-loading surface
- **Status:** complete
- **Evidence:** Local codex-cli 0.130.0 `codex exec --help` exposes `-c/--config`, `-p/--profile`, `-s/--sandbox`, `-C/--cd`, `--add-dir`, `--ignore-user-config`, `--ignore-rules`. `codex exec resume --help` exposes `-c/--config`, `-p/--profile`, `--last`, `--all`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `-m/--model` — and **does not accept `--sandbox` or `--cd`**. No `--config-file` or `--config-dir` flag exists on either subcommand. Codex's own config discovery loads project `.codex/config.toml` and user `$CODEX_HOME/config.toml` when `--ignore-user-config` is absent.
- **Notes:** Findings drove Decision 6 (resume-safe `-c` overrides) and Decision 9 (decouple `--ignore-user-config` from `codex_network`).

### T-Docs: Update docs
- **Status:** complete
- **Evidence:** `docs/development/mcp-tooling.md` adds new "Workers And Project MCP Servers" section with per-backend mapping table and a "Trust Boundary" subsection. `docs/development/codex-backend.md` adds trusted/restricted posture tables and a migration note for explicit `codex_network: 'workspace'` profiles. `docs/development/cursor-backend.md` adds `worker_posture` to the Settings table with a cross-reference to mcp-tooling.md. `src/backend/claude.ts` `CLAUDE_WORKER_SETTINGS_BODY` doc comment records `enableAllProjectMcpServers`, the trusted/restricted branching, and the precedence reasoning.
- **Notes:** No README / AGENTS.md changes (no existing parallel detail at this level).

### T-Rules: Capture rule candidates
- **Status:** complete
- **Evidence:** `.agents/rules/worker-posture.md` and `.agents/rules/worker-safety.md` added; `.claude/rules/` projections regenerated via `node scripts/sync-ai-workspace.mjs`.
- **Notes:** Rule scopes match the load-bearing files (`src/backend/**`, `src/orchestratorService.ts`, `src/contract.ts`, `src/harness/capabilities.ts`, `src/mcpTools.ts`, `src/claude/launcher.ts`).

### T-Verify: Final `pnpm verify` gate
- **Status:** complete
- **Evidence:** `pnpm verify` runs `pnpm build && pnpm test && node scripts/check-publish-ready.mjs && node scripts/resolve-publish-tag.mjs >/dev/null && pnpm audit --prod && npm pack --dry-run` and exits zero. Summary: `tests 577`, `pass 575`, `fail 0`, `skipped 2`; `[publish-ready] package metadata is ready for publish`; `[publish-tag] @ralphkrauss/agent-orchestrator@0.2.2 will publish with npm dist-tag latest`; `pnpm audit --prod` → "No known vulnerabilities found"; `npm pack --dry-run` produced `ralphkrauss-agent-orchestrator-0.2.2.tgz` successfully.
- **Notes:** All quality gates pass; #58 closure rule met (all three backends ship trusted posture).

### PR #60 review follow-up (2026-05-12)
- **Status:** complete
- **Resolution map:** `plans/58-issue-with-setting-sources/resolution-map.md` (7 fix items, 0 deferred).
- **Evidence:**
  - C1 (`docs/development/codex-backend.md:63`): replaced the blank line between two blockquotes with a `>` separator so MD028 no longer fires.
  - C2 (`docs/development/codex-backend.md:204`): renamed `Three concrete migration options (still restricted posture)` to `Migration options` with an intro sentence noting that option 1 moves off restricted entirely and options 2–4 stay within restricted; the four list items are unchanged.
  - C3 (`src/__tests__/cursorRuntime.test.ts:832-836`): asserted SDK-event presence first and compared `postureIdx < sdkSystemIdx` unconditionally so a future predicate drift cannot let the test pass silently.
  - C4 (`src/__tests__/processManager.test.ts:773-778`): asserted `result.ok === true` first and ran the retry-shape checks unconditionally; the prior `if (result.ok)` branch could no-op silently.
  - C5 (`src/backend/cursor/runtime.ts:229-251`): wrapped the post-`agent.send()` `worker_posture` `store.appendEvent` in `try { … } catch { … }` that calls `disposeAgentSafely(agent)` and returns `cursorSpawnFailure('Failed to persist worker_posture lifecycle event', error, { phase: 'append_event' })`. Added regression test `issue #58 (review Major 5): worker_posture appendEvent failure disposes the agent and surfaces phase: append_event` using a `RejectingPostureStore extends RunStore` and a local agent double that counts `dispose` invocations (option 2 from the resolution map — local double to avoid growing the shared `fakeAgent` API for a single regression case).
  - C6 (`src/orchestratorService.ts:836-865`): folded the posture-only branch into the settings build (non-validating) and ran `validateInheritedModelSettingsForBackend` against the merged result whenever `parsed.data.model || backendName === 'cursor'`, threading `validated.value` through `childPosture` / `codexNormalized` / `persistedSettings`. Added two integration regressions in `src/__tests__/integration/orchestrator.test.ts` (immediately after the Claude effort-validation `rejects model settings that a backend cannot apply` test, around line 741): a `worker_posture + claude-sonnet-4-6` rejection that previously slipped past the validator, and a posture-only happy-path that still persists the override.
  - C7 (`src/processManager.ts:240-262`): chained the `initialEvents` appends via `orderedInitialFlush = orderedInitialFlush.then(() => appendEventBuffered(...))` and appended `status: 'started'` only after the chain resolves, so `worker_posture` is guaranteed to land first even when `RunStore.appendEvent`'s `O_EXCL` filesystem lock loses the race. Added regression test `chains worker_posture before status:started so status:started cannot enter store.appendEvent until worker_posture resolves` in `src/__tests__/processManager.test.ts` using a `GatedAppendStore extends RunStore` that records `enterOrder` / `resolveOrder` and holds the `worker_posture` write inside `appendEvent`; the test asserts the in-flight invariant after two microtask ticks, then releases the gate and asserts both the in-memory order and the persisted on-disk sequence.
- **Verification:** `pnpm build` clean. `node --test dist/__tests__/processManager.test.js dist/__tests__/cursorRuntime.test.js dist/__tests__/integration/orchestrator.test.js` all green (22 + 34 + 38 = 94 tests pass). Full `pnpm test`: `tests 588, pass 586, fail 0, skipped 2` (skip count unchanged from rev. 3).
- **Notes:** Not committed in this pass per the implementer brief; commit/push and GitHub replies are deferred to the next step.
