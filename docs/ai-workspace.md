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

## OpenCode Orchestration Skills

The OpenCode orchestration launcher uses supervisor-only orchestration skills
from the shared `.agents/skills/` root. The Claude orchestration launcher reads
the same `orchestrate-*` skill files and embeds their instructions into its
generated supervisor prompt. Claude itself launches from the target workspace,
and the launcher mirrors the projected `.claude/skills` directory into the
redirected `HOME/.claude/skills` so `/skills` works without enabling project
settings. The launcher restricts MCP and editing tools through explicit Claude
flags and generated settings.

Project-owned orchestration skills live beside normal skills under
`.agents/skills/orchestrate-{name}/SKILL.md`. At launch,
`agent-orchestrator-opencode` configures OpenCode `skills.paths` to include the
shared `.agents/skills/` root and restricts the supervisor agent to
`orchestrate-*` skills. The package does not generate default orchestration
skills; project teams manage those files themselves.

The same OpenCode supervisor can discuss and maintain orchestration setup. It
has write permission only for the configured profiles manifest and
`.agents/skills/orchestrate-*/SKILL.md`; source files, normal skills, docs, MCP
configs, secrets, commits, and external services stay outside its direct write
surface. Orchestration skills should reference profile aliases, not raw model
names or variants.

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
~/worktrees-agent-orchestrator/
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
