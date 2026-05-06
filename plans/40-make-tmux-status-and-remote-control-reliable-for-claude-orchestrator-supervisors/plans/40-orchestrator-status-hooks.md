# Orchestrator Status Hooks

Branch: `40-make-tmux-status-and-remote-control-reliable-for-claude-orchestrator-supervisors`
Plan Slug: `orchestrator-status-hooks`
Parent Issue: #40
Created: 2026-05-06
Updated: 2026-05-06 (revision 5 — human Open-Human-Decisions answers applied; H1, H2, H4, H6-method resolved; reviewer-feedback iterations applied: #1 F1–F5 + non-blocking, #2 stale-timer anchoring + sidecar ULID validation + Claude worker isolation user-hook fixture, #3 stale-timer busy-loop guard with running/failed_unacked suppressors)
Status: implementation pass complete (reviewer iterations 1, 2, and 3 applied, re-review pending)

## Source: GitHub Issue #40

> Captured verbatim from `gh issue view 40 --repo ralphkrauss/agent-orchestrator --comments` so future reviewers and implementers can audit scope offline.

```text
title:  Add orchestrator status hooks for reliable tmux status and Remote Control
state:  OPEN
author: ralphkrauss (Ralph Krauss)
labels: enhancement
comments: 0

## Summary

`agent-orchestrator claude` should provide a reliable lightweight control surface for Claude Code supervisor sessions: Remote Control should work for the supervisor, and status displays should reflect daemon-owned orchestration state without being overwritten by background worker processes.

The immediate user-facing display is a tmux window/pane rename, but tmux should not be hard-coded as product behavior. The stable interface should be daemon-level **agent-orchestrator status hooks**. Users can implement tmux renaming, desktop notifications, webhooks, logs, or future UI integrations on top of those hooks.

## Product Intent

The desired mental model is:

- Claude Code is the cockpit: the user talks to the orchestrator there, locally or through Claude Remote Control.
- `agent-orchestrator` daemon is the control plane: it owns durable state, worker lifecycle, notifications, and aggregate status.
- Status hooks are display/event sinks: today a user hook may rename a tmux panel with an emoji, but the hook should render daemon-owned orchestration state rather than whichever Claude/worker process last fired a local hook.

This issue is a pragmatic short-term slice of the broader orchestrator identity work in #24. It should make the Claude supervisor usable as a reliable cockpit now, without requiring a full web control plane first. The hook interface should also be a foundation for a future web UI layer that consumes the same daemon-owned state.

## Current Behavior

Today, the Claude supervisor launch writes generated settings with `hooks: {}` and isolated Claude config, so user tmux hooks and Remote Control settings do not apply to the supervisor.

Worker processes are spawned with the daemon environment, so they can inherit tmux-related environment such as `TMUX` / `TMUX_PANE`. Claude workers may also load normal user Claude hooks. This lets background workers rename the same tmux window/pane that should belong to the supervisor, making the status indicator unreliable.

Relevant code:
- `src/claude/permission.ts` generates supervisor settings with `hooks: {}`.
- `src/claude/launcher.ts` writes isolated Claude settings and redirects `HOME`, `XDG_CONFIG_HOME`, and `CLAUDE_CONFIG_DIR`.
- `src/processManager.ts` spawns worker processes with `...process.env`.
- Related broader issue: #24.

## Desired Behavior

- The daemon owns orchestrator status and emits stable status events.
- The Claude supervisor can signal supervisor-local events to the daemon, such as turn started, turn stopped, and waiting for user.
- Worker lifecycle already flows through the daemon and should contribute to the same aggregate status.
- User-level agent-orchestrator hooks receive aggregate status payloads and decide how to present them.
- A user-level hook can rename tmux, but tmux is only one optional display sink.
- Worker processes do not directly update the supervisor's tmux/status display.
- Remote Control can be enabled for the Claude supervisor so the user can answer from mobile/web.

## Proposed Hook Interface

Add a user-level agent-orchestrator hook configuration, for example:

{
  "hooks": {
    "orchestrator_status_changed": [
      {
        "type": "command",
        "command": "~/.config/agent-orchestrator/hooks/tmux-status.sh"
      }
    ]
  }
}

Hooks should receive JSON on stdin. A v1 payload could look like:

{
  "version": 1,
  "event": "orchestrator_status_changed",
  "orchestrator": {
    "id": "orch_...",
    "client": "claude",
    "label": "payments-refactor",
    "cwd": "/path/to/worktree"
  },
  "status": {
    "state": "in_progress",
    "supervisor_turn_active": false,
    "waiting_for_user": false,
    "running_child_count": 2,
    "failed_unacked_count": 0
  },
  "display": {
    "tmux_pane": "%12",
    "tmux_window_id": "@4",
    "base_title": "payments-refactor"
  }
}

The `display` fields should be optional metadata captured from the supervisor launch. A tmux user hook can use them to rename a window or update pane styling, while other users can ignore them.

Suggested aggregate states:
- `in_progress`: supervisor turn active or any owned worker run is running.
- `waiting_for_user`: supervisor needs user input or approval.
- `idle`: supervisor is inactive and no owned worker runs are running.
- `attention`: an owned worker failed or needs acknowledgement.
- `stale`: the supervisor/display target disappeared or has not heartbeated.

## Worker Isolation Requirements

Worker processes should be prevented from interfering with supervisor status presentation.

Possible mechanisms:
- Strip `TMUX` / `TMUX_PANE` from worker subprocess environments by default.
- Set an env flag such as `AGENT_ORCHESTRATOR_WORKER=1` so any inherited user hooks can no-op in worker mode.
- For Claude worker runs, prevent inherited Claude hooks from renaming tmux directly, either through env isolation or generated worker-safe config.

Workers can still emit their own lifecycle through backend events and daemon run state. They just should not control the supervisor's tmux/status display directly.

## Remote Control Requirements

`agent-orchestrator claude` should support enabling Claude Remote Control for the supervisor without inheriting unsafe user settings wholesale.

This likely means selectively supporting remote-control-specific settings or flags, such as:
- `remoteControlAtStartup`
- `agentPushNotifEnabled`
- `--remote-control-session-name-prefix` or a generated supervisor/session name

The Remote Control session can be the cockpit from mobile/web, while daemon-owned hooks remain the source of reliable status and notifications.

## Acceptance Criteria

- [ ] Add or design a user-level agent-orchestrator hook interface for orchestrator status events.
- [ ] Hook payloads include enough stable context for user-level presentation, including orchestrator identity, aggregate status, and optional display metadata such as tmux target.
- [ ] Hook execution is best-effort, timeout-bound, and cannot block or fail orchestration.
- [ ] Worker subprocesses do not inherit tmux control by default, or are marked so tmux/status hooks can no-op in worker mode.
- [ ] Claude worker runs no longer rename the supervisor's tmux window/pane through inherited user hooks.
- [ ] `agent-orchestrator claude` supports Remote Control startup for the supervisor without inheriting unsafe user settings wholesale.
- [ ] The Claude supervisor can signal turn/activity/waiting state to the daemon, and worker lifecycle contributes to the same aggregate status.
- [ ] Supervisor status remains `in_progress` while any owned background run is still running.
- [ ] Tests cover worker env isolation for tmux variables, generated supervisor settings, hook payload generation, hook failure isolation, and aggregate status transitions.
- [ ] Docs explain that status is daemon-owned, hooks are presentation sinks, and worker lifecycle is aggregated through the daemon.

## Notes

Do not make tmux renaming built-in policy. Provide a stable hook/event interface and document tmux renaming as a user-level example.

A future web UI can build on the same daemon-owned state model and hook/event semantics, but this issue should avoid requiring that larger architecture before fixing the immediate tmux/Remote Control workflow.
```

## Context

This plan is the pragmatic short-term slice the issue describes. It implements
a daemon-owned orchestrator identity + aggregate status model, supervisor →
daemon turn signaling via harness-generated Claude Code hooks, a user-level
`agent-orchestrator` hook interface, worker subprocess isolation from tmux /
pane-correlation env vars and from inherited user Claude hooks, and an opt-in
Remote Control passthrough for the Claude supervisor. Tmux ships only as a
documented user-hook example; the daemon contains zero tmux logic.

Today's behavior (verified by reading the code, not assumed):

- `src/claude/permission.ts` (`buildClaudeSupervisorSettings`) generates
  supervisor `settings.json` with `hooks: {}`. The supervisor cannot run user
  Claude hooks today; this is intentional isolation, but it also blocks the
  controlled supervisor lifecycle hooks this plan needs.
- `src/claude/launcher.ts` (`buildClaudeEnvelope`) redirects `HOME`,
  `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, and launches with
  `--strict-mcp-config`, `--mcp-config`, `--settings`, `--tools`,
  `--allowed-tools`, `--permission-mode dontAsk`,
  `--append-system-prompt-file`, and `--setting-sources user`. The MCP server
  entry already pins `AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE` — a working
  precedent for pinning supervisor identity via the harness-owned MCP entry.
- `src/processManager.ts` spawns worker processes with `{...process.env,
  ...invocation.env, NO_COLOR:1, TERM:dumb}`. Worker processes therefore
  inherit `TMUX`, `TMUX_PANE`, `STY`, `WEZTERM_PANE`, `KITTY_WINDOW_ID`,
  `ITERM_SESSION_ID`, `WT_SESSION` and any user-side Claude/Codex/Cursor hook
  configuration on disk.
- `src/contract.ts` already models per-run `RunNotification` records with
  `terminal` and `fatal_error` kinds. There is no orchestrator-scoped status
  event type and no aggregate state.
- IPC method enum lives in `src/contract.ts` (`RpcMethodSchema`); the IPC
  server is in `src/ipc/server.ts`. MCP tools live in `src/mcpTools.ts`.
- `RpcPolicyContext` already exists in `src/contract.ts` and currently carries
  `writable_profiles_file`. It is the documented place to extend with
  `orchestrator_id` (per Reviewer Answer 2).
- `claude --help` (verified locally on Claude Code 2.1.129) confirms a CLI
  flag `--remote-control-session-name-prefix <prefix>`. Remote Control
  enablement settings keys (`remoteControlAtStartup`, `agentPushNotifEnabled`,
  `remoteControlSessionNamePrefix`) appear in the local Claude binary strings
  but are not in official Claude Code public settings docs; T7 includes a
  local smoke test recording the Claude version covered.
- Issue #24 (broader watch dashboard / orchestrator-identity work) is the
  longer arc. #40 must produce data shapes that #24 can later persist.

Sources read:

- GitHub issue #40 (verbatim above) and issue #24 (linked broader work)
- `AGENTS.md`, `CLAUDE.md`
- `.agents/rules/node-typescript.md`,
  `.agents/rules/ai-workspace-projections.md`,
  `.agents/rules/mcp-tool-configs.md`
- `.agents/skills/create-plan/SKILL.md`
- `src/claude/{launcher,permission,passthrough,config,monitorPin}.ts`
- `src/processManager.ts`, `src/orchestratorService.ts`, `src/runStore.ts`
- `src/contract.ts`, `src/mcpTools.ts`, `src/server.ts`, `src/serverPolicy.ts`
- `src/ipc/{server,client,protocol}.ts`
- `src/notificationPushPoller.ts`, `src/cli.ts`, `src/daemonCli.ts`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md`
- `claude --help` (Claude Code 2.1.129 CLI flag inventory)

## Confirmed Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Source of truth for status | Daemon-owned aggregate state model. The Claude supervisor only **signals** local turn events; the daemon **decides** the displayed status by combining supervisor turn state with owned worker run state. | Issue mandates "daemon owns orchestrator status". Avoids races where worker processes overwrite supervisor display. | (a) Supervisor computes status itself — rejected: cannot see workers spawned by previous sessions, contradicts worker-isolation requirement. (b) Workers update display directly — rejected explicitly by the issue. |
| 2 | Orchestrator identity scope | First-class `OrchestratorRecord` registered in the daemon at supervisor launch with fields `{id, client: 'claude', label, cwd, display: {tmux_pane, tmux_window_id, base_title, host}, registered_at, last_supervisor_event_at}`. The launcher generates the id (ULID via the existing `runStore` ULID source) **before** spawning Claude and pins it into the supervisor process via env. | Schema is forward-compatible with #24, avoids supervisor-side forging because the harness, not the model, sets the id. Mirrors the `AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE` pinned-env precedent. | (a) Hash of supervisor PID + cwd — rejected: fragile across restarts and not human-readable for debugging. (b) Supervisor sends id in each MCP call's body — rejected: model could forge or omit it. |
| 3 | Supervisor → daemon turn signaling | Claude Code lifecycle hooks generated by the harness in supervisor `settings.json`. The hook config uses Claude's documented nested `hooks.<EventName>[].matcher` / `hooks.<EventName>[].hooks[]` structure (per [Claude Code Hooks reference](https://docs.claude.com/en/docs/claude-code/hooks); verified against Claude Code 2.1.129). Per the Claude Hooks reference, `type: "command"` handlers are invoked as a **single shell-command string**, not as a `spawn(argv)` form. The harness composes that string from a pinned absolute CLI path (Decision 21) plus statically shell-quoted, repo-controlled tokens only (e.g. `'/abs/path/to/agent-orchestrator' supervisor signal UserPromptSubmit`). Lifecycle events used: `UserPromptSubmit`, `Notification`, `Stop`, `SessionStart`, `SessionEnd`. See Decision 3b for the explicit Claude-event → supervisor-state mapping. **Invariants:** (a) the harness-generated hook command strings include only repo-controlled tokens and never interpolate untrusted/user/model-supplied data; (b) hook commands for `UserPromptSubmit` and `SessionStart` must produce no stdout — Claude treats stdout from those events as additional context for the model. The CLI wrapper writes to stderr only (or to a state file under `<store_root>/hooks/...`) and exits 0. **Shell-execution split (canonical):** *Harness-generated* Claude supervisor hooks (this decision + Decision 21) are static-token, pinned-absolute-path shell-command strings authored by the orchestrator and contain **no untrusted interpolation**, even though Claude itself shell-interprets the value. *User* `~/.config/agent-orchestrator/hooks.json` entries (Decision 25) are executed by the daemon with `shell: true` (Claude parity, per Decision 7). The two surfaces both run as shell strings but differ in who authors them and therefore in what protects them. | Hooks are a stable Claude Code surface and the hook event names + invocation form are documented and verified against the local Claude binary. The harness fully owns the supervisor `hooks` object, so user hooks are still not loaded. Static repo-controlled tokens eliminate shell-injection surface even though Claude shell-interprets the string. | (a) Parse Claude stream-json — rejected: only works with `--print`, supervisor is interactive. (b) Periodic supervisor heartbeat via MCP tool call — rejected: requires the model to do plumbing and won't fire on user input. (c) Use a `spawn(argv)`-style hook entry — rejected: Claude Hooks reference defines `type: "command"` as shell-string; there is no argv form. |
| 3b | Claude lifecycle event → supervisor-state mapping | Each Claude lifecycle event maps to one internal `SupervisorEvent` consumed by the aggregate-status engine. Mapping (encoded as a single source-of-truth table in `src/claude/permission.ts` so T2 and T8 agree):<br/>• `UserPromptSubmit` → `turn_started`. Sets `supervisor_turn_active = true`. Recomputes aggregate via the precedence rule below.<br/>• `Stop` → `turn_stopped`. Sets `supervisor_turn_active = false`. Recomputes aggregate.<br/>• `Notification` → `waiting_for_user`. Sets a sticky `waiting_for_user = true` flag, cleared on the next `UserPromptSubmit`/`Stop`. Recomputes aggregate.<br/>• `SessionStart` → `session_active`. Marks the orchestrator as live, refreshes `last_supervisor_event_at`, resets `stale` timer.<br/>• `SessionEnd` → `session_ended`. Aggregate transition: → `stale` immediately; the orchestrator record is kept until either the launcher unregisters it (cleanup) or `STALE_AFTER_SECONDS` elapses without re-register.<br/>**Live-state precedence (highest first), evaluated each tick — supersedes the simpler precedence in earlier drafts of Decision 4:**<br/>1. `attention` — any unacked `fatal_error` on an owned run.<br/>2. `in_progress` (because `running_child_count > 0`) — at least one owned run is currently `running`. **This rule directly encodes AC8: supervisor status stays `in_progress` while any owned background run is still running, regardless of the supervisor's own turn flag or any sticky `waiting_for_user` flag.**<br/>3. `waiting_for_user` — `waiting_for_user` flag is set and rules 1–2 do not match.<br/>4. `in_progress` (because `supervisor_turn_active`) — supervisor is mid-turn but no owned runs are running and no `waiting_for_user` flag is set.<br/>5. `idle` — none of the above.<br/>`stale` is computed independently of rules 1–5 and overrides the live state when the supervisor has reported `session_ended` **or** when `last_supervisor_event_at` is older than `STALE_AFTER_SECONDS` and the owned-run set is empty (Decision 4). Decision 4's narrative is updated by this rule; if the two ever drift, this row is canonical. | Makes the supervisor↔aggregate relationship explicit so T2 (hook generation), T3 (CLI signal handling), and T8 (aggregate computation) cannot drift. The 5-rule precedence resolves the contradiction in earlier drafts where `Notification` could appear to override `in_progress` while owned runs were running — rule 2 dominates rule 3, so AC8 holds for every event ordering. | (a) Implicit mapping (assumed from Decision 4) — rejected: invites drift. (b) Earlier 4-rule precedence (`attention > waiting_for_user > in_progress > idle`) — rejected: contradicted AC8 because `waiting_for_user` could mask `in_progress` while owned runs ran. |
| 4 | Aggregate status state machine | Five states (`attention | in_progress | waiting_for_user | idle | stale`), computed deterministically by the daemon on every state-changing event. State definitions match the issue's "Suggested aggregate states" verbatim. **The authoritative selection rule across these states is the 5-rule live-state precedence in Decision 3b** — that table supersedes any earlier narrative in this row. `stale` is the only state computed outside the live-state precedence: it overrides when the supervisor has reported `session_ended` **or** when `last_supervisor_event_at` is older than `STALE_AFTER_SECONDS` (named v1 constant `= 600`, see Decision 17) and the owned-run set is empty. Idempotent re-emit is suppressed by deep-equal on the previous payload. | Matches the issue's suggested aggregate states verbatim. Deterministic computation via Decision 3b's precedence makes the AC8 invariant ("`in_progress` while owned runs are running") testable. | (a) "needs_attention sticky until ack" alternative — rejected: collapses the state machine but loses ordering with `waiting_for_user`. (b) Earlier 4-rule precedence (`attention > waiting_for_user > in_progress > idle`) — rejected as contradicting AC8; replaced by Decision 3b's 5-rule precedence. |
| 5 | User-level hook configuration file | New file `~/.config/agent-orchestrator/hooks.json` (used on Linux **and macOS** — see Decision 19). Schema in Decision 6. Loaded by the daemon at startup and cached with mtime; reread when mtime changes (cheap fstat per emission). Missing or invalid → no hooks; daemon logs a single warning per startup. | Mirrors existing `~/.config/agent-orchestrator/` layout. JSON keeps schema validation easy via Zod. | Reading from `settings.json` was rejected: there is no daemon-wide settings file today. Putting hooks in env vars was rejected for ergonomics. |
| 6 | Hook payload contract (v1) and `hooks.json` v1 schema (Claude-parity shell-string form, per human decision H4) | **Payload** written to the hook process's stdin matches the issue's example exactly, plus three fields for idempotency: `event_id` (ULID), `previous_status` (or `null` initially), `emitted_at` (ISO-8601). Top-level `version: 1` is required. Numeric counts are always present (`0` when no children). Display block populated when supervisor launch captured tmux env. Schema validated by Zod and exported from `src/contract.ts`.<br/>**`hooks.json` v1 schema (final, Claude Code parity):**<br/>`{`<br/>`  "version": 1,`<br/>`  "hooks": {`<br/>`    "orchestrator_status_changed": [`<br/>`      {`<br/>`        "type": "command",`<br/>`        "command": "<shell command string>",`<br/>`        "env": {"...": "..."},   // optional, default {}`<br/>`        "timeout_ms": 1500          // optional, default 1500, max 5000`<br/>`      }`<br/>`    ]`<br/>`  }`<br/>`}`<br/>`command` is a **shell-command string** (matching Claude Code's `type: "command"` semantics). Daemon-side execution uses a shell (Decision 7). **No `args` field in v1.** **No `filter` field in v1.** The schema is **closed at every level** via Zod `.strict()`: any unknown key is rejected by validation, including but not limited to `args` and `filter` per-entry, and any unknown top-level key (e.g. `extra_root`), unknown key inside the `hooks` object (e.g. `hooks.other_event`), or unknown per-entry key (e.g. `extra: true`). v2 can add fields additively by widening the schema; v1 consumers stay safe. User hook scripts that want to discriminate on state, client, or counts read those fields directly from the JSON payload on stdin and exit 0 on no-ops.<br/>**Threat model (explicit invariant):** `~/.config/agent-orchestrator/hooks.json` is a **user-owned, user-trusted** file, exactly like `~/.claude/settings.json` `hooks` entries. The daemon **must not** interpolate any model-supplied, worker-supplied, or run-supplied data into `command`. The daemon **must not** offer any remote-write path to this file (no MCP/IPC tool writes to it). User-side write protection (file mode, `chown`) is the user's responsibility, mirroring Claude Code. | The issue's example payload is already close to a stable contract; the three extra fields make hook scripts idempotent without breaking the documented shape. **Claude-parity shape** lets users move existing `~/.claude/settings.json` `hooks` entries into `~/.config/agent-orchestrator/hooks.json` with the same `{type, command, timeout_ms}` mental model — the human decision (H4) prioritized that ergonomic over the strict-argv safety. Keeping v1 minimal means the public surface only contains what AC1–AC10 actually require — adding `args` / `filter` later is additive (default-permissive), removing them later would be a breaking change. | (a) **Strict argv (`command` = executable path + `args: string[]`, `shell:false`)** — reconsidered and **rejected** per human decision H4 in favor of Claude-parity. The blocking finding **B2** from iteration 1 (argv-vs-shell-string contradiction) is therefore superseded: there is no argv form on the daemon side in v1; both the documented contract and the runtime use the same shell-string form. (b) Letting users opt into shell vs argv — rejected for v1; defer to v2 if a real need surfaces. (c) `filter.states` / `filter.client` in v1 — rejected per reviewer iteration 2. Adding `filter` in v2 stays backward-compatible because absence today means "always run". |
| 7 | Hook execution semantics (Claude-parity shell, per human decision H4) | Best-effort: invoke the user's `command` through a shell that matches Claude Code's behavior — concretely, `child_process.spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: <restricted> })`. Stdin = JSON payload (Decision 6). Stdout / stderr captured to `<store_root>/hooks/<orchestrator_id>/<event>-<event_id>.log` (file mode `0o600`). Per-entry `timeout_ms` (default 1500 ms, max 5000 ms) enforced via `setTimeout` + `child.kill('SIGKILL')`; on timeout the daemon also `SIGKILL`s the spawned shell's process group when the platform supports it (parity with Claude's hook timeout behavior). The daemon never awaits the result before continuing other work. Failures, non-zero exits, and timeouts increment per-hook counters surfaced via `get_observability_snapshot` and never affect daemon orchestration.<br/>**Restricted env passthrough:** `AGENT_ORCHESTRATOR_ORCH_ID`, `AGENT_ORCHESTRATOR_EVENT`, `PATH`, `HOME`, `LANG`, plus per-entry `env` overrides; everything else is dropped. The daemon **never** interpolates payload data into `command` (the JSON payload reaches the script via stdin only).<br/>**This shell-execution rule applies only to user `hooks.json` entries.** The harness-generated Claude supervisor hooks (Decisions 3 / 21) keep their static-token, statically-quoted shell-command-string composition with the pinned absolute CLI path — Claude itself shell-interprets those, but the orchestrator authors them, so injection surface is zero. | Issue requires "best-effort, timeout-bound, cannot block or fail orchestration". Captured logs are essential for debugging. Restricted env keeps hook scripts reproducible. Claude-parity shell execution lets users move their existing `~/.claude/settings.json` hook commands directly into `hooks.json` (per human decision H4). | (a) `shell:false` argv exec — reconsidered and rejected per H4 in favor of Claude parity. (b) Inheriting full daemon env — rejected: would leak unrelated secrets. (c) Awaiting hook completion in the orchestration path — rejected: would block orchestration on a slow user script. |
| 8 | Worker tmux/terminal env stripping | `ProcessManager.start` strips **only** terminal-multiplexer / pane-correlation env vars: `TMUX`, `TMUX_PANE`, `STY`, `WEZTERM_PANE`, `KITTY_WINDOW_ID`, `ITERM_SESSION_ID`, `WT_SESSION`. The rest of the parent env is preserved unchanged. Sets `AGENT_ORCHESTRATOR_WORKER=1`, `AGENT_ORCHESTRATOR_WORKER_RUN_ID=<run_id>`, and (when known) `AGENT_ORCHESTRATOR_PARENT_ORCHESTRATOR_ID=<orchestrator_id>`. | Issue requires both env stripping and a worker flag. Limiting strip to multiplexer vars avoids surprising changes to unrelated tooling that depends on the daemon's env. | A new opt-out env var was rejected for v1 to keep the surface small. |
| 9 | Claude **worker** isolation from user Claude hooks | Generate a worker-side `settings.json` with `{ "disableAllHooks": true }` written to a per-run temp file; pass `--settings <path>` and `--setting-sources user`. Do **not** redirect `CLAUDE_CONFIG_DIR` and do **not** use `--bare` by default. T13 includes a unit/integration test asserting that user `~/.claude/settings.json` hooks do not fire under a Claude worker run with these flags. If `disableAllHooks: true` is empirically insufficient, the **fallback** is to add a `CLAUDE_CONFIG_DIR` redirect (documented in Decision 9b below) — this fallback is **only** taken if T13 fails. | `disableAllHooks: true` is the least-disruptive isolation surface and preserves keychain/auth/memory/discovery for the worker. (Resolves blocking finding **B5** and Reviewer Answer 3.) | (a) `--bare` — rejected: disables keychain/auth/memory/discovery the worker often needs. (b) Redirected `CLAUDE_CONFIG_DIR` first — rejected for v1: bigger blast radius; kept only as a fallback. |
| 9b | Fallback worker isolation (only if Decision 9 proves insufficient) | Redirect `CLAUDE_CONFIG_DIR` to `<store_root>/runs/<run_id>/claude-config/`, write a worker-safe `settings.json` with `{ "hooks": {}, "disableAllHooks": true }` there, pass `--settings` + `--setting-sources user` as in Decision 9. Documented as a fallback so the test failure is the trigger, not a design choice. | Mirrors the supervisor envelope's redirect pattern. Only used if T13 proves needed. | — |
| 10 | Owned-run correlation | The harness-owned MCP server entry pins `AGENT_ORCHESTRATOR_ORCH_ID=<id>` (alongside `AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE`). The MCP frontend forwards the value into the `RpcPolicyContext` as a new optional field `orchestrator_id`, extending the existing `serverPolicy.ts` plumbing. The daemon stamps `metadata.orchestrator_id` on every `start_run` / `send_followup` whose `policy_context.orchestrator_id` is set, and returns it as part of the response so callers can verify. The model never authors `metadata.orchestrator_id`. Calls without a pinned id (e.g. CLI smoke tests) leave the metadata field unset and runs are not aggregated. | Mirrors and extends the proven isolation precedent. (Resolves Reviewer Answer 2.) | (a) Pass id explicitly via tool params — rejected: model could forge/omit. (b) Socket-keyed registration at MCP handshake — rejected: harder to test; reviewer ruled out. |
| 11 | Display metadata capture | At launcher startup, capture `TMUX`, `TMUX_PANE`, and (when `TMUX` is set and `tmux` is on `PATH`) the result of `tmux display-message -p -F '#{window_id}'` for the current pane (`shell:false`, 500 ms timeout). Capture `--orchestrator-label <name>` (default = `basename(cwd)`) and store under `display.base_title`. Supervisor `cwd` is also stored. All capture is best-effort; failures leave the field `null`. | Display metadata must be optional. Capturing once at launch keeps hook payloads cheap. | Live-querying tmux on every emission was rejected: extra latency and tmux may have closed. |
| 12 | Remote Control opt-in | New launcher flag `--remote-control` toggles emitting `remoteControlAtStartup: true` and `agentPushNotifEnabled: true` into the generated supervisor `settings.json`. New launcher flag `--remote-control-session-name-prefix <prefix>` is plumbed through to a Claude `--remote-control-session-name-prefix` argv pair. The existing passthrough validator (`src/claude/passthrough.ts`) gains `--remote-control-session-name-prefix` to the allow list so users can also pass the flag through `--`. Without `--remote-control`, supervisor settings remain RC-disabled (today's default). The launcher records the local Claude version covered by the smoke test in plan evidence (T14). | Matches the issue's call-out: "selectively supporting remote-control-specific settings or flags". The CLI flag `--remote-control-session-name-prefix` is the documented surface; the settings keys `remoteControlAtStartup` / `agentPushNotifEnabled` / `remoteControlSessionNamePrefix` are observed in the local Claude binary but not in public docs, so T7 acceptance includes a local smoke test. (Resolves Reviewer Answer 4.) | Accepting wholesale `~/.claude/settings.json` was rejected — explicitly forbidden by the issue. |
| 13 | Tmux is a documented user hook example, not built-in | Ship one example hook script under `examples/hooks/tmux-status.sh`, marked executable in repo metadata, that defaults to **ASCII state labels** (e.g. `[in_progress]`, `[attention]`); emoji are an opt-in via an env var inside the script. Reference the script from `docs/development/orchestrator-status-hooks.md`. The daemon ships zero tmux logic. | Issue says explicitly "Do not make tmux renaming built-in policy". ASCII default mirrors a "documented example" framing more conservatively than emoji. (Resolves H7 / Reviewer disposition.) | Bundling a tmux helper into the daemon was rejected by the issue. Emoji-only default was reframed to ASCII default + emoji opt-in. |
| 14 | New IPC + CLI surface (no public MCP tool, per human decision H2) | Add **internal-only** IPC methods `register_supervisor`, `signal_supervisor_event`, `unregister_supervisor`, and `get_orchestrator_status`. Per human decision H2 = (c), `get_orchestrator_status` is **not** exposed as a public MCP tool in v1; instead, a new CLI subcommand `agent-orchestrator supervisor status` (in the same `supervisor` family as `register` / `signal` / `unregister` from T3) reads the IPC method and prints a JSON document for shell scripts. The first three IPC methods are never exposed as MCP tools so the model cannot forge supervisor turn signals. The existing top-level `agent-orchestrator status` subcommand is reserved for daemon status and **must not** be overloaded with orchestrator-status semantics. `RpcMethodSchema` is extended; daemon-version mismatch handling already exists in IPC. | Keeps supervisor signaling private to the harness. The CLI subcommand under `supervisor status` provides shell-script consumers without growing the public MCP surface. The supervisor model can invoke its own CLI through the existing pinned `Bash` allowlist if a future skill needs status — but in v1, no MCP tool is registered. | (a) Public MCP tool — rejected per human decision H2. (b) Overloading `agent-orchestrator status` — rejected: existing daemon-status surface, would conflate semantics. (c) Exposing `register_supervisor` / `signal_supervisor_event` / `unregister_supervisor` as MCP tools — rejected: would defeat Decision 3. |
| 15 | Backward compatibility | Existing run records without `metadata.orchestrator_id` keep working; they don't appear in any orchestrator's owned-run set and don't trigger hooks. Users without `~/.config/agent-orchestrator/hooks.json` get current behavior. The supervisor `hooks: {}` invariant becomes `hooks: <harness-generated block>`; user hooks are still not loaded because `--setting-sources user` only loads the redirected harness-owned settings. The `ClaudeSupervisorSettings` type widens from `Record<string, never>` to a typed `ClaudeSupervisorHooks` shape. | No public CLI/MCP contract is broken. The Claude supervisor surface stays curated. | Versioning the hooks file format from v1 was deferred — start with `version: 1`, add migrations only if needed. |
| 16 | Status emission cadence and de-duplication | Status hooks fire only when computed `state` changes **or** when `running_child_count` / `failed_unacked_count` changes by ≥1, debounced to at most one emission per 250 ms per orchestrator. The "previous payload" is held in memory keyed by `orchestrator_id` and reset on `unregister_supervisor`. | Avoids hook flapping when many small worker events fire in close succession. | "Fire on every event" was rejected: overwhelms shell hook scripts. |
| 17 | Stale threshold is a named v1 constant | `STALE_AFTER_SECONDS = 600` is a named constant exported from a new `src/daemon/orchestratorStatus.ts` module. **Not** tunable via `hooks.json` v1 (keeps the public schema small). Adjustable in code only. | Reviewer Answer 6. Display behavior should not expand the new public schema. | Tunable via `hooks.json` — rejected to keep v1 schema stable. |
| 18 | `attention` aggregation scope | Aggregate only runs whose `metadata.orchestrator_id` equals the current orchestrator's id. Cross-supervisor / same-cwd aggregation stays deferred to #24. | Reviewer Answer 7. Matches issue #40 scope. | Cross-restart aggregation — deferred to #24. |
| 19 | macOS hooks file path | `~/.config/agent-orchestrator/hooks.json` on Linux and macOS. Do not honor `~/Library/Application Support/agent-orchestrator/`. | Reviewer Answer 5. Matches existing repo convention; uniform across Linux and macOS. | Darwin XDG fallback — rejected for this feature. |
| 20 | RunStore lifecycle observation | Add an explicit observer/callback path: `OrchestratorService` exposes `onRunLifecycle((event) => ...)` (event = `started | activity | terminal | notification`). The aggregate-status engine subscribes to this. The current code paths in `RunStore.appendEvent`, `RunStore.markTerminal`, and `RunStore.appendFatalErrorNotification` are wired into this observer at well-defined points so the engine is a pure consumer. (Resolves blocking finding **B3** — the original draft incorrectly assumed lifecycle events were already emitted on a bus.) | Avoids tight coupling between RunStore and the status engine. Easy to test by injecting a fake observer. | Polling RunStore from the engine — rejected: extra latency and load. |
| 21 | Pinned supervisor-CLI invocation | Harness-generated supervisor hooks invoke the supervisor-signal CLI through a **pinned absolute path** to the `agent-orchestrator` binary (resolved via `process.execPath` + the package's `cli.js`, mirroring the existing `monitorPin` pattern). The hook command never resolves through `PATH`. Because Claude Code `type: "command"` handlers are invoked as a shell-command string (Decision 3), the harness composes the string by **shell-quoting each repo-controlled token at generation time** (single-quote wrapping, with single-quote escapes; equivalent to `monitorPin`'s POSIX-quoted token shape). The composed string for an event has the fixed form `'<abs-bin>' supervisor signal <Event>` where `<Event>` is one of the five enumerated identifiers (no shell metacharacters by construction). The harness must **never** interpolate untrusted, user-supplied, or model-supplied data into this string; only the absolute binary path and the static event identifier are inserted. (Resolves blocking finding **B4** and reviewer iteration-2 blocker 1.) | Defense in depth: a user shadowing `agent-orchestrator` on `PATH` cannot intercept supervisor signals. Static repo-controlled tokens make shell-string injection unreachable even though Claude shell-interprets the value. Mirrors the proven `monitorPin` pattern. | (a) `PATH`-relative resolution — rejected: insecure and unstable. (b) `spawn(argv)`-style hook entry — rejected: Claude Hooks reference defines `type: "command"` as shell-string. |
| 22 | Supervisor signal exit codes | The `agent-orchestrator supervisor signal` CLI returns: `0` for success or non-fatal failure (daemon down / IPC unreachable / orchestrator not registered), `1` for invalid event name (programming error). It **never** returns `2` because Claude treats `UserPromptSubmit` / `Stop` hook exit code `2` as a blocking signal that suppresses the user's prompt or assistant turn. (Resolves blocking finding **B1**.) | `0`-on-IPC-failure preserves the orchestration flow when the daemon is briefly unavailable; `1` flags a real coding error in the harness. | Distinct exit codes per failure mode — rejected: any non-2 non-zero would still be safe, but `0` is ideal for transient IPC failures. |
| 23 | Public CLI surface for the launcher (resolves prior H1 = (a)) | `agent-orchestrator claude` ships **both** `--remote-control` and `--orchestrator-label` as accepted public flags. `--remote-control` toggles the documented Remote Control settings keys per Decision 12. `--orchestrator-label <name>` sets the orchestrator's display label per Decision 11; defaults to `basename(cwd)` when the flag is absent. Both flags appear in `claudeLauncherHelp()`, are documented in the README, and are exercised by T13 / T14. The launcher's `--print-config` reflects both. | The human chose option (a). Both flags carry distinct concerns (RC opt-in vs label customization) and are cheap to ship together. | (b) `--remote-control` only, derive label from cwd — rejected: lost flexibility for users who want a custom label. (c) `--orchestrator-label` only, RC via Claude passthrough — rejected: drops the documented settings-key emission and shifts RC enablement off the harness. |
| 24 | Supervisor status surface (resolves prior H2 = (c)) | No public MCP tool for orchestrator status in v1 (Decision 14). Instead, `agent-orchestrator supervisor status` is a new CLI subcommand, in the same `supervisor` family as `register` / `signal` / `unregister` (T3). Output is JSON on stdout (`{ orchestrator: {...}, status: {...}, display: {...} }`, matching the v1 hook payload minus the `event` / `event_id` / `previous_status` / `emitted_at` fields). Read-only. Exit code `0` on success, `1` on missing `--orchestrator-id` or unknown id; never `2`. The existing `agent-orchestrator status` subcommand (daemon status) is **reserved** and is **not** overloaded with orchestrator-status semantics. T10 implements this CLI subcommand; T13 / T14 verify it instead of an MCP tool registration. | The human chose option (c) with the preferred non-conflicting CLI name. Avoids growing the MCP surface in v1 while still giving shell scripts a documented consumer. The existing `status` subcommand reservation prevents an accidental overload. | (a) Public MCP tool — rejected per H2. (b) IPC-only — rejected: leaves no surface for shell scripts. (d) `agent-orchestrator orchestrator-status` or `agent-orchestrator status --orchestrator <id>` — rejected: less consistent with the new `supervisor` subcommand family. |
| 25 | `hooks.json` user contract (resolves prior H4 = Claude parity) | Claude-parity shell-string form per Decision 6. v1 schema is exactly `{version: 1, hooks.orchestrator_status_changed[].{type: "command", command: <string>, env?, timeout_ms?}}`. Daemon-side execution uses `shell:true` per Decision 7. The `args` field and the `filter` field are both **rejected by the v1 schema** so v2 can add them additively. The harness-generated Claude supervisor hooks (Decisions 3 / 21) keep their static-token, statically-quoted shell-string composition with the pinned absolute CLI path — that distinction is preserved. **Threat model:** `~/.config/agent-orchestrator/hooks.json` is user-owned and user-trusted; the daemon never interpolates model/run/worker data into `command` and exposes no remote-write path to the file. **Note on B2:** the iteration-1 blocking finding B2 (argv-vs-shell-string contradiction) is **superseded** by this decision because the v1 contract and the runtime now agree on shell-string form; B2's resolution path through "strict argv + `shell:false`" is replaced by "Claude-parity shell-string + threat-model invariant". | The human chose Claude parity so users can move existing `~/.claude/settings.json` hook entries verbatim. Threat model is identical to Claude's own hook-execution model, which the user has already accepted by editing `~/.claude/settings.json`. | (a) Strict argv + `shell:false` — reconsidered and rejected per H4. (b) Argv vs shell discriminator in v1 — rejected: extra complexity with no concrete user demand. (c) `filter` in v1 — rejected per reviewer iteration 2; deferred to v2. |
| 26 | Worker-side Claude hook isolation method (resolves prior H6-method = (a)) | Decision 9's chosen method is final: generated worker `settings.json` with `{ "disableAllHooks": true }`, passed via `--settings <path>` and `--setting-sources user`. **No `CLAUDE_CONFIG_DIR` redirect** in v1. Decision 9b (redirected `CLAUDE_CONFIG_DIR`) remains documented as a **test-driven fallback** that is only triggered if T13's `claudeWorkerIsolation.test.ts` proves `disableAllHooks: true` is empirically insufficient against a representative user `~/.claude/settings.json` hook. T5 / T13 acceptance is unchanged. | The human chose option (a) — least disruptive isolation, preserves keychain / auth / memory / discovery for the worker. | (b) Redirected `CLAUDE_CONFIG_DIR` unconditionally — rejected as default; kept only as the test-driven fallback. (c) `--bare` — rejected by reviewer (disables keychain/auth/memory/discovery). |

## Assumptions

These are no longer reviewer questions; the reviewer's answers have been
folded into the decisions above. They are recorded here so future reviewers
can audit them.

- **A1.** Claude Code 2.1.129's `settings.json.hooks` accepts the nested
  `hooks.<EventName>[].matcher` / `hooks.<EventName>[].hooks[]` shape used in
  Decision 3. T2 reproduces the verified shape; T13 has a regression test
  that diffs the launcher's offline `--print-config` output (the orchestrator
  launcher's own config-dump path; not a live Claude validation) against a
  golden `settings.json` fixture so any drift in the harness-generated shape
  is caught at test time. Live validation against the local Claude binary is
  the deferred, opt-in T14b live smoke.
- **A2.** `RpcPolicyContext` can carry `orchestrator_id` without breaking
  existing `writable_profiles_file` plumbing in `src/serverPolicy.ts`.
  (Reviewer Answer 2.)
- **A3.** A worker `settings.json` with `disableAllHooks: true` plus
  `--setting-sources user` prevents inherited user `~/.claude/settings.json`
  hooks from running. T13 verifies this; if it fails, Decision 9b applies.
- **A4.** The Remote Control settings keys observed in the local Claude
  binary (`remoteControlAtStartup`, `agentPushNotifEnabled`,
  `remoteControlSessionNamePrefix`) are interpreted by Claude Code 2.1.129
  the same way the issue body suggests. T14 records the observed Claude
  version in plan evidence so a future Claude release that changes these
  keys is detected.
- **A5.** Hook scripts are user-owned; we do not need to sandbox them beyond
  the documented timeout / no-shell envelope.
- **A6.** `tmux display-message -p -F '#{window_id}'` is portable enough
  across the Linux/macOS tmux versions in current use; falling back to
  `null` when it errors is acceptable.
- **A7.** The orchestrator registry can be in-memory for v1; persistence
  across daemon restarts is deferred to #24. If the daemon restarts while a
  supervisor is running, the supervisor's next hook signal triggers a
  re-register transparently.

## Reviewer Questions

_None — all 7 prior questions resolved by reviewer feedback and folded into
Decisions 1–22 / Assumptions A1–A7._

## Open Human Decisions

**none.**

All prior open items (H1, H2, H4, H6-method) were resolved by the human in
this revision and folded into Confirmed Decisions 23–26. Earlier-resolved
items (H3, H5, H6-goal, H7) are listed under "Previously resolved" below for
audit.

### Previously resolved (audit trail)

- **H1 → Decision 23.** Both `--remote-control` and `--orchestrator-label`
  ship on `agent-orchestrator claude` (option (a)).
- **H2 → Decision 24.** No public MCP tool for orchestrator status in v1;
  ship IPC + the new CLI subcommand `agent-orchestrator supervisor status`
  (option (c) with the preferred CLI name).
- **H3 (IPC additions + protocol bump):** Internal-only methods, covered by
  existing `PROTOCOL_VERSION_MISMATCH` handling and the daemon version-skew
  tests. Documented in T15. Not user-blocking.
- **H4 → Decision 25.** Claude-parity shell-string form for
  `~/.config/agent-orchestrator/hooks.json`; daemon-side `shell:true`
  execution per Decision 7; threat-model invariant documented; B2 is
  superseded by this decision.
- **H5 (worker terminal-multiplexer env stripping):** The issue body
  explicitly requests stripping `TMUX` / `TMUX_PANE` and adding
  `AGENT_ORCHESTRATOR_WORKER=1`. Decision 8 limits stripping to multiplexer
  vars only and preserves the rest of parent env.
- **H6 (goal):** workers no longer fire user supervisor hooks — resolved by
  Decision 9.
- **H6-method → Decision 26.** Method (a): generated worker `settings.json`
  with `disableAllHooks: true`, no `CLAUDE_CONFIG_DIR` redirect. Decision 9b
  remains as a test-driven fallback only.
- **H7 (example tmux hook in `examples/hooks/`):** Consistent with the
  issue's "documented example" framing. ASCII labels are the default; emoji
  are opt-in (Decision 13).

## Acceptance Criteria Trace

Maps the 10 acceptance criteria from the embedded issue body (AC1 = first
checkbox, AC10 = last) to the Decisions, Tasks, and Tests that cover them.

| AC | Issue text (abridged) | Covered by Decisions | Implemented by Tasks | Verified by Tests |
|---|---|---|---|---|
| AC1 | Add or design a user-level agent-orchestrator hook interface for orchestrator status events. | D5, D6, D19 | T9, T12 | T13 (`orchestratorHooks.test.ts`, `orchestratorHooksSchema.test.ts`) |
| AC2 | Hook payloads include orchestrator identity, aggregate status, and optional display metadata. | D2, D6, D11 | T1, T7, T9 | T13 (schema test asserts shape against the issue's example) |
| AC3 | Hook execution is best-effort, timeout-bound, and cannot block or fail orchestration. | D7 | T9 | T13 (timeout, failure-isolation, missing-file cases) |
| AC4 | Worker subprocesses do not inherit tmux control by default, or are flagged so hooks can no-op. | D8 | T4 | T13 (`processManagerEnvIsolation.test.ts`) |
| AC5 | Claude worker runs no longer rename the supervisor's tmux through inherited user hooks. | D9 (with D9b fallback) | T5 (T5b if needed) | T13 (`claudeWorkerIsolation.test.ts`) |
| AC6 | `agent-orchestrator claude` supports Remote Control startup without inheriting unsafe user settings wholesale. | D12 | T7, T11 | T14 (RC config smoke offline; T14b live smoke deferred) |
| AC7 | Supervisor can signal turn/activity/waiting state; worker lifecycle aggregates into the same status. | D1, D3, D3b, D4, D10, D20 | T2, T3, T6, T6b, T8 | T13 (state-machine + mapping tests), T14 (integration end-to-end) |
| AC8 | Supervisor status remains `in_progress` while any owned background run is still running. | D3b rule 2 (`in_progress` if `running_child_count > 0`, dominates `waiting_for_user` and the supervisor-turn-active form of `in_progress`); D4 references it. | T8 | T13 (`orchestratorStatus.test.ts`: the AC8 invariant test pair from T8 — sticky `waiting_for_user` does not mask `in_progress` while running children exist; symmetric test where `supervisor_turn_active = false` but running children still drive `in_progress`). |
| AC9 | Tests cover worker env isolation, supervisor settings, hook payload generation, hook failure isolation, aggregate transitions. | — (covered by T13 task definition) | T13 | T13 (all listed unit-test files) |
| AC10 | Docs explain that status is daemon-owned, hooks are presentation sinks, worker lifecycle aggregates through the daemon. | D1, D13 | T12, T15 | Manual quality gate (README + new doc) |

Coverage is exhaustive: every AC maps to at least one Decision, Task, and
Test entry. AC9 is explicitly a test-coverage requirement and is fully
discharged by T13.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| R1 | Claude Code release renames or drops a hook event used in Decision 3. | Hook generation is data-driven from a single table in `src/claude/permission.ts`. T13 includes a regression test that diffs the launcher's offline `--print-config` output (the orchestrator launcher's own config-dump path) against a golden `settings.json` fixture, so drift in the harness-generated shape is caught at unit-test time. Drift in Claude's own interpretation of those settings is caught by the deferred, opt-in T14b live smoke. | T2, T13, T14b |
| R2 | Hook command from `hooks.json` runs slow / hangs. | Per-hook `timeout_ms` (default 1500 ms, max 5000 ms), enforced via `setTimeout` + `child.kill('SIGKILL')`. Exec is not awaited by the orchestration path. Counters expose timeout rate via `get_observability_snapshot`. | T9 |
| R3 | Two orchestrators on the same machine try to register identical labels. | `orchestrator_id` is ULID; `label` is descriptive only and never used as a key. Hook payload includes both so user scripts can disambiguate. | T6 |
| R4 | Supervisor crashes without firing `SessionEnd`. | Daemon marks the orchestrator `stale` after `STALE_AFTER_SECONDS` (= 600) and re-emits status. Owned runs continue to completion. | T6, T8 |
| R5 | Worker subprocess invokes its own tmux command. | Decision 8 strips multiplexer env so child shells don't see `TMUX`. Decision 9 disables Claude hooks for Claude workers. We accept that a worker that explicitly invokes `tmux` against a known socket can still rename panes; that is a user-script concern, not a harness concern. | T4, T5 |
| R6 | Hook `command` shell string references secrets inline. | Hook commands run through a user-trusted shell per Decisions 7 / 25, identical to Claude Code's own hook model. Hook stdout/stderr is captured to `<store_root>/hooks/...` with mode `0o600`. Logs are pruned alongside `prune_runs` retention. The daemon **never** interpolates payload data into `command`; the JSON payload reaches the script via stdin only. Document that secrets in shell strings should be referenced via env vars rather than inlined. | T9, T15 |
| R7 | Remote Control accidentally exposes the supervisor pane to mobile when not desired. | RC is opt-in: default `--remote-control` is off; supervisor settings stay RC-disabled. README + new doc explain the opt-in. T14 smoke records the Claude version under test. | T7, T14, T15 |
| R8 | Orchestrator id forging by a non-supervisor MCP client. | The daemon stamps `metadata.orchestrator_id` only from the per-MCP-server pinned env via `RpcPolicyContext.orchestrator_id`; clients without the pinned env can't write that metadata. | T6 |
| R9 | Race: status hook fires while a new run starts. | Decision 16's per-orchestrator debounce + last-payload de-dup means at most one emission per 250 ms; the new run flips `running_child_count` on its next emission. | T8, T13 |
| R10 | User upgrades daemon but supervisor process is still running with old IPC contract. | Daemon already enforces matched protocol versions (`PROTOCOL_VERSION_MISMATCH`). The launcher restart on next supervisor launch reconciles. Document in PUBLISHING.md. | T15 |
| R11 | Hook payload growth breaks small shell consumers. | Payload is JSON on stdin (not argv), so size is bounded by stdin buffer (~64 KB). Schema is strictly typed; v1 fields are short. | T13 |
| R12 | Claude `UserPromptSubmit` / `SessionStart` hook stdout becomes unintended model context. | The harness-pinned CLI writes only to stderr / log files and exits `0`. T13 has a unit test that runs `agent-orchestrator supervisor signal <event>` against a mock daemon and asserts stdout is empty. | T3, T13 |
| R13 | Hook script behavior diverges between user shells. | Per Decisions 7 / 25, `command` is a shell string executed through `child_process.spawn(command, { shell: true })`, matching Claude Code semantics. Behavior follows the system default shell on POSIX (typically `/bin/sh`). The daemon does not normalize the user's chosen shell; documentation in T15 describes this and recommends users prefer POSIX-portable scripts. **Note:** the iteration-1 risk that motivated this row (shell-metacharacter abuse via injection) is no longer applicable to user `hooks.json` because the user authored the string themselves; it remains mitigated on the harness side by the static-token invariant in Decision 21. | T9, T15 |

## Implementation Tasks

Tasks are grouped into four interleaved deliverables; suggested order is
**T1 → T2 → T3 → T4 → T5 → T6 → T6b → T7 → T8 → T9 → T10 → T11 → T12 →
T13 → T14 → T15**. Test work happens incrementally per unit and is
consolidated under T13 (unit) and T14 (integration / live smoke).

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T1 | Define orchestrator status contract types in `src/contract.ts` | — | pending | Adds `OrchestratorRecordSchema`, `OrchestratorStatusStateSchema` (5 states), `OrchestratorStatusPayloadSchema` (v1 payload from issue + `version`/`event_id`/`previous_status`/`emitted_at`), `SupervisorEventSchema` (turn_started/turn_stopped/waiting_for_user/session_active/session_ended), and `OrchestratorHooksFileSchema` (Decision 6 v1 schema). Extends `RpcPolicyContextSchema` with optional `orchestrator_id`. Exports inferred TS types. Unit test asserts shapes. |
| T2 | Generate harness-owned Claude supervisor hooks | T1 | pending | `buildClaudeSupervisorSettings` accepts hook input and emits a populated nested `hooks.<EventName>[].matcher` / `hooks.<EventName>[].hooks[]` block whose `command` is a **shell-command string** built by `composeSupervisorHookCommand(eventName)` from the **pinned** supervisor-CLI path (Decision 21). Composition uses single-quote shell-escaping of the absolute binary path and concatenates the static event identifier; the function rejects any input that would introduce shell metacharacters and is unit-tested against an injection-style fixture. The supervisor settings type widens to `ClaudeSupervisorHooks`. Generated hook shape verified against Claude Code 2.1.129 via `--print-config`. T13 includes a regression test for the exact hook event name set, the shell-string form, and the static-token invariant. The Claude-event → supervisor-state mapping table from Decision 3b is the single source of truth for which events the harness emits. The harness-generated hooks remain the only hooks present. |
| T3 | Add `agent-orchestrator supervisor` CLI subcommands | T1, T2 | pending | New CLI subcommands `register`, `signal <event>`, `unregister`. `signal` reads `AGENT_ORCHESTRATOR_ORCH_ID` from env, accepts hook context on stdin from Claude, and never writes to stdout (Decision 3, R12). Exit codes: `0` for success or transient failure (daemon down / not registered), `1` for invalid event name; **never `2`** (Decision 22 / B1). Help output is concise. Unit tests cover stdout-empty invariant, env-id-missing, daemon-unreachable, success paths, and exit-code mapping. |
| T4 | Strip terminal-multiplexer env + add worker flags in `ProcessManager` | — | pending | `ProcessManager.start` removes only `TMUX`, `TMUX_PANE`, `STY`, `WEZTERM_PANE`, `KITTY_WINDOW_ID`, `ITERM_SESSION_ID`, `WT_SESSION` (Decision 8) — the rest of the parent env is preserved unchanged. Sets `AGENT_ORCHESTRATOR_WORKER=1`, `AGENT_ORCHESTRATOR_WORKER_RUN_ID=<run_id>`, `AGENT_ORCHESTRATOR_PARENT_ORCHESTRATOR_ID=<id-or-empty>`. Unit test asserts the worker process sees neither tmux env nor mutation of unrelated env. |
| T5 | Claude worker isolation via `disableAllHooks: true` | T4 | pending | Claude **worker** invocations write a per-run `settings.json` with `{ "disableAllHooks": true }` to a per-run temp file (Decision 9). The worker spawn passes `--settings <path>` and `--setting-sources user`. Idempotent on retries. T13 includes a test asserting that a representative user `~/.claude/settings.json` hook **does not fire** under a worker run. If T13 fails, switch to Decision 9b (redirected `CLAUDE_CONFIG_DIR`); T5b below covers the fallback. |
| T5b | Fallback: redirected `CLAUDE_CONFIG_DIR` for Claude workers | T5 if needed | pending (gated) | Only runs if T13's hook-isolation test under Decision 9 fails. Adds the per-run `CLAUDE_CONFIG_DIR` redirect under `<store_root>/runs/<run_id>/claude-config/` and writes both `hooks: {}` and `disableAllHooks: true` there. Updates docs to record the chosen method. |
| T6 | Daemon orchestrator registry + IPC methods | T1, T2 | pending | New module `src/daemon/orchestratorRegistry.ts` holds an in-memory map keyed by `orchestrator_id`. New IPC methods `register_supervisor`, `signal_supervisor_event`, `unregister_supervisor`, `get_orchestrator_status` wired through `src/server.ts`. `start_run` / `send_followup` stamp `metadata.orchestrator_id` from `RpcPolicyContext.orchestrator_id` (Decision 10). Protocol version bumps. Unit test covers register/signal/get round trip and forge prevention. |
| T6b | RunStore lifecycle observer | T6 | pending | Add `OrchestratorService.onRunLifecycle((event) => ...)` (Decision 20 / B3). Events fire from `RunStore.appendEvent` (`activity`, `notification`), `RunStore.markTerminal` (`terminal`), and `RunStore.appendFatalErrorNotificationIfNew` (`notification`). Pure consumer pattern: the engine subscribes from T8. Unit test verifies the observer fires the right events at the right boundaries. |
| T7 | Launcher integration: register orchestrator + Remote Control opt-in | T2, T6 | pending | `runClaudeLauncher` calls IPC `register_supervisor` with captured display metadata before spawning Claude, stores the returned `orchestrator_id` in env for the supervisor process, and pins it into the MCP server entry's env. New flags `--orchestrator-label` and `--remote-control` (both confirmed by Decision 23), plus `--remote-control-session-name-prefix`. `--print-config` reflects the new state. Unit tests cover `print-config` output (with and without each new flag), env propagation, that RC settings keys are emitted only with `--remote-control`, and that `--orchestrator-label demo` propagates to the registered orchestrator's `display.base_title`. **Acceptance also requires** the offline RC config smoke in T14 recording Claude version 2.1.129 (or current). |
| T8 | Aggregate status state machine + hook-emission scheduler | T1, T6, T6b | pending | New module `src/daemon/orchestratorStatus.ts` computes the 5-state status from supervisor event log + owned-run snapshot + unacked notifications using the **5-rule live-state precedence** from Decision 3b (`attention` > `in_progress` if `running_child_count > 0` > `waiting_for_user` > `in_progress` if `supervisor_turn_active` > `idle`; `stale` overrides on `session_ended` or timeout). Subscribes to `OrchestratorService.onRunLifecycle`. Debounces 250 ms; suppresses unchanged payloads. Calls into the hook executor (T9). Exports `STALE_AFTER_SECONDS = 600` (Decision 17). Unit tests cover each Claude-event → supervisor-state mapping from Decision 3b, all five precedence rules, and debounce behavior. **AC8-specific test:** with `running_child_count > 0`, fire `Notification` (sticky `waiting_for_user`) and assert aggregate stays `in_progress`; clear children and assert aggregate transitions to `waiting_for_user`. **Symmetric test:** with `supervisor_turn_active = false` and `running_child_count > 0`, assert aggregate is `in_progress` (rule 2 fires regardless of supervisor turn flag). |
| T9 | Hook executor + `hooks.json` v1 loader (Claude-parity) | T1 | pending | New module `src/daemon/orchestratorHooks.ts` loads `~/.config/agent-orchestrator/hooks.json` (Decision 19), validates with the v1 Zod schema (Decisions 6 / 25 — Claude-parity shell-string form; no `args` field, no `filter` field; closed schema), caches by mtime. `executeHook(payload, entry)` invokes the user's shell command via `child_process.spawn(command, { shell: true, stdio: ['pipe','pipe','pipe'], env: <restricted> })` (Decision 7), no inherited env beyond the documented passthrough, `timeout_ms` enforced via SIGKILL on the spawned shell's process group when the platform supports it. Captures stdout/stderr to `<store_root>/hooks/<orchestrator_id>/<event>-<event_id>.log` (mode `0o600`). Tracks success/failure/timeout counters. Never throws into the caller. **Daemon never interpolates payload data into `command`** (payload reaches the script via stdin only). Unit tests cover: happy-path shell command (e.g. `echo $AGENT_ORCHESTRATOR_EVENT > /tmp/...`), timeout, missing file, schema-invalid file (including the closed-schema rejection tests below to assert `.strict()` at every level), `command` accepts arbitrary strings (no shell-metacharacter rejection — that test is dropped per H4), and stdio capture into the per-event log file. **Closed-schema rejection tests (all four required):** (a) per-entry `args` field rejected; (b) per-entry `filter` field rejected; (c) per-entry generic unknown key rejected with a fixture like `{type:"command", command:"echo hi", env:{}, timeout_ms:1500, extra: true}`; (d) top-level unknown key rejected (e.g. `{version:1, hooks:{...}, extra_root: true}`) AND unknown key inside the `hooks` object rejected (e.g. `{hooks:{orchestrator_status_changed:[...], other_event:[...]}}`). |
| T10 | CLI subcommand `agent-orchestrator supervisor status` (resolves H2 = (c)) | T3, T6 | pending | New subcommand in the `supervisor` family alongside `register` / `signal` / `unregister` from T3. Reads `--orchestrator-id <id>` (or falls back to `AGENT_ORCHESTRATOR_ORCH_ID` from env) and calls IPC `get_orchestrator_status`. Output is JSON on stdout: `{ orchestrator: {...}, status: {...}, display: {...} }` (the v1 hook payload minus `event` / `event_id` / `previous_status` / `emitted_at`). Read-only. Exit codes: `0` on success, `1` on missing/unknown id; never `2`. **No MCP tool is registered** (per Decision 24). The existing top-level `agent-orchestrator status` subcommand stays reserved for daemon status and is not modified. Unit tests assert: subcommand prints valid JSON for a registered orchestrator, exits `1` with a clear stderr message for an unknown id, and that no new MCP tool name appears in `src/mcpTools.ts`. |
| T11 | Update Claude passthrough validator and launcher help | T7 | pending | `src/claude/passthrough.ts` adds `--remote-control-session-name-prefix` to `ALLOWED_FLAG_TOKENS`. `claudeLauncherHelp()` documents the new opt-in flags `--remote-control` and `--orchestrator-label` (confirmed by Decision 23) alongside the passthrough flag. Unit test covers the new allowed Claude flag, confirms both `--remote-control` and `--orchestrator-label` are launcher-side (not forwarded to Claude), and asserts the help text mentions both. |
| T12 | Example tmux hook + docs | T9, T8 | pending | `examples/hooks/tmux-status.sh` reads the v1 payload from stdin, falls back gracefully when `display.tmux_pane` is absent, and renames the pane with **ASCII state labels by default** plus an opt-in env var to use emoji (Decision 13). Marked executable. The example is wired in `hooks.json` exactly the way Claude Code users already wire `~/.claude/settings.json` hooks — `{"type": "command", "command": "~/.config/agent-orchestrator/hooks/tmux-status.sh", "timeout_ms": 1500}` — per Decision 25. New doc `docs/development/orchestrator-status-hooks.md` describes the v1 payload, hook file location, `version` field, the **Claude-parity shell-string convention** (Decisions 6 / 7 / 25), the user-trusted-file threat model, and links to the example. The doc also documents the new `agent-orchestrator supervisor status` CLI subcommand from T10. README gains a short "Status hooks" section that mentions both `--remote-control` and `--orchestrator-label` per Decision 23. |
| T13 | Unit test suite (split by area) | T1–T11 | pending | Independent unit-test files: `orchestratorStatus.test.ts` (must include the AC8 invariant test from T8: `Notification` arriving while `running_child_count > 0` keeps aggregate `in_progress`, and a symmetric test where the supervisor turn flag is false but a running child still drives `in_progress`), `orchestratorHooks.test.ts` (executes the user shell command via `shell:true`, asserts stdio capture and timeout SIGKILL), `orchestratorHooksSchema.test.ts` (schema validation only — independent from any live Claude invocation; **closed-schema rejection tests at every level**: (a) per-entry `args` rejected, (b) per-entry `filter` rejected, (c) per-entry generic unknown key rejected (fixture `{type:"command", command:"echo hi", env:{}, timeout_ms:1500, extra: true}`), (d) top-level unknown key rejected (`{version:1, hooks:{...}, extra_root:true}`) and unknown key inside the `hooks` object rejected (`{hooks:{orchestrator_status_changed:[...], other_event:[...]}}`); positive test that `command` accepts arbitrary shell strings including metacharacters per H4), `orchestratorRegistry.test.ts`, `claudeWorkerIsolation.test.ts` (asserts user `~/.claude/settings.json` hooks do not fire under a worker; gates Decision 9 vs Decision 9b), `processManagerEnvIsolation.test.ts`, `supervisorStatusCli.test.ts` (exercises `agent-orchestrator supervisor status` per T10, asserts JSON shape and exit codes, and asserts no new MCP tool name appears in `src/mcpTools.ts`), plus extensions to `claudeHarness.test.ts` (harness-generated shell-string hook composition + injection-fixture rejection — note the harness side keeps its static-token invariant per Decisions 3 / 21, separate from the user-side shell-string acceptance) and `mcpTools.test.ts`. Hook payload schema, runner timeout, owned-run correlation, RC opt-in, passthrough validator, launcher offline `--print-config` output (covering both `--remote-control` and `--orchestrator-label` per Decision 23), supervisor-signal CLI stdout invariant. |
| T14 | Integration test + RC config smoke (offline) | T13 | pending | Extend `src/__tests__/integration/orchestrator.test.ts` with an end-to-end test that registers an orchestrator, simulates supervisor turn events, starts and finishes a worker run with stamped `metadata.orchestrator_id`, and asserts that the `agent-orchestrator supervisor status` CLI (T10) reports the expected aggregate state at each step. Hook executor is mocked at the spawn boundary. The CLI is invoked as a child process so the integration test exercises the same surface the user has. **RC config smoke (offline):** a separate test fixture runs `agent-orchestrator claude --remote-control --orchestrator-label demo --print-config` (which does **not** start Claude or enter Remote Control) and asserts the generated `settings.json` contains the documented RC keys, the harness-generated nested `hooks` block from T2, the pinned absolute supervisor-CLI path, and the chosen orchestrator label per Decision 23. The fixture **records the Claude version observed by `--print-discovery`** in plan evidence (Decision 12, R7). This task does NOT prove that Claude actually enters Remote Control on launch — that is **T14b**. |
| T14b | RC live smoke (deferred / opt-in) | T7, T14 | deferred | A minimal opt-in smoke that actually launches Claude with `--remote-control` against the local binary and asserts that Claude reports a Remote Control session as active (e.g. by checking the supervisor's stderr / Claude's session record under the redirected `CLAUDE_CONFIG_DIR`). Gated on `CLAUDE_BIN` being present and an explicit env opt-in (e.g. `AGENT_ORCHESTRATOR_RC_LIVE_SMOKE=1`) so CI does not require Anthropic credentials. Records the Claude version under test in plan evidence. **Scheduling is the implementer's call** — the offline config smoke (T14) is sufficient by default; T14b runs only when an operator opts in via the env flag. |
| T15 | Docs + release notes | T11, T12 | pending | Update README "Claude Code" section to mention both `--remote-control` and `--orchestrator-label` (Decision 23) and the `agent-orchestrator supervisor status` CLI subcommand (Decision 24). Add `docs/development/orchestrator-status-hooks.md` covering the Claude-parity `hooks.json` v1 schema (Decision 25), the user-trusted-file threat model, and a worked example identical in shape to a `~/.claude/settings.json` hook. Update `PUBLISHING.md` with a note about the protocol-version bump and the new user config file. Add a short note in the Claude supervisor's system prompt that supervisor turn signaling is automatic and the user's tmux/desktop hook will see it. Document that full Remote Control enablement is sensitive to local Claude version and reference the version recorded by T14. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| RC1 | "User-config files belong under `~/.config/agent-orchestrator/`; daemon may read at startup and on mtime change, never write." | Daemon-wide guidance in `.agents/rules/` | T9 lands |
| RC2 | "Supervisor identity is harness-set via pinned MCP-server env; the model never authors `metadata.orchestrator_id`." | Claude/MCP guidance in `.agents/rules/` | T6 lands |
| RC3 | "User `hooks.json` execution is best-effort, timeout-bound, never blocks orchestration. The daemon executes the user's `command` via `shell:true` (Claude Code parity) and never interpolates payload data into the command string — the payload reaches the script via stdin only. Harness-generated Claude supervisor hooks are a separate surface and keep the static-token, statically-quoted shell-string invariant against the pinned absolute CLI path." | New rule capturing the contract | T9 lands |
| RC4 | "Supervisor-signal CLI hook shapes for Claude `UserPromptSubmit`/`SessionStart` must keep stdout empty (Claude treats stdout as model context)." | Claude harness guidance | T3 lands |

## Quality Gates

- [ ] `pnpm install --frozen-lockfile` succeeds.
- [ ] `pnpm build` passes.
- [ ] `pnpm test` passes (new tests above + existing tests still green).
- [ ] `pnpm verify` passes (publish readiness, dependency audit, npm pack
      dry run).
- [ ] `node scripts/sync-ai-workspace.mjs --check` reports no drift after any
      `.agents/` rule additions are projected.
- [ ] No lint regressions in `src/` and tests.
- [ ] **T14 (offline RC config smoke):** records the Claude binary version
      observed by `agent-orchestrator claude --print-discovery` (e.g.
      `2.1.129`) in plan evidence under "Execution Log" → T14. This gate
      does **not** require Claude to actually launch with Remote Control.
- [ ] **T14b (live RC smoke):** deferred / opt-in. Only required when the
      human reviewer schedules T14b (per H1/H2 disposition); records the
      Claude version under test in plan evidence under "Execution Log" →
      T14b. The offline T14 gate above remains required regardless.
- [ ] Manual smoke (per AGENTS.md "Local Claude Tmux Smoke Testing") confirms:
      - Supervisor `--print-config` shows the harness-generated nested hooks
        block referencing the pinned CLI absolute path.
      - Worker subprocess env does not contain `TMUX` / `TMUX_PANE`; rest of
        env is preserved.
      - A status hook script logged to `<store_root>/hooks/...` receives a
        v1 payload during a worker run.
      - `--remote-control` adds the documented settings keys; default
        launcher does not.
      - `agent-orchestrator supervisor signal UserPromptSubmit` produces no
        stdout.

## Execution Log

### T1: Define orchestrator status contract types
- **Status:** done
- **Evidence:** Added `OrchestratorRecordSchema`, `OrchestratorStatusStateSchema`, `OrchestratorStatusSnapshotSchema`, `OrchestratorStatusPayloadSchema`, `SupervisorEventSchema`, `OrchestratorHookCommandEntrySchema` (.strict()), `OrchestratorHooksMapSchema` (.strict()), `OrchestratorHooksFileSchema` (.strict()), `RegisterSupervisorInputSchema`, `SignalSupervisorEventInputSchema`, `UnregisterSupervisorInputSchema`, `GetOrchestratorStatusInputSchema` to `src/contract.ts`. Extended `RpcPolicyContextSchema` with optional `orchestrator_id`. Extended `RpcMethodSchema` with the four new IPC methods.
- **Notes:** Verified by `pnpm build`; closed-schema rejection covered by `src/__tests__/orchestratorHooksSchema.test.ts` (rejection cases (a)–(d) all green).

### T2: Generate harness-owned Claude supervisor hooks
- **Status:** done
- **Evidence:** `src/claude/permission.ts` now exports `ClaudeSupervisorHooks`, `CLAUDE_SUPERVISOR_HOOK_EVENT_NAMES`, `composeSupervisorHookCommand`, `buildClaudeSupervisorHooks`. `buildClaudeSupervisorSettings` widens `hooks: Record<string, never>` to a populated nested `hooks.<EventName>[].hooks[]` block whose `command` uses the pinned absolute supervisor-CLI path via `quoteCommandTokens`. `composeSupervisorHookCommand` rejects any non-enumerated event name (injection-style fixture covered in `src/__tests__/claudeHarness.test.ts`).
- **Notes:** Static-token invariant: command is `'<nodePath>' '<cli.js>' supervisor signal <Event>` with each repo-controlled token POSIX-quoted at generation time.

### T3: Add `agent-orchestrator supervisor` CLI subcommands
- **Status:** done
- **Evidence:** New `src/supervisorCli.ts` with `register`, `signal`, `unregister`, `status`. `signal` reads `AGENT_ORCHESTRATOR_ORCH_ID` from env, drains stdin, **never writes to stdout**, and exits **0 on transient/IPC failures, 1 on invalid event, never 2** (Decision 22 / B1). Wired into `src/cli.ts`.
- **Notes:** Covered by `src/__tests__/supervisorStatusCli.test.ts` (signal stdout invariant, exit-code mapping including never-2, daemon-down transient path).

### T4: Strip terminal-multiplexer env + add worker flags
- **Status:** done
- **Evidence:** `src/processManager.ts` exports `WORKER_STRIPPED_TERMINAL_ENV_VARS` and `stripTerminalMultiplexerEnv`. `ProcessManager.start` now strips the seven multiplexer vars (`TMUX`, `TMUX_PANE`, `STY`, `WEZTERM_PANE`, `KITTY_WINDOW_ID`, `ITERM_SESSION_ID`, `WT_SESSION`), preserves the rest of the parent env, and adds `AGENT_ORCHESTRATOR_WORKER=1`, `AGENT_ORCHESTRATOR_WORKER_RUN_ID=<run_id>`, and (when known) `AGENT_ORCHESTRATOR_PARENT_ORCHESTRATOR_ID=<id>` derived from the run's `metadata.orchestrator_id`.
- **Notes:** Covered by `src/__tests__/processManagerEnvIsolation.test.ts`.

### T5: Claude worker isolation via `disableAllHooks: true`
- **Status:** done
- **Evidence:** `src/backend/claude.ts` exports `CLAUDE_WORKER_SETTINGS_FILENAME` / `CLAUDE_WORKER_SETTINGS_BODY`. `ClaudeBackend` accepts a `RunStore` and writes per-run `claude-worker-settings.json` containing `{ "disableAllHooks": true }` (mode 0o600), then injects `--settings <path>` and `--setting-sources user` into both `start()` and `resume()` invocations. Idempotent across retries because the path is deterministic.
- **Notes:** Covered by `src/__tests__/claudeWorkerIsolation.test.ts`. Decision 9 (no `CLAUDE_CONFIG_DIR` redirect) holds; T5b stays gated.

### T5b: Fallback `CLAUDE_CONFIG_DIR` redirect (gated)
- **Status:** deferred (gated)
- **Evidence:** Not triggered: T13's `claudeWorkerIsolation.test.ts` passes under Decision 9, so the fallback in Decision 9b remains unused.
- **Notes:** Documented in plan; would only be implemented if a future regression proves `disableAllHooks: true` insufficient against a representative user `~/.claude/settings.json` hook.

### T6: Daemon orchestrator registry + IPC methods
- **Status:** done
- **Evidence:** New `src/daemon/orchestratorRegistry.ts` (in-memory map keyed by `orchestrator_id`, `applyEvent` implements Decision 3b mapping). `OrchestratorService.dispatch` wires `register_supervisor`, `signal_supervisor_event`, `unregister_supervisor`, `get_orchestrator_status`. `start_run` and `send_followup` stamp `metadata.orchestrator_id` from `RpcPolicyContext.orchestrator_id` via `stampOrchestratorIdInMetadata`. The MCP frontend (`src/serverPolicy.ts`) forwards the pinned `AGENT_ORCHESTRATOR_ORCH_ID` env into the IPC policy_context for `start_run` and `send_followup` only; the model never authors this field.
- **Notes:** Covered by `src/__tests__/orchestratorRegistry.test.ts` and the new integration test in `src/__tests__/integration/orchestrator.test.ts` (`orchestrator status flow`). No protocol-version bump needed: existing `PROTOCOL_VERSION_MISMATCH` handling continues to enforce daemon/frontend agreement on the new method enum.
- **Reviewer-feedback hardening (F1, D10/R8):** `stampOrchestratorIdInMetadata` was tightened to **always strip a caller-supplied `orchestrator_id` first** before re-adding the pinned value. This catches both model-supplied stamps (via `start_run`/`send_followup` `metadata`) and parent-inherited stamps (via `metadataForFollowup`). Helper exported for unit testing and covered by `src/__tests__/orchestratorIdForgePrevention.test.ts` (six cases including the strip-without-pin and replace-with-pin paths) and a new integration scenario in `src/__tests__/integration/orchestrator.test.ts` (`forge prevention: model-supplied metadata.orchestrator_id is stripped in start_run and send_followup unless pinned (D10/R8)`).

### T6b: RunStore lifecycle observer
- **Status:** done
- **Evidence:** `OrchestratorService.onRunLifecycle()` plus an internal `emitRunLifecycle` are wired around the managed-run start/completion path so the engine is a pure consumer (Decision 20 / B3). Lifecycle events fire on `started`, `terminal`, and on fatal `notification` boundaries with the orchestrator id resolved from `metadata.orchestrator_id`.
- **Notes:** The status engine subscribes via `service.onRunLifecycle` in `bootDaemon.ts` and recomputes aggregate status with the 250 ms debounce.

### T7: Launcher integration + Remote Control opt-in
- **Status:** done
- **Evidence:** `src/claude/launcher.ts` parses new flags `--remote-control`, `--remote-control-session-name-prefix`, `--orchestrator-label`. `runClaudeLauncher` generates a ULID orchestrator id, captures display metadata via `captureSupervisorDisplay` (TMUX, TMUX_PANE, `tmux display-message -p -F '#{window_id}'` with `shell:false` 500ms timeout, hostname, label), passes both into `buildClaudeEnvelope`, calls IPC `register_supervisor` before spawn (failures don't block launch), and `unregister_supervisor` on shutdown. The MCP server entry's env pins `AGENT_ORCHESTRATOR_ORCH_ID`; the supervisor's spawn env also exposes it. `--print-config` prints orchestrator id, label, RC enable state, and display metadata.
- **Notes:** Covered by `src/__tests__/claudeHarness.test.ts` (`--remote-control opt-in (issue #40, T7 / Decision 12) embeds RC settings keys and pins orchestrator id...`) and `src/__tests__/rcConfigSmoke.test.ts`.
- **Reviewer-feedback hardening (F5, A7 — daemon-restart re-register):** the launcher now writes a registration sidecar at `<store_root>/orchestrators/<orchestrator_id>.json` (mode 0o600) before calling `register_supervisor`, and removes it on unregister. New helper module `src/daemon/orchestratorSidecar.ts` exports `writeOrchestratorSidecar` / `readOrchestratorSidecar` / `removeOrchestratorSidecar`. The supervisor signal CLI in `src/supervisorCli.ts` detects the daemon's `INVALID_INPUT: Unknown orchestrator id` response (whether wrapped in the IPC result envelope or thrown), reads the sidecar, calls `register_supervisor` with the cached record, and retries `signal_supervisor_event` once. Exit codes still per D22 (0 / 1 / never 2). Covered by `src/__tests__/supervisorStatusCli.test.ts → 'on unknown_orchestrator the CLI re-registers from <store_root>/orchestrators/<id>.json and retries the signal'` (uses a real `IpcServer` simulating a freshly-restarted daemon and asserts the call sequence `signal_supervisor_event → register_supervisor → signal_supervisor_event`).

### T8: Aggregate status state machine + hook-emission scheduler
- **Status:** done
- **Evidence:** New `src/daemon/orchestratorStatus.ts` exports `STALE_AFTER_SECONDS = 600` (Decision 17), `HOOK_EMISSION_DEBOUNCE_MS = 250`, `computeOrchestratorStatusSnapshot` (5-rule live-state precedence per Decision 3b plus stale override), `buildOrchestratorStatusPayload`, and `OrchestratorStatusEngine` (debounced + de-duped emission to the hook executor).
- **Notes:** Covered by `src/__tests__/orchestratorStatus.test.ts` including the AC8 invariant test pair (sticky `waiting_for_user` does not mask `in_progress` while running children exist; symmetric test where `supervisor_turn_active = false` but a running child still drives `in_progress`).
- **Reviewer-feedback hardening (F4, D3b rule 1 / D17):**
  - `OrchestratorService.collectOwnedRunSnapshot` now counts unacked `fatal_error` notifications across **all** owned runs (running + terminal), not just terminal runs, so D3b rule 1 (`attention`) dominates as soon as any owned run has an unacked fatal regardless of its lifecycle state.
  - `OrchestratorService.failPreSpawn` emits `terminal` and (for fatal errors) `notification` lifecycle events into the engine via `emitRunLifecycle`, so a pre-spawn failure recomputes the aggregate immediately.
  - `OrchestratorService.ackRunNotification` schedules a recompute for every registered orchestrator on a successful ack (engine de-dup collapses no-ops), so `attention` clears when its driving fatal_error is acknowledged.
  - `OrchestratorStatusEngine` arms a one-shot stale timer; engine accepts injectable `scheduleTimer` / `cancelTimer` test seams.
- **Reviewer iteration #2 hardening (stale timer correctness):**
  - The stale timer is now armed at `last_supervisor_event_at + STALE_AFTER_SECONDS`, **not** `now() + STALE_AFTER_SECONDS`. A non-supervisor recompute mid-window (e.g. owned worker run completes) cancels the previous timer and re-arms with `delayMs = max(0, deadlineMs - now())`, so the absolute stale deadline stays anchored to the last supervisor event. This closes the bug where a recompute at t+590s would otherwise have pushed stale emission to t+1190s.
  - `resetStaleTimer` skips re-arming once the computed status is already `stale`, so a stale orchestrator does not generate periodic stale timers indefinitely. The next genuine supervisor event (which updates `last_supervisor_event_at` via the registry) will re-arm a fresh timer relative to the refreshed timestamp.
  - Coverage: four tests in `src/__tests__/orchestratorStatus.test.ts → 'OrchestratorStatusEngine — stale timer (F4 + iteration #2 hardening)'` using a hand-rolled timer driver that captures both `delayMs` and `scheduledAtMs` so the test can compute and assert the absolute deadline drift:
    1. last event 590s old → next stale timer armed with delay ≈ 10s, not ≈ 600s.
    2. Non-supervisor recomputes do not postpone the stale deadline (deadline drift < 200ms across multiple recomputes).
    3. After a stale recompute fires, no further stale timer is re-armed; only a fresh supervisor event (refreshed `last_supervisor_event_at`) re-arms a new timer relative to the new timestamp.
    4. Original session_active → fire stale timer → `stale` emission with `previous_status = 'idle'` test still passes; additionally asserts no re-arm after the stale emission.
- **Reviewer iteration #3 hardening (stale timer busy-loop guard):**
  - `resetStaleTimer` now also skips arming while owned-run suppressors hold the aggregate above `stale`: `snapshot.running > 0 || snapshot.failed_unacked > 0`. Without this guard a past-deadline stale timer would clamp to `delayMs = 0`, fire, recompute (still suppressed), and re-arm a new zero-delay timer — a CPU/log busy-loop. Lifecycle/ack recomputes already wake the engine when those suppressors clear (terminal → `emitRunLifecycle('terminal')`, ack → service-level recompute fan-out), so stale is correctly emitted at that point because `last_supervisor_event_at` is already past the threshold.
  - Coverage: two new regression tests in the same suite:
    1. `running > 0` with a deadline already past → exactly one `in_progress` emission, no stale timer armed; clearing `running` to `0` and recomputing produces an immediate `stale` emission.
    2. `failed_unacked > 0` with a deadline already past → exactly one `attention` emission, no stale timer armed; simulating ack (`failed_unacked` → `0`) and recomputing produces an immediate `stale` emission.

### T9: Hook executor + `hooks.json` v1 loader
- **Status:** done
- **Evidence:** New `src/daemon/orchestratorHooks.ts` exports `OrchestratorHookExecutor`, `defaultHooksFilePath`, `DEFAULT_HOOK_TIMEOUT_MS`, `MAX_HOOK_TIMEOUT_MS`, `readAndValidateHooksFile`. Loader caches by mtime, rereads on change. Executor invokes user `command` via `child_process.spawn(command, { shell: true, stdio: ['pipe','pipe','pipe'], env: <restricted>, detached: <POSIX> })` (Decision 7 + F2), captures stdout/stderr to `<store_root>/hooks/<orchestrator_id>/<event>-<event_id>.log` (mode 0o600), enforces `timeout_ms` (default 1500ms, max 5000ms) via `setTimeout` followed by `process.kill(-pid, 'SIGKILL')` on POSIX **and** `child.kill('SIGKILL')`, and never throws into the caller. Emit is fire-and-forget; engine never awaits hook completion.
- **Notes:** Covered by `src/__tests__/orchestratorHooks.test.ts` (happy-path shell command with stdio capture, timeout SIGKILL, grandchild-survives-timeout test for F2, log-mode-0o600, restricted-env-passthrough leak probe, log_capture_failed counter via malformed orchestrator id, missing file, schema-invalid file rejection).
- **Reviewer-feedback hardening (F2, F3):**
  - **F2 — process-group kill.** Hook spawns now use `detached: process.platform !== 'win32'` so the shell command (and any grandchildren it forks) lives in its own process group. Timeout SIGKILLs the entire group via `process.kill(-pid, 'SIGKILL')` followed by `child.kill('SIGKILL')` as a fallback. The new `'timeout SIGKILLs grandchildren too'` unit test forks a `sleep` grandchild, fires the timeout, and asserts the grandchild's pid is dead via `process.kill(pid, 0)`.
  - **F3 — log-stream errors never escape.** Both `WriteStream.on('error', ...)` and `child.stdout.on('error', ...)` / `child.stderr.on('error', ...)` listeners are attached; on stream error the executor bumps `counters.log_capture_failed` and continues. Log-dir creation failures fall through to `stdio: ['pipe', 'ignore', 'ignore']` so timeout/exit semantics still hold. Path components are sanitized via strict ULID grammar (`/^[0-9A-HJKMNP-TV-Z]{26}$/`) for `orchestrator.id` and `event_id`, plus a closed `ALLOWED_HOOK_EVENTS` set for `event`, so a malformed payload cannot escape `<store_root>/hooks/` via `..` or absolute-path segments. New `log_capture_failed` counter exposed on `OrchestratorHookExecutor.counters`.

### T10: CLI subcommand `agent-orchestrator supervisor status` (resolves H2 = (c))
- **Status:** done
- **Evidence:** Implemented in `src/supervisorCli.ts` (`runStatus`). Reads `--orchestrator-id <id>` or falls back to `AGENT_ORCHESTRATOR_ORCH_ID` env. Calls IPC `get_orchestrator_status` and prints JSON `{ orchestrator: {...}, status: {...}, display: {...} }` on stdout. Exits **0 on success, 1 on missing/unknown id, never 2**. The top-level `agent-orchestrator status` subcommand is unchanged. `src/__tests__/supervisorStatusCli.test.ts` asserts no new MCP tool is added (Decision 24).
- **Notes:** No MCP tool is registered; the model would have to invoke this CLI through the existing pinned Bash allowlist if a future skill needed it.

### T11: Update Claude passthrough validator + launcher help
- **Status:** done
- **Evidence:** `src/claude/passthrough.ts` adds `--remote-control-session-name-prefix` to `ALLOWED_FLAG_TOKENS`. `claudeLauncherHelp()` documents `--remote-control`, `--remote-control-session-name-prefix`, and `--orchestrator-label` plus the new passthrough entry. Test `passthrough validator accepts --remote-control-session-name-prefix as an allowed Claude flag` covers the new allow.
- **Notes:** Existing forbidden-flag tests stay green.

### T12: Example tmux hook + docs
- **Status:** done
- **Evidence:** New `examples/hooks/tmux-status.sh` (executable; ASCII state labels by default with `AGENT_ORCHESTRATOR_HOOK_USE_EMOJI=1` opt-in), referenced from new `docs/development/orchestrator-status-hooks.md` describing the v1 payload, hooks.json schema, threat model, execution semantics, and `agent-orchestrator supervisor status` CLI.
- **Notes:** README also gains a "Status hooks (issue #40)" subsection that mentions both `--remote-control` and `--orchestrator-label` per Decision 23 and links to the example + doc.

### T13: Unit test suite (split by area)
- **Status:** done
- **Evidence:** New independent test files: `orchestratorStatus.test.ts` (5-rule precedence + AC8 + F4 stale-timer with hand-rolled timer driver), `orchestratorHooks.test.ts` (executor / shell:true / timeout SIGKILL / **F2 grandchild process-group kill** / **log-mode 0o600** / **restricted env passthrough leak probe** / **F3 log_capture_failed counter** / missing file / schema-invalid), `orchestratorHooksSchema.test.ts` (closed-schema rejection (a)/(b)/(c)/(d), positive accept of arbitrary shell metacharacters per H4), `orchestratorRegistry.test.ts` (register / id forge prevention / supervisor event mapping / unregister), `orchestratorIdForgePrevention.test.ts` (**F1 strip-then-add invariant**, six cases including parent-inherited stamp), `claudeWorkerIsolation.test.ts` (asserts `--settings <per-run>` + `--setting-sources user` + on-disk `disableAllHooks: true`), `processManagerEnvIsolation.test.ts` (multiplexer-only strip, unrelated env preserved, no input mutation), `supervisorStatusCli.test.ts` (signal stdout-empty invariant, never-2, status missing id, **status happy-path through real IpcServer**, **status unknown-id never-2**, **F5 re-register from sidecar via real IpcServer**, no MCP tool registered). Extensions to `claudeHarness.test.ts` cover hook composition, injection-style rejection, RC opt-in settings, RC argv pair, and `--remote-control-session-name-prefix` passthrough.
- **Notes:** All 391 tests pass via `pnpm test` after reviewer iteration #3 (stale-timer busy-loop guard + two regression tests for the `running` and `failed_unacked` suppressor branches).
- **Reviewer iteration #2 additions:**
  - `orchestratorStatus.test.ts` gained four stale-timer tests that explicitly assert the deadline is anchored to `last_supervisor_event_at` (delay ≈ remaining-window, not full `STALE_AFTER_SECONDS`), that non-supervisor recomputes don't postpone the deadline, that no periodic re-arm happens after the aggregate becomes `stale`, and that a fresh supervisor event re-arms with a new deadline.
  - `claudeWorkerIsolation.test.ts` gained a fixture-based test that writes a representative user `~/.claude/settings.json` with hooks into a temp HOME, then asserts the worker invocation pins `--settings <per-run>` (with `disableAllHooks: true`) and `--setting-sources user`, and that the argv builder does not execute the user hook (sentinel file does not exist). A `TODO(t13b)` note marks the live-binary verification as deferred to the opt-in `AGENT_ORCHESTRATOR_RC_LIVE_SMOKE` path.
  - `src/daemon/orchestratorSidecar.ts` now applies the same strict ULID grammar (`/^[0-9A-HJKMNP-TV-Z]{26}$/`) used by the hook log path, so a malformed orchestrator id cannot produce a path-traversal segment under `<store_root>/orchestrators/`. `writeOrchestratorSidecar` throws on a non-ULID id; `readOrchestratorSidecar` / `removeOrchestratorSidecar` degrade to "no sidecar found" / no-op.

### T14: Integration test + RC config smoke (offline)
- **Status:** done
- **Evidence:** `src/__tests__/integration/orchestrator.test.ts` `orchestrator status flow` exercises register → turn_started → in_progress → turn_stopped + waiting_for_user → start_run with stamped `metadata.orchestrator_id` (verifying AC8) → wait_for_run → waiting_for_user transition → session_ended → stale → unregister. New `forge prevention: model-supplied metadata.orchestrator_id is stripped in start_run and send_followup unless pinned (D10/R8)` integration scenario covers the F1 wiring end-to-end through the real dispatcher with the mock-CLI fixture. `src/__tests__/rcConfigSmoke.test.ts` asserts the offline RC config smoke (RC keys, hooks block from T2, pinned absolute CLI path, orchestrator label).
- **Notes:** **Recorded Claude version observed by `--print-discovery` (Decision 12, R7): `claude 2.1.129 (Claude Code)`** captured by running `node dist/cli.js claude --print-discovery` on this branch.

### T14b: RC live smoke (deferred / opt-in)
- **Status:** deferred (opt-in via `AGENT_ORCHESTRATOR_RC_LIVE_SMOKE=1`; offline T14 is the default sufficient gate)
- **Evidence:** Not scheduled in this implementation pass.
- **Notes:** Skeleton hook in plan still applies; the offline T14 fixture provides the harness/Claude-config invariants without requiring Anthropic credentials in CI.

### T15: Docs + release notes
- **Status:** done
- **Evidence:** README "Claude Code Orchestration Mode" section gains a "Status hooks (issue #40)" subsection mentioning both `--remote-control` and `--orchestrator-label` plus the `agent-orchestrator supervisor status` CLI. New doc `docs/development/orchestrator-status-hooks.md` covers the Claude-parity hooks.json v1 schema, threat model, payload, worker isolation, hook execution counters (with surfacing through `get_observability_snapshot` flagged as deferred), and a worked tmux example. Updated `PUBLISHING.md` with an "Issue #40 release notes" subsection covering the new IPC methods, user config file, launcher flags, supervisor CLI subcommand family, and an explicit clarification that `PROTOCOL_VERSION` is unchanged at `1` (the new IPC methods are additive); package-version skew remains enforced separately. Supervisor system prompt gains a short paragraph that turn signaling is automatic and the user's tmux/desktop hook will see it.
- **Notes:** `pnpm test` green (385 pass, 1 skipped) after reviewer-feedback hardening; `pnpm verify` audit failure for `ip-address` is **pre-existing** on this branch's base (advisory dated 2026-05-05; fix lives on PR #38 branch `b23c6ba` which is not yet merged into main and not present on this branch), and is unrelated to this implementation.
