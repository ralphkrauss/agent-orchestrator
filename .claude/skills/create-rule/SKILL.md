---
name: create-rule
description: Add or update AI guidance in the correct layer. Use when the user says "create rule", "add rule", "new rule", "add instruction", or wants to capture a convention for future agents.
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# Create Rule

Classify a new instruction, deduplicate it against existing guidance, and place
it in the narrowest effective layer.

## Instructions

### Step 1: Extract The Lesson

Identify:

- the desired behavior
- why it matters
- the anti-pattern or failure mode
- where it applies
- whether it is universal, directory-scoped, file-pattern based, or
  tool-specific

### Step 2: Search Existing Guidance

Read likely overlapping files:

- root `AGENTS.md`
- nested `AGENTS.md`
- `.agents/rules/*.md`
- `.agents/*.md`
- tool-specific wrappers such as `CLAUDE.md`
- relevant docs

Prefer updating an existing rule over creating a duplicate.

### Step 3: Choose The Layer

Use the first matching layer:

| Layer | Use When |
|---|---|
| `AGENTS.md` | short universal instruction needed every session |
| nested `AGENTS.md` | applies to one directory tree |
| `.agents/*.md` | longer reference guidance |
| `.agents/rules/*.md` | applies across file patterns or multiple directories |
| tool wrapper | only one tool needs the instruction |
| skill | the request is a repeatable workflow, not a rule |
| hook/check | deterministic enforcement is required |

If scope is ambiguous, ask one concise question and recommend a default.

### Step 4: Write Or Update

For `.agents/rules/*.md`, use frontmatter only if the repository's tools need
it. A common format is:

```markdown
---
description: "What this rule covers"
paths:
  - "**/*Example*"
globs:
  - "**/*Example*"
---

# Rule Title

## Specific Rule

Use {correct pattern} because {reason}. Avoid {anti-pattern} because {failure}.
```

For `AGENTS.md`, keep it short and link to detailed docs.

For docs, include reasoning, examples, and references.

### Step 5: Sync Or Validate

If the repository uses generated rule copies, run the approved sync command. Ask
first if it may overwrite manually edited generated files.

### Step 6: Report

Report:

- created or updated file
- why that layer was chosen
- overlapping guidance found
- whether sync ran

## Critical Rules

- Search before creating.
- Update overlapping guidance instead of duplicating it.
- Keep always-loaded instructions short.
- Use reasoning and examples for judgment rules.
- Do not place project-specific rules into generic shared assets.
- Do not commit or push.

## Checklist

- [ ] Lesson extracted
- [ ] Existing guidance searched
- [ ] Layer chosen
- [ ] Rule created or updated
- [ ] Sync or validation handled
- [ ] Summary reported
