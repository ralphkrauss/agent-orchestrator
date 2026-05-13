# Reference

This page holds the operational details that used to make the README long. Start with [first-run.md](first-run.md) if you are trying the package for the first time.

## Architecture

| Process | Responsibility | Lifetime |
|---|---|---|
| `agent-orchestrator` | Stdio MCP server. Translates MCP tool calls into JSON-RPC requests over a local daemon IPC endpoint. Holds no run state. | Same lifetime as the MCP client. Restarts are expected. |
| `agent-orchestrator-daemon` | Owns worker subprocesses, active run handles, timeouts, cancellation, follow-up session reuse, and the durable run store. | Long-lived. Auto-started by the MCP server or controlled manually. |

MCP-client restarts preserve run state because the daemon keeps running. Daemon restarts do not preserve active worker ownership; any run still marked `running` becomes terminal `orphaned` with the previous daemon PID and worker PID in the error context.

Package-version skew between the MCP frontend and daemon returns a version-mismatch error with a restart hint instead of failing later with stale methods or result shapes.

## Daemon Lifecycle

```bash
agent-orchestrator status
agent-orchestrator status --verbose
agent-orchestrator runs
agent-orchestrator runs --json --prompts
agent-orchestrator watch
agent-orchestrator start
agent-orchestrator stop
agent-orchestrator stop --force
agent-orchestrator restart
agent-orchestrator restart --force
agent-orchestrator prune --older-than-days 30 --dry-run
agent-orchestrator prune --older-than-days 30
```

`agent-orchestrator-daemon` is also available as a standalone daemon-control alias. With `npx`, run daemon commands through the main bin:

```bash
npx -y @ralphkrauss/agent-orchestrator@latest status
npx -y @ralphkrauss/agent-orchestrator@latest runs
npx -y @ralphkrauss/agent-orchestrator@latest watch
npx -y @ralphkrauss/agent-orchestrator@latest restart
```

`stop` and `restart` refuse while runs are active. `--force` cancels active runs through the normal cancellation path before stopping or restarting.

## Run Store

Default location:

```text
~/.agent-orchestrator/
  daemon.log
  daemon.pid
  config.json
  daemon.sock        (POSIX only)
  runs/
    <run-id>/
      meta.json
      events.jsonl
      prompt.txt
      stdout.log
      stderr.log
      result.json
```

Override it with:

```bash
AGENT_ORCHESTRATOR_HOME=/path/to/store
```

Security behavior:

- The root directory is created with user-only permissions where the platform supports POSIX modes.
- On POSIX, startup aborts if the root directory is owned by another UID.
- On POSIX, broader permissions on a current-user-owned root are coerced to `0700`.
- On POSIX, `daemon.sock` is bound under a restrictive umask so the socket file is `0600`.
- On Windows, the daemon listens on a named pipe derived from the run-store path.
- `daemon.pid` is written with `0600` mode where supported.

Prompts are stored as `prompt.txt` in each private run directory. Do not pass secrets in prompts unless you are comfortable with them being written to the local run store.

## Observability

Use:

```bash
agent-orchestrator status --verbose
agent-orchestrator runs
agent-orchestrator runs --json
agent-orchestrator runs --json --prompts
agent-orchestrator watch
agent-orchestrator watch --recent-events 300
```

`watch` opens an Ink-based interactive terminal dashboard designed for SSH and
ordinary terminal panes. The default view focuses on live orchestrator sessions
registered with the daemon. Each live orchestrator is shown as a collapsible
group in the left sidebar, and expanded groups list worker conversations rather
than raw run records. Completed workers remain visible while their orchestrator
is live. When an orchestrator exits or reports `session_ended`, it leaves the
live list and remains available from the archive view.

The main pane has two deliberately different surfaces:

- Selecting an orchestrator opens an overview dashboard with a double border,
  worker counts, workspace context, elapsed session time, last-update age, and
  one compact status row per named worker.
- Selecting a worker opens a `Worker Timeline` chat view. Every run round has a
  colored left rail, so the run start marker, supervisor prompt, tool activity,
  worker messages, and run end marker are visually grouped.

