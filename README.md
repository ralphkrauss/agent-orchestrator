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
agent-orchestrator opencode
agent-orchestrator opencode --cwd /path/to/workspace
agent-orchestrator-opencode
agent-orchestrator-opencode --cwd /path/to/workspace
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
agent-orchestrator opencode --print-config
agent-orchestrator opencode --profiles-file ~/.config/agent-orchestrator/profiles.json
agent-orchestrator opencode --profiles-json '{"version":1,"profiles":{}}'
agent-orchestrator opencode --skills .agents/skills
agent-orchestrator opencode --orchestrator-model anthropic/claude-sonnet-4-6
agent-orchestrator opencode --orchestrator-small-model openai/gpt-5.4-mini
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

## Claude Code Orchestration Mode (recommended rich-feature harness)

Claude Code orchestration mode starts Claude Code as a constrained supervisor
inside a per-launch isolated envelope. Claude is positioned as the **recommended
rich-feature** orchestration harness when its primitives are needed (native
push notifications, strong isolation flags such as `--strict-mcp-config`,
`--setting-sources ""`, `--tools`, and ephemeral skill / settings injection).
The OpenCode harness above remains a fully supported peer.

```bash
agent-orchestrator claude
agent-orchestrator claude --cwd /path/to/workspace
agent-orchestrator-claude
agent-orchestrator-claude --cwd /path/to/workspace
```

The launcher builds a per-launch ephemeral envelope under the system temp
directory containing the supervisor system prompt, a deny-by-default
`settings.json`, an `mcp.json` that exposes only the `agent-orchestrator` MCP
server, and a curated `.claude/skills/` directory under the envelope containing
only the project's `orchestrate-*` SKILL.md files. Claude is spawned with
`cwd = <envelope>` so its cwd-rooted discovery sees only those curated skills.
The spawn passes:

- `--strict-mcp-config --mcp-config <ephemeral mcp.json>` so only the
  `agent-orchestrator` MCP server is reachable.
- `--settings <ephemeral settings.json>` and `--setting-sources ""` so user,
  project, and local `settings.json` files are not loaded.
- `--append-system-prompt-file <ephemeral system-prompt.md>` so the supervisor
  contract is appended to Claude's default scaffolding.
- `--tools "Read,Glob,Grep"` so the only available built-in tools are the
  read-only inspection tools. `Bash`, `Edit`, `Write`, `WebFetch`, `WebSearch`,
  `Task`, `NotebookEdit`, and `TodoWrite` are unavailable. The agent-orchestrator
  MCP tools are loaded separately via `--mcp-config` and are not affected by
  `--tools`. `settings.permissions.deny` lists `Bash` and the other
  unavailable tools as defense in depth.
- Redirected `HOME`, `XDG_CONFIG_HOME`, and `CLAUDE_CONFIG_DIR` so the
  supervisor cannot read the user's `~/.claude/`.

The harness intentionally does **not** pass:

- `--disable-slash-commands` (would also disable skill discovery, blocking the
  curated `orchestrate-*` skills).
- `--add-dir <target workspace>` (Claude scans add-dir paths for project
  `.claude/skills`, `.claude/commands`, `.claude/agents`, `.claude/hooks`, and
  `CLAUDE.md`, which would re-introduce target workspace `.claude/*` leakage).
- `--allowed-tools` (only pre-approves; does not restrict availability — the
  reviewer-correct restriction surface for built-ins is `--tools`).
- `--dangerously-skip-permissions` (never).

Because `--add-dir` is not passed, the supervisor cannot directly read files
from the target workspace. Worker runs are dispatched with `cwd =
<target workspace>` via `mcp__agent-orchestrator__start_run`; workers have full
access in their own session. The supervisor learns about target workspace
content indirectly through `get_run_status`, `get_run_events`, and
`get_run_result`. This matches the "dumb supervisor" principle and is the
strongest isolation that still permits orchestration.

