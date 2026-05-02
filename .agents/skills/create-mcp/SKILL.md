---
name: create-mcp
description: Add or update MCP server configuration safely. Use when the user says "add MCP server", "new MCP server", "create MCP", "add tool to MCP", or wants tool access wired into AI clients.
---

# Create MCP

Add an MCP server to the repository's selected AI tool configs while keeping
secrets out of the repo and documenting guardrails.

## Instructions

### Step 1: Inventory Existing MCP Setup

Look for:

- `.mcp.json`
- `.cursor/mcp.json`
- `.codex/config.toml`
- `opencode.json`
- docs mentioning MCP
- helper scripts for secrets or launch wrappers

### Step 2: Gather Server Details

Ask or infer:

- server name
- purpose
- transport: stdio or HTTP
- command/image/url
- required environment variables
- which variables are secrets
- access level: read-only or read-write
- guardrails: allowed commands, blocked commands, approval mode
- target AI clients

### Step 3: Choose Secret Strategy

Do not put secrets in repo config. Use:

- environment variable references
- user-level secret files
- documented local setup
- existing secret bridge/wrapper if the repo has one

### Step 4: Update Configs

Update only selected tool configs. Keep entries consistent across tools, but do
not invent unsupported formats.

If an existing MCP setup differs, merge with it and ask before replacing.

### Step 5: Document

Update or create MCP notes with:

- server inventory
- prerequisites
- secret names
- access level
- safety guardrails
- health check

### Step 6: Verify

Validate JSON/TOML syntax where applicable. Do not start external services or
write to remote systems unless approved.

## Critical Rules

- Never commit secrets.
- Prefer read-only access for shared or remote environments.
- Add guardrails for tools that can mutate state.
- Ask before changing existing MCP config.
- Ask before starting servers or testing write-capable tools.

## Checklist

- [ ] Existing MCP config inventoried
- [ ] Server details gathered
- [ ] Secret strategy documented
- [ ] Selected configs updated
- [ ] Docs updated
- [ ] Syntax validated
