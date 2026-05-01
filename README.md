# Agent Orchestrator MCP

An MCP server that lets a supervising agent coordinate Codex and Claude worker CLI runs through a persistent local daemon.

The package is intentionally host-native. It does not install Codex or Claude. Those CLIs stay external because they have their own installation, authentication, and local session state. The orchestrator detects them at runtime and reports what is available.

## Install

Use the package directly from npm in any MCP client config:

```bash
npx -y @ralphkrauss/agent-orchestrator-mcp@latest
```

For local development from a checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js doctor
node dist/cli.js
```

## Prerequisites

- POSIX environment. v1 uses Unix sockets and POSIX process groups. Windows named pipes are not implemented.
- Node.js 22 or newer.
- Codex CLI installed and authenticated if you want Codex workers.
- Claude CLI installed and authenticated if you want Claude workers.

The MCP package never installs or bundles worker CLIs. Missing workers are reported by diagnostics and by failed run results, but one missing backend does not prevent the MCP server from starting.

## Diagnostics

Run:

```bash
npx -y @ralphkrauss/agent-orchestrator-mcp@latest doctor
npx -y @ralphkrauss/agent-orchestrator-mcp@latest doctor --json
```

Diagnostics check:

- POSIX support
- Node version
- run-store accessibility
- `codex` and `claude` binary presence
- resolved binary path
- version when available
- required help/subcommand flag support
- best-effort auth readiness from environment variables

Diagnostics do not make model calls. If auth cannot be proven locally without a model call, the backend reports `auth_unknown` with a next-step hint.

Supervisor agents can use the MCP tool `get_backend_status` to retrieve the same diagnostics.

## MCP Client Config

### Claude Code `.mcp.json`

```json
{
  "mcpServers": {
    "agent-orchestrator": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ralphkrauss/agent-orchestrator-mcp@latest"]
    }
  }
}
```

### Codex `.codex/config.toml`

```toml
[mcp_servers.agent-orchestrator]
command = "npx"
args = ["-y", "@ralphkrauss/agent-orchestrator-mcp@latest"]
```

### Cursor `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "agent-orchestrator": {
      "command": "npx",
      "args": ["-y", "@ralphkrauss/agent-orchestrator-mcp@latest"]
    }
  }
}
```

### OpenCode `opencode.json`

```json
{
  "mcp": {
    "agent-orchestrator": {
      "type": "local",
      "command": ["npx", "-y", "@ralphkrauss/agent-orchestrator-mcp@latest"]
    }
  }
}
```

### Generic MCP stdio client

Use command:

```text
npx
```

Use arguments:

```text
-y @ralphkrauss/agent-orchestrator-mcp@latest
```

If your repository already has a cross-platform `npx` wrapper, use it the same way you would use it for Playwright MCP:

```json
{
  "command": "node",
  "args": ["scripts/run-npx-mcp.mjs", "@ralphkrauss/agent-orchestrator-mcp@latest"]
}
```

## Architecture

There are two processes:

| Process | Responsibility | Lifetime |
|---|---|---|
| `agent-orchestrator-mcp` | Stdio MCP server. Translates MCP tool calls into JSON-RPC requests over a Unix socket. Holds no run state. | Same lifetime as the MCP client. Restarts are expected. |
| `agent-orchestrator-mcp-daemon` | Owns worker subprocesses, active run handles, timeouts, cancellation, follow-up session reuse, and the durable run store. | Long-lived. Auto-started by the MCP server or controlled manually. |

The guarantee is deliberately scoped:

- MCP-client or supervisor restarts preserve run state and in-flight runs because the daemon keeps running.
- Daemon restarts do not preserve in-flight worker ownership. On daemon startup, any run still marked `running` becomes terminal `orphaned` with the previous daemon PID and worker PID in the error context.

## Daemon Lifecycle

When installed locally or globally, use:

```bash
agent-orchestrator-mcp-daemon status
agent-orchestrator-mcp-daemon start
agent-orchestrator-mcp-daemon stop
agent-orchestrator-mcp-daemon stop --force
agent-orchestrator-mcp-daemon prune --older-than-days 30 --dry-run
agent-orchestrator-mcp-daemon prune --older-than-days 30
```

With `npx`, target the daemon bin explicitly:

```bash
npx -y --package @ralphkrauss/agent-orchestrator-mcp@latest agent-orchestrator-mcp-daemon status
npx -y --package @ralphkrauss/agent-orchestrator-mcp@latest agent-orchestrator-mcp-daemon stop --force
npx -y --package @ralphkrauss/agent-orchestrator-mcp@latest agent-orchestrator-mcp-daemon prune --older-than-days 30 --dry-run
```

`stop` refuses while runs are active and prints the active run IDs. `stop --force` cancels active runs through the normal cancellation path, waits for terminal statuses, and exits. Direct `SIGTERM`/`SIGINT` to the daemon behaves like `stop --force`; `SIGKILL` cannot be caught and any in-flight runs become `orphaned` on next daemon startup.

`prune` deletes only terminal runs with `finished_at` older than the requested age. Use `--dry-run` first to inspect the matching run IDs.

## Run Store

Default location:

```text
~/.agent-orchestrator/
  daemon.sock
  daemon.log
  daemon.pid
  config.json
  runs/
    <run-id>/
      meta.json
      events.jsonl
      stdout.log
      stderr.log
      result.json