- Oldest loaded content appears above newer content, with the latest content at
  the bottom like a chat history. Short transcripts are bottom-aligned in the
  pane instead of floating at the top.
- The view follows new output automatically until you scroll up.
- The TUI explicitly enters raw input mode and decodes terminal escape
  sequences itself. Mouse wheel scrolling is enabled in terminals that report
  SGR, urxvt, or legacy X10 mouse wheel events, with each wheel tick moving one
  rendered transcript row. Press `m` to release terminal mouse capture for
  native text selection in the transcript pane, and press `m` again to restore
  wheel scrolling.
- The main pane shows a scroll indicator and a `top`/percentage/`bottom` label
  so the current viewport position is visible.
- Scrollback is independent of terminal height; `--recent-events <n>` controls
  how many worker events are loaded per run.
- Initial worker prompts and follow-up child runs are folded into one worker
  conversation using parent run links and backend session ids. Follow-ups render
  as `Supervisor -> Worker` turns inside the transcript, followed by distinct
  `Worker message`, `Tool call`, `Tool result`, `Worker activity`, and
  `Final response` entries.
- Run completion status is shown on run boundary markers, not stamped onto old
  chat messages.
- Assistant and prompt text is rendered with real terminal Markdown handling
  for paragraphs, lists, code fences, inline code, headings, links,
  blockquotes, and tables where practical.
- Worker timeline prompt, assistant, and final-response text wraps inside the
  pane rather than being truncated. Source line breaks in Markdown responses
  are preserved, including final answers. Compact summaries are reserved for
  the overview and sidebar surfaces.
- Tool calls and tool results are summarized by tool name, command/status, and
  concise result or error text. Full raw tool payloads are not dumped by
  default.

Keyboard controls:

| Key | Action |
|---|---|
| `Up` / `Down`, `k` / `j` | Move selection in the sidebar. |
| `Space` | Collapse or expand the selected orchestrator group. |
| `Right` / `l` | Expand the selected orchestrator group. |
| `Left` / `h` | Collapse the selected orchestrator group. |
| `a` / `Tab` | Toggle between live orchestrators and archive history. |
| Mouse wheel | Scroll the transcript pane one rendered row at a time when mouse capture is enabled. |
| `m` | Toggle terminal mouse capture so native text selection can be used. |
| `u` / `d`, `Ctrl-U` / `Ctrl-D` | Scroll the transcript pane by a half page. |
| `PageUp` / `PageDown`, `Ctrl-B` / `Ctrl-F` | Scroll the transcript pane by a full page. |
| `g` / `Home` | Jump to the oldest loaded transcript content. |
| `G`, `Enter`, `End`, `Ctrl-E` | Return the transcript pane to auto-follow latest output. |
| `q` / `Ctrl-C` | Quit. |

For readable dashboard labels, pass metadata on `start_run` or `send_followup`:

```json
{
  "metadata": {
    "session_title": "Release readiness",
    "session_summary": "Prepare and verify the npm package",
    "prompt_title": "Run release checks",
    "prompt_summary": "Build, test, and inspect publish readiness"
  }
}
```

## Tool Response Envelope

Every MCP tool returns:

```ts
type ToolResponse<TPayload> =
  | ({ ok: true } & TPayload)
  | { ok: false; error: OrchestratorError };
```

Expected operational failures use `{ ok: false, error }`. MCP `isError: true` is reserved for unexpected internal failures such as uncaught exceptions or IPC framing breaks.

## MCP Tools

| Tool | Purpose |
|---|---|
| `get_backend_status` | Return the same diagnostics as `doctor`. |
| `get_observability_snapshot` | Return sessions, prompts, run summaries, diagnostics, and recent activity. |
| `list_worker_profiles` | Load profile aliases and report invalid profiles without hiding valid ones. |
| `upsert_worker_profile` | Create or update one profile alias. |
| `start_run` | Start a profile-mode or direct-mode worker run. |
| `list_runs` | List known runs. |
| `get_run_status` | Return one run summary. |
| `get_run_events` | Return raw event pages with a sequence cursor. |
| `get_run_progress` | Return a bounded, user-facing progress summary. |
| `wait_for_run` | Block until one run reaches terminal status, bounded by seconds. |
| `wait_for_any_run` | Block until any listed run has a terminal or fatal-error notification. |
| `list_run_notifications` | Read durable run notifications. |
| `ack_run_notification` | Mark a durable notification acknowledged. |
| `get_run_result` | Return terminal result details when available. |
| `send_followup` | Start a child run that follows up on a terminal parent. |
| `cancel_run` | Request cancellation for a running worker. |

