# .agents

Canonical AI workspace source for this repository.

## Layout

```text
.agents/
  skills/    Repeatable workflows
  rules/     Cross-cutting coding and process rules
  agents/    Reusable agent definitions
```

Tool-specific directories such as `.claude/` and `.cursor/` contain generated
projections. Edit the canonical files under `.agents/` unless a file explicitly
says otherwise.

## Skills

Each skill is a folder containing `SKILL.md`.

```text
.agents/skills/{skill-name}/SKILL.md
```

Skills are for repeatable multi-step workflows. Keep them generic where
possible and move long reference material into a `references/` folder.

OpenCode orchestration skills use the same shared skill root. Name them with an
`orchestrate-*` prefix so they are clearly distinguishable from normal worker
skills:

```text
.agents/skills/orchestrate-{name}/SKILL.md
```

The `agent-orchestrator-opencode` launcher points OpenCode `skills.paths` at
`.agents/skills/` and does not generate default skills. The OpenCode supervisor
can write only the configured profiles manifest and `SKILL.md` files under
`.agents/skills/orchestrate-*/`. Orchestration skills should reference profile
aliases, not raw model names or variants.

## Rules

Rules describe constraints, conventions, and review checks. Use rules for
cross-cutting guidance that should load when relevant files are touched.

## Maintenance

- Search before adding a new rule or skill.
- Update existing material when it partially covers the new lesson.
- Keep generated tool-specific files in sync with
  `node scripts/sync-ai-workspace.mjs`.
