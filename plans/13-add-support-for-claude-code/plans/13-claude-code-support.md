# Claude Code Support

Branch: `13-add-support-for-claude-code`
Plan Slug: `claude-code-support`
Parent Issue: #13
Created: 2026-05-03
Status: implemented

## Context

Issue #13 ("Add support for claude code") asks for an orchestrator client with
Claude Code analogous to the existing OpenCode integration. The clarification
comment from the issue owner (2026-05-03) reframes the priority: the load-bearing
problem is that the supervisor/main thread today has to remain blocked polling
`wait_for_run` per active run. There is no way for several runs to be in flight
while the supervisor returns control to the user, and no notification path so
the main thread learns that a run reached terminal/error without polling.

A subsequent product-scope decision from the human owner (2026-05-03, recorded
in Decision 18) **expands** this issue: the Claude Code harness is positioned
as the **recommended rich-feature** orchestration harness once it is ready,
because Claude Code exposes more of the primitives the orchestrator wants
(background tasks, native push, isolation flags). The OpenCode supervisor
harness **remains supported** and continues to receive compatible
improvements where feasible (notification-aware prompt, parity on shared
harness abstractions, docs covering both harnesses). The existing Codex and
Claude worker backends are unchanged. There is **no deprecation, removal
plan, runtime deprecation warning, or maintenance-only schedule for the
OpenCode supervisor in this plan**. Earlier draft language to that effect
was overstated and is explicitly retracted.

This plan covers three interleaved deliverables, sequenced **B → A → C**:

- **B. Monitor / notification core (daemon-owned, backend-agnostic).** Add
  durable notification records, request/response APIs that subscribe across
  many runs at once, and a monitor CLI that blocks against the daemon until
  the next `terminal` or `fatal_error` so a Claude Code (or any) supervisor
  can launch it as a background process and be notified by the surrounding
  harness when the background process exits.
- **A. Production-grade Claude Code supervisor harness.** A non-invasive
  launcher that wires the agent-orchestrator MCP server into the Claude Code
  CLI with a curated supervisor system prompt, **strict isolation from the
  user's Claude Code state**, an explicit permission/tool/MCP/skill
  allowlist, and a hardened CLI passthrough surface. The harness must not
  inherit user/project Claude skills, slash commands, agents, hooks, or MCP
  servers, must not use `--dangerously-skip-permissions`, and must use
  `--strict-mcp-config` (or the validated equivalent) so only the
  agent-orchestrator MCP server is reachable.
- **C. OpenCode coexistence and shared-core parity.** Extract the parts of
  the harness that are not Claude-specific (worker-profile validation,
  capability catalog, supervisor prompt building blocks, monitor-pin
  resolution, deny-by-default permission scaffolding) into a shared core
  consumed by both `src/claude/` and `src/opencode/`. Update the OpenCode
  supervisor prompt to use `wait_for_any_run` and `list_run_notifications`,
  and update the docs so both harnesses are described side-by-side with
  Claude framed as the recommended rich-feature option when available.

Current implementation note: the Claude supervisor's built-in tool surface is
`Read`, `Glob`, `Grep`, `Bash`, `Skill`. Bash is exposed with a positive
allowlist of exactly five patterns: two explicit pinned daemon monitor argv
shapes generated from POSIX-quoted command tokens
(`Bash(<command-prefix> monitor * --json-line)` and the cursored
`Bash(<command-prefix> monitor * --json-line --since *)`), `Bash(pwd)`,
`Bash(git status)`, and `Bash(git status *)`. Anything else is not in the allowlist and is denied
by `--permission-mode dontAsk`; the supervisor must use Read/Glob/Grep and
the agent-orchestrator MCP tools for everything else, including read-only
inspection commands such as `cat`, `ls`, `head`, `tail`, `grep`, `find`,
`jq`, `git log`, `git diff`, `git show`, `git rev-parse`, and `git branch`.
A comprehensive Bash deny list is layered on top of the allowlist as
defense in depth: it rejects shell metacharacters, write-shaped commands,
mutating/network git subcommands plus their global-option bypass shapes
(`git -C *`, `git --git-dir*`, `git --work-tree*`, `git --no-pager *`,
`git --exec-path*`, `git --namespace*`), script interpreters except the
monitor's required `process.execPath` Node binary (`python`, `perl`, `ruby`,
`php`, shells, and adjacent runtimes), inline-script flags (`-e`, `-c`,
`--eval`, `--exec`, `--command`), package managers, network/file-transfer
tools, command-dispatch builtins (`command *`, `builtin *`), and
backslash-escaped commands (`Bash(*\\*)`).
`Skill` is exposed so `/skills` and the orchestrate-* projections work like
in a normal Claude Code launch via the redirected user skill mirror. The
supervisor's primary wake path for runs started in the current turn is the
pinned `agent-orchestrator monitor <run_id> --json-line` Bash background
task; `mcp__agent-orchestrator__list_run_notifications` is the cross-turn
reconciliation path and `mcp__agent-orchestrator__ack_run_notification`
acknowledges handled notifications. `wait_for_any_run` and `wait_for_run`
are denied for the Claude supervisor because the pinned Bash monitor is the
intended single-active-wait primitive; both tools remain registered for
non-Claude clients. The MCP server entry written for the supervisor pins
`AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE` so `upsert_worker_profile` is
restricted to the harness-provided profiles manifest path and cannot be used
as a generic file-write primitive.

Envelope persistence note: earlier decision text that describes a random
per-launch temp envelope is superseded by follow-up #10. The current Claude
supervisor launches with `cwd` set to the **target workspace** itself rather
than to a synthetic envelope directory, and uses `--setting-sources user`
plus a redirected `HOME`/`CLAUDE_CONFIG_DIR` so Claude Code reads only the
harness-owned settings/MCP/skills under the daemon-owned
`claude-supervisor/home/` and `claude-supervisor/envelopes/` state. Project
`.claude/skills` are mirrored into the redirected user skill root so
`/skills` works without loading project settings. The launcher regenerates
harness-owned settings/MCP/prompt/skills and clears Claude discovery files
before each launch, so the supervisor sees only the curated surface.

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

