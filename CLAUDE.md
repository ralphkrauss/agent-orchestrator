# Agent Orchestrator - Claude Guide

@AGENTS.md

## Skills

Canonical skills live in `.agents/skills/*/SKILL.md`.

Generated Claude copies live under `.claude/skills/`. If they look stale, run:

```bash
node scripts/sync-ai-workspace.mjs
```

## MCP Tools

Use `docs/development/mcp-tooling.md` for the local GitHub MCP setup.

Do not create, edit, print, or commit real credentials. If an MCP server needs
credentials, route them through `scripts/mcp-secret-bridge.mjs` or the documented
user-level secrets file.

## GitHub Comments

When posting GitHub comments from AI-assisted workflows, make the AI authorship
clear in the comment body unless the user gives a different convention.
