---
paths:
  - ".mcp.json"
  - ".cursor/mcp.json"
  - ".codex/config.toml"
  - "opencode.json"
  - "scripts/mcp-secret-bridge.mjs"
  - "scripts/init-mcp-secrets.mjs"
  - "scripts/gh-mcp-server.mjs"
  - "scripts/run-npx-mcp.mjs"
  - "docs/development/mcp-tooling.md"
  - "justfile"
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# MCP Tool Configs

- Never commit real tokens, API keys, `.env` contents, or user-level config.
- Secret-bearing MCP server entries must launch through
  `scripts/mcp-secret-bridge.mjs`.
- The bridge may map canonical repo variables such as `GITHUB_TOKEN` to the
  child variable a server expects, such as `GITHUB_PERSONAL_ACCESS_TOKEN` or
  `GH_TOKEN`.
- Prefer user-level secrets at
  `~/.config/agent-orchestrator-mcp/mcp-secrets.env`, process environment, or
  local `gh` auth. Do not use repo-local secret files.
- Add new MCP servers to every supported client config in one pass:
  `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, and `opencode.json`.
- Keep simple non-secret env near the command definition so reviewers can see
  what the server receives.
- Guard high-risk CLI wrappers with blocked command patterns and client-side
  approval where supported.