`get_run_progress` is the preferred user-facing progress tool. Use `get_run_events` only when raw backend events are needed.

`wait_for_any_run` is the notification-aware wake path for clients that can block on MCP tools. The Claude Code supervisor instead uses the pinned `agent-orchestrator monitor <run_id>` Bash command and reconciles with `list_run_notifications`.

## Model And Network Settings

`model` is passed through to the selected backend as provided. Codex validates only that it is a non-empty string. Claude aliases such as `opus` and `sonnet` are rejected when supplied explicitly; pass a direct model id accepted by Claude Code.

`reasoning_effort` maps to Codex `model_reasoning_effort` or Claude `--effort`. `service_tier` is Codex-only.

`worker_posture` (issue #58) controls whether workers see project / user
configuration and MCP servers, independently of `codex_network`:

| Value | Behavior |
|---|---|
| `trusted` (default) | Worker gets backend-native parity with a manual run from the project worktree. Claude loads project/user/local setting-sources and auto-approves project MCP servers; Codex loads user + project `config.toml`; Cursor loads every ambient SDK settings layer. |
| `restricted` | Orchestrator-curated isolated envelope (pre-#58 closed-by-default). Codex emits `--ignore-user-config`; Claude restricts setting-sources to `user`; Cursor omits ambient `settingSources`. |

The Claude supervisor envelope is always restricted and ignores
`worker_posture`. Direct-mode `start_run` / `send_followup` accept the field;
profile-mode rejects mixing (set it on the profile manifest).

`codex_network` is Codex-only and independent of `worker_posture`. The effective
argv depends on both axes (issue #58 review follow-up):

| Posture × `codex_network` | Argv |
|---|---|
| `trusted` + unset | `-c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true` (persisted as `codex_network: null`) |
| `trusted` + `isolated` | (no sandbox flags; codex defaults apply) |
| `trusted` + `workspace` | `-c sandbox_workspace_write.network_access=true` |
| `trusted` + `user-config` | (no flags) |
| `restricted` + unset or `isolated` | `--ignore-user-config` |
| `restricted` + `workspace` | `--ignore-user-config -c sandbox_workspace_write.network_access=true` |
| `restricted` + `user-config` | (no flags) |

Under `worker_posture: 'restricted'`, codex profiles that omit
`codex_network` resolve to `'isolated'` and emit a one-off
`codex_network_defaulted` lifecycle warning the first time the run starts;
under `'trusted'` the warning is suppressed since the absence is the
intended default. See [development/codex-backend.md](development/codex-backend.md)
for the migration table.

## Long-Running Runs

The daemon supervises long work with an idle-progress timeout. Generated config defaults to:

```text
default_idle_timeout_seconds: 1200
max_idle_timeout_seconds: 7200
default_execution_timeout_seconds: null
max_execution_timeout_seconds: 14400
```

`idle_timeout_seconds` cancels only after the worker has been quiet for that many seconds. stdout, stderr, parsed backend events, errors, start, and terminalization all count as activity. `execution_timeout_seconds` remains available as an explicit hard elapsed-time cap.

Known fatal backend errors such as auth, quota, rate limit, invalid model, permission, protocol, backend availability, or missing worker binaries are surfaced as `latest_error` and fail the run promptly.

## Manual Cleanup

```bash
agent-orchestrator prune --older-than-days 30 --dry-run
agent-orchestrator prune --older-than-days 30
agent-orchestrator stop --force
rm -rf "${AGENT_ORCHESTRATOR_HOME:-$HOME/.agent-orchestrator}"
```

On Windows, remove the configured run-store directory after stopping the daemon.
