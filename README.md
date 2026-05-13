# Agent Orchestrator

[![CI](https://github.com/ralphkrauss/agent-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/ralphkrauss/agent-orchestrator/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@ralphkrauss/agent-orchestrator)](https://www.npmjs.com/package/@ralphkrauss/agent-orchestrator)
[![license](https://img.shields.io/npm/l/@ralphkrauss/agent-orchestrator)](LICENSE.md)
[![node](https://img.shields.io/node/v/@ralphkrauss/agent-orchestrator)](package.json)

Local MCP orchestrator for supervising Codex, Claude, Cursor, and OpenCode worker runs through a persistent daemon.

## What It Does

Agent Orchestrator lets a supervising MCP client start local worker runs, watch progress, send follow-ups, cancel work, and inspect durable run results. The stdio MCP server stays small; a local daemon owns worker subprocesses, timeouts, notifications, run metadata, logs, and session reuse.

It is meant for developers who already use local agent CLIs and want a safer control plane for delegating work from a supervisor.

## What It Does Not Do

- It does not install Codex, Claude Code, OpenCode, or Cursor credentials.
- It does not host a remote service or send prompts to an orchestrator-owned cloud.
- It does not isolate filesystems, create worktrees, or prevent two workers from editing the same file.
- It does not make missing CLI auth disappear; diagnostics report what the host can actually run.

## Project Status

- Maturity: usable, published, and still evolving before a broad public launch.
- Runtime: Node.js 22 or newer.
- Platforms: Linux and macOS run the full CI verification matrix on Node 22 and 24. Windows runs build, focused Windows tests, and packed CLI smoke tests on Node 22 and 24.
- Backends: Codex, Claude, Cursor, and OpenCode supervision surfaces.
- Known limitation: Windows Claude orchestration requires Git Bash because Claude Code uses Bash for its `Bash` tool.

## Install

Use the published package directly from any MCP client:

```bash
npx -y @ralphkrauss/agent-orchestrator@latest
```

For a local checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js doctor
```

## Five-Minute Quickstart

Run diagnostics first. This makes no model calls.

```bash
npx -y @ralphkrauss/agent-orchestrator@latest doctor
npx -y @ralphkrauss/agent-orchestrator@latest doctor --json
```

Expected shape:

```text
Agent Orchestrator diagnostics
Frontend version: 0.2.2
Platform: darwin
Node: v24.15.0
Backends:
- codex: auth_unknown
- claude: auth_unknown
- cursor: auth_unknown
```

`missing` means the worker binary or SDK is not available. `auth_unknown` means the backend looks runnable, but the package cannot prove auth without asking that backend to make a model call.

Add the MCP server to one client. Persistent MCP client entries should pin a
concrete package version so restarts use the same MCP surface; the examples
below use `0.2.2`.

```json
{
  "mcpServers": {
    "agent-orchestrator": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ralphkrauss/agent-orchestrator@0.2.2"]
    }
  }
}
```

Then use the MCP tools from that client:

```text
get_backend_status({})
```

Create a profile. Choose a model id that your local backend accepts. The
example below uses `worker_posture: "restricted"` together with
`codex_network: "isolated"` to keep the worker on the closed-network,
`--ignore-user-config` envelope. Omit both fields (or use
`worker_posture: "trusted"`, the default since #58) for backend-native parity
with a manual `codex exec` run — see [`docs/reference.md`](docs/reference.md#model-and-network-settings)
for the two-axis posture × `codex_network` argv table.

```text
upsert_worker_profile({
  "profile": "codex-local",
  "backend": "codex",
  "model": "<codex-model-id>",
  "worker_posture": "restricted",
  "codex_network": "isolated",
  "description": "Local Codex worker with closed network egress (restricted posture)"
})
```

Start one run:

```text
start_run({
  "profile": "codex-local",
  "prompt": "Run pwd and summarize the repository in one sentence.",
  "cwd": "/path/to/workspace"
})
```

Expected result:

```json
{ "ok": true, "run_id": "01..." }
```

Inspect it:

```text
get_run_progress({ "run_id": "01..." })
get_run_result({ "run_id": "01..." })
```

See [docs/first-run.md](docs/first-run.md) for a complete first-run guide, common failures, daemon restart commands, and no-model-call paths.

## MCP Client Config

Persistent MCP client entries should pin a concrete package version. Use
`@latest` for one-off diagnostics, and update pinned client config versions
when intentionally upgrading.

Claude Code `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-orchestrator": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ralphkrauss/agent-orchestrator@0.2.2"]
    }
  }
}
```

Codex `.codex/config.toml`:

```toml
[mcp_servers.agent-orchestrator]
command = "npx"
args = ["-y", "@ralphkrauss/agent-orchestrator@0.2.2"]
```

Cursor `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agent-orchestrator": {
      "command": "npx",
      "args": ["-y", "@ralphkrauss/agent-orchestrator@0.2.2"]
    }
  }
}
```

OpenCode `opencode.json`:

```json
{
  "mcp": {
    "agent-orchestrator": {
      "type": "local",
      "command": ["npx", "-y", "@ralphkrauss/agent-orchestrator@0.2.2"]
    }
  }
}
```

## Supported Backends

| Backend | How it authenticates | Notes |
|---|---|---|
| Codex | Codex CLI auth or `OPENAI_API_KEY` / `CODEX_API_KEY` in the daemon environment | `codex_network` controls whether worker network egress is isolated, workspace-enabled, or inherited from user config. |
| Claude | Claude CLI auth, `ANTHROPIC_API_KEY`, or registered Claude accounts | Account registry supports `config_dir` and `api_env` modes with rotation on rate-limit. |
| Cursor | `CURSOR_API_KEY` in the daemon environment or daemon-managed secrets file | Uses `@cursor/sdk` as an optional dependency and runs SDK work in-process. |
| OpenCode | Host OpenCode binary and project configuration | OpenCode orchestration mode constrains a supervisor around MCP tools and project skills. |

## Security Model

This is a trusted-local tool. Worker processes run as the current OS user, inherit the daemon environment, and can access the credentials that the selected backend CLI can access.

- Do not expose the daemon IPC endpoint to untrusted users.
- Do not paste API keys into prompts or MCP tool arguments.
- Prompts, stdout, stderr, events, and results are written to the local run store.
- Default run store: `~/.agent-orchestrator`.
- Secret-bearing development MCP configs use the repo-local secret bridge; real tokens must stay outside repo files.

Read [SECURITY.md](SECURITY.md) before using this with sensitive repositories.

## Reference Docs

- [First successful run](docs/first-run.md)
- [Architecture, daemon lifecycle, run store, and MCP tools](docs/reference.md)
- [Repository map](docs/repository-map.md)
- [Daemon auth setup](docs/development/auth-setup.md)
- [Codex backend and `codex_network`](docs/development/codex-backend.md)
- [Claude multi-account setup](docs/development/claude-multi-account.md)
- [Cursor backend](docs/development/cursor-backend.md)
- [MCP tooling for this repository](docs/development/mcp-tooling.md)
- [Roadmap](ROADMAP.md)
- [Publishing](PUBLISHING.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The release-quality local gate is:

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` builds, runs tests, checks publish readiness, audits production dependencies, resolves the npm dist-tag, and runs an npm pack dry run.
