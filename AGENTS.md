# Agent Orchestrator MCP

## Project Overview

This repository publishes `@ralphkrauss/agent-orchestrator-mcp`, a standalone
MCP server for coordinating local Codex and Claude worker CLI runs through a
persistent daemon.

## Build And Test

Use the repository scripts:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm verify
```

`pnpm verify` is the release-quality check. It builds, runs tests, checks
publish readiness, audits production dependencies, resolves the npm dist-tag,
and runs an npm pack dry run.

## Development Rules

- Read the existing TypeScript, tests, and docs before introducing new
  patterns.
- Prefer the repository's existing plain TypeScript style and Node built-ins.
- Keep public package behavior stable unless the task is explicitly about an API
  or contract change.
- Add or update focused tests for daemon lifecycle, run-store persistence,
  backend invocation, MCP contracts, and release behavior when those areas
  change.
- Do not commit, push, publish, deprecate npm versions, activate hooks, install
  packages, change secrets, or write to external services unless explicitly
  asked.
- Treat uncommitted changes as user-owned unless you made them during the
  current task.
- Record concrete evidence when claiming that builds, tests, audits, or publish
  checks passed.

## Release Notes

Release process documentation lives in `PUBLISHING.md`.

- Prereleases publish to the npm `next` dist-tag.
- Stable releases publish to the npm `latest` dist-tag.
- GitHub Actions publishes from matching `v*.*.*` tags.

## MCP Tooling

Repository MCP setup is documented in `docs/development/mcp-tooling.md`.

- GitHub API access is configured through the `github` MCP server.
- GitHub CLI access is configured through the repo-local `gh` MCP wrapper.
- Secret-bearing MCP launches go through `scripts/mcp-secret-bridge.mjs`.
- The bridge resolves `GITHUB_TOKEN` from a user-level secrets file, process
  environment, or the local `gh auth token` result.

Never place real tokens in repo files, MCP config, docs, examples, or command
arguments.

## AI Workspace

- Shared skills live in `.agents/skills/`.
- Cross-cutting rules live in `.agents/rules/`.
- Reusable agent definitions live in `.agents/agents/`.
- Generated Claude and Cursor projections are produced by
  `scripts/sync-ai-workspace.mjs`; edit `.agents/` instead.
- Longer workspace documentation lives in `docs/ai-workspace.md`.

## Before Implementing

1. Inspect the affected source, tests, and docs.
2. Identify the narrowest relevant verification command.
3. Load relevant rules from `.agents/rules/`.
4. Ask before changing release, secret, hook, or external-service behavior.
