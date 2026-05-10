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
```

`watch` opens an interactive terminal dashboard. Detail views include raw prompt, recent activity, model/source, session-resume audit state, artifact paths, and size indicators.

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

`codex_network` is Codex-only:

| Value | Behavior |
|---|---|
| `isolated` | Passes `--ignore-user-config`; network remains closed by Codex defaults. |
| `workspace` | Passes `--ignore-user-config` and enables workspace-write network access. |
| `user-config` | Lets Codex read `$CODEX_HOME/config.toml` verbatim. |

Codex profiles that omit `codex_network` default to `isolated`. See [development/codex-backend.md](development/codex-backend.md) for the migration table.

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
