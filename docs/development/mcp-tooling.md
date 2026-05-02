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

1. `~/.config/agent-orchestrator-mcp/mcp-secrets.env`
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
~/.config/agent-orchestrator-mcp/mcp-secrets.env
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
api repos/ralphkrauss/agent-orchestrator-mcp/actions/runs --jq '.workflow_runs[0].status'
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
daemon socket is not already responding. For manual lifecycle checks, use:

```bash
just orchestrator-doctor
just orchestrator-status
just orchestrator-start
just orchestrator-restart
just orchestrator-stop
just orchestrator-stop --force
just orchestrator-prune-dry-run 30
just orchestrator-prune 30
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
