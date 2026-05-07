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
node dist/cli.js server
```

Bare `agent-orchestrator` (no subcommand) prints this help when run from a
terminal and starts the stdio MCP server when stdin is piped (the way every MCP
client launches it). Use `agent-orchestrator server` to start the MCP server
explicitly from a terminal.

To test a checkout without colliding with an npm-installed stable daemon, use
the short local `just` passthrough:

```bash
just local status
just local claude --cwd /path/to/workspace
just local opencode --cwd /path/to/workspace
just local stop --force
just local-clean
```

`just local ...` builds the branch and runs `dist/cli.js` with an isolated
`AGENT_ORCHESTRATOR_HOME`. For an npm-style shell session instead, run
`eval "$(just local-env)"` and then use `agent-orchestrator ...` normally. The
generated shims are named like the npm package bins (`agent-orchestrator`,
`agent-orchestrator-claude`, `agent-orchestrator-opencode`, and
`agent-orchestrator-daemon`) but point at this checkout.

The branch gets its own daemon socket/pipe, PID file, logs, run store, and
Claude supervisor state. The default store is a deterministic short path under
`${TMPDIR:-/tmp}/agent-orchestrator-local/<checkout>-<hash>` so POSIX socket
paths stay below OS limits. `local-clean` force-stops the local branch daemon if
the build is present and removes both that isolated store and the generated
command shims. Set
`AGENT_ORCHESTRATOR_LOCAL_BASE=/short/path` to choose a different base
directory. The normal global npm installation continues to use
`${AGENT_ORCHESTRATOR_HOME:-$HOME/.agent-orchestrator}`.

## Prerequisites

- Node.js 22 or newer.
- Codex CLI installed and authenticated if you want Codex workers.
- Claude CLI installed and authenticated if you want Claude workers.
- `@cursor/sdk` installed (ships as an optional dependency) and `CURSOR_API_KEY`
  available to the daemon (set via `agent-orchestrator auth cursor` or exported
  in the daemon environment) if you want Cursor workers. Cursor runs use the
  SDK in-process, local runtime only; tokens are billed to your Cursor account.
  See `docs/development/cursor-backend.md` and
  [`docs/development/auth-setup.md`](docs/development/auth-setup.md) for the
  daemon-managed credential file.

Linux and macOS use Unix sockets and POSIX process groups. Windows uses a
per-store named pipe for daemon IPC and `taskkill` for worker process-tree
cancellation.

On Windows, `agent-orchestrator claude` requires Git Bash (the MSYS-flavored
`bash` that Claude Code uses for its `Bash` tool); PowerShell-only Claude Code
installs are not supported. The Claude supervisor's pinned monitor command and
`Bash(...)` permission entries are emitted with forward-slash paths on Windows
(for example `C:/Users/<name>/AppData/Roaming/npm/...`) so they do not collide
with the supervisor's Bash deny list.

On Windows, `just` recipes run under PowerShell Desktop and through `node`
directly for parameter-taking recipes (via `just`'s `[script]` attribute, which
requires `just >= 1.44`); no Git Bash or `sh.exe` is required for the dev
workflow. The Git Bash requirement for `agent-orchestrator claude` itself
(described above) is unchanged because Claude Code uses Bash for its `Bash`
tool.

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
- `@cursor/sdk` module resolvability and `CURSOR_API_KEY` presence
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
`list_worker_profiles` MCP tool returns usable live profiles plus
`invalid_profiles` diagnostics, so one broken profile does not hide the rest.

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

The current package supports Codex, Claude, and Cursor worker backends.
Cursor uses the `@cursor/sdk` module in-process (local runtime only) and
requires `CURSOR_API_KEY`; cursor profiles must declare `model` and must omit
`reasoning_effort` and `service_tier` (see
`docs/development/cursor-backend.md`). **BREAKING (codex):** codex profiles
gain a new optional `codex_network` field (`isolated` / `workspace` /
`user-config`) that defaults to `'isolated'` when unset. See
`docs/development/codex-backend.md` for the migration. Claude profiles can opt
into native multi-account rotation via `claude_account_priority` and the
`agent-orchestrator auth login claude --account <name>` /
`auth set claude --account <name>` commands; details in
`docs/development/claude-multi-account.md`. The profiles manifest stays
provider-agnostic so future backends can add capability descriptors without
changing the supervisor workflow.

OpenCode permissions are application-level guardrails, not an operating-system
sandbox. For stronger enforcement, run the supervisor in a read-only worktree
mount, under a separate OS user, or inside a container with only intentional
writable paths exposed.

OpenCode supervision is MCP-only. The OpenCode supervisor does not use Bash,
`Bash run_in_background`, or `agent-orchestrator monitor`; it starts runs with
`start_run`, waits with `wait_for_any_run`, fetches state with
`get_run_progress`/`get_run_status`/`get_run_events`/`get_run_result`, and
reconciles later turns with `list_run_notifications`.

## Claude Code Orchestration Mode (recommended rich-feature harness)

Claude Code orchestration mode starts Claude Code as a constrained supervisor
in the target workspace. Claude is positioned as the **recommended
rich-feature** orchestration harness when its primitives are needed (strong
isolation flags such as `--strict-mcp-config`, `--setting-sources user`,
`--tools`, embedded workflow / settings injection, mirrored workspace skills,
and daemon-owned durable notification reconciliation).
The OpenCode harness above remains a fully supported peer.

```bash
agent-orchestrator claude
agent-orchestrator claude --cwd /path/to/workspace
agent-orchestrator-claude
agent-orchestrator-claude --cwd /path/to/workspace
```

The launcher builds a stable state envelope under
`${AGENT_ORCHESTRATOR_HOME:-$HOME/.agent-orchestrator}/claude-supervisor/envelopes/<workspace>-<hash>`.
The hash is derived from the real target workspace path, so generated MCP,
settings, prompt, inline profile, and debug files are stable per workspace.
Claude itself is spawned with `cwd = <target workspace>`, matching a normal
Claude Code launch for workspace-relative context and slash-command UX. On
every launch the launcher regenerates the supervisor system prompt,
deny-by-default `settings.json`, `mcp.json`, a redirected user skill mirror
populated from the target workspace `.claude/skills`, and a curated snapshot of
the project's `orchestrate-*` SKILL.md files for print-config/debugging; the
orchestrate workflow instructions are also embedded in the generated system
prompt for reliability.
Claude's own account/auth state is redirected to a durable orchestrator-owned
state directory, defaulting to
`${AGENT_ORCHESTRATOR_HOME:-$HOME/.agent-orchestrator}/claude-supervisor`, so
you can log in once without exposing your normal `~/.claude` or target
workspace `.claude` files. Inside that state directory, the supervisor uses
`home/.claude` because Claude Code's account auth and user skill source are
read from `HOME/.claude`.
The spawn passes:

- `--strict-mcp-config --mcp-config <generated mcp.json>` so only the
  `agent-orchestrator` MCP server is reachable.
- `--settings <generated settings.json>` and `--setting-sources user` so only
  the redirected orchestrator-owned user settings and skill mirror are loaded;
  project/local settings and the user's real `~/.claude` settings are not
  loaded.
- `--append-system-prompt-file <generated system-prompt.md>` so the supervisor
  contract is appended to Claude's default scaffolding.
- `--tools "Read,Glob,Grep,Bash,Skill"` so the only available built-in tools
  are read-only workspace inspection, the pinned monitor command surface, and
  Claude's skill loader.
- `--allowed-tools "Read,Glob,Grep,Bash(<node> <cli> monitor * --json-line),Bash(<node> <cli> monitor * --json-line --since *),Bash(pwd),Bash(git status),Bash(git status *),Skill,mcp__agent-orchestrator__..."`
  (comma-joined) and `--permission-mode dontAsk` pre-approve only read-only
  inspection, the explicit Bash allowlist (two pinned monitor argv shapes:
  `agent-orchestrator monitor <run_id> --json-line` and the cursored variant
  `... --json-line --since <notification_id>`, plus `pwd`, `git status`, and
  `git status *`), the skill surface, and the Claude-specific safe subset of
  agent-orchestrator MCP tools. Anything else (including `git log`, `cat`,
  `ls`, `head`, `tail`, `grep`, `find`, `jq`, `git diff`, `git show`,
  bypass shapes such as `git -C . add` or `command touch /tmp/x`, etc.) is
  not in the allow list and is denied. `wait_for_run` and `wait_for_any_run`
  are denied for the Claude supervisor; the pinned Bash monitor is the
  current-turn wake path and `list_run_notifications` / `ack_run_notification`
  handle cross-turn reconciliation. Shell metacharacters such as `;`, `&`
  (including `&&`), `|`, redirection, command substitution, backslash escapes,
  and newline are explicitly denied so a shell command cannot chain another
  command or redirect output into a write.
- Redirected `HOME`, `XDG_CONFIG_HOME`, and `CLAUDE_CONFIG_DIR` to the durable
  orchestrator-owned state directory so Claude login survives across launches
  while the supervisor still cannot read the user's normal `~/.claude/`.
  `AGENT_ORCHESTRATOR_HOME` is kept explicit so the MCP server still talks to
  the normal orchestrator daemon store rather than creating one under the
  supervisor's redirected `HOME`.
- A regenerated `HOME/.claude/skills` mirror copied from the target workspace
  `.claude/skills`, so `/skills` can find the same project skills without
  enabling project `settings.json`, hooks, or project MCP configuration.

### Status hooks (issue #40)

The launcher accepts two opt-in flags that drive the daemon-owned orchestrator
status surface:

- `--remote-control` embeds the documented `remoteControlAtStartup` and
  `agentPushNotifEnabled` keys in the generated supervisor `settings.json`
  (off by default). `--remote-control-session-name-prefix <prefix>` is forwarded
  to Claude as a CLI flag.
- `--orchestrator-label <name>` sets the orchestrator's display label
  surfaced to user-level status hooks. Defaults to `basename(cwd)`.

User-level hooks live in `~/.config/agent-orchestrator/hooks.json` and follow
the Claude-parity shell-string shape used by `~/.claude/settings.json` hooks.
The daemon emits a v1 `orchestrator_status_changed` payload to each entry
and never blocks orchestration on hook execution. See
[`docs/development/orchestrator-status-hooks.md`](docs/development/orchestrator-status-hooks.md)
and the example tmux hook at [`examples/hooks/tmux-status.sh`](examples/hooks/tmux-status.sh).

Read the current orchestrator status from a shell with
`agent-orchestrator supervisor status`. The top-level
`agent-orchestrator status` subcommand stays reserved for daemon status.

The harness intentionally does **not** pass:

- `--add-dir <target workspace>` because the target workspace is already the
  process cwd.
- `--dangerously-skip-permissions` (never).

The supervisor may inspect the workspace with read-only tools, but cannot edit
files directly. Worker runs are dispatched with `cwd = <target workspace>` via
`mcp__agent-orchestrator__start_run`; workers have full access in their own
session. Worker profile setup is handled through `list_worker_profiles` and
`upsert_worker_profile`; the supervisor must not dispatch workers just to edit
the profiles manifest. It must not inspect Claude Code internal
`.claude/projects` or `tool-results` files.

`--dangerously-skip-permissions` is **never** added to the spawn command line.
Forbidden Claude flags after `--` (the harness owns these or they would break
isolation): `--mcp-config`, `--strict-mcp-config`, `--allowed-tools`,
`--disallowed-tools`, `--add-dir`, `--settings`, `--setting-sources`,
`--system-prompt(-file)`, `--append-system-prompt(-file)`, `--plugin-dir`,
`--agents`, `--agent`, `--permission-mode`, `--tools`,
`--disable-slash-commands`, `--bare`. (`--bare` changes Claude memory, plugin,
auth/keychain, and discovery behavior that the harness owns through the
restricted supervisor launch.)

The supervisor's tool surface is `Read`, `Glob`, `Grep`, `Bash`, the `Skill`
tool, and the Claude-specific agent-orchestrator MCP allowlist. The Bash
allowlist contains exactly five patterns: two explicit pinned monitor argv
shapes (`Bash(<command-prefix> monitor * --json-line)` and the cursored
`Bash(<command-prefix> monitor * --json-line --since *)`),
`Bash(pwd)`, `Bash(git status)`, and `Bash(git status *)`. Other read-only
commands such as `cat`, `ls`, `head`, `tail`, `grep`, `find`, `jq`, `git log`,
`git diff`, `git show`, `git rev-parse`, and `git branch` are not in the
allowlist; use Read, Glob, Grep, and the agent-orchestrator MCP tools for those
inspections. `Edit`, `Write`, `WebFetch`, `WebSearch`, `Task`, `NotebookEdit`,
`TodoWrite`, write-shaped shell commands such as `touch`, `rm`, `mv`, `cp`, and
mutating git commands such as `git add`, `git commit`, `git push`, `git reset`,
`git checkout`, `git merge`, and `git rebase` are unavailable, including via
global-option bypass shapes such as `git -C dir add` or `git --git-dir=...`. The MCP blocking
wait tools `wait_for_run` / `wait_for_any_run` are unavailable to the Claude
supervisor.

For long-running run supervision, the supervisor starts worker runs through the
daemon and immediately launches the pinned `agent-orchestrator monitor
<run_id> --json-line` command with Claude's `Bash` tool in background mode.
The monitor prints one JSON line for the first `terminal` or `fatal_error`
notification and exits with the documented monitor exit code.
`mcp__agent-orchestrator__list_run_notifications` is the cross-turn
reconciliation path, and `mcp__agent-orchestrator__ack_run_notification` is
called once a notification has been handled. `wait_for_run` and
`wait_for_any_run` are MCP blocking wait tools for non-Claude clients and are
denied in the Claude supervisor.

Supervisor wait behavior is intentionally different by client:

| Supervisor | Current-turn wake path | Fallback | Cross-turn reconciliation |
|---|---|---|---|
| OpenCode | `wait_for_any_run` over MCP | bounded `wait_for_run` for older daemons or single-run compatibility | `list_run_notifications` |
| Claude Code | pinned `agent-orchestrator monitor <run_id> --json-line` through background Bash | relaunch monitor with `--since <notification_id>` when recovering an inherited active run | `mcp__agent-orchestrator__list_run_notifications` |

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

Secrets and CLI credentials are not stored in MCP tool arguments. Worker
authentication comes from the host CLI's normal auth state or from environment
variables already present when the MCP server/daemon starts. The Claude Code
supervisor launcher uses a dedicated orchestrator-owned state directory for its
own Claude login so that account auth can survive across isolated supervisor
launches. Do not pass API keys as MCP tool arguments; those requests can be
logged by clients.

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
| `list_worker_profiles` | `{ profiles_file?: string, cwd?: string }` | `{ profiles_file: string, profiles: WorkerProfile[], invalid_profiles: InvalidWorkerProfile[], diagnostics: string[] }` |
| `upsert_worker_profile` | `{ profiles_file?: string, cwd?: string, profile: string, backend: "codex" \| "claude" \| "cursor", model?: string, variant?: string, reasoning_effort?: string, service_tier?: string, codex_network?: "isolated" \| "workspace" \| "user-config", description?: string, metadata?: object, create_if_missing?: boolean }` | `{ profiles_file: string, profile: WorkerProfile, previous_profile: object \| null, created: boolean, invalid_profiles: InvalidWorkerProfile[], diagnostics: string[] }` |
| `start_run` | Profile mode: `{ profile: string, profiles_file?: string, prompt: string, cwd: string, metadata?: object, idle_timeout_seconds?: number, execution_timeout_seconds?: number }`; direct mode: `{ backend: "codex" \| "claude" \| "cursor", prompt: string, cwd: string, model?: string, reasoning_effort?: string, service_tier?: string, codex_network?: "isolated" \| "workspace" \| "user-config", metadata?: object, idle_timeout_seconds?: number, execution_timeout_seconds?: number }` | `{ run_id: string }` |
| `list_runs` | `{}` | `{ runs: RunSummary[] }` |
| `get_run_status` | `{ run_id: string }` | `{ run_summary: RunSummary }` |
| `get_run_events` | `{ run_id: string, after_sequence?: number, limit?: number }` | `{ events: WorkerEvent[], next_sequence: number, has_more: boolean }` |
| `get_run_progress` | `{ run_id: string, after_sequence?: number, limit?: number, max_text_chars?: number }` | `{ run_summary: RunSummary, progress: { event_count, next_sequence, has_more, latest_event_sequence, latest_event_at, latest_text, recent_events } }` |
| `wait_for_run` | `{ run_id: string, wait_seconds: number }` | Terminal status or `{ status: "still_running", wait_exceeded: true, run_summary }` |
| `wait_for_any_run` | `{ run_ids: string[], wait_seconds: number, after_notification_id?: string, kinds?: ("terminal" \| "fatal_error")[] }` | `{ notifications: RunNotification[], wait_exceeded: boolean }` |
| `list_run_notifications` | `{ run_ids?: string[], since_notification_id?: string, kinds?: ("terminal" \| "fatal_error")[], include_acked?: boolean, limit?: number }` | `{ notifications: RunNotification[] }` |
| `ack_run_notification` | `{ notification_id: string }` | `{ acked: boolean, notification_id: string }` |
| `get_run_result` | `{ run_id: string }` | `{ run_summary: RunSummary, result: WorkerResult \| null }` |
| `send_followup` | `{ run_id: string, prompt: string, model?: string, reasoning_effort?: string, service_tier?: string, codex_network?: "isolated" \| "workspace" \| "user-config", metadata?: object, idle_timeout_seconds?: number, execution_timeout_seconds?: number }` (codex_network is direct-mode-only and rejected when the parent run is profile-mode) | `{ run_id: string }` for a new child run |
| `cancel_run` | `{ run_id: string }` | `{ accepted: true, status: RunStatus }` |

`wait_for_any_run` blocks against the local daemon until any of the supplied
run ids has a `terminal` or `fatal_error` notification newer than
`after_notification_id`, bounded by `wait_seconds` (1-300). Default wake
semantics are the union of `terminal` and `fatal_error`. The MCP server also
relays `notifications/run/changed` push hints with the minimal payload
`{ run_id, notification_id, kind, status }`. Push is advisory; the durable
notification journal is authoritative.

`get_run_progress` is the preferred user-facing progress/status tool. It
returns a bounded tail or cursor page of compact event summaries plus extracted
text snippets, so supervisors do not need to fetch large raw event pages or
parse client tool-result files. Use `get_run_events` only when raw backend
events are explicitly needed, with a small `limit` and an `after_sequence`
cursor.

For backends that emit a terminal result event without a summary, such as some
Codex JSON streams, `get_run_result` falls back to the latest assistant message
so terminal results still include the worker's final text.

The `agent-orchestrator monitor <run_id>` CLI is a one-shot notification bridge
that blocks against the daemon, prints exactly one JSON line when a terminal or
fatal-error notification arrives, and exits with a documented code: `0`
completed, `1` failed/orphaned, `2` cancelled, `3` timed_out, `10` fatal_error,
`4` unknown run, `5` daemon unavailable, `6` argument error. The Claude Code
supervisor uses this CLI as its current-turn wake path through a pinned
background Bash invocation and reconciles cross-turn with
`list_run_notifications`. OpenCode and other notification-aware MCP clients use
`wait_for_any_run` for the same wake purpose.

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
`fast` and `flex` are passed through; `normal` is suppressed in the codex argv
because it is the codex CLI default. **BREAKING (codex):** as of this release
the codex backend's network egress posture is controlled by a separate
`codex_network` profile field (`isolated`, `workspace`, `user-config`) rather
than by `service_tier`. Codex profiles that omit `codex_network` default to
`'isolated'` (closed network egress, `--ignore-user-config` passed to
`codex exec`). See `docs/development/codex-backend.md` for the migration
table, the three migration options, and the per-run warning copy emitted in
the run event log.

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

Supervisors should use the client-specific wake path documented above. Claude
Code uses the pinned background Bash monitor and reconciles cross-turn with
`list_run_notifications`; `wait_for_run` and `wait_for_any_run` are denied for
the Claude supervisor. OpenCode and generic notification-aware MCP clients use
`wait_for_any_run` with a bounded wait and notification cursor.
`wait_for_run` remains a bounded single-run compatibility fallback for clients
that cannot use `wait_for_any_run`.

For fallback polling, a useful cadence is a first check-in around 30 seconds
after `start_run`, then roughly 2 minutes, 5 minutes, and a 10-15 minute ceiling
while `last_activity_at` continues advancing. At each check-in, inspect
`get_run_status` for `last_activity_at`, `last_activity_source`,
`idle_timeout_seconds`, `execution_timeout_seconds`, `timeout_reason`,
`terminal_reason`, and `latest_error`; use `get_run_progress` when the activity
or error state changed. Reserve `get_run_events` for raw-event debugging.

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
