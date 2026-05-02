# Agent Orchestrator

An MCP server that lets a supervising agent coordinate Codex and Claude worker CLI runs through a persistent local daemon.

The package is intentionally host-native. It does not install Codex or Claude. Those CLIs stay external because they have their own installation, authentication, and local session state. The orchestrator detects them at runtime and reports what is available.

## Install

Use the package directly from npm in any MCP client config:

```bash
npx -y @ralphkrauss/agent-orchestrator@latest
```

For local development from a checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js doctor
node dist/cli.js
```

## Prerequisites

- Node.js 22 or newer.
- Codex CLI installed and authenticated if you want Codex workers.
- Claude CLI installed and authenticated if you want Claude workers.

Linux and macOS use Unix sockets and POSIX process groups. Windows uses a
per-store named pipe for daemon IPC and `taskkill` for worker process-tree
cancellation.

The MCP package never installs or bundles worker CLIs. Missing workers are reported by diagnostics and by failed run results, but one missing backend does not prevent the MCP server from starting.

## Diagnostics

Run:

```bash
npx -y @ralphkrauss/agent-orchestrator@latest doctor
npx -y @ralphkrauss/agent-orchestrator@latest doctor --json
```

Diagnostics check:

- platform and POSIX process-group availability
- Node version
- run-store accessibility
- `codex` and `claude` binary presence
- resolved binary path
- version when available
- required help/subcommand flag support
- best-effort auth readiness from environment variables

Diagnostics do not make model calls. If auth cannot be proven locally without a model call, the backend reports `auth_unknown` with a next-step hint.

Supervisor agents can use the MCP tool `get_backend_status` to retrieve the same diagnostics.
When called through the daemon, that report also includes the frontend package version, daemon package version, daemon PID, and whether the two package versions match.

## MCP Client Config

### Claude Code `.mcp.json`

```json
{
  "mcpServers": {
    "agent-orchestrator": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ralphkrauss/agent-orchestrator@latest"]
    }
  }
}
```

### Codex `.codex/config.toml`

```toml
[mcp_servers.agent-orchestrator]
command = "npx"
args = ["-y", "@ralphkrauss/agent-orchestrator@latest"]
```

### Cursor `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "agent-orchestrator": {
      "command": "npx",
      "args": ["-y", "@ralphkrauss/agent-orchestrator@latest"]
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
      "command": ["npx", "-y", "@ralphkrauss/agent-orchestrator@latest"]
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
-y @ralphkrauss/agent-orchestrator@latest
```

If your repository already has a cross-platform `npx` wrapper, use it the same way you would use it for Playwright MCP:

```json
{
  "command": "node",
  "args": ["scripts/run-npx-mcp.mjs", "@ralphkrauss/agent-orchestrator@latest"]
}
```

## OpenCode Orchestration Mode

OpenCode orchestration mode starts OpenCode as a constrained supervisor for a
target workspace. The supervisor can inspect the repository and use
`agent-orchestrator` MCP tools to start, wait for, inspect, follow up with, and
cancel worker runs. It cannot directly edit source files, use todo writes,
commit, push, create pull requests, publish, or mutate external services.

The same supervisor can also create or update project-owned `orchestrate-*`
skills and the configured profiles manifest. Those paths are the only direct
writes allowed in OpenCode orchestration mode.

Launch from the repository where workers should run:

```bash
agent-orchestrator-opencode
agent-orchestrator-opencode --cwd /path/to/workspace
agent-orchestrator opencode --cwd /path/to/workspace
```

OpenCode passthrough arguments after `--` are intentionally limited to no
subcommand or `run` followed by positional prompt tokens. The launcher rejects
non-supervisor subcommands and any option token after `run`, including
`--agent`, `--attach`, `--dir`, `--share`, `--session`, `--file`, and
`--dangerously-skip-permissions`.

The launcher does not modify normal OpenCode config. It generates an
`OPENCODE_CONFIG_CONTENT` overlay, loads project-owned orchestration skills from
the shared `.agents/skills/` root, and does not generate default skills. The
target workspace path is included in the supervisor prompt and should be passed
as `cwd` to worker runs unless the user explicitly chooses another workspace.

The supervisor reads worker profiles from:

```text
~/.config/agent-orchestrator/profiles.json
```

This keeps personal model preferences out of git and reusable across
repositories. OpenCode can start before that file exists so you can discuss the
profile aliases you need. The supervisor may write this profiles manifest when you
ask it to configure profiles, but it cannot write other config, source, docs,
normal skills, secrets, commits, pull requests, run bash, or mutate external
services. It must not start worker runs until the profiles manifest validates.

Example:

```json
{
  "version": 1,
  "profiles": {
    "deep-implementation": {
      "backend": "codex",
      "model": "gpt-5.5",
      "reasoning_effort": "high",
      "description": "Implementation and hardening"
    },
    "strict-review": {
      "backend": "claude",
      "model": "claude-opus-4-7",
      "reasoning_effort": "xhigh",
      "description": "Review and risk assessment"
    }
  }
}
```

Ask the supervisor to create or refine its orchestration skills. The launcher
creates the shared skill root before OpenCode starts, then grants edit
permission only to the profiles manifest and:

```text
.agents/skills/orchestrate-*/SKILL.md
```

Project-owned orchestration skills use the same OpenCode skill layout as normal
skills, with an `orchestrate-*` folder and skill name:

```text
.agents/skills/orchestrate-{name}/SKILL.md
```

Orchestration skills should reference profile aliases from the manifest, not raw
model names, variants, backend names, or effort levels. Each user chooses
concrete models in the profiles manifest.

When starting workers, the supervisor should normally call `start_run` with a
live `profile` alias plus `profiles_file`. The daemon reads and validates the
current manifest at worker-start time, so profile edits take effect without
restarting OpenCode. Direct `backend`/`model` starts remain available for
explicit one-off user overrides or when the profile setup is broken. The
`list_worker_profiles` MCP tool returns the validated live profiles and their
configured backend/model settings.

Useful options:

```bash
agent-orchestrator-opencode --print-config
agent-orchestrator-opencode --profiles-file ~/.config/agent-orchestrator/profiles.json
agent-orchestrator-opencode --profiles-json '{"version":1,"profiles":{}}'
agent-orchestrator-opencode --skills .agents/skills
agent-orchestrator-opencode --orchestrator-model anthropic/claude-sonnet-4-6
agent-orchestrator-opencode --orchestrator-small-model openai/gpt-5.4-mini
```

Environment fallbacks use the `AGENT_ORCHESTRATOR_OPENCODE_*` prefix, including
`AGENT_ORCHESTRATOR_OPENCODE_CWD`,
`AGENT_ORCHESTRATOR_OPENCODE_PROFILES_FILE`,
`AGENT_ORCHESTRATOR_OPENCODE_PROFILES_JSON`,
`AGENT_ORCHESTRATOR_OPENCODE_ROUTES_FILE`,
`AGENT_ORCHESTRATOR_OPENCODE_ROUTES_JSON`,
`AGENT_ORCHESTRATOR_OPENCODE_MANIFEST`,
`AGENT_ORCHESTRATOR_OPENCODE_SKILLS_PATH`,
`AGENT_ORCHESTRATOR_OPENCODE_MODEL`,
`AGENT_ORCHESTRATOR_OPENCODE_SMALL_MODEL`, and
`AGENT_ORCHESTRATOR_OPENCODE_BIN`.

The current package supports Codex and Claude worker backends, but the profiles
manifest is provider-agnostic. Future backends can add capability descriptors
without changing the supervisor workflow.

OpenCode permissions are application-level guardrails, not an operating-system
sandbox. For stronger enforcement, run the supervisor in a read-only worktree
mount, under a separate OS user, or inside a container with only intentional
writable paths exposed.

## Architecture

There are two processes:

| Process | Responsibility | Lifetime |
|---|---|---|
| `agent-orchestrator` | Stdio MCP server. Translates MCP tool calls into JSON-RPC requests over a local daemon IPC endpoint. Holds no run state. | Same lifetime as the MCP client. Restarts are expected. |
| `agent-orchestrator-daemon` | Owns worker subprocesses, active run handles, timeouts, cancellation, follow-up session reuse, and the durable run store. | Long-lived. Auto-started by the MCP server or controlled manually. |

The guarantee is deliberately scoped:

- MCP-client or supervisor restarts preserve run state and in-flight runs because the daemon keeps running.
- Daemon restarts do not preserve in-flight worker ownership. On daemon startup, any run still marked `running` becomes terminal `orphaned` with the previous daemon PID and worker PID in the error context.
- Package upgrades can restart the stdio MCP frontend without restarting the daemon. If their package versions differ, tool calls return `DAEMON_VERSION_MISMATCH` with both versions and a restart hint instead of failing later with stale method or result-shape errors.

## Daemon Lifecycle

When installed locally or globally, use:

```bash
agent-orchestrator-daemon status
agent-orchestrator-daemon status --verbose
agent-orchestrator-daemon runs
agent-orchestrator-daemon runs --json --prompts
agent-orchestrator-daemon watch
agent-orchestrator-daemon start
agent-orchestrator-daemon stop
agent-orchestrator-daemon stop --force
agent-orchestrator-daemon restart
agent-orchestrator-daemon restart --force
agent-orchestrator-daemon prune --older-than-days 30 --dry-run
agent-orchestrator-daemon prune --older-than-days 30
```

With `npx`, target the daemon bin explicitly:

```bash
npx -y --package @ralphkrauss/agent-orchestrator@latest agent-orchestrator-daemon status
npx -y --package @ralphkrauss/agent-orchestrator@latest agent-orchestrator-daemon runs
npx -y --package @ralphkrauss/agent-orchestrator@latest agent-orchestrator-daemon watch
npx -y --package @ralphkrauss/agent-orchestrator@latest agent-orchestrator-daemon stop --force
npx -y --package @ralphkrauss/agent-orchestrator@latest agent-orchestrator-daemon restart
npx -y --package @ralphkrauss/agent-orchestrator@latest agent-orchestrator-daemon restart --force
npx -y --package @ralphkrauss/agent-orchestrator@latest agent-orchestrator-daemon prune --older-than-days 30 --dry-run
```

`stop` refuses while runs are active and prints the active run IDs. `stop --force` cancels active runs through the normal cancellation path, waits for terminal statuses, and exits. `restart` uses the same safe default and refuses active runs; `restart --force` cancels active runs before starting a fresh daemon. Direct `SIGTERM`/`SIGINT` to the daemon behaves like `stop --force`; `SIGKILL` cannot be caught and any in-flight runs become `orphaned` on next daemon startup.

After changing the configured npm version or dist-tag, restart the daemon so it picks up the same package build as the MCP frontend:

```bash
npx -y --package @ralphkrauss/agent-orchestrator@latest agent-orchestrator-daemon restart
```

`prune` deletes only terminal runs with `finished_at` older than the requested age. Use `--dry-run` first to inspect the matching run IDs.

## Observability

Use the daemon CLI to inspect sessions and runs:

```bash
agent-orchestrator-daemon status --verbose
agent-orchestrator-daemon runs
agent-orchestrator-daemon runs --json
agent-orchestrator-daemon runs --json --prompts
agent-orchestrator-daemon watch
```

`watch` opens an interactive terminal dashboard. Use arrow keys to move through
sessions and prompts, Enter to open details, Backspace or Escape to return, and
`q` to quit. Detail views include the raw prompt, recent activity, model/source,
session-resume audit state, artifact paths, and size indicators.

The dashboard groups runs by backend session ID when available and falls back to
the parent/child run chain while a backend session is still pending. Follow-up
runs record both the requested session ID and the backend-observed session ID so
the dashboard can warn when a resume appears to start or report a different
session.

Prompts are stored as `prompt.txt` in each private run directory so operators can
inspect exactly what was sent to a worker. The run store is local and permission
restricted, but prompts may contain sensitive instructions or secrets supplied by
callers. Do not pass API keys or other credentials in prompts unless you are
comfortable with them being written to the local run store.

For human-readable dashboard labels, pass metadata on `start_run` or
`send_followup`:

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

`title` and `summary` are also accepted as shorthand. Follow-up runs inherit the
session title and summary from the parent unless overridden. Prompt title and
summary are per run.

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
- On POSIX, if the root directory exists and is owned by another UID, startup aborts.
- On POSIX, if the root directory is owned by the current UID but has broader permissions, startup coerces it to `0700`.
- On POSIX, `daemon.sock` is bound under a restrictive umask so the socket file is `0600`.
- On Windows, the daemon listens on a named pipe derived from the run-store path; there is no socket file to remove.
- `daemon.pid` is written with `0600` mode where supported.
- A stale POSIX socket is unlinked only when it is owned by the current UID.

Secrets and CLI credentials are not stored by the MCP package. Worker authentication comes from the host CLI's normal auth state or from environment variables already present when the MCP server/daemon starts. Do not pass API keys as MCP tool arguments; those requests can be logged by clients.

Manual cleanup:

```bash
agent-orchestrator-daemon prune --older-than-days 30 --dry-run
agent-orchestrator-daemon prune --older-than-days 30
agent-orchestrator-daemon stop --force
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
| `get_observability_snapshot` | `{ limit?: number, include_prompts?: boolean, recent_event_limit?: number, diagnostics?: boolean }` | `{ snapshot: ObservabilitySnapshot }` |
| `list_worker_profiles` | `{ profiles_file?: string, cwd?: string }` | `{ profiles_file: string, profiles: WorkerProfile[] }` |
| `start_run` | Profile mode: `{ profile: string, profiles_file?: string, prompt: string, cwd: string, metadata?: object, execution_timeout_seconds?: number }`; direct mode: `{ backend: "codex" \| "claude", prompt: string, cwd: string, model?: string, reasoning_effort?: string, service_tier?: string, metadata?: object, execution_timeout_seconds?: number }` | `{ run_id: string }` |
| `list_runs` | `{}` | `{ runs: RunSummary[] }` |
| `get_run_status` | `{ run_id: string }` | `{ run_summary: RunSummary }` |
| `get_run_events` | `{ run_id: string, after_sequence?: number, limit?: number }` | `{ events: WorkerEvent[], next_sequence: number, has_more: boolean }` |
| `wait_for_run` | `{ run_id: string, wait_seconds: number }` | Terminal status or `{ status: "still_running", wait_exceeded: true, run_summary }` |
| `get_run_result` | `{ run_id: string }` | `{ run_summary: RunSummary, result: WorkerResult \| null }` |
| `send_followup` | `{ run_id: string, prompt: string, model?: string, reasoning_effort?: string, service_tier?: string, metadata?: object, execution_timeout_seconds?: number }` | `{ run_id: string }` for a new child run |
| `cancel_run` | `{ run_id: string }` | `{ accepted: true, status: RunStatus }` |

Most worker preparation failures are run failures rather than envelope failures. For example, if `codex` is missing, `start_run` creates a durable run and that run lands in `failed` with `WORKER_BINARY_MISSING` details.

`model` is passed through to the selected worker CLI as provided. Codex model
names change over time, so Codex validates only that the value is a non-empty
string. Claude aliases such as `opus` and `sonnet` are rejected when supplied
explicitly; pass a direct model id such as `claude-opus-4-7` or
`claude-opus-4-7[1m]` so the dashboard and worker invocation are auditable.
Follow-up runs inherit the parent run model unless a new `model` is supplied.

`reasoning_effort` is mapped to Codex `model_reasoning_effort` or Claude
`--effort`. Codex accepts `none`, `minimal`, `low`, `medium`, `high`, and
`xhigh`. Claude accepts `low`, `medium`, `high`, `xhigh`, and `max` on supported
direct model ids; `xhigh` is accepted only for Opus 4.7 to avoid Claude Code's
documented fallback to `high` on older models. `service_tier` is Codex-only:
`fast` and `flex` are passed through, while `normal` runs Codex without loading
the user's config so a global fast setting is not inherited.

The observability snapshot includes additive fields for model source, display
metadata, raw prompt artifacts, activity summaries, artifact sizes, and
session-resume audit state. Older runs without these fields load with
`legacy_unknown` or `null` defaults.

## Operational Notes

This package is for trusted local MCP clients. Worker processes run with the current user's OS privileges, inherit the daemon environment, and can use whatever credentials the host Codex or Claude CLI can access. Do not expose the daemon IPC endpoint to untrusted users or pass secrets as MCP tool arguments.

Concurrent runs against the same `cwd` are the supervisor's responsibility. The orchestrator does not create worktrees, isolate file systems, or lock a working directory. If two workers edit the same files, they can conflict.

If a daemon restart marks a run `orphaned`, the previous worker process may still be consuming CPU or API tokens. Inspect `~/.agent-orchestrator/daemon.log` and the run result for the previous daemon PID and worker PID, then clean up manually if needed.

On POSIX, prefer killing the process group when you know the PGID:

```bash
kill -TERM -<worker-pgid>
sleep 5
kill -KILL -<worker-pgid>
```

On Windows, use the worker PID from the run result:

```powershell
taskkill /PID <worker-pid> /T
taskkill /PID <worker-pid> /T /F
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
npm install "/path/to/agent-orchestrator/$package_file"
./node_modules/.bin/agent-orchestrator doctor --json
```

## Publishing

See [PUBLISHING.md](PUBLISHING.md) for:

- first manual npm publish
- GitHub Actions Trusted Publishing setup
- CodeArtifact publish workflow inputs
- license readiness guard
