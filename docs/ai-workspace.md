# AI Workspace

This repository uses a repo-local AI workspace so coding agents share project
instructions, workflows, rules, and MCP setup.

## Canonical Files

| Path | Purpose |
|---|---|
| `AGENTS.md` | Repository-wide instructions |
| `CLAUDE.md` | Claude-specific wrapper that imports `AGENTS.md` |
| `.agents/skills/` | Repeatable workflows |
| `.agents/rules/` | Cross-cutting rules |
| `.agents/agents/` | Reusable agent definitions |
| `docs/development/mcp-tooling.md` | GitHub MCP setup and secret flow |

## Generated Files

Claude and Cursor need tool-specific projections:

```text
.claude/skills/
.claude/rules/
.claude/agents/
.cursor/rules/
```

Edit `.agents/` and regenerate:

```bash
node scripts/sync-ai-workspace.mjs
```

Check drift:

```bash
node scripts/sync-ai-workspace.mjs --check
```

## Hooks

The repository includes hooks that sync AI workspace projections after checkout
and merge.

```bash
node scripts/ai-hooks.mjs status
node scripts/ai-hooks.mjs enable
node scripts/ai-hooks.mjs disable
```

Enabling hooks writes repository-local git config:

```text
core.hooksPath=.githooks
```

Agents must ask before enabling or disabling hooks.

## Worktrees

Use repository recipes for branch worktrees:

```bash
just worktree <branch>
just worktree-list
just worktree-remove <branch>
just worktree-prune
```

Worktrees are created under:

```text
~/worktrees-agent-orchestrator-mcp/
```

`just worktree <branch>` attaches an existing local or remote branch when one
exists. If the branch does not exist, it creates the branch from `origin/main`
or local `main`.

The helper refuses to run from inside a child worktree and refuses to remove a
dirty worktree.

## Safety

Agents must ask before:

- deleting or overwriting files
- committing or pushing
- modifying secrets
- activating or deactivating hooks
- installing dependencies
- writing to external services
- publishing or deprecating npm versions
- running long-lived application processes

## Adding Guidance

- Add reusable workflows with the `create-skill` skill.
- Add coding or process rules with the `create-rule` skill.
- Keep always-loaded instructions short.
- Prefer updating existing guidance over adding duplicates.