```

Override it with:

```bash
AGENT_ORCHESTRATOR_HOME=/path/to/store
```

Security behavior:

- The root directory is created as `0700`.
- If the root directory exists and is owned by another UID, startup aborts.
- If the root directory is owned by the current UID but has broader permissions, startup coerces it to `0700`.
- `daemon.sock` is bound under a restrictive umask so the socket file is `0600`.
- `daemon.pid` is written as `0600`.
- A stale socket is unlinked only when it is owned by the current UID.

Secrets and CLI credentials are not stored by the MCP package. Worker authentication comes from the host CLI's normal auth state or from environment variables already present when the MCP server/daemon starts. Do not pass API keys as MCP tool arguments; those requests can be logged by clients.

Manual cleanup:

```bash
agent-orchestrator-mcp-daemon prune --older-than-days 30 --dry-run
agent-orchestrator-mcp-daemon prune --older-than-days 30
agent-orchestrator-mcp-daemon stop --force
rm -rf "${AGENT_ORCHESTRATOR_HOME:-$HOME/.agent-orchestrator}"
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

| Tool | Input | Success payload |
|---|---|---|
| `get_backend_status` | `{}` | `{ status: BackendStatusReport }` |
| `start_run` | `{ backend: "codex" \| "claude", prompt: string, cwd: string, model?: string, metadata?: object, execution_timeout_seconds?: number }` | `{ run_id: string }` |
| `list_runs` | `{}` | `{ runs: RunSummary[] }` |
| `get_run_status` | `{ run_id: string }` | `{ run_summary: RunSummary }` |
| `get_run_events` | `{ run_id: string, after_sequence?: number, limit?: number }` | `{ events: WorkerEvent[], next_sequence: number, has_more: boolean }` |
| `wait_for_run` | `{ run_id: string, wait_seconds: number }` | Terminal status or `{ status: "still_running", wait_exceeded: true, run_summary }` |
| `get_run_result` | `{ run_id: string }` | `{ run_summary: RunSummary, result: WorkerResult \| null }` |
| `send_followup` | `{ run_id: string, prompt: string, model?: string, execution_timeout_seconds?: number }` | `{ run_id: string }` for a new child run |
| `cancel_run` | `{ run_id: string }` | `{ accepted: true, status: RunStatus }` |

Most worker preparation failures are run failures rather than envelope failures. For example, if `codex` is missing, `start_run` creates a durable run and that run lands in `failed` with `WORKER_BINARY_MISSING` details.

`model` is passed through to the selected worker CLI as provided. Codex and Claude model names change over time, so the orchestrator validates only that the value is a non-empty string. Follow-up runs inherit the parent run model unless a new `model` is supplied.

## Operational Notes

This package is for trusted local MCP clients. Worker processes run with the current user's OS privileges, inherit the daemon environment, and can use whatever credentials the host Codex or Claude CLI can access. Do not expose the daemon socket to untrusted users or pass secrets as MCP tool arguments.

Concurrent runs against the same `cwd` are the supervisor's responsibility. The orchestrator does not create worktrees, isolate file systems, or lock a working directory. If two workers edit the same files, they can conflict.

If a daemon restart marks a run `orphaned`, the previous worker process may still be consuming CPU or API tokens. Inspect `~/.agent-orchestrator/daemon.log` and the run result for the previous daemon PID and worker PID, then clean up manually if needed.

Prefer killing the process group when you know the PGID:

```bash
kill -TERM -<worker-pgid>
sleep 5
kill -KILL -<worker-pgid>
```

## Development

```bash
pnpm install --frozen-lockfile
pnpm verify
npm pack --dry-run
```

Installed-package smoke test:

```bash
package_file="$(npm pack --silent | tail -n 1)"
temp_dir="$(mktemp -d)"
cd "$temp_dir"
npm init -y >/dev/null
npm install "/path/to/agent-orchestrator-mcp/$package_file"
./node_modules/.bin/agent-orchestrator-mcp doctor --json
```

## Publishing

See [PUBLISHING.md](PUBLISHING.md) for:

- first manual npm publish
- GitHub Actions Trusted Publishing setup
- CodeArtifact publish workflow inputs
- license readiness guard