> **Authoritative current state:** Decisions 7, 22, 23, and 24 below capture
> the original PR #26 contract; they have been adjusted by the post-merge
> 2026-05-04 review-followup fixes and the corresponding Reviewer Follow-up
> sections later in this plan. The current contract — which all of
> `src/claude/`, `src/server.ts`, the README, and
> `docs/development/mcp-tooling.md` actually implement — is:
>
> - **Isolation envelope (Decision 7, current):** stable per-target-workspace
>   state under daemon-owned `claude-supervisor/{home,envelopes/<workspace>-<hash>}`,
>   `cwd` = target workspace, `--setting-sources user`, redirected `HOME` /
>   `XDG_CONFIG_HOME` / `CLAUDE_CONFIG_DIR`, no `--add-dir`, no `--bare`, no
>   `--disable-slash-commands`, no `--dangerously-skip-permissions`. Project
>   `.claude/` and `.mcp.json` are not loaded. The MCP server entry pins
>   `AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE` so `upsert_worker_profile`
>   cannot write outside the harness-provided manifest path.
> - **Permission/tool allowlist (Decision 22, current):** built-in tools are
>   `Read,Glob,Grep,Bash,Skill`. The Bash allowlist contains exactly four
>   patterns: the pinned monitor (Decision 23), `Bash(pwd)`, `Bash(git status)`,
>   `Bash(git status *)`. A comprehensive Bash deny list is layered on top as
>   defense in depth (shell metacharacters, write-shaped commands,
>   mutating/network git subcommands plus their global-option bypass shapes,
>   script interpreters, inline-script flags, package managers,
>   network/file-transfer tools, command-dispatch builtins, backslash
>   escapes). `Edit`, `Write`, `WebFetch`, `WebSearch`, `Task`, `NotebookEdit`,
>   `TodoWrite`, `wait_for_any_run`, and `wait_for_run` are denied.
> - **Monitor command (Decision 23, current):** the pinned
>   `<absolute-bin> monitor <run_id> [--json-line] [--since <id>]` shape is
>   the supervisor's primary current-turn wake path; the five-pattern
>   allowlist above keeps both monitor argv shapes (no-cursor and cursored)
>   pre-approved as explicit `Bash(...)` rules. `pwd` and
>   `git status [args]` are also allowlisted as small read-only inspection
>   commands; everything else (e.g. `cat`, `ls`, `git log`, `git diff`,
>   `command touch`, `git -C dir add`) is denied.
> - **Skill exposure (Decision 24, current):** two surfaces are exposed at
>   runtime: a curated orchestrate-* snapshot under the stable envelope's
>   `.claude/skills/`, AND a redirected user skill mirror under
>   `claude-supervisor/home/.claude/skills/` populated from the **target
>   workspace** `.claude/skills/`. `/skills` lists both so workspace skills
>   like `review`, `commit`, etc. are available alongside `orchestrate-*`
>   without loading project-level settings or the user's real
>   `~/.claude/skills/`.
>
> The decision rows below are kept verbatim as the original PR #26 contract;
> read them in conjunction with the Reviewer Follow-ups #5, #8, #9, #10 and
> the 2026-05-04 review-followup resolutions.

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Scope for issue #13 | Cover both monitor/notification core (B) and Claude Code supervisor harness (A) in one plan. Sequence: B before A. Implementation may land across multiple PRs. | The clarification comment makes the notification path the load-bearing deliverable; the harness depends on it. Treating ClaudeBackend as completion of #13 is explicitly rejected. | Splitting into two issues; doing only A; doing only B; treating the existing worker backend as enough. |
| 2 | Notification model | Daemon-owned, backend-agnostic durable notification records keyed by `run_id` + `notification_id`. Each terminal/error/(later) milestone state transition produces one record. Records persist across daemon restart. | Polling-only is insufficient per the comment. MCP push notifications are not a guaranteed path on every client. A daemon-owned record store is portable, request/response compatible, replayable after disconnect, and supports many concurrent runs. | Relying on MCP `notifications/*` push as the only path; in-memory-only signalling that is lost across restart; per-backend bespoke notify hooks. |
| 3 | Subscribe API shape | Add `wait_for_any_run({ run_ids[], wait_seconds, after_notification_id? })` and `list_run_notifications({ run_ids?[], since_notification_id?, limit, include_acked? })` plus `ack_run_notification({ notification_id })`. All request/response-compatible. Existing `wait_for_run` and status APIs stay. | Many supervisors only need a single multi-run blocking call. The list/ack pair makes the daemon a durable queue across client restarts and lets the supervisor reconcile runs after returning control to the user. | Adding only `wait_for_any_run`; relying on streaming MCP subscriptions; reusing `wait_for_run` with a list parameter (breaks the schema and existing 300 s ceiling per run). |
| 4 | MCP push notifications | Optional, opportunistic. The daemon may emit `notifications/run/changed` over the MCP channel when a record is appended, but the supervisor is not required to consume them. Notification records remain authoritative. | The reviewer requires that the plan not rely solely on push. Push-as-hint plus durable records is robust whether the client surfaces push or not. | Making push the primary path; omitting push entirely; gating Claude Code support on MCP push behavior. |
| 5 | Monitor CLI | Add `agent-orchestrator monitor <run_id> [--json-line] [--since <notification_id>]` that blocks against the daemon until **either a `terminal` or a `fatal_error` notification** is appended for the run. Prints exactly one JSON line on stdout (`run_id`, `status`, `kind`, `terminal_reason`, `notification_id`, `latest_error`) and exits with the documented exit-code table (see CCS-5 acceptance criteria). | This is the cleanest way to leverage Claude Code's `Bash run_in_background: true` primitive: the supervisor launches one monitor per active run and the surrounding Claude Code harness signals the main thread when the bash exits. Waking on `fatal_error` as well as `terminal` matches the comment's "terminal or error state" requirement and lets the supervisor react to fatal backend failures without waiting for the worker process to terminate. | Server-only signalling (no CLI handle); using stderr instead of a clean json-line; mixing progress lines with the terminal record; waking only on `terminal` (would delay actionable error reporting). |
| 6 | Claude is the recommended rich-feature harness; OpenCode coexists as a supported harness | Position Claude as the **recommended** orchestration harness when its richer feature set is needed (native background tasks, push notifications, strong isolation primitives). OpenCode stays a fully supported peer harness and receives compatible improvements: notification-aware supervisor prompt, parity on shared harness abstractions, dual-harness docs. There is no deprecation warning, deprecation phase, removal plan, or maintenance-only label applied to OpenCode in this plan. The OpenCode supervisor harness remains stable and supported; the existing Codex and Claude worker backends are unchanged. | Reviewer-corrected product decision (2026-05-03 retraction): the user plans to switch to Claude Code once it is ready, but explicitly wants OpenCode to remain supported and improved in parallel; no deprecation in this slice. | Deprecating OpenCode now; framing OpenCode as legacy; printing a deprecation warning; scheduling removal phases; treating OpenCode improvements as out of scope. |
| 7 | Claude Code harness isolation boundary | The supervisor runs in a **strict isolation envelope** built ephemerally per launch under the daemon-owned state dir. Concretely: (a) a generated MCP config containing **only** the agent-orchestrator MCP server is passed via `--mcp-config <ephemeral.json>` together with `--strict-mcp-config` (CCS-7a confirms the flag; see Decision 17); (b) a generated `settings.json` is passed via the validated injection mechanism (CCS-7a) and configures permissions, the tool allowlist, and the curated skill/agents/commands roots; (c) the spawned `claude` process is started with `HOME` and `XDG_CONFIG_HOME` redirected to ephemeral dirs and with `CLAUDE_CONFIG_DIR` (or whatever variable CCS-7a confirms) pointing into the same ephemeral root, so the user's `~/.claude/` is unreadable to the supervisor; (d) project-scoped `.mcp.json`, `.claude/settings.json`, `.claude/skills/`, `.claude/commands/`, `.claude/agents/`, and `.claude/hooks/` files in the target workspace are explicitly **not** loaded — confirmed by harness leak tests; (e) `--dangerously-skip-permissions` is **never** used; (f) all ephemeral files are cleaned up on exit. Do not write into the target workspace's `.claude/` or `.mcp.json`, or into the user's `~/.claude/`. | Production-grade orchestration must not silently inherit arbitrary user MCP servers, slash commands, hooks, or skills — these can leak secrets, change tool semantics, or break the orchestration contract. The reviewer specified strict isolation and no `--dangerously-skip-permissions`. Ephemeral redirection of `HOME`/`XDG_CONFIG_HOME`/`CLAUDE_CONFIG_DIR` makes the boundary enforceable rather than merely documented. | Inheriting user/project Claude state by default; opt-out instead of opt-in for user state; using `--dangerously-skip-permissions`; making the boundary documentation-only; mutating user/workspace config; passing only `--mcp-config` without `--strict-mcp-config`. |
| 8 | Claude Code supervisor surface | Single curated supervisor system prompt + permission/tool/MCP/skill allowlist generated by `src/claude/config.ts` and consumed by the launcher. No dependency on Claude Code's experimental sub-agent / agent-team / Task-tool behavior. Prompt teaches: profile-mode `start_run`, launching `agent-orchestrator monitor <run_id>` via `Bash run_in_background: true` (with the monitor command reaching the daemon through a known path; see Decision 23), reacting on both `terminal` and `fatal_error` wake semantics, relaunching the pinned monitor with `--since <notification_id>` when a live handle is missing, and reconciling via `list_run_notifications`. Claude is not allowlisted for MCP blocking wait tools. Tool allowlist (Decision 22) restricts which Claude Code tools the supervisor can call. | Robust on whatever Claude Code primitives are stable today. Sub-agents and agent-team behavior may be useful later but cannot be a hard dependency. | Requiring sub-agents/agent-teams; relying on Claude Code's `Task` tool semantics being stable; baking model-specific Claude Code internals into the prompt; allowing free-form tool use. |
| 9 | Persistence layout | Single daemon-owned append-only journal `notifications.jsonl` under the run-store root acts as the authoritative source of order. Each entry carries a `notification_id` that **embeds a strictly increasing daemon-global sequence number** (see Decision 13). A per-run `notifications.jsonl` file may be written as a denormalized index/optimization, but the global journal is the source of truth used for cursor reads. Acknowledgement is recorded in a sidecar `acks.jsonl` (global) so the original notification is never mutated. | Append-only matches the existing run-store style and gives durability without schema migration risk. A single global journal removes any ambiguity about cross-run ordering. | Mutating notification records in place; storing notifications inside `meta.json`; adding a SQLite dependency; using only per-run files (forces order reconstruction at read time). |
| 10 | API compatibility | All new tools and contract fields are additive. Existing tool names, response envelopes, status enums, and bounded `wait_for_run` semantics are preserved. | Reviewer specifies request/response-compatible APIs. Breaking existing clients is rejected. | Renaming or repurposing `wait_for_run`; changing status enums; replacing the existing run schema. |
| 11 | Notification trigger surface | Emit notifications on terminal status transitions (`completed`, `failed`, `cancelled`, `timed_out`, `orphaned`) and on the first appended fatal `latest_error`. Reserve schema room for future progress milestones, but do not emit progress notifications in this slice. | Matches the comment's "terminal or error state" requirement and avoids notification spam. | Emitting on every event; emitting only on success; coupling to backend-specific events. |
| 12 | Wake semantics for consumers | `wait_for_any_run`, `list_run_notifications`, and the `monitor` CLI all wake on **both** `terminal` and `fatal_error` notification kinds by default. Filter parameters (`kinds?: ('terminal' \| 'fatal_error')[]`) are accepted additively for callers that want narrower wake conditions, but the default is the union. The `monitor` CLI's exit-code table distinguishes terminal-success / terminal-failure / fatal-error / timeout / cancelled / unknown / daemon-unavailable so a Claude Code `Bash run_in_background: true` consumer can branch on the exit code without parsing JSON. | Aligns with the comment: the supervisor must learn about a fatal backend error as soon as it surfaces, not only after the worker process has fully terminated. Default-union wake avoids a class of "supervisor stuck because it only listened for terminal" bugs. | Waking only on `terminal` by default; requiring an explicit kind filter to receive fatal errors; emitting fatal errors only over the optional MCP push hint. |
| 13 | Notification id and cursor scheme | `notification_id` is `${seq.toString().padStart(20, '0')}-${ulid()}`. The 20-digit zero-padded prefix is a **persisted daemon-global monotonic sequence** stored under the run-store root (e.g. `notifications.seq` written via fsync on increment, recovered on daemon start by scanning the global journal). The ULID suffix is for human-readable uniqueness and tie-breaking. Lexicographic comparison on `notification_id` is a total order matching insertion order. `since_notification_id` cursors compare lexicographically. | Reviewer required deterministic global ordering before implementation. A persisted daemon-global counter embedded in the id makes ordering total, cheap, restart-safe, and cursor reads O(1) on the global journal. The ULID suffix preserves human readability without weakening order. | Plain ULID (only loosely monotonic, requires daemon-global state to be inferred); per-run sequence (does not order across runs); SQLite autoincrement (new dependency); timestamp-only ids (collisions, clock skew). |
| 14 | MCP push payload | Push hint payload is `{ run_id, notification_id, kind, status }` only. No full record, no error context, no diff. | Locked by reviewer answer. Keeps push cheap, makes durable journal authoritative, avoids racing the disk write. | Embedding `latest_error`; embedding the full record; mixing terminal context into the hint. |
| 15 | `wait_for_any_run` ceiling | `wait_seconds` is bounded to 1-300, mirroring `wait_for_run`. | Locked by reviewer answer. Consistent client-side timeout policy. Lifting later remains additive. | Allowing unbounded waits; using a different per-tool ceiling. |
| 16 | Monitor CLI single-run v1 | Ship `agent-orchestrator monitor <run_id>` only. A `--any <run_id>...` mode is explicitly deferred. | Locked by reviewer answer. One background bash per run matches the Claude Code primitive cleanly. | Shipping multi-run mode in v1; replacing single-run with multi-run only. |
| 17 | Quality gates and dependencies | All quality gates run via repo scripts (`pnpm build`, `pnpm test`, `pnpm verify`, `node scripts/sync-ai-workspace.mjs --check`). Do not install packages or change dependency ranges without explicit user approval. | AGENTS.md rule: explicit user approval for installs. Prior plan (#10) ran into the same constraint. | Adding new dependencies opportunistically; skipping `sync-ai-workspace.mjs --check` when `.agents/` changes. |
| 18 | Scope expansion: production-grade Claude harness as the recommended rich-feature mode | This issue's harness deliverable is a **production-grade** Claude orchestration harness positioned as the recommended rich-feature option once available. It is **not** a replacement for OpenCode and does not deprecate it. The plan covers launcher, isolation, allowlists, supervisor prompt parity for orchestrate-* skills, leak-proof tests, docs that describe both harnesses side-by-side, and shared harness abstractions so Claude and OpenCode do not diverge. | Reviewer-corrected product decision (2026-05-03). The Claude harness is rich-featured; OpenCode coexists. Earlier "core only" framing is superseded; earlier "deprecate OpenCode" framing is retracted. | Treating the Claude harness as a partial peer; deferring isolation/allowlists/skills; treating OpenCode improvements as out of scope; reintroducing deprecation language. |
| 19 | OpenCode coexistence and shared-core parity | OpenCode supervisor harness is fully supported in parallel with the new Claude harness. Concrete coexistence work in this slice: (a) update `src/opencode/config.ts` supervisor prompt to use `wait_for_any_run` / `list_run_notifications` while preserving LRT-7 cadence; (b) extract harness-shared logic (worker-profile validation, capability catalog, supervisor prompt scaffolding, monitor-pin resolution, deny-by-default permission scaffolding) into a shared module consumed by both `src/claude/` and `src/opencode/` so they cannot drift; (c) update README and `docs/development/mcp-tooling.md` to describe both harnesses side-by-side, with Claude framed as recommended when its richer feature set is needed; (d) add OpenCode-side improvements that fall out of the shared core (e.g. tighter allowlist defaults) where compatible. **No** deprecation warning is emitted. **No** removal plan is scheduled. The existing Codex and Claude worker backends are unchanged. | The user explicitly wants OpenCode to remain supported and to improve in parallel; the most durable way to achieve that is to keep the surface stable, share the parts of the harness that are not Claude-specific, and update the OpenCode prompt for the new notification primitives. | Skipping OpenCode prompt update; letting Claude and OpenCode harnesses diverge; building Claude-only abstractions; emitting any deprecation warning; treating OpenCode as legacy. |
| 20 | "Dumb daemon and supervisor" principle for profiles and secrets | Worker profiles remain backend/model/settings aliases only. The daemon and the Claude supervisor must not introspect, surface, or relay arbitrary user MCP servers, secrets, environment variables, tokens, or credentials, and must not let user-provided MCP servers be reachable inside the supervisor envelope. The supervisor's only MCP server is agent-orchestrator. The MCP server itself only handles the documented tool surface and never proxies free-form user MCP calls. The launcher reads the profiles manifest only for backend/model/settings resolution. The same principle applies to the OpenCode supervisor envelope. | Reviewer requirement. Production-grade isolation depends on this invariant; relaxing it would re-introduce the leakage paths the isolation envelope is designed to prevent. | Allowing profiles to attach extra MCP servers; letting the supervisor enumerate user MCP servers; surfacing user environment variables to the supervisor prompt; proxying user MCP traffic through the agent-orchestrator MCP server. |
| 21 | CLI passthrough hardening | `agent-orchestrator claude` accepts a small allowlist of `claude` CLI flags after `--`; everything else is rejected with an actionable error. Explicitly **rejected**: `--dangerously-skip-permissions`, `--mcp-config` (the harness sets it), `--strict-mcp-config` (always-on), `--allowed-tools`/`--disallowed-tools` (the harness sets them), `--add-dir` (would widen the file boundary), and any flag that loads additional settings or skill/command/agent roots from outside the ephemeral envelope. Allowed: prompt input, `--print`, `--output-format`, model selection that respects profile rules, and analogous read-only flags. The allowlist lives next to the launcher and is unit-tested. | Mirrors the OpenCode passthrough hardening (`validateOpenCodePassthroughArgs`) and prevents a user from accidentally (or intentionally) breaking the isolation envelope by passing flags that would re-enable user state. | Allowing arbitrary passthrough flags; allowing `--dangerously-skip-permissions` "just for development"; allowing `--add-dir`; relying on docs alone to discourage misuse. |
| 22 | Claude Code permission and tool allowlist | The generated `settings.json` denies all by default and allows: `Read`, `Glob`, `Grep`, the agent-orchestrator MCP tools (under their MCP namespace), and `Bash` **only for the curated monitor command pattern** from Decision 23. `Edit`, `Write`, `WebFetch`, `WebSearch`, `Task`, `NotebookEdit`, `TodoWrite`, generic `Bash`, and any non-orchestrate skill/command/agent calls are denied. The allowlist is generated from a single source of truth in `src/claude/config.ts` and asserted by tests. The supervisor's system prompt aligns with the allowlist (no instructions to use denied tools). | Mirrors and improves on the OpenCode permission model (`orchestrationPermission`). Production-grade isolation requires that the supervisor cannot accidentally edit files, run unrestricted bash, or call tools outside the orchestration contract. | Allowing free-form `Bash`; allowing `Edit`/`Write` for general use; allowing `Task` (which would launch sub-agents that escape the envelope); leaving the allowlist implicit. |
| 23 | Monitor command allowlist and resolution | The supervisor invokes `agent-orchestrator monitor <run_id>` exclusively via `Bash run_in_background: true` against an absolute, pinned binary path resolved at launch (the daemon CLI binary that is currently running, looked up via `process.execPath` + the package CLI script, or via the `AGENT_ORCHESTRATOR_BIN` env injected by the launcher). The Bash allowlist matches that exact command shape (positional `run_id`, optional `--json-line`, optional `--since <id>`) and rejects anything else. The supervisor prompt always passes the absolute monitor binary path. The CLI rejects unexpected flags. | Without a pinned path the supervisor could be tricked (or could drift) into spawning a different binary. Constraining the Bash allowlist to a single command shape makes the boundary enforceable and auditable. | Allowing arbitrary `Bash` and trusting the model to use the right command; resolving `agent-orchestrator` from `PATH` inside the supervisor; allowing arbitrary flags after the `run_id`. |
| 24 | Skill/command/agent strategy inside the envelope | The launcher generates an ephemeral skill root containing **only the project's `orchestrate-*` SKILL.md files** (resolved from `.agents/skills/orchestrate-*/`). No project non-orchestrate skills, slash commands, sub-agents, or hooks are exposed. The ephemeral envelope's settings explicitly disable user/project skill discovery (`enableAllProjectMcpServers: false`-equivalent and the validated skill/command/agent root overrides confirmed by CCS-7a). The supervisor's system prompt references skills by name and only by their orchestrate-* names. | Mirrors and tightens the OpenCode skill behavior (`skill: { '*': 'deny', 'orchestrate-*': 'allow' }`). User-defined skills are valuable for the user's own Claude Code work but should not bleed into the orchestration supervisor. | Inheriting all project skills by default; allowing user-level skills; allowing slash commands or sub-agents; allowing project hooks. |
| 25 | Backward compatibility | Existing CLIs, bins, MCP tool names, contract envelopes, and run-store layout remain stable. New Claude tools, contract additions, and the `agent-orchestrator claude` launcher are additive. The existing Codex and Claude worker backends both remain stable. The OpenCode supervisor harness remains stable; any improvements to it are additive (prompt content, shared-core consumption, tightened allowlist defaults that do not break existing prompts). No removal, deprecation, or breaking change is scheduled by this plan. | Reviewer requirement: preserve backward compatibility. The user wants both harnesses supported. | Removing or renaming any existing surface; renaming any stable MCP tool; changing `wait_for_run` semantics; breaking the run schema; emitting deprecation warnings. |

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
- New `src/claude/` package: `discovery.ts`, `capabilities.ts`, `config.ts`,
  `permission.ts`, `skills.ts`, `passthrough.ts`, `launcher.ts`.
- Production-grade Claude Code supervisor harness with:
  - **Target-workspace launch with isolated state** per Decision 7 and
    follow-up #10: spawn cwd is the target workspace itself; harness-owned
    `settings.json` + MCP config + system prompt + skill mirror live under a
    daemon-owned `claude-supervisor/` state directory keyed by target
    workspace; `--mcp-config <state>`; always-on `--strict-mcp-config`;
    redirected `HOME`/`XDG_CONFIG_HOME`/`CLAUDE_CONFIG_DIR` so the user's
    real `~/.claude/` is not loaded while supervisor auth state persists in
    the redirected `claude-supervisor/home/.claude/`; project-scoped
    `.mcp.json`, `.claude/settings.json`, `.claude/commands/`,
    `.claude/agents/`, and `.claude/hooks/` are not loaded
    (`--setting-sources user`); project `.claude/skills/` is mirrored into
    the redirected user skill mirror so `/skills` works without reading
    project settings; never `--dangerously-skip-permissions`; harness-owned
    files are regenerated and stale Claude discovery files cleared before
    each launch.
  - **Permission and tool allowlist** per Decision 22: deny-by-default;
    `--tools Read,Glob,Grep,Bash,Skill` plus the pinned monitor Bash entry
    and the curated agent-orchestrator MCP tool allowlist; comprehensive
    Bash deny list rejects shell metacharacters, write-shaped commands,
    mutating/network git subcommands, script interpreters, inline-script
    flags, package managers, and network/file-transfer tools as
    defense-in-depth.
  - **MCP allowlist and writable-path pin**: only the agent-orchestrator
    MCP server is reachable, and the MCP server entry sets
    `AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE` so `upsert_worker_profile`
    is restricted to the harness-pinned profiles manifest path.
  - **Skill curation** per Decision 24: a curated orchestrate-* snapshot
    plus a redirected user skill mirror populated from the target
    workspace `.claude/skills/`; `wait_for_any_run` and `wait_for_run` are
    denied for the supervisor because the pinned Bash monitor is the
    intended single-active-wait primitive.
  - **CLI passthrough hardening** per Decision 21: small explicit allowlist;
    reject `--dangerously-skip-permissions`, `--mcp-config`,
    `--strict-mcp-config`, `--allowed-tools`/`--disallowed-tools`,
    `--add-dir`, `--bare`, and any setting/skill/command/agent override
    flags.
  - **Pinned monitor command** per Decision 23 (as adjusted by the 2026-05-04
    review-followup): the Bash allowlist contains exactly five patterns —
    two explicit pinned monitor argv shapes
    (`Bash(<command-prefix> monitor * --json-line)` and the cursored
    `Bash(<command-prefix> monitor * --json-line --since *)`),
    `Bash(pwd)`, `Bash(git status)`, and `Bash(git status *)`. Every other
    Bash invocation (including read-only commands such as `cat`, `ls`,
    `head`, `tail`, `grep`, `find`, `jq`, `git log`, `git diff`, `git show`,
    plus bypass shapes such as `git -C dir add` or `command touch /tmp/x`)
    is not in the allowlist and is denied; the comprehensive Bash deny list
    is defense in depth.
  - **Curated supervisor system prompt** that teaches profile-mode
    `start_run`, the pinned Bash background monitor as the primary wake
    path, `list_run_notifications` cross-turn reconciliation,
    `ack_run_notification` discipline, and cancellation discipline;
    references only orchestrate-* skills by name; explicitly forbids
    `wait_for_any_run` and `wait_for_run` in the Claude supervisor.
- New CLI entry `agent-orchestrator claude [...]` and
  `agent-orchestrator-claude` bin that ships as the **recommended
  rich-feature** orchestration launcher. Spawns the `claude` CLI with the
  target workspace as cwd, harness-owned settings/MCP/skills under the
  daemon-owned `claude-supervisor/` state directory, and never writes into
  the target workspace. Help text and README describe both Claude and
  OpenCode launchers and recommend Claude when its richer feature set is
  needed.
- Claude surface discovery (CCS-7a) produces a versioned compatibility report
  covering `--mcp-config`, `--strict-mcp-config`, `--setting-sources`,
  settings/permissions injection, skill/command/agent root overrides,
  env-based config redirection, and `Bash run_in_background`. Harness fails
  fast if the report indicates the isolation envelope cannot be built; the
  launcher does **not** silently downgrade to a less-isolated path.
- Leak-proof harness tests: assert that during a `claude` launch (a) no writes
  occur outside the daemon-owned `claude-supervisor/` state dir, (b) the
  user's real `~/.claude/` is not opened/read, (c) project-scoped
  `.mcp.json`, `.claude/settings.json`, `.claude/commands/`,
  `.claude/agents/`, `.claude/hooks/` in the target workspace are not
  loaded, (d) only the agent-orchestrator MCP server is reachable,
  (e) the orchestrate-* curated snapshot and the redirected user skill
  mirror are the only `/skills` sources, (f) the permission/tool allowlist
  and the comprehensive Bash deny list match the asserted sets,
  (g) `--dangerously-skip-permissions` is never on the spawn command line,
  (h) the monitor command pin is enforced, (i) the MCP server entry pins
  `AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE` to the harness-provided
  profiles manifest path so `upsert_worker_profile` cannot write
  arbitrary files.
- OpenCode coexistence and parity work in this slice (no deprecation):
  - `src/opencode/config.ts` supervisor prompt is updated to prefer
    `wait_for_any_run` and `list_run_notifications` while preserving LRT-7
    adaptive cadence guidance. **No** background-monitor process spawning is
    added to the OpenCode harness.
  - Extract a shared harness core consumed by both `src/claude/` and
    `src/opencode/`: worker-profile validation, capability catalog,
    supervisor prompt scaffolding, monitor-pin resolution helpers,
    deny-by-default permission scaffolding. Both packages re-export only
    what they need; behavior must not regress for OpenCode users.
  - README and `docs/development/mcp-tooling.md` describe both harnesses
    side-by-side. Claude is framed as recommended when its richer feature
    set is needed; OpenCode is described as a fully supported peer with
    its own strengths.
  - orchestrate-* skill projections reference both harnesses and use
    profile-mode commands rather than locking in either launcher.
  - **No** deprecation warning, deprecation phase, removal plan, or
    maintenance-only language is shipped for OpenCode. The existing Codex
    and Claude worker backends are also unchanged.
- Updates to `src/mcpTools.ts`, README, `docs/development/mcp-tooling.md`,
  and the orchestrate-* skill projections so consumers learn the new APIs,
  the Claude Code launcher, the dual-harness side-by-side framing, and how
  to choose between Claude and OpenCode for a given workflow.
- Focused tests for everything above plus: notification store
  append/list/ack/durability across daemon restart, daemon-global ordering
  invariants, `wait_for_any_run` blocking + already-terminal short-circuit
  + fatal-error wake + cursor resume + `kinds` filter, monitor CLI exit
  codes and json-line contract, Claude launcher arg parsing, passthrough
  rejection of disallowed flags, generated permission/MCP/skill allowlists,
  shared-core regression coverage (Claude and OpenCode both consume the
  shared module without behavior drift), OpenCode prompt regression for
  LRT-7 + new `wait_for_any_run` guidance, MCP schema/tool registration.

### Out Of Scope

- Any deprecation of the OpenCode supervisor harness. No runtime warning, no
  deprecation phases, no removal plan, no maintenance-only schedule, and no
  CHANGELOG deprecation notice are shipped by this plan. (Earlier draft
  language to that effect was overstated and is explicitly retracted.)
- Any change to the existing Codex or Claude worker backends.
- Native OpenCode background-monitor process parity. The OpenCode supervisor
  prompt is updated to use `wait_for_any_run`; spawning monitor processes
  from the OpenCode harness is intentionally not added in this slice.
- Reattaching to in-flight worker processes after daemon restart.
- Streaming MCP subscriptions as the primary notification path.
- Mutating the target workspace's `.claude/`, `.mcp.json`, user-level
  `~/.claude/`, or any global config.
- New Claude Code sub-agents / agent-team / Task-tool integration as a
  hard dependency. (The supervisor explicitly does not require these.)
- Live Claude Code or OpenCode model-call tests.
- Publishing, tagging, or release behavior changes.
- Cross-worktree locking or concurrent-edit prevention.
- Adding new runtime dependencies. Build-only dev dependencies are also
  out-of-scope without explicit approval.
- Allowing user MCP servers, the user's real `~/.claude/skills/`,
  project-scoped settings, project hooks, project commands, or project agents
  inside the supervisor launch. Target workspace `.claude/skills/` are
  intentionally mirrored into the redirected user skill root so `/skills`
  exposes workspace skills such as `review` and `commit` alongside
  `orchestrate-*`, without loading project settings or the user's real
  `~/.claude/` state (per Decision 7 and Decision 24).

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
| 17 | Claude Code's stable surfaces (`--mcp-config`, `--strict-mcp-config`, generated supervisor prompt/config, permission/tool allowlist, env-based config redirection, `Bash run_in_background`) differ from the harness assumptions. | CCS-7a runs an explicit discovery/validation pass against the installed `claude` binary and produces a versioned compatibility report consumed by CCS-8/9/15-19. If the only stable path requires persistent `.claude/` or `.mcp.json` mutation, the harness work is paused and the user is asked for explicit approval before deviating from Decision 7. | CCS-7a discovery report + harness fail-fast behavior. |
| 18 | User secrets or arbitrary user MCP servers leak into the supervisor envelope. | Decisions 7, 20, 22, 23, 24 enforce strict isolation: redirected `HOME`/`XDG_CONFIG_HOME`/`CLAUDE_CONFIG_DIR`, `--strict-mcp-config`, MCP allowlist of size 1 (agent-orchestrator), tool/skill/command/agent allowlists, deny-by-default permissions, monitor-command pin, and passthrough hardening. Leak-proof tests assert each invariant. | CCS-15..CCS-19 + CCS-22 leak-proof tests. |
| 19 | Target-workspace Claude state silently changes supervisor behavior. | Project settings, commands, agents, hooks, `.mcp.json`, and the user's real `~/.claude/` are not loaded. Target workspace `.claude/skills/` are intentionally mirrored into the redirected user skill root so `/skills` works with workspace skills alongside `orchestrate-*`; tests assert the mirror source and continue to prove that project settings/hooks/MCP and real user-level skills are not exposed. | Leak-proof test (CCS-22) and skill-curation test (CCS-17). |
| 20 | A future Claude Code release silently re-enables a state path the harness does not know about. | The discovery report is versioned and stored alongside the launcher; on launch the launcher re-runs a quick verification of declared surfaces and refuses to launch if a surface drifted in a way that affects isolation. Docs include a "what to do if discovery fails" runbook. | CCS-7a + launcher fail-fast tests. |
| 21 | Claude and OpenCode harnesses drift apart, producing inconsistent supervisor behavior. | A shared harness core (CCS-21) holds worker-profile validation, capability catalog, supervisor prompt scaffolding, monitor-pin helpers, and deny-by-default permission scaffolding. Both `src/claude/` and `src/opencode/` consume it. Tests assert the shared invariants (e.g. profile-mode handling, monitor-pin resolution) hold for both harnesses. | CCS-21 shared-core extraction + regression tests for both harnesses. |
| 22 | Documentation drift makes one harness look officially "the answer" by accident. | README and `docs/development/mcp-tooling.md` describe both harnesses side-by-side, with the **recommended-when-needed** framing for Claude (Decision 6). orchestrate-* skill projections reference profile-mode commands rather than locking in either launcher. A docs review checklist enforces parity. | CCS-20 docs task + projection check. |
| 23 | Claude harness becomes the recommended rich-feature path before all orchestrate-* skills work under the curated allowlist. | CCS-16 (skill curation) and CCS-18 (allowlist) include a parity check that exercises each orchestrate-* skill end-to-end (or asserts the static skill content is consistent with the allowlist) before the Claude harness is declared ready for recommended use. | CCS-16 + CCS-18 tests. |
| 24 | Pinned monitor binary path differs across pnpm/npm install layouts (linked, hoisted, npx, global). | Launcher resolves the absolute monitor path via `process.execPath` + the package CLI script (the same package providing the daemon CLI), with a fallback to `AGENT_ORCHESTRATOR_BIN` env. Tests cover at least the local-build, pnpm-linked, and global-install layouts. | CCS-19 launcher test fixtures. |

## Implementation Tasks

> **Authoritative current state (post-merge 2026-05-04):** the CCS-* tasks
> below are the original PR #26 deliverables. CCS-9, CCS-15, CCS-16, CCS-19,
> and CCS-22 have evolved through Reviewer Follow-ups #5, #8, #9, #10 and
> the 2026-05-04 review-followup fixes; see the Decisions banner above and
> the Execution Log entries for those tasks for the current shape. Future
> branch-context workflows must read the rows below as the original task
> framing rather than as the current contract — in particular:
>
> - CCS-9 ships a target-workspace launch (cwd = target workspace) under
>   stable per-workspace state in `claude-supervisor/{home,envelopes/}`,
>   not a per-launch ephemeral envelope under `os.tmpdir()`.
> - CCS-15 produces a positive Bash allowlist of pinned monitor + `pwd` +
>   `git status` + `git status *` plus a comprehensive Bash deny list, not
>   "Bash only for the curated monitor command".
> - CCS-16 mirrors the **target workspace** `.claude/skills/` into a
>   redirected user skill mirror (so workspace skills like `review`,
>   `commit`, etc. are exposed alongside `orchestrate-*`), in addition to
>   the curated orchestrate-* snapshot. The launcher uses
>   `--setting-sources user` rather than `--setting-sources ""`.
> - CCS-19's pinned monitor patterns are two of the five allowlist entries
>   (no-cursor and cursored argv shapes generated from POSIX-quoted command
>   tokens), not the only Bash entry.
> - CCS-22 leak-proof tests assert the five-pattern Bash allowlist (two
>   explicit monitor argv shapes plus `pwd`, `git status`, and
>   `git status *`) plus the bypass-resistance deny shapes, not "the Bash
>   allowlist matches the pinned monitor command exactly". They also assert
>   the MCP server entry pins `AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE` so
>   `upsert_worker_profile` is restricted to the harness-provided manifest
>   path.


| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| CCS-1 | Notification record contract and store | none | pending | `src/contract.ts` adds additive schemas: `RunNotificationKindSchema = z.enum(['terminal', 'fatal_error'])`, `RunNotification` (`notification_id`, `seq`, `run_id`, `kind`, `status`, `terminal_reason`, `latest_error`, `created_at`), input schemas for `wait_for_any_run` (`{ run_ids[], wait_seconds: 1..300, after_notification_id?, kinds?: RunNotificationKind[] }`), `list_run_notifications` (`{ run_ids?, since_notification_id?, kinds?, include_acked?, limit }`), `ack_run_notification`, and response schemas. `src/runStore.ts` gains append-only `appendNotification`, `listNotifications`, `markNotificationAcked` backed by a daemon-global `notifications.jsonl` journal plus an optional per-run index. `notification_id` follows the `${seq:20}-${ulid}` scheme from Decision 13; the persisted `notifications.seq` counter is recovered from the global journal on start. Records and counter survive daemon restart, including a corrupt/missing `notifications.seq` recovery path. |
| CCS-2 | Daemon emission on terminal/error transitions | CCS-1 | pending | `OrchestratorService` and `ProcessManager` append exactly one `terminal` notification per terminal transition (`completed`, `failed`, `cancelled`, `timed_out`, `orphaned`) and exactly one `fatal_error` notification when a fatal `latest_error` is first surfaced (deduplicated per run). Pre-spawn failures and orphan-on-restart emit one `terminal` notification (and a `fatal_error` first if a fatal error was captured). No duplicates on idempotent terminal writes. Emission order is observable via the global sequence. |
| CCS-3 | MCP tools `wait_for_any_run`, `list_run_notifications`, `ack_run_notification` | CCS-1, CCS-2 | pending | New tools registered in `src/mcpTools.ts` and routed in `OrchestratorService.dispatch`. **Default wake semantics**: `wait_for_any_run` returns when any of the supplied `run_ids` has a `terminal` **or** `fatal_error` notification newer than `after_notification_id` (or any if cursor omitted), otherwise blocks up to `wait_seconds` (1-300). `kinds` filter is additive and defaults to `['terminal', 'fatal_error']`. Already-terminal runs short-circuit. `list_run_notifications` supports `since_notification_id` (lexicographic cursor on the global ordering), `run_ids` filter, `kinds` filter, `include_acked`, and pagination by `limit`. `ack_run_notification` is idempotent. Schemas validated end-to-end. |
| CCS-4 | Optional MCP push hint | CCS-3 | pending | When a notification is appended, the MCP server emits a `notifications/run/changed` push (or equivalent SDK hook) with the locked minimal payload `{ run_id, notification_id, kind, status }`. Supervisor behavior remains correct without subscription. Push is documented as advisory; durable journal is authoritative. |
| CCS-5 | `agent-orchestrator monitor` CLI | CCS-1, CCS-3 | pending | New CLI subcommand wired in `src/cli.ts`. Blocks via repeated `wait_for_any_run` / `list_run_notifications` against the local daemon, **waking on both `terminal` and `fatal_error` by default**. Emits exactly one JSON line on stdout for the wake record (`{ run_id, notification_id, kind, status, terminal_reason, latest_error }`). Exit-code table documented and asserted: `0` for `terminal`+`completed`, `1` for `terminal`+`failed`/`orphaned`, `2` for `terminal`+`cancelled`, `3` for `terminal`+`timed_out`, `10` for `fatal_error` (run may still be running but supervisor must react), `4` for unknown run, `5` for daemon unavailable, `6` for argument error. `--json-line` and `--since <notification_id>` supported. Single-run only in v1 (Decision 16). |
| CCS-6 | OpenCode supervisor prompt update (notification-aware, no deprecation) | CCS-3 | pending | `src/opencode/config.ts` prompt teaches `wait_for_any_run` (default-wake on terminal+fatal_error) and `list_run_notifications` for multi-run reconciliation while preserving LRT-7 adaptive cadence guidance as a fallback. Existing OpenCode harness regression tests pass; new assertions cover the new guidance. **No deprecation note is added to the prompt.** **Do not** add background-monitor process spawning to the OpenCode harness. |
| CCS-7a | Claude Code surface discovery and validation | CCS-1 | pending | New script + module (`src/claude/discovery.ts` and `scripts/probe-claude.mjs` or equivalent test) probe the installed `claude` binary and produce a structured compatibility report covering: (a) `--mcp-config <file>` accepted; (b) `--strict-mcp-config` (or the validated equivalent) accepted; (c) project-scoped MCP wiring without `.mcp.json` mutation; (d) supervisor system-prompt / config injection mechanism (CLI flag, env var, or file); (e) permission / tool allowlist behavior via `--allowed-tools` / `--disallowed-tools` and/or settings-file driven allowlists; (f) `Bash` tool with `run_in_background: true` is reliably surfaced. The report explicitly records `--dangerously-skip-permissions` as a **forbidden** surface that the harness must never emit. Report includes detected `claude --version`, presence/absence of each surface, and the recommended harness path. **Acceptance**: a fixture-backed test asserts the report shape and a documented compatibility matrix. **Escalation rule**: if the only stable path requires persistent `.claude/` or `.mcp.json` mutation, CCS-8/9 are paused and the user is asked for explicit approval before continuing. |
| CCS-7 | Claude Code capability catalog | CCS-7a | pending | `src/claude/capabilities.ts` exposes a Claude-Code-supervisor-side catalog (analogous to `src/opencode/capabilities.ts`) that re-uses backend status and worker profile validation; no duplication of OpenCode logic — extract a shared core if needed. Consumes the discovery report from CCS-7a to gate availability. |
| CCS-8 | Claude Code supervisor config builder (prompt + curated allowlist sources) | CCS-7 | pending | `src/claude/config.ts` builds an in-memory MCP config (only the agent-orchestrator MCP server) + supervisor system prompt + the inputs that CCS-15 (`permission.ts`) and CCS-16 (`skills.ts`) consume to assemble the final ephemeral `settings.json` and skill root, using only surfaces validated by CCS-7a. Prompt teaches: profile-mode `start_run`, launching `agent-orchestrator monitor <run_id>` via `Bash run_in_background: true` against the pinned monitor binary path (Decision 23), reacting on both `terminal` and `fatal_error` wake semantics, relaunching the pinned monitor with `--since <notification_id>` when a live handle is missing, `list_run_notifications` reconciliation, and cancellation discipline. References only orchestrate-* skills by name. No experimental sub-agent / agent-team dependency. |
| CCS-9 | Claude Code launcher | CCS-8, CCS-15, CCS-16, CCS-17, CCS-18 | pending (adjusted post-merge: see banner above and Execution Log) | `src/claude/launcher.ts` parses args (mirrors OpenCode launcher options surface where appropriate), resolves the `claude` binary, builds an ephemeral envelope under the daemon state dir containing `settings.json` (from CCS-15), `.mcp.json`-equivalent MCP config (only agent-orchestrator), curated skill root (from CCS-16), and any other surfaces required by the CCS-7a report. Spawns `claude` with: the discovery-validated MCP-config flag, **always-on `--strict-mcp-config`**, redirected `HOME`/`XDG_CONFIG_HOME`/`CLAUDE_CONFIG_DIR` env, the supervisor prompt + agent identity, and the curated permission/tool allowlist. Never passes `--dangerously-skip-permissions`. Applies passthrough hardening from CCS-17 to user-supplied flags. Cleans up the ephemeral dir on exit (including on signal). Fails fast with an actionable error if the binary's surfaces no longer match the recorded discovery report. |
| CCS-10 | CLI/bin wiring | CCS-9, CCS-5 | pending | `src/cli.ts` adds `claude` and `monitor` subcommands. `src/claudeCli.ts` mirrors `src/opencodeCli.ts`. `package.json` adds `agent-orchestrator-claude` to `bin`. Help text updated. Backward compatibility preserved: existing `agent-orchestrator`, `-daemon`, `-opencode` bins behave identically. |
| CCS-11 | Pruning extension | CCS-1, CCS-2 | pending | `prune_runs` extended (additively) to prune notifications for runs that are pruned, with a dry-run report. Dry-run still reports counts without mutation. |
| CCS-12 | Docs and skill projections | CCS-3, CCS-5, CCS-9 | pending | README, `docs/development/mcp-tooling.md`, and `src/mcpTools.ts` document the new tools, the monitor CLI exit-code contract, and the Claude Code launcher. `.agents/skills/orchestrate-*/SKILL.md` updated where relevant. `node scripts/sync-ai-workspace.mjs --check` passes. |
| CCS-13 | Focused tests | CCS-1..CCS-12 | pending | Test coverage for: notification schema/defaults including `kind` enum, run-store append/list/ack/persistence-across-restart, **daemon-global ordering invariants under concurrent appends**, **`notifications.seq` recovery from a missing or corrupt counter**, daemon emission idempotency for both `terminal` and `fatal_error`, `wait_for_any_run` blocking + already-terminal short-circuit + **fatal-error wake** + cursor resume + `kinds` filter, push-hint payload exactly equals `{run_id, notification_id, kind, status}`, monitor CLI exit codes (including the new `10` fatal-error code) + json-line + fatal-error wake before terminal, harness non-invasiveness (no writes outside daemon temp dir; `.claude/`, `.mcp.json`, `~/.claude/` untouched), CCS-7a discovery report shape, generated Claude prompt assertions, OpenCode prompt regression for LRT-7 + new `wait_for_any_run` guidance, MCP tool registration, pruning of notifications. |
| CCS-14 | Verify quality gates | CCS-13, CCS-15..CCS-22 | pending | `pnpm build`, `pnpm test`, `node scripts/sync-ai-workspace.mjs --check`, `pnpm verify` all pass before review/PR. If `node_modules` is missing, request explicit user approval before running `pnpm install --frozen-lockfile`. Record concrete evidence in the Execution Log. |
| CCS-15 | Claude permission/config builder | CCS-7a, CCS-8 | pending (adjusted post-merge: see banner above and Execution Log) | `src/claude/permission.ts` produces an ephemeral `settings.json` (or the validated equivalent) that is deny-by-default and explicitly allows: `Read`, `Glob`, `Grep`, the agent-orchestrator MCP tools (under their MCP namespace as confirmed by CCS-7a), and `Bash` only for the curated monitor command pattern from Decision 23 / CCS-19. Denies `Edit`, `Write`, `WebFetch`, `WebSearch`, `Task`, `NotebookEdit`, `TodoWrite`, generic `Bash`, all non-orchestrate skills, all slash commands, all sub-agents, all hooks. Generated content is deterministic given inputs and unit-tested against a fixture. |
| CCS-16 | Claude skill curation strategy | CCS-7a, CCS-8 | pending (adjusted post-merge: see banner above and Execution Log) | `src/claude/skills.ts` resolves the project's `orchestrate-*` skills exclusively from the canonical source `.agents/skills/orchestrate-*/SKILL.md` and copies/links them into an ephemeral skill root under the daemon state dir. The launcher does **not** read `.claude/skills/` as harness input — generated `.claude/skills/orchestrate-*` projections remain `scripts/sync-ai-workspace.mjs` artifacts only. No non-orchestrate skills, slash commands, sub-agents, or hooks are exposed. The settings file disables user/project skill discovery for non-orchestrate paths (using the surface CCS-7a confirms). Tests assert: only orchestrate-* skill names are present, the source root is `.agents/skills/`, no slash commands/agents/hooks are present, ephemeral skill root is cleaned up on exit. |
| CCS-17 | Claude CLI passthrough hardening | CCS-9 | pending | `src/claude/passthrough.ts` parses tokens after `--` and validates them against a small allowlist (Decision 21). Explicitly **rejects**: `--dangerously-skip-permissions`, `--mcp-config`, `--strict-mcp-config`, `--allowed-tools`, `--disallowed-tools`, `--add-dir`, `--settings`, `--skill-roots` (or the validated equivalents from CCS-7a), and any flag that would point at user/project state. Allows: positional prompt input, `--print`, `--output-format`, model/profile-respecting flags, and analogous read-only flags. Errors are actionable. Unit-tested for accepted and rejected cases. |
| CCS-18 | MCP and tool allowlist enforcement | CCS-7a, CCS-15 | pending | The single source of truth for the agent-orchestrator MCP tool allowlist lives in `src/claude/config.ts` and is fed both into the supervisor system prompt and into the generated `settings.json` permission set (CCS-15). The set equals exactly the tools registered in `src/mcpTools.ts`. Tests assert: the allowlist matches `tools` exported from `mcpTools.ts`, nothing else is allowed, and the supervisor prompt does not instruct the model to call any denied tool. |
| CCS-19 | Pinned monitor command resolution and Bash allowlist | CCS-5, CCS-15 | pending (adjusted post-merge: see banner above and Execution Log) | The launcher resolves the absolute monitor binary path at launch (using `process.execPath` + the package CLI script, with `AGENT_ORCHESTRATOR_BIN` env override for unusual install layouts; see Risk #24) and embeds it in the supervisor prompt and in the `Bash` allowlist as `<absolute-bin> monitor <run_id> [--json-line] [--since <id>]`. Tests cover: pnpm-linked layout, local-build layout, and global-install layout via fixtures. Other Bash invocations are denied. The CLI rejects unexpected flags. |
| CCS-20 | Dual-harness docs (Claude and OpenCode side-by-side) | CCS-9, CCS-12, CCS-21 | pending | README and `docs/development/mcp-tooling.md` describe both `agent-orchestrator claude` and `agent-orchestrator opencode` side-by-side. Claude is framed as the **recommended rich-feature** harness when its richer feature set is needed (background tasks, native push, isolation primitives); OpenCode is described as a fully supported peer with its own strengths. orchestrate-* skill projections reference profile-mode commands rather than locking in either launcher. **No deprecation notice is added to docs.** `node scripts/sync-ai-workspace.mjs --check` passes. |
| CCS-21 | Shared harness core extraction | CCS-7, CCS-8, CCS-9 | pending | New shared module (e.g. `src/harness/`) holds worker-profile validation, capability catalog, supervisor prompt scaffolding (intro/permissions language/long-running cadence), monitor-pin resolution helpers, and deny-by-default permission scaffolding. `src/claude/` and `src/opencode/` are refactored to consume it. The OpenCode supervisor prompt and config keep their existing **observable** behavior unless explicitly approved (CCS-6 is the only behavior change). Tests cover: shared-module unit tests, Claude harness still produces the expected envelope, OpenCode harness still produces the existing config (modulo CCS-6 prompt update). |
| CCS-22 | Leak-proof harness tests | CCS-9, CCS-15..CCS-19 | pending (adjusted post-merge: see banner above and Execution Log) | Integration-style tests that launch the harness against a tempdir target workspace (with a poisoned `.mcp.json`, `.claude/settings.json`, `.claude/skills/test-skill/SKILL.md`, `.claude/commands/test.md`, `.claude/agents/test.md`, `.claude/hooks/test.sh`, and a fake user `~/.claude/` containing a poisoned skill and MCP config) and assert that none of those poisoned surfaces are loaded. Tests assert: no writes outside the daemon ephemeral dir; the user's real `~/.claude/` is never opened/read (verified via redirected `HOME`/`XDG_CONFIG_HOME`); only the agent-orchestrator MCP server is reachable; only orchestrate-* skills are exposed; the spawn command line never contains `--dangerously-skip-permissions`; the spawn command line always contains `--strict-mcp-config` (or the validated equivalent); the Bash allowlist matches the pinned monitor command exactly. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | Supervisors should treat MCP push notifications as advisory and reconcile via durable notification records. | Daemon/MCP contract guidance for orchestrator clients. | After CCS-4 lands and is observed to be stable. |
| 2 | Supervisor harnesses must not write into the target workspace `.claude/`, `.mcp.json`, or user-level config; they must use ephemeral configs under the daemon state dir. | Supervisor harness packages (`src/claude/`, `src/opencode/`). | After CCS-9 lands. |
| 3 | New backend-agnostic orchestration features must add daemon-owned support before per-backend specialization. | Cross-cutting daemon/MCP guidance. | After CCS-3 lands. |

## Quality Gates

- [ ] `pnpm build` passes (TypeScript strict; no relaxation of `tsconfig.json`).
- [ ] `pnpm test` passes (Node native test runner; targeted tests for all
  CCS-13 and CCS-15..CCS-22 items).
- [ ] `node scripts/sync-ai-workspace.mjs --check` passes whenever `.agents/`
  guidance changes.
- [ ] `pnpm verify` passes before PR (release-quality gate).
- [ ] No new runtime or dev dependencies added without explicit user approval.
- [ ] Harness non-invasiveness test asserts no writes outside the daemon-owned
  ephemeral dir during a `claude` launch.
- [ ] Leak-proof harness tests (CCS-22) pass against a poisoned tempdir
  workspace and a poisoned fake user `~/.claude/`.
- [ ] Generated permission/MCP/skill allowlists exactly match the tools
  registered in `src/mcpTools.ts` and the orchestrate-* skills present under
  `.agents/skills/`.
- [ ] The spawn command line for `claude` never contains
  `--dangerously-skip-permissions` and always contains the validated
  `--strict-mcp-config` (or the discovery-confirmed equivalent).
- [ ] OpenCode supervisor harness behavior is **not** broken: regression
  tests for `src/opencode/` config and prompt continue to pass; the only
  intentional change is the additive notification-aware prompt guidance
  from CCS-6. **No deprecation warning is emitted by `agent-orchestrator
  opencode` or `agent-orchestrator-opencode`** (asserted in tests).
- [ ] Shared harness core (CCS-21) is consumed by both `src/claude/` and
  `src/opencode/` without observable behavior drift for OpenCode users.
- [ ] All MCP tool descriptions in `src/mcpTools.ts` match the contract
  schemas in `src/contract.ts`.
- [ ] Relevant `.agents/rules/` checks are satisfied (`node-typescript`,
  `mcp-tool-configs`, `ai-workspace-projections`).

## Execution Log

> **Authoritative current state:** the CCS-* "completed (2026-05-03)" entries
> below are a historical record of the original PR #26 landing and have been
> partially superseded by Reviewer Follow-ups #1-#10, the 2026-05-04 plan
> amendment, and the 2026-05-04 review-followup fixes. The current
> Claude supervisor implementation is summarised at the top of this plan
> ("Current implementation note" and "Envelope persistence note") and in the
> 2026-05-04 plan amendment near the end. Where individual CCS entries below
> still describe the older shape (ephemeral envelope under `os.tmpdir()`,
> `--setting-sources ""`, `--disable-slash-commands`, generic Bash deny only,
> orchestrate-* only skill loading, etc.), trust the top-of-plan summary and
> the 2026-05-04 amendment instead. Future workers loading this plan as
> context **must** treat the historical evidence as evolution history rather
> than as the current contract.

### CCS-1: Notification record contract and store
- **Status:** completed (2026-05-03)
- **Evidence:**
  - Contract additions in `src/contract.ts`: `RunNotificationKindSchema`, `RunNotificationSchema`, `WaitForAnyRunInputSchema`, `ListRunNotificationsInputSchema`, `AckRunNotificationInputSchema`, `RunNotificationPushPayloadSchema`. New `RpcMethodSchema` entries: `wait_for_any_run`, `list_run_notifications`, `ack_run_notification`.
  - Store additions in `src/runStore.ts`: `appendNotification`, `listNotifications`, `markNotificationAcked`, `pruneNotificationsForRuns`, `appendFatalErrorNotificationIfNew`, `notificationsJournalPath`, `notificationsAcksPath`, `notificationsSeqPath`, persisted `notifications.seq` counter, recovery from journal when counter is missing/corrupt.
  - Notification id format: `${seq:20}-${ulid()}` per Decision 13.
  - Tests: `src/__tests__/notifications.test.ts` (append/list/persistence/restart, journal recovery, ack idempotency, dedupe, prune cascade, schemas).
- **Notes:** Daemon-global journal `notifications.jsonl` is authoritative; per-run sentinel file `.fatal_notification` dedupes fatal_error appends.

### CCS-2: Daemon emission on terminal/error transitions
- **Status:** completed (2026-05-03)
- **Evidence:**
  - `RunStore.markTerminal` now atomically transitions and then emits one `terminal` notification (only when an actual transition happened — idempotent re-invocation is a no-op). When the resolved `latest_error` is fatal it first emits a `fatal_error` notification via the dedupe path so order is `fatal_error` then `terminal`.
  - `ProcessManager.recordObservedError` calls `appendFatalErrorNotificationIfNew` on the first fatal observed error so the notification fires before terminal.
  - Pre-spawn failures (`OrchestratorService.failPreSpawn`) flow through `markTerminal` with the latest_error and produce the fatal_error+terminal pair.
  - Orphan-on-restart (`OrchestratorService.orphanRunningRuns`) flows through `markTerminal('orphaned')`; if the meta carries fatal latest_error, the dedupe path emits `fatal_error` first.
  - Tests: notifications.test.ts ("emits a terminal notification on markTerminal and a fatal_error notification when meta has fatal latest_error", idempotency assertion), and existing ProcessManager tests still pass.

### CCS-3: MCP tools `wait_for_any_run`, `list_run_notifications`, `ack_run_notification`
- **Status:** completed (2026-05-03)
- **Evidence:**
  - `OrchestratorService.dispatch` routes the new methods. `waitForAnyRun` short-circuits when notifications already exist for the supplied run ids and otherwise polls every 200 ms until `wait_seconds` deadline (1-300 s, schema-bounded). Default kinds filter is `['terminal','fatal_error']`.
  - `listRunNotifications` exposes `runIds`, `since_notification_id` (lexicographic global cursor), `kinds`, `include_acked`, `limit` (≤500).
  - `ackRunNotification` is idempotent.
  - `mcpTools.ts` registers all three tools; `toolTimeout.ts` extends the IPC timeout for `wait_for_any_run` similarly to `wait_for_run`.
  - Tests: notifications.test.ts schema parsing, plus full test suite green.

### CCS-4: Optional MCP push hint
- **Status:** completed (2026-05-03)
- **Evidence:**
  - `src/server.ts` starts a background poller after `server.connect(transport)`. The poller calls `list_run_notifications` with the cursor of the highest seen notification id and emits `notifications/run/changed` for each new record with payload exactly `{ run_id, notification_id, kind, status }` (validated through `RunNotificationPushPayloadSchema`).
  - Poll interval is configurable via `AGENT_ORCHESTRATOR_NOTIFICATION_POLL_MS` (default 500 ms). Failures are swallowed: the durable journal remains authoritative (Decision 4).

### CCS-5: `agent-orchestrator monitor` CLI
- **Status:** completed (2026-05-03)
- **Evidence:**
  - `src/monitorCli.ts` parses `<run_id>`, `--json-line`, `--since <id>`. Blocks via `wait_for_any_run` chunks of 60 s, wakes on terminal **or** fatal_error per Decision 12, and prints exactly one JSON line on stdout for the wake notification.
  - Documented exit codes exported as constants: 0 completed, 1 failed/orphaned, 2 cancelled, 3 timed_out, 10 fatal_error, 4 unknown run, 5 daemon unavailable, 6 argument error.
  - `src/cli.ts` adds the `monitor` subcommand and updates help text. Single-run only in v1 (Decision 16).
  - Tests: `src/__tests__/monitorCli.test.ts` (arg parsing, help, exit-code constants).

### CCS-6: OpenCode supervisor prompt update (notification-aware, no deprecation)
- **Status:** completed (2026-05-03)
- **Evidence:**
  - `src/opencode/config.ts` long-running supervision section now leads with `wait_for_any_run` (default-wake on terminal+fatal_error) and `list_run_notifications` cursor reconciliation, while preserving LRT-7 adaptive cadence as the fallback path. **No deprecation note added.** No background-monitor process spawning added to the OpenCode harness.
  - Existing OpenCode harness regression tests still pass (`pnpm test`).

### CCS-7a: Claude Code surface discovery and validation
- **Status:** completed (2026-05-03)
- **Evidence:**
  - `src/claude/discovery.ts` probes `claude --version` and `claude --help`, asserts the required surfaces are present (`--mcp-config`, `--strict-mcp-config`, `--settings`, `--allowed-tools`, `--disallowed-tools`, `--system-prompt`), reports presence of optional surfaces (`--setting-sources`, `--append-system-prompt`, `--bare`, `-p`/`--print`, `--output-format`), and records `--dangerously-skip-permissions` as a forbidden surface.
  - Recommended path is `isolated_envelope` only when all required surfaces are present. The launcher fails fast otherwise.
  - Verified live against installed `claude 2.1.126`: `node dist/cli.js claude --print-discovery` reports `Recommended path: isolated_envelope`.
- **Notes:** Persistent `.claude/` or `.mcp.json` mutation is **not** required by the available surfaces, so no escalation was needed.

### CCS-7: Claude Code capability catalog
- **Status:** completed (2026-05-03)
- **Evidence:** `src/claude/capabilities.ts` re-exports the shared catalog from `src/harness/capabilities.ts` (CCS-21 extraction). Same logic; no duplication.

### CCS-8: Claude Code supervisor config builder
- **Status:** completed (2026-05-03)
- **Evidence:** `src/claude/config.ts` builds `{ systemPrompt, settings, mcpConfig, monitorPin }`. The system prompt teaches profile-mode `start_run`, `Bash run_in_background: true` against the pinned monitor binary, terminal+fatal_error wake semantics, relaunching the pinned monitor with `--since <notification_id>` when a live handle is missing, `list_run_notifications` reconciliation, and references only orchestrate-* skill names. The MCP config exposes only the agent-orchestrator MCP server (Decision 7, Decision 20). Tests: `claudeHarness.test.ts`.

### CCS-9: Claude Code launcher
- **Status:** completed (2026-05-03); superseded in part by Reviewer Follow-ups #5, #8, #10 and the 2026-05-04 plan amendment. The list below describes the **current** behavior.
- **Evidence:**
  - `src/claude/launcher.ts` parses options, validates passthrough, runs CCS-7a discovery, builds harness-owned settings/MCP/system-prompt files plus a redirected user-skill mirror under the daemon-owned
    `${AGENT_ORCHESTRATOR_HOME:-$HOME/.agent-orchestrator}/claude-supervisor/{home,envelopes/<workspace>-<hash>}` state directory (no `os.tmpdir()`; the envelope is stable per target workspace).
  - Spawn: `claude --strict-mcp-config --mcp-config <state mcp.json> --settings <state settings.json> --setting-sources user --append-system-prompt-file <state system-prompt.md> --tools Read,Glob,Grep,Bash,Skill --allowed-tools <list> --permission-mode dontAsk [allowed passthrough]` with cwd = target workspace and `HOME`/`XDG_CONFIG_HOME`/`CLAUDE_CONFIG_DIR` redirected to the supervisor's `claude-supervisor/home/`. `--disable-slash-commands` is **not** passed; slash commands stay enabled and `/skills` reads from the redirected user skill mirror populated from the project `.claude/skills/`. `--add-dir` is **not** passed.
  - Cleanup: harness-owned `settings.json`, `mcp.json`, system prompt, and skill mirror are regenerated on each launch; stale Claude discovery files (`CLAUDE.md`, `.claude/commands`, `.claude/agents`, `.claude/hooks`, `.mcp.json`) inside the envelope are removed before each launch. Discovery report drives `recommended_path`; the launcher fails fast with `summarizeReport` output if surfaces drift.
  - Tests: `claudeHarness.test.ts` ("Claude launcher envelope", "Claude launcher leak-proof tests", `buildClaudeSpawnArgs` always sets `--strict-mcp-config` and never `--dangerously-skip-permissions`).

### CCS-10: CLI/bin wiring
- **Status:** completed (2026-05-03)
- **Evidence:**
  - `src/cli.ts` adds `claude` and `monitor` subcommands (in addition to existing `opencode`).
  - `src/claudeCli.ts` is the standalone bin entry.
  - `package.json` adds `agent-orchestrator-claude` to `bin`.
  - Backward compatibility: existing `agent-orchestrator`, `agent-orchestrator-daemon`, `agent-orchestrator-opencode` bins retained. `daemonCli.test.ts` updated to expect the new bin entry; otherwise unchanged behaviour.

### CCS-11: Pruning extension
- **Status:** completed (2026-05-03)
- **Evidence:** `RunStore.pruneTerminalRuns` now also calls `pruneNotificationsForRuns` for the deleted run ids and reports `pruned_notifications` in `PruneRunsResult`. Dry-run still reports counts without mutation. Tests: notifications.test.ts ("prunes notifications and acks for pruned runs").

### CCS-12: Docs and skill projections
- **Status:** completed (2026-05-03)
- **Evidence:**
  - `README.md` adds `## Claude Code Orchestration Mode` describing the launcher, isolation envelope, allowlist, monitor command, and `--print-discovery`/`--print-config`. Adds `wait_for_any_run`, `list_run_notifications`, `ack_run_notification` rows to the MCP tools table; documents the monitor CLI exit codes; documents the optional `notifications/run/changed` push hint.
  - `node scripts/sync-ai-workspace.mjs --check` passes.
- **Notes:** `docs/development/mcp-tooling.md` was updated in the second reviewer follow-up to include a `### Claude Code orchestration launcher` and `### Notification-aware run supervision` subsection. Side-by-side framing also lives in `README.md` (CCS-20).

### CCS-13: Focused tests
- **Status:** completed (2026-05-03)
- **Evidence:** New tests:
  - `src/__tests__/notifications.test.ts` — schemas, append/list/ack/prune, persistence-across-restart, sequence recovery, daemon-global ordering, dedupe, idempotent terminal emission, fatal+terminal pair from `markTerminal`.
  - `src/__tests__/monitorCli.test.ts` — arg parsing, help, exit-code constants.
  - `src/__tests__/claudeHarness.test.ts` — allowlist matches `mcpTools.ts`, settings allow/deny set, monitor pin resolution layouts (`AGENT_ORCHESTRATOR_BIN` absolute vs fallback), passthrough hardening (forbidden + allowed + unknown), skill curation copies orchestrate-* only, config builder includes monitor pin and skills, launcher envelope `--strict-mcp-config` + never `--dangerously-skip-permissions`, leak-proof test asserts poisoned `.mcp.json`/`.claude/*` are not loaded.
  - Final: `pnpm test` reports `tests 137 / pass 136 / fail 0` (1 skipped pre-existing).

### CCS-14: Verify quality gates
- **Status:** completed (2026-05-03)
- **Evidence:** `pnpm verify` is fully green. Output highlights: `tests 137 / pass 136 / fail 0`, `No known vulnerabilities found`, `npm pack --dry-run` succeeds (214.6 kB tarball, 188 files). `node scripts/sync-ai-workspace.mjs --check` reports projections in sync.
- **Notes:** `pnpm install --frozen-lockfile` was run with explicit user approval to populate `node_modules`. No dependency manifests were modified.

### CCS-15: Claude permission/config builder
- **Status:** completed (2026-05-03); superseded in part by Reviewer Follow-ups #5, #8, #9 and the 2026-05-04 review-followup fixes. The text below describes the **current** behavior.
- **Evidence:** `src/claude/permission.ts` produces `settings.json` with `defaultMode: dontAsk`. The `allow` list contains exactly: `Read`, `Glob`, `Grep`, `Bash(<pinned monitor pattern>)`, the explicit Bash inspection allowlist (`Bash(pwd)`, `Bash(git status)`, `Bash(git status *)`), `Skill`, and the curated agent-orchestrator MCP tool allowlist (Decision 22, minus `wait_for_any_run`/`wait_for_run` which are denied per Follow-up #8). The `deny` list contains `Edit`, `Write`, `WebFetch`, `WebSearch`, `Task`, `NotebookEdit`, `TodoWrite`, both denied MCP wait tools, and a comprehensive Bash deny list covering shell metacharacters, write-shaped commands, mutating/network git subcommands (including bypass shapes such as `git -C *`, `git --git-dir*`, `git --work-tree*`), script interpreters except the monitor's required `process.execPath` Node binary, inline-script flags (`-e`, `-c`, `--eval`, `--exec`, `--command`), package managers, network/file-transfer tools, and command-dispatch builtins (`command *`, `builtin *`). Generic Node commands remain outside the positive allowlist and inline execution remains denied, while the pinned monitor is not shadowed by `Bash(*/node *)`. Sets `enableAllProjectMcpServers: false`. Empty `hooks` and `enabledPlugins`. The launcher pairs this with `--setting-sources user` so the only settings source is the redirected user skill mirror under `claude-supervisor/home/.claude/`; project settings are not loaded. Tests: `claudeHarness.test.ts` (built-in tool surface, settings allow/deny, comprehensive deny coverage, bypass-resistance assertions, monitor allow-vs-deny shadow invariant).

### CCS-16: Claude skill curation strategy
- **Status:** completed (2026-05-03); superseded in part by Reviewer Follow-up #10 and the 2026-05-04 plan amendment. The text below describes the **current** behavior.
- **Evidence:** `src/claude/skills.ts` exposes two skill surfaces:
  - A curated orchestrate-* snapshot under the stable envelope (`<envelope>/.claude/skills/`) populated from the canonical `.agents/skills/` source. Non-orchestrate skills are excluded from this snapshot; the embedded supervisor system prompt enumerates the same orchestrate-* skill names.
  - A redirected user skill mirror under `claude-supervisor/home/.claude/skills/` populated from the **target workspace** `.claude/skills/` (which `scripts/sync-ai-workspace.mjs` keeps in sync with `.agents/skills/`). This mirror is what `/skills` lists at runtime, so workspace skills like `review`, `commit`, etc. are available alongside `orchestrate-*` without loading project-level settings.
  - The launcher uses `--setting-sources user` (not `""`) and does **not** pass `--disable-slash-commands`; slash command discovery is enabled but is sourced only from the redirected user skill mirror plus the curated envelope snapshot, never from the user's real `~/.claude/` or from any project settings file in the target workspace. Tests: `claudeHarness.test.ts` ("Claude skill curation" and the leak-proof test).

### CCS-17: Claude CLI passthrough hardening
- **Status:** completed (2026-05-03; tightened 2026-05-04 — `--bare` and `--debug-file` moved out of the allow list)
- **Evidence:** `src/claude/passthrough.ts` parses tokens after `--` and rejects: `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--mcp-config`, `--strict-mcp-config`, `--allowedTools`/`--allowed-tools`, `--disallowedTools`/`--disallowed-tools`, `--add-dir`, `--settings`, `--setting-sources`, `--system-prompt(-file)`, `--append-system-prompt(-file)`, `--plugin-dir`, `--agents`, `--agent`, `--permission-mode`, `--tools`, `--disable-slash-commands`, `--bare` (changes Claude memory/plugin/auth/discovery behavior the harness owns), and `--debug-file(=...)` (the unknown-flag path; would let Claude write outside the harness state dir). Allows: `--print`, `-p`, `--output-format`, `--input-format`, `--include-partial-messages`, `--include-hook-events`, `--verbose`, `--debug`, `-d`, `--name`, `-n`, `--exclude-dynamic-system-prompt-sections`, `--no-session-persistence`. Tests: `claudeHarness.test.ts` ("Claude passthrough hardening", including explicit `--bare` and `--debug-file` rejection cases).

### CCS-18: MCP and tool allowlist enforcement
- **Status:** completed (2026-05-03)
- **Evidence:** `src/claude/permission.ts` derives the agent-orchestrator MCP allowlist directly from `tools` exported by `src/mcpTools.ts` (`mcp__agent-orchestrator__<tool>`). The system prompt enumerates the same list. Test: `claudeHarness.test.ts` ("orchestratorMcpToolAllowList matches every registered MCP tool exactly").

### CCS-19: Pinned monitor command resolution and Bash allowlist
- **Status:** completed (2026-05-03; updated 2026-05-04 to use POSIX-quoted command tokens and explicit monitor argv shapes)
- **Evidence:** `src/claude/monitorPin.ts.resolveMonitorPin` returns `{ bin, nodePath, command_prefix, command_prefix_string, monitor_command_patterns, monitor_bash_allow_patterns }`. The bin resolves from `AGENT_ORCHESTRATOR_BIN` env (when absolute) or the package CLI script (`process.execPath` + `dist/cli.js`). Both `bin` and `nodePath` go through `assertMonitorPathIsSupported()`, which rejects characters that the supervisor's defense-in-depth Bash deny list would shadow even after POSIX quoting (single quote, `;`, `&`, `|`, `<`, `>`, `$`, backtick, backslash, CR, LF). `command_prefix_string` POSIX-quotes the `[node, bin]` tokens so install paths with spaces or parentheses (the realistic non-alphanumeric cases on macOS and bundled Node distributions) embed safely in shell command lines and `Bash(...)` permission entries. `monitor_bash_allow_patterns` contains exactly two explicit shapes: `Bash(<command-prefix> monitor * --json-line)` and `Bash(<command-prefix> monitor * --json-line --since *)`. The launcher injects the pin into the supervisor system prompt and into the `Bash(<pattern>)` allow rules of `settings.json`, then asserts both exact monitor command shapes match an allow rule and no deny rule. Other Bash invocations are denied by the positive allowlist and defense-in-depth deny rules. Tests: `claudeHarness.test.ts` ("Claude monitor pin", POSIX-quoting case for spaces/parens, explicit rejection case for shadow-prone characters, explicit-argv-shape cases, monitor allow-vs-deny shadow invariant).

### CCS-20: Dual-harness docs (Claude and OpenCode side-by-side)
- **Status:** completed (2026-05-03)
- **Evidence:** `README.md` keeps the existing OpenCode section and adds a new Claude Code section framed as the **recommended rich-feature** harness when its primitives are needed. **No deprecation language** for OpenCode is added (Decision 6). The orchestrate-* skill projections (`.agents/skills/orchestrate-*`) reference profile-mode commands and stay launcher-agnostic; they are projected via `node scripts/sync-ai-workspace.mjs` whose check passes.

### CCS-21: Shared harness core extraction
- **Status:** completed (2026-05-03)
- **Evidence:**
  - `src/harness/capabilities.ts` is the source-of-truth for `WorkerProfileSchema`, `WorkerProfileManifestSchema`, `createWorkerCapabilityCatalog`, `parseWorkerProfileManifest`, `validateWorkerProfiles`, and the `WorkerCapabilityCatalog` / `ValidatedWorkerProfile` types.
  - `src/opencode/capabilities.ts` and `src/claude/capabilities.ts` are pure re-export shims so both harnesses cannot drift.
  - Existing OpenCode harness tests continue to pass (`opencodeCapabilities.test.ts`, `opencodeHarness.test.ts`); no observable behaviour change for OpenCode.
- **Notes:** Supervisor prompt scaffolding is intentionally not yet extracted into a shared helper because the Claude prompt is materially different from the OpenCode prompt (isolation contract, monitor command pin, MCP allowlist enumeration). A follow-up extraction can lift only the genuinely shared blocks (e.g. profile diagnostics formatter) once both prompts have stabilised.

### CCS-22: Leak-proof harness tests
- **Status:** completed (2026-05-03); superseded in part by Reviewer Follow-ups #5, #8, #10 and the 2026-05-04 review-followup fixes. The text below describes the **current** assertions.
- **Evidence:** `src/__tests__/claudeHarness.test.ts` "Claude launcher leak-proof tests" creates a target workspace with poisoned `.mcp.json`, `.claude/settings.json`, `.claude/commands/evil.md`, plus a non-orchestrate skill (`review`) under the project skill root, builds the harness state, and asserts:
  - The generated MCP config exposes only the agent-orchestrator server (no `evil` entry) and pins `AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE` to the harness-provided profiles manifest path.
  - `enableAllProjectMcpServers` is `false` in settings.
  - `--setting-sources user` is in the spawn args (the only settings source is the redirected supervisor `HOME/.claude/`); project `settings.json`, `.mcp.json`, `commands/`, `agents/`, `hooks/` are not loaded.
  - The curated orchestrate-* snapshot under the envelope contains only `orchestrate-*` skills; the redirected user skill mirror under `claude-supervisor/home/.claude/skills/` contains the workspace `.claude/skills/` entries (orchestrate-* plus other workspace skills the user has defined) and never the user's real `~/.claude/skills/`.
  - `HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR` are redirected away from the user's home to `claude-supervisor/home/`.
  - `--strict-mcp-config` is always in the spawn args; `--dangerously-skip-permissions` is never; `--disable-slash-commands` is never; `--add-dir` is never; `--bare` is never.
  - The Bash allow list contains exactly the pinned monitor, `Bash(pwd)`, `Bash(git status)`, and `Bash(git status *)`. The deny list covers metacharacters, write/exec/network commands, mutating/network git subcommands (including bypass forms `git -C *`, `git --git-dir*`, `git --work-tree*`), script interpreters and inline-script flags, package managers, and command-dispatch builtins (`command *`, `builtin *`).
- **Notes:** Live spawning of `claude` is intentionally not exercised — leak prevention is asserted at the spawn-argument and harness-state level, which is what this harness controls. End-to-end live-spawn verification is documented as residual risk; see Risk #18 in the plan body.

## Backward Compatibility And Coexistence

This plan does **not** schedule any deprecation, removal, or maintenance-only
status for the OpenCode supervisor harness. Both supervisor harnesses
(`agent-orchestrator claude`, `agent-orchestrator opencode`) ship and remain
supported. Both existing worker backends (`Backend = 'codex'`,
`Backend = 'claude'`) remain supported.

What stays stable:

- All existing CLIs and bins (`agent-orchestrator`, `agent-orchestrator-daemon`,
  `agent-orchestrator-opencode`).
- All MCP tool names, response envelopes, and contract types.
- `wait_for_run` semantics and the 1-300 s ceiling.
- Run-store layout — additions (`notifications.jsonl`, `acks.jsonl`, an
  optional per-run index) are append-only and additive.
- The OpenCode supervisor prompt remains observably equivalent except for
  the additive notification-aware guidance from CCS-6.

What is new and additive:

- `agent-orchestrator claude` / `agent-orchestrator-claude` launcher
  positioned as the **recommended rich-feature** harness when its primitives
  are needed.
- New MCP tools: `wait_for_any_run`, `list_run_notifications`,
  `ack_run_notification`.
- `agent-orchestrator monitor` CLI.
- Optional `notifications/run/changed` MCP push hint.
- Shared harness core under `src/harness/` consumed by both `src/claude/`
  and `src/opencode/`.

Coexistence invariants:

- The Claude and OpenCode harnesses share validation, capability cataloging,
  prompt scaffolding, and permission scaffolding via the shared core. They
  cannot diverge without a corresponding update to the shared module.
- Documentation describes both harnesses side-by-side. Recommending Claude
  for rich-feature flows is editorial framing, not a deprecation.
- orchestrate-* skill projections reference profile-mode commands and stay
  agnostic of the launcher.

## Open Questions

Closed by earlier reviewer feedback (recorded as locked Decisions above):

- **Wake semantics** — locked: union of `terminal` + `fatal_error`
  (Decision 12, CCS-3, CCS-5).
- **Global cursor / id scheme** — locked: `${seq:20}-${ulid}` over a
  persisted daemon-global monotonic counter; daemon-global
  `notifications.jsonl` is authoritative (Decisions 9 and 13, CCS-1).
- **Claude Code surface validation** — locked as a real task (CCS-7a).
- **Push-hint payload** — locked at `{ run_id, notification_id, kind, status }`
  (Decision 14, CCS-4).
- **`wait_for_any_run` ceiling** — locked at 300 s (Decision 15, CCS-3).
- **Monitor CLI multi-run** — deferred; v1 is single-run only
  (Decision 16, CCS-5).

Closed by the 2026-05-03 scope expansion (Decisions 18-25):

- **Claude as recommended rich-feature harness; OpenCode coexists** —
  locked (Decisions 6, 18, 19; CCS-20, CCS-21).
- **No deprecation, no removal plan, no maintenance-only language for
  OpenCode** — locked (Decision 6, Decision 19, Out Of Scope, Quality Gates;
  the earlier deprecation framing is explicitly retracted).
- **Isolation boundary** — locked (current shape per Follow-up #10 and the
  2026-05-04 plan amendment): stable per-workspace envelope under
  `claude-supervisor/envelopes/<workspace>-<hash>`, harness-owned settings /
  MCP / system prompt / skill mirror under `claude-supervisor/home/`,
  `--strict-mcp-config`, agent-orchestrator-only MCP, redirected
  `HOME`/`XDG_CONFIG_HOME`/`CLAUDE_CONFIG_DIR` to the supervisor `HOME`,
  `--setting-sources user` (not `""`), no `--dangerously-skip-permissions`,
  no `--add-dir`, no `--disable-slash-commands`, no `--bare`, no inheritance
  of the user's real `~/.claude/` or project `.claude/`/`.mcp.json`/`CLAUDE.md`
  in the target workspace (Decision 7, CCS-9, CCS-22).
- **Permission/tool allowlist** — locked (current shape per Follow-up #5,
  Follow-up #8, Follow-up #9, and the 2026-05-04 review-followup fixes):
  `--tools Read,Glob,Grep,Bash,Skill` plus a positive Bash allowlist
  containing only the pinned monitor, `Bash(pwd)`, `Bash(git status)`,
  `Bash(git status *)`; comprehensive Bash deny list as defense in depth;
  `wait_for_any_run`/`wait_for_run` denied for Claude; MCP server entry
  pins `AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE` so
  `upsert_worker_profile` cannot write outside the harness-provided
  profiles manifest (Decision 22, CCS-15, CCS-18).
- **Skill curation** — locked (current shape per Follow-up #10):
  orchestrate-* curated snapshot under the stable envelope plus a
  redirected user skill mirror under `claude-supervisor/home/.claude/skills/`
  populated from the target workspace `.claude/skills/`. Slash commands
  stay enabled and `/skills` reads only from these two sources
  (Decision 24, CCS-16).
- **Passthrough hardening** — locked (Decision 21, CCS-17).
- **Monitor command pin** — locked (Decision 23, CCS-19).
- **Dumb daemon/supervisor for profiles and secrets** — locked
  (Decision 20).
- **Backward compatibility** — locked: no removal, no breaking changes; all
  additions are additive (Decision 25, Backward Compatibility section).

Remaining material questions (each could affect implementation; resolve
before or during the relevant CCS task, do not silently broaden scope):

1. **Exact Claude Code injection surface for `settings.json` and config
   redirection.** Discovery (CCS-7a) must confirm one of: (a) a
   `--settings <path>` (or analogous) flag, (b) a `CLAUDE_CONFIG_DIR` (or
   analogous) env var, or (c) a combination. The plan currently encodes
   redirected `HOME`/`XDG_CONFIG_HOME`/`CLAUDE_CONFIG_DIR` as the
   load-bearing path; if CCS-7a finds none of these reliably isolate user
   state, escalate to the user before continuing CCS-9. Do **not** fall
   back to writing into the target workspace or `~/.claude/`.
2. **`--strict-mcp-config` availability.** If the installed `claude` binary
   does not support the flag (or its validated equivalent), the plan
   currently says "fail fast and ask the user." Confirm whether the user
   wants any softer behavior (e.g. warn-and-proceed when only
   `--mcp-config` is available). Default behavior in this plan: fail fast.
3. **Shared core module name and home.** The plan currently encodes
   `src/harness/` for the shared core extracted by CCS-21. Confirm this
   path or pick another (e.g. `src/supervisor/`) before CCS-21 begins so
   imports do not have to be churned later.
4. **OpenCode-side improvements that fall out of the shared core.** When
   shared invariants tighten (e.g. deny-by-default permission scaffolding
   already enforced in OpenCode today), CCS-21 may need to update the
   OpenCode prompt or config to keep behavior identical. Any change beyond
   "additive notification guidance" should be raised before landing so we
   do not silently change OpenCode user-facing behavior.
5. **Compatibility report storage.** CCS-7a produces a versioned
   compatibility report. Default in this plan: regenerate per launch
   (cheap; always matches the installed binary). Confirm before CCS-7a
   lands if a packaged-report variant would be preferred for offline
   reproducibility.

## Reviewer Follow-up (2026-05-03)

A blocking reviewer pass identified four issues; all four are now fixed in the
same branch and the implementation re-verified end-to-end. Summary, evidence,
and the affected execution-log entries:

### Follow-up 1: Bash deny precedence (CCS-15, CCS-18)
- **Symptom (reviewer):** generated `settings.json` had `Bash(<pinned monitor pattern>)` in `permissions.allow` AND bare `Bash` in `permissions.deny`. Claude Code deny rules take precedence over an allow rule for the same tool name, so the bare-`Bash` deny would also block the pinned monitor pattern.
- **Fix:** removed bare `Bash` from `permissions.deny` (`src/claude/permission.ts`). Documented inline that overall Bash availability is restricted at the spawn-arg level via `--allowed-tools`, not via a settings deny rule that would shadow the allow pattern.
- **Compensating control:** `buildClaudeAllowedToolsList` now exports the explicit tool whitelist used by the launcher to set `--allowed-tools "Read Glob Grep Bash(<pinned pattern>) mcp__agent-orchestrator__<each tool>"` at spawn time, so any Bash invocation outside the pinned pattern is unavailable to the supervisor regardless of permission ordering.
- **Test:** `claudeHarness.test.ts` — "builds settings that allow Read/Glob/Grep/agent-orchestrator MCP tools and the pinned Bash pattern, denying other write/exfil tools" now asserts that bare `Bash` is **not** in `permissions.deny`.

### Follow-up 2: monitor command shape mismatch (CCS-19, CCS-8)
- **Symptom (reviewer):** the Bash allow pattern was `${process.execPath} ${bin} monitor *` (i.e. with the `node` interpreter prefix), but the supervisor system prompt taught `${bin} monitor <run_id>` (without the `node` prefix), so the supervisor's `Bash run_in_background` invocations would not match the allow pattern.
- **Fix:** `src/claude/monitorPin.ts` now resolves a structured `ResolvedMonitorPin` that is the single source of truth for the canonical command:
  - `nodePath` (`process.execPath`)
  - `bin` (absolute CLI script)
  - `command_prefix` (the tokens) and `command_prefix_string` (the joined string used in prompts)
  - `bash_allowlist_pattern = command_prefix_string + " monitor *"`
  The system prompt (`src/claude/config.ts`) now teaches the canonical prefix verbatim and explicitly states that the Bash allowlist matches only commands beginning with that prefix.
- **Test:** `claudeHarness.test.ts` — "Claude monitor pin: keeps the prompt command shape and Bash allow pattern aligned" asserts the prompt-side prefix and the Bash pattern share the same prefix, and the leak-proof launcher test extracts the Bash pattern's prefix from `--allowed-tools` and confirms the system prompt teaches the same prefix.
- **Live verification:** `node dist/cli.js claude --print-config --cwd /tmp` shows the canonical prefix in the prompt's "Pinned monitor command prefix:" line, the system-prompt instruction, and the `Bash(<prefix> monitor *)` allow rule are all the same string.

### Follow-up 3: skill exposure without leakage (CCS-9, CCS-16)
- **Symptom (reviewer):** the launcher always passed `--disable-slash-commands`, but Claude Code documents that flag as disabling all skills and commands. Curated `orchestrate-*` skills were copied to `<envelope>/skills/`, but no spawn flag wired them into Claude's discovery, so they would not be exposed.
- **Fix:**
  - Removed `--disable-slash-commands` from the harness's spawn args (`src/claude/launcher.ts.buildClaudeSpawnArgs`).
  - Moved curated skills to `<envelope>/.claude/skills/<orchestrate-*>/SKILL.md` (was `<envelope>/skills/`), and changed the spawn `cwd` to the envelope. Claude's cwd-rooted skill discovery now finds only the curated `orchestrate-*` SKILL.md files.
  - The target workspace is exposed via `--add-dir <target workspace>` so `Read`/`Glob`/`Grep` still operate on it. Project state in the target workspace (`.claude/`, `.mcp.json`, etc.) is **not** auto-loaded because the spawn's cwd is the envelope, not the target workspace.
  - Defense in depth: `--strict-mcp-config` keeps `agent-orchestrator` the only reachable MCP server; `--setting-sources ""` prevents loading user/project/local `settings.json`; `HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR` are still redirected to ephemeral subdirectories. `--disable-slash-commands` remains in the **passthrough** forbidden list so a user supplying it after `--` is rejected with an actionable error.
- **Tests:**
  - `claudeHarness.test.ts` — "Claude launcher envelope" asserts the spawn args do NOT include `--disable-slash-commands` and DO include `--add-dir <target>` and `--allowed-tools` with a Bash pattern.
  - "Claude launcher leak-proof tests" creates a target workspace with poisoned `.claude/{settings.json, skills, commands, agents, hooks}` plus `.mcp.json`, asserts that none of those leak into the envelope's `.claude/`, that the curated skill root contains only `orchestrate-*`, and that the spawn cwd would be the envelope rather than the target workspace.
  - The `buildClaudeSpawnArgs` unit test asserts the new shape (`--add-dir`, `--allowed-tools`, no `--disable-slash-commands`).

### Follow-up 4: notification sequence recovery (CCS-1)
- **Symptom (reviewer):** `nextNotificationSequence` consulted `notifications.seq` first and only fell back to scanning the journal if the counter file was missing or corrupt. Because `appendNotification` writes the journal **before** updating the counter, a crash between those two writes leaves the counter stale (lower than the journal max). On restart, the next id would be `(stale_counter + 1)` and could collide with an existing id in the journal.
- **Fix:** `RunStore.nextNotificationSequence` now reads the persisted counter **and** the journal's highest seq in parallel and takes `max(counter, journal_max) + 1`. The journal scan is also optimised to a tail read that walks from the end of the file backwards until it parses a valid record, falling back to a full scan only when the journal is small or has many trailing corrupt lines.
- **Tests:** `notifications.test.ts` — "recovers monotonically when notifications.seq is stale (lower than the journal max), simulating a crash between journal append and counter write" creates seqs 1-3, rewrites `notifications.seq` to `1`, and asserts the next id is `seq=4` and that all four notification ids remain unique. The existing missing/corrupt counter test continues to pass.

### Non-blocking items addressed

- **`docs/development/mcp-tooling.md`** now contains a `### Claude Code orchestration launcher` subsection that documents the launcher, the envelope, the new spawn flags, and a `### Notification-aware run supervision` subsection that documents `wait_for_any_run`, `list_run_notifications`, `ack_run_notification`, the monitor CLI, and the optional `notifications/run/changed` push hint.
- **Test coverage gaps:**
  - New `src/__tests__/waitForAnyRun.test.ts` adds five service-level tests against `OrchestratorService.waitForAnyRun`: immediate return for already-existing notification, blocking + fatal-error wake before terminal, `after_notification_id` cursor (no double-wake), `kinds` filter (terminal-only ignores fatal_error), and aggregation across multiple run ids.
  - The leak-proof harness test in `claudeHarness.test.ts` was hardened to additionally poison `.claude/agents/` and `.claude/hooks/`, to add a non-orchestrate skill (`review`) under the same `.agents/skills/` source root, and to assert that the harness's curated skill root contains exactly the orchestrate-* skill names — and that the envelope's `.claude/` does not leak `commands/`, `agents/`, `hooks/`, `settings.json`, or `.mcp.json`.
  - The `buildClaudeSpawnArgs` unit test now asserts the full new shape including `--add-dir` and `--allowed-tools`, and asserts the absence of `--disable-slash-commands`.
- **AI workspace projection** (`.claude/skills/orchestrate-implement-plan/SKILL.md`) is regenerated alongside the canonical `.agents/` source change; `node scripts/sync-ai-workspace.mjs --check` reports projections in sync.

### Final verification
- `pnpm verify` green: `tests 144 / pass 143 / fail 0` (1 pre-existing skipped); `No known vulnerabilities found`; `npm pack --dry-run` succeeds.
- `node scripts/sync-ai-workspace.mjs --check` green.
- `node dist/cli.js claude --print-discovery` continues to report `Recommended path: isolated_envelope` against installed `claude 2.1.126`.
- `node dist/cli.js claude --print-config --cwd /tmp` shows the canonical monitor command prefix appears identically in: (a) the system prompt's "Pinned monitor command prefix:" line, (b) the system prompt's instruction sentence, (c) the `Bash(<prefix> monitor *)` settings allow rule, and (d) the spawn-time `--allowed-tools` Bash pattern.

### Residual risks after follow-up
- Live end-to-end smoke against a spawned `claude` (TUI or `--print`) was not exercised in this branch. Spawn-arg, prompt, allow-pattern, and leak-prevention assertions are unit-tested. A CI-gated live smoke (e.g. `agent-orchestrator claude -- --print --bare "list_runs and exit"` with a fixture profile) is the most useful follow-up.
- The MCP push hint remains a 500 ms server-side poll loop. The durable journal is authoritative; lower-latency push (e.g. a daemon→server unidirectional notify channel) is a follow-up rather than a blocker.

## Reviewer Follow-up #2 (2026-05-03)

> **Note (2026-05-04):** the no-Bash, MCP-only model that this follow-up
> introduced was itself superseded by Follow-up #5 (Bash restored for the
> pinned monitor) and the 2026-05-04 plan amendment. The text below is kept
> as evolution history; for the current behavior see the top-of-plan
> "Current implementation note" and the 2026-05-04 plan amendment.

A second reviewer pass identified two further blockers in the spawn-arg model
introduced by the first follow-up. Both are now corrected and re-verified.
This section supersedes the stale parts of "Reviewer Follow-up (2026-05-03)"
above; specifically the references to `--add-dir <target>` and to
`--allowed-tools` as the restriction surface are no longer accurate. Plan
Decisions 5, 19, 22, and 23 are adjusted as documented below; no other
decisions change.

### Follow-up #2-1: `--add-dir <target>` would scan target workspace for project skills/commands/agents/hooks (`src/claude/launcher.ts`)
- **Symptom (reviewer):** the previous fix passed `--add-dir <target>` so the supervisor's `Read`/`Glob`/`Grep` could inspect the target workspace. Per Claude Code's documented behaviour, add-dir paths are scanned for project `.claude/skills`, `.claude/commands`, `.claude/agents`, `.claude/hooks`, and `CLAUDE.md`. That re-introduces the leakage we're trying to prevent.
- **Fix:** `--add-dir` is no longer passed by the harness. `buildClaudeSpawnArgs` no longer accepts a `targetWorkspace` parameter. The supervisor no longer has direct read access to the target workspace; instead, it dispatches worker runs with `cwd = <target workspace>` via `mcp__agent-orchestrator__start_run` and reconciles via `get_run_status`, `get_run_events`, and `get_run_result`. This matches the "dumb supervisor" principle (Decision 20).
- **Tests:** `claudeHarness.test.ts` — "Claude launcher envelope" and the leak-proof test both assert `built.spawnArgs` does NOT include `--add-dir`. The `buildClaudeSpawnArgs` unit test asserts the same.
- **Live verification:** `node dist/cli.js claude --print-config --cwd /tmp` now shows spawn args `["--strict-mcp-config","--mcp-config",…,"--settings",…,"--setting-sources","","--append-system-prompt-file",…,"--tools","Read,Glob,Grep"]` — no `--add-dir`.

### Follow-up #2-2: `--allowed-tools` only pre-approves; arbitrary Bash was still requestable (`src/claude/permission.ts`, `src/claude/launcher.ts`)
- **Symptom (reviewer):** `--allowed-tools` pre-approves matching tool patterns so they don't prompt; it does not restrict overall tool availability. Because bare `Bash` had been removed from `permissions.deny` in the first follow-up and `--tools` was not used, generic Bash remained requestable/promptable. The reviewer's correct restriction surface for built-in availability is `--tools`.
- **Fix:**
  - `buildClaudeSpawnArgs` now passes `--tools "Read,Glob,Grep"` (no Bash). `--allowed-tools` is no longer passed by the harness. Edit, Write, WebFetch, WebSearch, Task, NotebookEdit, and TodoWrite are also unavailable as built-ins. The agent-orchestrator MCP tools are loaded separately via `--mcp-config` and are unaffected by `--tools`.
  - `buildClaudeSupervisorSettings()` now takes no inputs and returns an `allow` list of `Read`, `Glob`, `Grep`, plus the agent-orchestrator MCP tool names; `deny` includes `Bash` (defense in depth, in case `--tools` semantics ever loosen) plus the existing write/exfil tools (`Edit`, `Write`, `WebFetch`, `WebSearch`, `Task`, `NotebookEdit`, `TodoWrite`).
  - `CLAUDE_SUPERVISOR_BUILTIN_TOOLS = ['Read', 'Glob', 'Grep']` is the single source of truth for the built-in availability list and is consumed by both `permission.ts` and `launcher.ts`.
  - The deleted `buildClaudeAllowedToolsList` helper and the per-launch `monitorBashAllowlistPattern` permission input are gone.
  - `--tools` is added to the passthrough forbidden list (`src/claude/passthrough.ts`) so users cannot override it via `agent-orchestrator claude -- --tools default`.
- **Tests:**
  - `claudeHarness.test.ts` — settings test asserts `Read`, `Glob`, `Grep` and the agent-orchestrator MCP tools are in `allow`; `Bash`, `Edit`, `Write`, etc. are in `deny`; no Bash pattern appears in `allow`.
  - `claudeHarness.test.ts` — launcher envelope and `buildClaudeSpawnArgs` tests assert `--tools` is `"Read,Glob,Grep"`, no `--allowed-tools`, no `--add-dir`, no `--disable-slash-commands`, no `--dangerously-skip-permissions`.
  - `claudeHarness.test.ts` — config-builder test asserts the system prompt teaches MCP polling (`wait_for_any_run`) for run supervision and explicitly tells the supervisor that "Bash is not available inside the envelope". The standalone `agent-orchestrator monitor <run_id>` CLI is mentioned only as an out-of-envelope pointer for the user's own shell.
- **Live verification:** `node dist/cli.js claude --print-config --cwd /tmp --skills .agents/skills` shows the system prompt now contains "Bash, Edit, Write, … are not available. Do not request them.", the supervisor reading guidance "The supervisor cannot directly read files outside this envelope. To inspect or modify the target workspace, dispatch a worker run …", and the standalone-CLI pointer "The supervisor itself does not invoke this command — Bash is not available inside the envelope." Spawn args are exactly `--strict-mcp-config --mcp-config … --settings … --setting-sources "" --append-system-prompt-file … --tools Read,Glob,Grep`.

### Plan decision adjustments
- **Decision 5 (monitor CLI as the primary long-running supervision primitive)** — adjusted: the monitor CLI is still the load-bearing primitive for *users* who want a one-shot background process tied to a single run. Inside the Claude envelope, the supervisor relies on bounded `wait_for_any_run` polling (which already wakes on the union of `terminal` + `fatal_error`). The monitor CLI exit-code table and JSON-line stdout contract are unchanged.
- **Decision 19 (OpenCode coexistence)** — unchanged. OpenCode's prompt continues to lead with `wait_for_any_run` cursor-based polling.
- **Decision 22 (permission/tool allowlist)** — adjusted: the supervisor's tool surface inside the envelope is exactly `Read`, `Glob`, `Grep`, plus the agent-orchestrator MCP tools. Bash is not exposed at all. Built-in availability is enforced with `--tools` (the correct restriction surface per the Claude CLI docs); `settings.permissions.deny` lists `Bash` plus the other write/exfil tools as defense in depth.
- **Decision 23 (pinned monitor command and Bash allowlist)** — adjusted: there is no in-envelope Bash allowlist, because Bash is not exposed inside the envelope. `resolveMonitorPin` continues to return the canonical command prefix; the launcher embeds it in the system prompt as informational text only, so the supervisor can mention the standalone CLI to the user.

### Stale-evidence cleanup
The first reviewer follow-up section (above) contains evidence that is no longer accurate:
- "compensating control: `buildClaudeAllowedToolsList` … `--allowed-tools …`" — superseded; the helper is removed and `--allowed-tools` is no longer passed.
- "`Bash(<prefix> monitor *)` settings allow rule" — superseded; the pinned Bash pattern is no longer in `permissions.allow`.
- "`--add-dir <target workspace>` so `Read`/`Glob`/`Grep` can inspect the target workspace" — superseded; `--add-dir` is no longer passed.
- "system prompt teaches the same monitor command prefix as the Bash allow pattern" — adjusted; there is no Bash allow pattern. The prompt teaches the canonical prefix as an informational pointer to the standalone CLI.
- "`docs/development/mcp-tooling.md` was left unchanged" — superseded; the file now contains a `### Claude Code orchestration launcher` and `### Notification-aware run supervision` subsection.

These corrections are intentional and the working evidence below is the authoritative version.

### Final verification
- Build: `pnpm build` clean.
- Targeted tests: `pnpm test` reports `tests 143 / pass 142 / fail 0` (1 pre-existing skipped). The Claude launcher envelope test, the leak-proof test, the `buildClaudeSpawnArgs` unit test, the settings test, the config builder test, and the monitor pin tests all pass under the new model.
- AI workspace: `node scripts/sync-ai-workspace.mjs --check` green.
- Live: `node dist/cli.js claude --print-discovery` continues to report `Recommended path: isolated_envelope` against installed `claude 2.1.126`. `node dist/cli.js claude --print-config --cwd /tmp` shows the new spawn args (`--tools "Read,Glob,Grep"`, no `--add-dir`, no `--allowed-tools`, no `--dangerously-skip-permissions`, no `--disable-slash-commands`) and the new system prompt language.
- `pnpm verify` is run as the very last step; results are recorded below.

### Residual risks after follow-up #2
- Live end-to-end smoke against a spawned `claude` is still not exercised. Pure-spawn-arg verification has been strengthened: the harness no longer relies on permission-pattern semantics that we cannot run-time verify in CI without a Claude session. A CI-gated live smoke remains the most useful follow-up.
- Supervisors that depended on `Bash run_in_background: true` for low-latency run notification have to use bounded `wait_for_any_run` polling instead. The supervisor still wakes on the union of `terminal` + `fatal_error` per Decision 12, so the supervision contract is preserved; only the in-envelope mechanism changed.
- The MCP push hint remains a 500 ms server-side poll loop. Durable journal is authoritative.

## Reviewer Follow-up #3 (2026-05-03)

A third reviewer pass identified two follow-on inconsistencies in the
discovery and passthrough surfaces introduced by follow-up #2. Both are now
corrected.

### Follow-up #3-1: discovery validated the wrong tool flags (`src/claude/discovery.ts`)
- **Symptom (reviewer):** `discoverClaudeSurface` still listed `--allowed-tools` and `--disallowed-tools` as **required** surfaces and did not check `--tools` at all. Because the harness's actual security boundary moved to `--tools "Read,Glob,Grep"` in follow-up #2, a Claude binary that lacked `--tools` could still be reported as `Recommended path: isolated_envelope`. The live `--print-discovery` output also had no `tools_flag` line, which is unmonitored drift from the new model.
- **Fix:**
  - Added `tools_flag` (required) and `append_system_prompt_file_flag` (required) to `ClaudeSurfaceReport.surfaces`. The harness depends on both: `--tools` for built-in availability restriction and `--append-system-prompt-file` for system-prompt injection.
  - Demoted `allowed_tools_flag` and `disallowed_tools_flag` to `required: false`. They are still reported (so an operator can see what the binary advertises) but they are not part of the security boundary, because `--allowed-tools` only pre-approves and `--disallowed-tools` cannot express the inverse-of-pinned pattern we would need.
  - `setting_sources_flag` is now required too (the harness depends on `--setting-sources ""` to suppress user/project/local settings).
  - The `--append-system-prompt-file` regex was relaxed to also match the bare-mode shorthand `--append-system-prompt[-file]` because the installed `claude 2.1.126` lists the flag only inside the `--bare` description rather than as a top-level option. Both forms indicate the file variant is supported.
- **Tests:** new `src/__tests__/claudeDiscovery.test.ts` exercises `discoverClaudeSurface` against five fake-binary fixtures (a shell-script `claude` whose `--help` and `--version` outputs are tailored per case):
  - All required surfaces present → `recommended_path = isolated_envelope`, `forbidden_surfaces = ['--dangerously-skip-permissions']`.
  - `--tools` removed → downgraded to `unsupported`; `errors` calls out `tools_flag` specifically.
  - `--append-system-prompt-file` removed → downgraded to `unsupported`.
  - `--allowed-tools` and `--disallowed-tools` removed → still `isolated_envelope` (they are no longer required).
  - `summarizeReport` includes lines for the new `tools_flag` and `append_system_prompt_file_flag` surfaces.
- **Live verification:** `node dist/cli.js claude --print-discovery` against installed `claude 2.1.126` now emits `Detected surfaces: ... tools_flag: present, append_system_prompt_file_flag: present, ... allowed_tools_flag: present, disallowed_tools_flag: present, ...` and `Recommended path: isolated_envelope`.

### Follow-up #3-2: `--bare` was on the safe passthrough list (`src/claude/passthrough.ts`)
- **Symptom (reviewer):** `validateClaudePassthroughArgs` allowed `--bare`, and `claudeHarness.test.ts` asserted it as acceptable. Per Claude Code docs, `--bare` skips auto-discovery of skills, plugins, MCP servers, memory, and CLAUDE.md. The harness's load-bearing skill exposure mechanism is exactly cwd-rooted discovery of `<envelope>/.claude/skills/orchestrate-*`, so `--bare` would silently hide the curated skill surface — the same failure mode that already disqualified `--disable-slash-commands`.
- **Fix:** moved `--bare` from `ALLOWED_FLAG_TOKENS` to `FORBIDDEN_FLAGS`. Added an inline comment explaining the parallel with `--disable-slash-commands`. Updated the launcher's `--help` text accordingly.
- **Tests:** `claudeHarness.test.ts` "Claude passthrough hardening" — the rejection list now includes `--bare`; the acceptance test no longer passes `--bare` (uses `--no-session-persistence` instead as another safe flag).

### Stale-text cleanup (non-blocking)
- **`README.md`** — removed the sentence claiming the harness "teaches the supervisor to launch `agent-orchestrator monitor <run_id>` via `Bash run_in_background: true` against a pinned absolute path …"; reframed the "recommended rich-feature" paragraph to no longer cite Bash background tasks (it now lists `--strict-mcp-config`, `--setting-sources ""`, `--tools`, and ephemeral skill / settings injection as the rich-feature primitives).
- **`docs/development/mcp-tooling.md`** — removed the sentence describing the standalone monitor CLI as "what the Claude harness uses with `Bash run_in_background: true`"; added that the harness itself does not invoke it because Bash is not part of the supervisor's tool surface.
- **`src/claude/launcher.ts`** — replaced two stale comments that still claimed the target workspace was reachable through `--add-dir`. Both now correctly state that the target workspace is not exposed to the supervisor and is reached only by dispatching worker runs with `cwd = <target>`.

### Final verification
- `pnpm build` clean.
- `pnpm test` reports `tests 148 / pass 147 / fail 0` (1 pre-existing skipped). The new `claudeDiscovery.test.ts` adds 5 tests that exercise the discovery contract end-to-end against fake binaries.
- `node scripts/sync-ai-workspace.mjs --check` green.
- Live: `node dist/cli.js claude --print-discovery` against installed `claude 2.1.126` reports every required surface (`tools_flag`, `append_system_prompt_file_flag`, etc.) as `present` and `Recommended path: isolated_envelope`.
- `pnpm verify` results recorded below.

### Residual risks after follow-up #3
- The discovery report is built only from `claude --help` and `claude --version`. A future Claude release could rename `--tools` and silently break the boundary; the discovery report would then mark `tools_flag` as missing and the launcher would correctly fail-fast with `Recommended path: unsupported` (validated by the discovery tests).
- Live spawn against `claude` is still not exercised in CI — see follow-up #2 risks.

## Reviewer Follow-up #4 (2026-05-03, README docs only)

A subsequent reviewer pass flagged two stale spots in `README.md` that
contradicted the post-#2/#3 implementation. No source/test/docs other than
`README.md` were touched in this follow-up.

- **README ~line 537**: the "MCP Tools" table preamble said `agent-orchestrator monitor <run_id>` was "the recommended way for a Claude Code supervisor to use background bash to subscribe to a run." This contradicted the rest of the README (which says Bash is not part of the supervisor's tool surface) and `docs/development/mcp-tooling.md`. Reworded to: the monitor CLI is for **out-of-envelope** use from a user shell; the Claude supervisor itself does not invoke it because Bash is not part of its tool surface, and in-envelope supervision uses bounded `wait_for_any_run` polls. Exit-code table preserved verbatim.
- **README ~line 319**: the post-`--`  forbidden-flag list was missing `--bare` even though `src/claude/passthrough.ts` rejects it (follow-up #3-2). Added `--bare` to the list with the same parenthetical rationale used by `claudeLauncherHelp()` and `mcp-tooling.md`: `--bare` disables skill / CLAUDE.md / plugin / MCP auto-discovery, hiding the curated `orchestrate-*` skills the supervisor depends on.

### Verification
- `git diff --check` clean (no whitespace errors introduced).
- `node scripts/sync-ai-workspace.mjs --check` reports projections in sync (no `.agents/` source touched, so no projections needed regeneration).
- `grep -n "background bash\|recommended way for a Claude" README.md` returns no matches; only the corrected "out-of-envelope" framing remains.
- `grep -n "--bare" README.md` shows the forbidden-flag entry with rationale; the README no longer contains text suggesting `--bare` is acceptable.

No source, test, or other docs were modified in this follow-up.

## Reviewer Follow-up #5 (2026-05-03)

The polling-only Claude supervisor from follow-ups #2-#4 conflicted with the
issue #13 product requirement: Claude Code should create a real background
monitor job per run so the runtime can wake when that job exits. This follow-up
restores that direction without re-introducing broad Bash access.

- **Fix:** the Claude supervisor built-in surface is now
  `Read,Glob,Grep,Bash`. Bash is pre-approved only for
  `Bash(<node> <agent-orchestrator> monitor *)` through generated settings and
  `--allowed-tools`; `--permission-mode dontAsk` denies anything outside the
  allowlist instead of prompting. `Edit`, `Write`, `WebFetch`, `WebSearch`,
  `Task`, `NotebookEdit`, and `TodoWrite` remain denied/unavailable.
- **Prompt:** after `start_run`, the supervisor is instructed to launch
  `<agent-orchestrator command> monitor <run_id> --json-line` with
  `Bash run_in_background: true`, parse the one JSON wake line, update the
  notification cursor, then fetch status/result as needed. `wait_for_any_run`
  remains the bounded fallback and `list_run_notifications` remains the
  cross-turn reconciliation path.
- **Discovery:** `--allowed-tools` and `--permission-mode` are required
  surfaces again, alongside `--tools`, `--setting-sources`, strict MCP config,
  settings injection, and append-system-prompt-file.
- **Docs:** README and `docs/development/mcp-tooling.md` once again describe
  `agent-orchestrator monitor <run_id>` as the Claude harness background
  monitor bridge, not merely an out-of-envelope user-shell helper.

### Superseded Evidence
- Follow-up #2's `--tools "Read,Glob,Grep"` / no-`--allowed-tools` model is
  superseded by `--tools "Read,Glob,Grep,Bash"` plus the pinned Bash monitor
  allow pattern and `dontAsk`.
- Follow-up #3's statement that `--allowed-tools` is optional is superseded:
  it is required to pre-approve the monitor command.
- Follow-up #4's README-only out-of-envelope monitor language is superseded:
  the Claude supervisor invokes the monitor itself as a background Bash task.

## Reviewer Follow-up #6 (2026-05-03)

The supervisor prompt now makes the run-supervision mechanisms hierarchical
instead of presenting them as interchangeable options:

- MCP starts runs and fetches authoritative state.
- The pinned Bash monitor is the normal current-turn wake path for runs started
  by the Claude supervisor.
- If the supervisor inherits active run IDs without live monitor handles, it
  launches new pinned monitors, using `--since <notification_id>` when it has a
  cursor.
- `list_run_notifications` is cross-turn reconciliation.

The prompt explicitly says to use exactly one active wait mechanism per run and
not to call MCP blocking wait tools from the Claude supervisor.

## Reviewer Follow-up #7 (2026-05-03)

OpenCode and Claude now have intentionally different, explicit run-supervision
contracts:

- OpenCode is MCP-only. Its prompt says not to use Bash,
  `Bash run_in_background`, or the monitor CLI; `wait_for_any_run` is the
  normal current-turn wake path, `wait_for_run` is compatibility fallback, and
  `list_run_notifications` is cross-turn reconciliation.
- Claude uses the pinned Bash monitor as the normal current-turn wake path,
  relaunches that same pinned monitor when no monitor handle exists, and is not
  allowlisted for MCP blocking wait tools.

README and `docs/development/mcp-tooling.md` now document this client-specific
matrix so future prompt changes do not collapse the two harness contracts.

## Reviewer Follow-up #8 (2026-05-03)

Live Claude smoke exposed that fallback language is not enough. Claude first
launched the pinned Bash monitor and then called synchronous `wait_for_run`; a
second smoke removed that path, but Claude still launched the monitor and then
called `wait_for_any_run` in parallel. The corrected contract is therefore:
Claude has exactly one blocking wait mechanism, the pinned Bash monitor.

- **Fix:** Claude's MCP tool allowlist excludes both MCP blocking wait tools:
  `mcp__agent-orchestrator__wait_for_any_run` and
  `mcp__agent-orchestrator__wait_for_run`. Generated Claude settings deny both
  tools explicitly, and spawn-time `--allowed-tools` omits both.
- **Prompt:** the Claude supervisor prompt no longer describes MCP waits as a
  fallback. After `start_run` or `send_followup`, Claude launches the pinned
  monitor with `Bash run_in_background: true`; if it later inherits active
  run IDs without live monitor handles, it launches a new pinned monitor,
  using `--since <notification_id>` when it has a cursor.
- **Coexistence:** both MCP blocking wait tools remain registered in the MCP
  server and remain available to OpenCode/generic clients. OpenCode stays
  MCP-only: `wait_for_any_run` is its normal current-turn wake path and
  `wait_for_run` is its bounded single-run compatibility fallback.

## Reviewer Follow-up #9 (2026-05-03)

Live Claude smoke showed that progress/status inspection still had an
uncontrolled escape hatch: after `get_run_events` returned a large MCP payload,
Claude shell-parsed the client-side saved tool-result file with `jq`/`head`.
That violated the intended supervisor model even though it was not a worker
wait.

- **MCP contract:** added `get_run_progress`, a compact, bounded progress tool
  that returns recent event summaries and extracted text snippets with
  `limit`, `after_sequence`, and `max_text_chars` controls. It is the preferred
  user-facing progress/status path; `get_run_events` remains for raw event
  debugging only.
- **Claude prompt and permissions:** Claude now explicitly uses
  `get_run_progress` for progress/status questions, must not inspect
  `.claude/projects` or `tool-results`, and must not use shell tools such as
  `jq`, `cat`, `head`, `tail`, `grep`, `rg`, `sed`, or `awk` for MCP output
  inspection. Generated settings deny those common shell-inspection patterns
  while still allowing only the pinned monitor command.
- **OpenCode parity:** the OpenCode supervisor prompt also names
  `get_run_progress` as the normal progress/status inspection tool while
  preserving its MCP-only wait path.
- **Docs/tests:** README and MCP tooling docs document the split; tests cover
  the new MCP schema, compact progress output, Claude deny rules/prompt text,
  and OpenCode prompt text.

## Reviewer Follow-up #10 (2026-05-03)

Live Claude usage showed the per-launch random temp envelope was too isolated:
Claude prompted to trust a different random project directory on every launch,
and supervisor session history/resume was fragmented by the changing cwd.

- **Fix:** the Claude launcher now uses a stable isolated envelope per target
  workspace under
  `${AGENT_ORCHESTRATOR_HOME:-$HOME/.agent-orchestrator}/claude-supervisor/envelopes/<workspace>-<hash>`.
  The hash is derived from the real target workspace path, so the same `--cwd`
  gets the same Claude project path across launches.
- **Isolation preserved:** the stable envelope is still not the target
  workspace and `--add-dir` is still not passed. Before each launch the
  launcher removes cwd-rooted Claude discovery surfaces from the envelope
  (`.claude/`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`) and regenerates
  only the curated orchestrate-* skill root plus the harness-owned
  `settings.json`, `mcp.json`, and system prompt.
- **State split:** Claude account/auth state remains in the durable supervisor
  `HOME/.claude`, while the stable envelope supplies only the project cwd used
  for trust prompts, project-scoped discovery, and supervisor session history.
- **Tests/docs:** the Claude harness test now asserts same-workspace launches
  reuse the same envelope path, stale poisoned discovery files are cleared on
  relaunch, and cleanup no longer removes the stable cwd. README and MCP
  tooling docs describe the stable-envelope behavior.

### Post-merge regression fix (2026-05-04): monitor deny shadow and empty Codex summaries

- **Symptom:** live `just local claude` testing showed the supervisor still had
  Bash available, but the pinned monitor command was denied. The generated
  settings allowed `Bash(<process.execPath> <cli> monitor * --json-line)` while
  also denying `Bash(*/node *)`; Claude deny precedence shadowed the required
  monitor command.
- **Fix:** `src/claude/permission.ts` no longer expands `node` into first-token
  deny patterns. Generic Node commands remain outside the positive allowlist and
  inline execution (`node -e`, `--eval`, etc.) remains denied. The launcher now
  asserts both exact monitor command shapes match an allow rule and no deny rule
  before producing the harness config.
- **Second symptom:** Codex `turn.completed` events can carry usage metadata but
  no summary, leaving `result.json.summary` empty even though the last
  `assistant_message` event contains the worker's actual answer.
- **Fix:** run finalization now falls back to the last assistant message when a
  successful backend result event has an empty summary. `get_run_result` also
  applies the same fallback for older persisted runs whose `result.json` already
  has an empty summary.
- **Evidence:** `src/__tests__/claudeHarness.test.ts` covers the monitor
  allow-vs-deny invariant and non-permitted write/exec shell samples;
  `src/__tests__/processManager.test.ts` covers persisted summary fallback for
  successful Codex runs; `src/__tests__/integration/orchestrator.test.ts` covers
  `get_run_result` fallback for older empty-summary results. Verification:
  `pnpm build`; `node --test dist/__tests__/claudeHarness.test.js
  dist/__tests__/processManager.test.js
  dist/__tests__/integration/orchestrator.test.js` (59 passed); `pnpm test`
  (255 passed, 1 skipped); `just local claude --print-config` confirmed the
  local launcher emits the two Node-backed monitor allow patterns without the
  previous `Bash(node *)` / `Bash(*/node *)` deny shadow.

## Plan Amendment (2026-05-04, PR #26 review): Bash retired, MCP wake path

> **Note (2026-05-04, post-merge fixes):** the "Bash retired" model below is
> itself superseded by the post-merge follow-up review fixes documented in
> `plans/13-add-support-for-claude-code/reviews/review-2026-05-04.md`. The
> current Claude supervisor exposes `Bash` again via `--tools` with a
> **positive Bash allowlist** containing only the pinned monitor command,
> `Bash(pwd)`, `Bash(git status)`, and `Bash(git status *)`. Comprehensive
> Bash deny patterns (shell metacharacters, write/exec/network commands,
> mutating/network git subcommands including `git -C *` / `git --git-dir*` /
> `git --work-tree*`, script interpreters, inline-script flags, package
> managers, command-dispatch builtins) are defense in depth on top of the
> allowlist + `--permission-mode dontAsk`. The pinned monitor (CLI:
> `agent-orchestrator monitor <run_id> --json-line`) is the supervisor's
> primary current-turn wake path, run as `Bash run_in_background: true`.
> `wait_for_any_run` and `wait_for_run` are denied for the Claude
> supervisor; `list_run_notifications` + `ack_run_notification` are the
> cross-turn reconciliation path. The MCP server entry sets
> `AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE` so `upsert_worker_profile` is
> restricted to the harness-pinned profiles manifest.



- **What changed (A9):** the original plan's "pinned background Bash monitor"
  wake path is retracted. `CLAUDE_SUPERVISOR_BUILTIN_TOOLS` is now
  `['Read', 'Glob', 'Grep']` and the launcher no longer adds any
  `Bash(<prefix> ...)` entry to `--allowed-tools` or
  `settings.permissions.allow`. The supervisor waits via
  `mcp__agent-orchestrator__wait_for_any_run` (cursored 60-second chunks) and
  reconciles with `mcp__agent-orchestrator__list_run_notifications` /
  `ack_run_notification`. `wait_for_run` stays denied. `monitorPin.ts` is
  removed; the external `agent-orchestrator monitor` CLI is preserved for
  non-Claude clients.
- **Why:** a `Bash(<prefix> *)` allowlist glob does not constrain shell
  metacharacters in the suffix. The supervisor could append `;`, `&&`, `|`,
  command substitution, redirection, or extra flags after the approved prefix
  and Claude would still pre-approve the line, breaking the deny-by-default
  isolation contract. The targeted `Bash(jq *)` / `Bash(cat *)` denies do not
  catch suffix injection behind the allowed prefix.
- **What changed (A10):** `--debug-file` is removed from the passthrough
  allowlist. It would let a caller specify a path outside the daemon-owned
  envelope/state dir, breaking the "Claude only writes inside `${stateDir}`"
  invariant. Both `--debug-file=/path` and `--debug-file /path` forms now hit
  the "rejects unknown flag" branch in `validateClaudePassthroughArgs`.
- **What changed (B1):** `RunStore.markTerminal` now appends the terminal (and
  any `fatal_error`) notification inside `withRunLock`, immediately after the
  meta/result/event writes. `RunStore.ensureReady` runs an idempotent
  `reconcileTerminalNotifications` pass that backfills missing notifications
  for runs whose `meta.json` is terminal but whose journal record was never
  written (crash gap). Sentinels (`.terminal_notification`,
  `.fatal_notification`) gate emission; reconciliation also handles the
  upgrade path where a journal record exists but the sentinel is missing.
  `ensureReady` is idempotent (`ready` flag short-circuits reentrant calls)
  so reconciliation cannot recurse through `appendNotification`.
- **Evidence:**
  - Tests: `src/__tests__/claudeHarness.test.ts` ("Bash is excluded across
    the entire supervisor envelope", "rejects --debug-file in both space and
    equals forms"), `src/__tests__/runStoreTerminalDurability.test.ts`
    (atomic emission, crash-gap reconciliation, sentinel-without-journal,
    journal-without-sentinel, no-recursion).
  - Source: `src/claude/permission.ts`, `src/claude/config.ts`,
    `src/claude/launcher.ts`, `src/claude/passthrough.ts`,
    `src/runStore.ts`, `src/notificationPushPoller.ts`.
  - Docs: README "Claude Code Orchestration Mode" and supervisor wait table,
    `docs/development/mcp-tooling.md` Claude harness section.