`--dangerously-skip-permissions` is **never** added to the spawn command line.
Forbidden Claude flags after `--` (the harness owns these or they would break
isolation): `--mcp-config`, `--strict-mcp-config`, `--allowed-tools`,
`--disallowed-tools`, `--add-dir`, `--settings`, `--setting-sources`,
`--system-prompt(-file)`, `--append-system-prompt(-file)`, `--plugin-dir`,
`--agents`, `--agent`, `--permission-mode`, `--tools`,
`--disable-slash-commands`, `--bare`. (`--bare` disables skill / CLAUDE.md /
plugin / MCP auto-discovery, which would hide the curated `orchestrate-*`
skills the supervisor depends on.)

The supervisor's tool surface is exactly `Read`, `Glob`, `Grep`, and the
`agent-orchestrator` MCP tools. `Bash`, `Edit`, `Write`, `WebFetch`,
`WebSearch`, `Task`, `NotebookEdit`, and `TodoWrite` are unavailable.

For long-running run supervision, the supervisor uses bounded
`mcp__agent-orchestrator__wait_for_any_run` polls (1-300 s each) with a
notification cursor. Default wake semantics are the union of `terminal` and
`fatal_error`, so a fatal backend error surfaces immediately rather than
waiting for terminal. The standalone `agent-orchestrator monitor <run_id>` CLI
is documented for use from the user's own shell (e.g., as a one-shot
background process tied to a single run). The supervisor itself does **not**
invoke this CLI, because Bash is not part of its tool surface.

Inspect the discovery report and the generated envelope without launching
Claude:

```bash
agent-orchestrator claude --print-discovery
agent-orchestrator claude --print-config --cwd /path/to/workspace
```

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

`agent-orchestrator-daemon` remains available as a standalone daemon-control
alias for scripts. With `npx`, run daemon commands through the main bin:

```bash
npx -y @ralphkrauss/agent-orchestrator@latest status
npx -y @ralphkrauss/agent-orchestrator@latest runs
npx -y @ralphkrauss/agent-orchestrator@latest watch
npx -y @ralphkrauss/agent-orchestrator@latest stop --force
npx -y @ralphkrauss/agent-orchestrator@latest restart
npx -y @ralphkrauss/agent-orchestrator@latest restart --force
npx -y @ralphkrauss/agent-orchestrator@latest prune --older-than-days 30 --dry-run
```

`stop` refuses while runs are active and prints the active run IDs. `stop --force` cancels active runs through the normal cancellation path, waits for terminal statuses, and exits. `restart` uses the same safe default and refuses active runs; `restart --force` cancels active runs before starting a fresh daemon. Direct `SIGTERM`/`SIGINT` to the daemon behaves like `stop --force`; `SIGKILL` cannot be caught and any in-flight runs become `orphaned` on next daemon startup.

After changing the configured npm version or dist-tag, restart the daemon so it picks up the same package build as the MCP frontend:

```bash
npx -y @ralphkrauss/agent-orchestrator@latest restart
```

`prune` deletes only terminal runs with `finished_at` older than the requested age. Use `--dry-run` first to inspect the matching run IDs.

## Observability

Use the main CLI to inspect sessions and runs:

