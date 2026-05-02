---
paths:
  - ".agents/**"
  - ".claude/**"
  - ".cursor/rules/**"
  - "scripts/sync-ai-workspace.mjs"
  - ".githooks/**"
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# AI Workspace Projections

- Treat `.agents/` as the canonical source for skills, rules, and reusable
  agents.
- Do not manually edit generated files under `.claude/skills/`,
  `.claude/rules/`, `.claude/agents/`, or `.cursor/rules/`.
- Regenerate projections with `node scripts/sync-ai-workspace.mjs`.
- Check projection drift with `node scripts/sync-ai-workspace.mjs --check`.
- Hook activation writes repository-local git config and requires explicit user
  approval.
