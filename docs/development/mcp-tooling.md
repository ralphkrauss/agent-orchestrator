# MCP Tooling

This repository includes a small GitHub-focused MCP setup adapted for this
standalone open source package.

## Servers

| Server | Client Configs | Purpose | Credentials |
|---|---|---|---|
| `github` | `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `opencode.json` | GitHub API through `ghcr.io/github/github-mcp-server` | `GITHUB_TOKEN` mapped to `GITHUB_PERSONAL_ACCESS_TOKEN` |
| `gh` | `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `opencode.json` | Repo-local MCP wrapper around the `gh` CLI | `GITHUB_TOKEN` mapped to `GH_TOKEN`, with local `gh auth token` fallback |
| `agent-orchestrator` | `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `opencode.json` | Local dogfood instance of this package, launched from `dist/cli.js` | No MCP secrets; worker CLIs use host-local auth |

## Credential Resolution

Secret-bearing MCP entries launch through:

```bash
node scripts/mcp-secret-bridge.mjs <profile> -- <command> [args...]
```

The bridge resolves `GITHUB_TOKEN` in this order:

1. `~/.config/agent-orchestrator/mcp-secrets.env`
2. current process environment, such as `GITHUB_TOKEN` or `GH_TOKEN`
3. `gh auth token`

Blank entries in the optional secrets file are treated as unset, so the
generated `GITHUB_TOKEN=` template falls through to process env or local `gh`
auth.

The token is never printed by the bridge.

Initialize the optional user-level secrets file with:

```bash
node scripts/init-mcp-secrets.mjs
```

Then edit:

```text
~/.config/agent-orchestrator/mcp-secrets.env
```

The local `gh auth token` fallback means a machine that already has `gh auth
login` configured can usually use these MCP servers without copying the token
into the secrets file.

## Client Setup

Claude Code reads:

```text
.mcp.json
```

Cursor reads:

```text
.cursor/mcp.json
```

Codex reads:

```text
.codex/config.toml
```

OpenCode reads:

```text
opencode.json
```

Normal OpenCode development sessions use `opencode.json`. The orchestration
launcher is intentionally separate:

```bash
agent-orchestrator opencode
agent-orchestrator-opencode
```

That launcher starts OpenCode with a process-local `OPENCODE_CONFIG_CONTENT`
overlay instead of editing `opencode.json`, user config, or global config. The
overlay disables the broad `github` and `gh` MCP servers, configures only the
local `agent-orchestrator` MCP server, loads project-owned `orchestrate-*`
skills from the shared `.agents/skills/` root, denies bash, and restricts direct
writes to the profiles manifest plus `.agents/skills/orchestrate-*/SKILL.md`.

Passthrough arguments after `--` are limited to no OpenCode subcommand or `run`
followed by positional prompt tokens. The launcher rejects non-supervisor
subcommands and any option token after `run`, including `--agent`, `--attach`,
`--dir`, `--share`, `--session`, `--file`, and
`--dangerously-skip-permissions`.

### Claude Code orchestration launcher

A second supervisor harness ships in this repo and is positioned as the
**recommended rich-feature** harness when its primitives are needed (strong
isolation flags such as `--strict-mcp-config`, `--setting-sources user`,
`--tools`, embedded workflow / settings / MCP injection, mirrored workspace
skills, target-workspace launches, and daemon-owned durable notification
reconciliation). The
OpenCode harness above remains a fully supported peer; both are documented
side-by-side and there is no deprecation:

```bash
agent-orchestrator claude
agent-orchestrator-claude
```

The Claude launcher builds a stable state envelope under
`${AGENT_ORCHESTRATOR_HOME:-$HOME/.agent-orchestrator}/claude-supervisor/envelopes/<workspace>-<hash>`
and spawns `claude` with `cwd = <target workspace>`. The hash is derived from
the real target workspace path, so generated MCP, settings, prompt, inline
profile, and debug files are stable per workspace. On every launch, the
launcher regenerates a curated snapshot of the project's `orchestrate-*`
SKILL.md files, a redirected user skill mirror copied from the target workspace
`.claude/skills`, a deny-by-default `settings.json`, and an `mcp.json` exposing
only `agent-orchestrator`. Slash commands stay enabled for normal Claude Code
controls such as `/exit` and `/skills`; `/skills` resolves through the
redirected `HOME/.claude/skills` mirror so project settings can stay disabled,
and the same orchestrate workflow instructions are embedded in the generated
system prompt for reliability.
Claude's own account/auth state is redirected to a durable orchestrator-owned
state directory, defaulting to
`${AGENT_ORCHESTRATOR_HOME:-$HOME/.agent-orchestrator}/claude-supervisor`, so a
supervisor login persists without exposing the user's normal `~/.claude`. The
durable `HOME` contains `.claude` because Claude Code account auth is read from
`HOME/.claude`; `AGENT_ORCHESTRATOR_HOME` remains explicit so the embedded MCP
server still uses the normal daemon store. The spawn passes
`--strict-mcp-config`, `--setting-sources user`, `--tools "Read,Glob,Grep,Bash,Skill"`
(read-only inspection, the pinned monitor command surface, and skill loading),
`--allowed-tools` with `Read`, `Glob`, `Grep`, Bash, `Skill`, and the
Claude-specific safe MCP allowlist, `--permission-mode dontAsk`,
`--append-system-prompt-file`, and redirects
`HOME`, `XDG_CONFIG_HOME`, and `CLAUDE_CONFIG_DIR` to that durable state
directory. `wait_for_run` and `wait_for_any_run` are denied for the Claude
supervisor because the pinned background Bash monitor is its current-turn wake
path. The Bash allowlist contains exactly five patterns: two explicit monitor
argv shapes (`Bash(<node> <cli> monitor * --json-line)` and the cursored
`Bash(<node> <cli> monitor * --json-line --since *)`), `Bash(pwd)`,
`Bash(git status)`, and `Bash(git status *)`. Other
read-only commands such as `cat`, `ls`, `head`, `tail`, `grep`, `find`, `jq`,
`git log`, `git diff`, `git show`, `git rev-parse`, and `git branch` are not
allowlisted; the supervisor uses `Read`, `Glob`, `Grep`, and the agent-orchestrator
MCP tools for those inspections instead. Shell metacharacters such as `;`,
`&` (including `&&`), `|`, redirection, command substitution, backslash escapes,
and newline are explicitly denied so a shell command cannot chain another
command or redirect output into a write. Write-shaped commands such as
`touch`, `rm`, `mv`, `cp`, mutating git commands such as `git add`,
`git commit`, `git push`, `git reset`, `git checkout`, `git merge`,
`git rebase`, and bypass shapes such as `git -C dir add`, `git --git-dir=...`,
`command touch`, and `builtin touch` are denied as defense in depth. The
launcher never passes `--dangerously-skip-permissions`,
does not use `--add-dir` because the target workspace is already the process
cwd, and keeps user-supplied `--tools`, `--allowed-tools`, `--permission-mode`,
`--disable-slash-commands`, and `--bare` forbidden because the harness owns
those surfaces.

The supervisor may inspect the workspace with read-only tools, but cannot edit
files directly. Worker runs are dispatched with `cwd = <target workspace>` via
`mcp__agent-orchestrator__start_run`; workers have full access in their own
session. The supervisor checks progress through `get_run_progress`, reconciles
lifecycle through `get_run_status`, and fetches terminal output through
`get_run_result`. It uses `get_run_events` only when raw backend events are
explicitly needed, with a small limit and an `after_sequence` cursor. The
supervisor repairs worker profile configuration through `list_worker_profiles`
and `upsert_worker_profile`, not by dispatching a worker to edit the profiles
manifest. It must not inspect Claude Code internal `.claude/projects` or
`tool-results` files.

Inspect the discovery report and the generated envelope without spawning
Claude:

```bash
agent-orchestrator claude --print-discovery
agent-orchestrator claude --print-config --cwd /path/to/workspace
```

### Notification-aware run supervision

Both harnesses share daemon-owned, backend-agnostic notification primitives:

- `wait_for_any_run({ run_ids[], wait_seconds, after_notification_id?, kinds? })`
  blocks against the local daemon until any of the supplied runs has a
  `terminal` or `fatal_error` notification newer than the cursor. Default
  wake semantics are the union of `terminal` + `fatal_error`.
- `list_run_notifications({ run_ids?, since_notification_id?, kinds?,
  include_acked?, limit? })` returns durable notifications since a
  lexicographic global cursor for reconciliation after disconnect.
- `ack_run_notification({ notification_id })` is idempotent.
- `get_run_progress({ run_id, after_sequence?, limit?, max_text_chars? })`
  returns a compact, bounded progress summary with recent event summaries and
  extracted text snippets. Supervisors should prefer it for user-facing
  progress/status checks instead of fetching large raw event pages or parsing
  client tool-result files.
- `get_run_result({ run_id })` returns the terminal result. If a backend
  completed successfully but emitted an empty result summary, the service falls
  back to the latest assistant message so the final worker text is still
  available.
- `agent-orchestrator monitor <run_id>` is a one-shot CLI used by the Claude
  supervisor's pinned background Bash monitor and by non-Claude clients
  (e.g. external monitoring tools and user shells). The CLI prints
  exactly one JSON line when a terminal or fatal-error notification arrives;
  it is not a live event stream. Exit codes: `0` completed, `1`
  failed/orphaned, `2` cancelled, `3` timed_out, `10` fatal_error, `4`
  unknown run, `5` daemon unavailable, `6` argument error.
- Claude uses the pinned monitor for current-turn wakeups:
  `agent-orchestrator monitor <run_id> --json-line` runs through Bash in
  background mode, while `list_run_notifications` is cross-turn
  reconciliation. `wait_for_run` and `wait_for_any_run` are denied for the
  Claude supervisor because MCP blocking waits are the wrong wake surface for a
  Claude-style supervisor.
- OpenCode uses MCP-only supervision: `wait_for_any_run` is the normal
  current-turn wake path, `wait_for_run` is compatibility fallback, and
  `list_run_notifications` is cross-turn reconciliation. OpenCode does not
  use Bash, `Bash run_in_background`, or `agent-orchestrator monitor`.
- The MCP server also relays an advisory `notifications/run/changed` push
  hint with payload `{ run_id, notification_id, kind, status }`. The hint is
  optional; the durable journal under the run-store root is authoritative.

Run it from the workspace where worker agents should operate, or pass
`--cwd <path>`. Worker profile configuration is read from
`~/.config/agent-orchestrator/profiles.json` by default so personal model
preferences stay out of git and can be reused across repositories. If profiles
are missing or invalid, the same supervisor can discuss the needed profile
aliases, and can create or update that user-level profiles manifest through the
daemon `upsert_worker_profile` tool when you ask it to configure profiles.
`list_worker_profiles` reports valid profiles plus `invalid_profiles`
diagnostics, so one broken profile does not hide the rest. Worker starts should
normally use `list_worker_profiles` to inspect the live profile aliases and
`start_run` with `profile` plus `profiles_file`; the daemon reads and validates
the current manifest at worker-start time. Direct backend/model starts remain
available for explicit one-off overrides or broken profile setup. The OpenCode
launcher creates the shared skill root and profiles-manifest directory before
OpenCode starts.

## Prerequisites

- Node.js 22 or newer
- `gh` installed and authenticated for the `gh` wrapper
- Docker available for the official `github` MCP server
- `pnpm build` run before starting `agent-orchestrator`, so `dist/cli.js`
  exists

Check GitHub CLI auth:

```bash
gh auth status
```

List configured bridge profiles:

```bash
node scripts/mcp-secret-bridge.mjs --list-profiles
```

## GitHub API Server

The `github` server uses the official GitHub MCP container:

```text
ghcr.io/github/github-mcp-server
```

The bridge maps canonical `GITHUB_TOKEN` to the container's expected
`GITHUB_PERSONAL_ACCESS_TOKEN`.

## GitHub CLI Server

The `gh` server uses `scripts/gh-mcp-server.mjs`. It exposes:

| Tool | Purpose |
|---|---|
| `diagnose` | Check `gh` version and auth status |
| `help` | Show `gh help` output |
| `execute` | Run a bounded `gh` command without a shell |

The wrapper blocks the highest-risk commands by default, including token
printing, auth mutation, repo deletion/archive, and key deletion. Clients that
support per-tool approval should require approval for `gh.execute`.

Example commands for the `execute` tool:

```text
pr list --state open --json number,title,headRefName
repo view --json nameWithOwner,description,url
run list --limit 5
api repos/ralphkrauss/agent-orchestrator/actions/runs --jq '.workflow_runs[0].status'
```

## Agent Orchestrator Server

The `agent-orchestrator` server starts this repository's own MCP package from
the local build output:

```text
node dist/cli.js
```

This lets agents use the orchestrator while developing the orchestrator. Run
`pnpm build` after changing source before restarting the MCP client. If the
daemon is already running, restart it too so it picks up the new `dist/` code.

The plain `orchestrator-*` recipes use the normal run store, so they behave like
the installed package. To dogfood branch changes beside a stable npm
installation, prefer the npm-style local command shims. They are named like the
published package bins (`agent-orchestrator`, `agent-orchestrator-claude`,
`agent-orchestrator-opencode`, and `agent-orchestrator-daemon`) but set
`AGENT_ORCHESTRATOR_HOME` to an isolated local branch store before executing the
built branch CLI. That gives the branch build a separate daemon socket/pipe, PID
file, logs, run store, and Claude supervisor state. The default store is a
deterministic short path under
`${TMPDIR:-/tmp}/agent-orchestrator-local/<checkout>-<hash>` so POSIX Unix
socket paths stay below OS limits. Set `AGENT_ORCHESTRATOR_LOCAL_BASE` to choose
a different short base directory when needed.

`dist/cli.js` starts the stdio MCP server and auto-starts the daemon if the
local daemon IPC endpoint is not already responding. The endpoint is a Unix
socket on POSIX and a named pipe on Windows. For manual lifecycle checks, use:

```bash
just orchestrator-doctor
just orchestrator-opencode-config --cwd /path/to/workspace
just orchestrator-opencode --cwd /path/to/workspace
just orchestrator-status
just orchestrator-status --verbose
just orchestrator-runs
just orchestrator-watch
just orchestrator-start
just orchestrator-restart
just orchestrator-stop
just orchestrator-stop --force
just orchestrator-prune-dry-run 30
just orchestrator-prune 30
```

For isolated local branch testing, use the short local `just` passthrough. It
builds the branch and runs `dist/cli.js` with the isolated local branch store:

```bash
just local doctor
just local status
just local status --verbose
just local runs
just local watch
just local start
just local restart --force
just local stop --force
just local prune --older-than-days 30 --dry-run
just local prune --older-than-days 30
just local claude --print-config --cwd /path/to/workspace
just local claude --cwd /path/to/workspace
just local opencode --print-config --cwd /path/to/workspace
just local opencode --cwd /path/to/workspace
just local-clean
```

For an npm-style shell session instead, run `eval "$(just local-env)"` and then
use `agent-orchestrator ...` normally. The longer
`just agent-orchestrator <subcommand> [args...]` recipe is the same passthrough
with the package name spelled out.

`local-clean` force-stops the local branch daemon when `dist/cli.js` exists and
then removes both the isolated local branch store printed by `local-home` and
the generated command shims. Use it after testing to avoid leaving branch
daemons and local run stores behind.

The daemon is long-lived across MCP reconnects and editor restarts. After
changing package source, rebuilding `dist/`, or switching npm dist-tags during
dogfooding, restart the daemon so the frontend and daemon package versions
match:

```bash
node dist/cli.js restart
node dist/cli.js restart --force
just orchestrator-restart
```

Access level: read/write local process orchestration. The server can start
Codex or Claude worker CLI processes in a requested working directory. Worker
authentication remains whatever the host Codex or Claude CLI already has.

Guardrails:

- do not pass secrets as MCP tool arguments
- prefer explicit `cwd` values
- avoid concurrent worker runs against the same dirty working tree unless that
  is the task
- supervise long-running workers with the harness-specific path documented
  above: Claude uses the pinned background Bash monitor, OpenCode uses bounded
  `wait_for_any_run` over MCP, and `wait_for_run` is only a compatibility
  fallback for single-run clients (denied for the Claude supervisor)
- inspect `latest_error`, `timeout_reason`, `terminal_reason`, and
  `get_run_progress` before backing off; fatal backend errors should be reported or routed
  immediately instead of waiting for the idle timeout
- use `idle_timeout_seconds` for quiet-but-legitimate work; reserve
  `execution_timeout_seconds` for an explicit hard elapsed-time cap
- clients that support per-tool approval should require approval for
  `start_run`, `send_followup`, and `cancel_run`

## Secret Rules

- Do not commit real tokens.
- Do not print `gh auth token`.
- Do not place credentials in MCP JSON/TOML configs.
- Do not add repo-local secret files.
- Prefer the bridge for any future secret-bearing MCP server.
