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
agent-orchestrator-opencode
agent-orchestrator opencode
```

That launcher starts OpenCode with a process-local `OPENCODE_CONFIG_CONTENT`
overlay instead of editing `opencode.json`, user config, or global config. The
overlay disables the broad `github` and `gh` MCP servers, configures only the
local `agent-orchestrator` MCP server, loads project-owned `orchestrate-*`
skills from the shared `.agents/skills/` root, and restricts direct writes to
the profiles manifest plus `.agents/skills/orchestrate-*/SKILL.md`.

Run it from the workspace where worker agents should operate, or pass
`--cwd <path>`. Worker profile configuration is read from
`~/.config/agent-orchestrator/profiles.json` by default so personal model
preferences stay out of git and can be reused across repositories. If profiles
are missing or invalid, the same supervisor can discuss the needed profile
aliases, and can create or update that user-level profiles manifest when you ask
it to configure profiles. Worker starts should normally use `list_worker_profiles`
to inspect the live profile aliases and `start_run` with `profile` plus
`profiles_file`; the daemon reads and validates the current manifest at
worker-start time. Direct backend/model starts remain available for explicit
one-off overrides or broken profile setup. The launcher creates the shared skill
root and profiles-manifest directory before OpenCode starts.

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

The daemon is long-lived across MCP reconnects and editor restarts. After
changing package source, rebuilding `dist/`, or switching npm dist-tags during
dogfooding, restart the daemon so the frontend and daemon package versions
match:

```bash
node dist/daemonCli.js restart
node dist/daemonCli.js restart --force
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
- clients that support per-tool approval should require approval for
  `start_run`, `send_followup`, and `cancel_run`

## Secret Rules

- Do not commit real tokens.
- Do not print `gh auth token`.
- Do not place credentials in MCP JSON/TOML configs.
- Do not add repo-local secret files.
- Prefer the bridge for any future secret-bearing MCP server.
