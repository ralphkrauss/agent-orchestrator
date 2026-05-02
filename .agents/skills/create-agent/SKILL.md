---
name: create-agent
description: Create or update reusable agent definitions. Use when the user asks to create, refine, or standardize custom agents.
---

# Create Agent

Define a focused agent in the repository's canonical agent location, normally
`.agents/agents/{agent-name}.md`.

## Instructions

### Step 1: Define The Role

Clarify:

- what the agent owns
- when to use it
- what it must not do
- what output should look like
- tool or permission constraints

### Step 2: Search Existing Agents

Update an overlapping agent instead of creating a duplicate.

### Step 3: Write The Agent

Use a concise structure:

```markdown
---
name: agent-name
description: What it does. Use when...
---

# Agent Title

You are a {role} for this repository.

You own:
- ...

You do not own:
- ...

Workflow:
1. ...

Escalate when:
- ...

Avoid:
- ...
```

Adapt frontmatter to the selected tools if the repository has a required agent
format.

### Step 4: Sync Or Validate

If the repository generates tool-specific agent copies, run the approved sync
command.

## Critical Rules

- Keep agents narrow and practical.
- Do not grant broad tools or permissions by default.
- Prefer updating existing agents over adding duplicates.
- Do not commit or push.

## Checklist

- [ ] Role boundary clear
- [ ] Existing agents searched
- [ ] Agent file written
- [ ] Tool format respected
- [ ] Sync or validation handled