```bash
agent-orchestrator status --verbose
agent-orchestrator runs
agent-orchestrator runs --json
agent-orchestrator runs --json --prompts
agent-orchestrator watch
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
agent-orchestrator prune --older-than-days 30 --dry-run
agent-orchestrator prune --older-than-days 30
agent-orchestrator stop --force
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
| `start_run` | Profile mode: `{ profile: string, profiles_file?: string, prompt: string, cwd: string, metadata?: object, idle_timeout_seconds?: number, execution_timeout_seconds?: number }`; direct mode: `{ backend: "codex" \| "claude", prompt: string, cwd: string, model?: string, reasoning_effort?: string, service_tier?: string, metadata?: object, idle_timeout_seconds?: number, execution_timeout_seconds?: number }` | `{ run_id: string }` |
| `list_runs` | `{}` | `{ runs: RunSummary[] }` |
| `get_run_status` | `{ run_id: string }` | `{ run_summary: RunSummary }` |
| `get_run_events` | `{ run_id: string, after_sequence?: number, limit?: number }` | `{ events: WorkerEvent[], next_sequence: number, has_more: boolean }` |
| `wait_for_run` | `{ run_id: string, wait_seconds: number }` | Terminal status or `{ status: "still_running", wait_exceeded: true, run_summary }` |
| `wait_for_any_run` | `{ run_ids: string[], wait_seconds: number, after_notification_id?: string, kinds?: ("terminal" \| "fatal_error")[] }` | `{ notifications: RunNotification[], wait_exceeded: boolean }` |
| `list_run_notifications` | `{ run_ids?: string[], since_notification_id?: string, kinds?: ("terminal" \| "fatal_error")[], include_acked?: boolean, limit?: number }` | `{ notifications: RunNotification[] }` |
| `ack_run_notification` | `{ notification_id: string }` | `{ acked: boolean, notification_id: string }` |
| `get_run_result` | `{ run_id: string }` | `{ run_summary: RunSummary, result: WorkerResult \| null }` |
| `send_followup` | `{ run_id: string, prompt: string, model?: string, reasoning_effort?: string, service_tier?: string, metadata?: object, idle_timeout_seconds?: number, execution_timeout_seconds?: number }` | `{ run_id: string }` for a new child run |
| `cancel_run` | `{ run_id: string }` | `{ accepted: true, status: RunStatus }` |

`wait_for_any_run` blocks against the local daemon until any of the supplied
run ids has a `terminal` or `fatal_error` notification newer than
`after_notification_id`, bounded by `wait_seconds` (1-300). Default wake
semantics are the union of `terminal` and `fatal_error`. The MCP server also
relays `notifications/run/changed` push hints with the minimal payload
`{ run_id, notification_id, kind, status }`. Push is advisory; the durable
notification journal is authoritative.

The `agent-orchestrator monitor <run_id>` CLI is for **out-of-envelope** use
from a user shell (e.g. as a one-shot `&`-suffixed background process tied to
a single run, or as a scriptable wrapper around `wait_for_any_run`). The
Claude Code supervisor itself does **not** invoke this CLI: Bash is not part
of the supervisor's tool surface, and run supervision inside the envelope uses
bounded `mcp__agent-orchestrator__wait_for_any_run` polls. The CLI blocks
against the daemon and exits with a documented code: `0` completed, `1`
failed/orphaned, `2` cancelled, `3` timed_out, `10` fatal_error, `4` unknown
run, `5` daemon unavailable, `6` argument error.

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

### Long-Running Runs

The daemon supervises long work with an idle-progress timeout rather than a long
default wall-clock timeout. New generated config uses
`default_idle_timeout_seconds: 1200`, `max_idle_timeout_seconds: 7200`,
`default_execution_timeout_seconds: null`, and
`max_execution_timeout_seconds: 14400`. `idle_timeout_seconds` cancels only after
the worker has been quiet for that many seconds; stdout, stderr, parsed backend
events, errors, start, and terminalization all count as activity.
`execution_timeout_seconds` remains available as an explicit hard elapsed-time
cap for tasks that truly need one.

Supervisors should keep `wait_for_run` bounded. A useful cadence is a first
check-in around 30 seconds after `start_run`, then roughly 2 minutes, 5 minutes,
and a 10-15 minute ceiling while `last_activity_at` continues advancing. At each
check-in, inspect `get_run_status` for `last_activity_at`,
`last_activity_source`, `idle_timeout_seconds`, `execution_timeout_seconds`,
`timeout_reason`, `terminal_reason`, and `latest_error`; use `get_run_events`
when the activity or error state changed.

Known fatal backend errors from structured events or stderr, such as auth,
quota, rate limit, invalid model, permission, protocol, backend availability,
or missing worker binaries, are surfaced as `latest_error` and fail the run
promptly. Do not keep waiting for the idle timeout after `latest_error.fatal` is
visible. Do not cancel a run only because elapsed time is high when activity is
still advancing; choose a larger `idle_timeout_seconds` for known quiet work.

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
