---
name: create-skill
description: Create or update a reusable workflow skill. Use when the user says "create skill", "new skill", "add skill", or wants to capture a repeatable multi-step process.
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# Create Skill

Create or update a skill in the repository's canonical skill location, normally
`.agents/skills/{skill-name}/SKILL.md`.

## Instructions

### Step 1: Understand The Workflow

Extract:

- what the workflow does
- when users would invoke it
- files it creates or modifies
- commands it runs
- tools it relies on
- risks or confirmations it needs

### Step 2: Decide Whether It Should Be A Skill

A skill is appropriate when the workflow is:

- multi-step
- repeatable
- easy to get wrong
- specific enough to benefit from a structured procedure

If the request is a principle or convention, create or update a rule instead.
If it is long reference material, create or update docs.

### Step 3: Search Existing Skills

Search `.agents/skills/`.

- Exact duplicate: stop and report the existing skill.
- Partial overlap: update the existing skill.
- No overlap: create a new skill.

### Step 4: Ask Missing Questions

Ask only questions needed to write a correct skill, such as:

- What trigger phrases should activate it?
- Is this repository-specific or reusable across repos?
- Does it require tool-specific features?
- What commands or files are involved?

### Step 5: Write The Skill

Use this structure:

```markdown
---
name: skill-name
description: What it does. Use when the user says "trigger phrase" or wants to...
---

# Skill Title

One-line purpose.

## Instructions

### Step 1: ...

## Critical Rules

- ...

## Checklist

- [ ] ...
```

Rules:

- directory and `name` use kebab-case
- frontmatter includes `name` and `description`
- description includes trigger phrases
- avoid tool-specific tool names unless the skill is explicitly tool-specific
- keep `SKILL.md` concise and move long reference material to `references/`
- include safety confirmations for risky operations

### Step 6: Sync Or Validate

If the repository uses generated tool-specific skill copies, run the approved
sync command. If running it could overwrite user changes, ask first.

## Critical Rules

- Canonical skills belong under `.agents/skills/` unless the repository has a
  documented alternative.
- Prefer updating overlapping skills over creating duplicates.
- Do not embed secrets or project-private credentials.
- Do not commit or push.

## Checklist

- [ ] Existing skills searched
- [ ] Correct destination chosen
- [ ] Frontmatter valid
- [ ] Trigger phrases included
- [ ] Safety confirmations included
- [ ] Sync or validation handled
