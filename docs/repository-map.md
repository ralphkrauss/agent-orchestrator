# Repository Map

This repository includes the published package, development docs, and dogfooding material for the agent workspace used to build the package. The non-package files are intentional, but most users only need the README and `docs/`.

## Public Package Surface

| Path | Purpose |
|---|---|
| `src/` | TypeScript source for the MCP server, daemon, backends, CLI, contracts, and tests. |
| `package.json` | npm metadata, scripts, engines, bin entries, dependencies, and package file allowlist. |
| `README.md` | Newcomer-focused landing page and quickstart. |
| `docs/` | User, operator, and development reference docs. |
| `CHANGELOG.md` | Versioned public release notes. |
| `PUBLISHING.md` | Release process and npm Trusted Publishing notes. |
| `LICENSE.md` | MIT license. |

## Contributor Surface

| Path | Purpose |
|---|---|
| `CONTRIBUTING.md` | Setup, verification, testing, style, and PR expectations. |
| `SECURITY.md` | Vulnerability reporting and local trust model. |
| `SUPPORT.md` | Support channels and boundaries. |
| `ROADMAP.md` | Public stability notes, near-term priorities, and non-goals. |
| `.github/ISSUE_TEMPLATE/` | Structured bug and feature issue templates. |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR checklist for contributors. |
| `.github/workflows/` | CI and publish workflows. |

## GitHub Repository Settings

The live GitHub repository metadata is not managed by package code. Before a
public launch, a maintainer with repository settings access should set:

| Setting | Value |
|---|---|
| Description | `Local MCP orchestrator for supervising Codex, Claude, Cursor, and OpenCode worker runs.` |
| Homepage | `https://www.npmjs.com/package/@ralphkrauss/agent-orchestrator` |
| Topics | `mcp`, `model-context-protocol`, `agent-orchestration`, `codex-cli`, `claude-code`, `cursor`, `opencode`, `typescript`, `nodejs` |
| Issues | Enabled |
| Discussions | Disabled unless `SUPPORT.md` is updated with a discussions policy. |

An authenticated maintainer can apply the metadata with GitHub CLI:

```bash
gh api -X PATCH repos/ralphkrauss/agent-orchestrator \
  -f description='Local MCP orchestrator for supervising Codex, Claude, Cursor, and OpenCode worker runs.' \
  -f homepage='https://www.npmjs.com/package/@ralphkrauss/agent-orchestrator'

gh api -X PUT repos/ralphkrauss/agent-orchestrator/topics \
  -H 'Accept: application/vnd.github+json' \
  -f names[]=mcp \
  -f names[]=model-context-protocol \
  -f names[]=agent-orchestration \
  -f names[]=codex-cli \
  -f names[]=claude-code \
  -f names[]=cursor \
  -f names[]=opencode \
  -f names[]=typescript \
  -f names[]=nodejs
```

Verify the live settings after applying them:

```bash
gh repo view ralphkrauss/agent-orchestrator --json description,homepageUrl,repositoryTopics
```

If GitHub CLI is not installed, use the repository Settings page in the GitHub
web UI, or use the REST API with a maintainer token kept outside the repo:

```bash
curl -fsS -X PATCH https://api.github.com/repos/ralphkrauss/agent-orchestrator \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"description":"Local MCP orchestrator for supervising Codex, Claude, Cursor, and OpenCode worker runs.","homepage":"https://www.npmjs.com/package/@ralphkrauss/agent-orchestrator"}'

curl -fsS -X PUT https://api.github.com/repos/ralphkrauss/agent-orchestrator/topics \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"names":["mcp","model-context-protocol","agent-orchestration","codex-cli","claude-code","cursor","opencode","typescript","nodejs"]}'
```

## Dogfooding And AI Workspace Files

| Path | Purpose |
|---|---|
| `.agents/` | Canonical source for reusable skills, rules, and agent definitions used while developing this repository. |
| `.claude/` | Generated Claude projection produced from `.agents/`. Do not edit it directly. |
| `.cursor/rules/` | Generated Cursor projection produced from `.agents/`. Do not edit it directly. |
| `.codex/`, `.mcp.json`, `.cursor/mcp.json`, `opencode.json` | Repo-local MCP and client config used for development. Secret-bearing launches go through `scripts/mcp-secret-bridge.mjs`. |
| `plans/` | Historical and active planning, review, and resolution artifacts. They document the project history and are not required for normal package use. |
| `.githooks/` | Optional local hooks. They are not activated by clone or install. |

Generated projections are checked with:

```bash
node scripts/sync-ai-workspace.mjs --check
```

Regenerate them with:

```bash
node scripts/sync-ai-workspace.mjs
```

## Secrets Policy

Real tokens must not appear in repo files, examples, docs, issue templates, command arguments, or committed MCP config. The repository uses placeholders and a local secret bridge for development-only MCP launches.

User-level secret files live outside the repo:

```text
~/.config/agent-orchestrator/secrets.env
~/.config/agent-orchestrator/mcp-secrets.env
```

The first file is for daemon-managed provider credentials. The second is for repo-development MCP bridge launches.
