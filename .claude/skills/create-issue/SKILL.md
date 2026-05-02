---
name: create-issue
description: Create a structured issue with context and acceptance criteria. Use when the user says "create issue", "open issue", "new issue", "file issue", "report bug", or "feature request".
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# Create Issue

Create a useful issue after gathering enough repository context to avoid vague
or duplicate work.

## Instructions

### Step 1: Classify The Issue

Classify as:

- bug
- feature
- task
- chore
- documentation
- question/research

Ask if unclear.

### Step 2: Search For Duplicates

Search existing issues and recent PRs using available tools. If possible
duplicates exist, show them and ask whether to create a new issue, link to an
existing issue, or stop.

### Step 3: Gather Context

Inspect:

- relevant code files
- docs
- existing patterns
- related issues/PRs
- logs or error messages provided by the user

Do not write a generic issue if repository evidence is available.

### Step 4: Draft The Issue

Present a draft first:

```markdown
Title: {concise title}
Labels: {labels if known}

## Summary

{what and why}

## Context

- {code/docs references}
- {current behavior}

## Acceptance Criteria

- [ ] {testable criterion}
- [ ] {testable criterion}

## Notes

{constraints, suggested approach, open questions}

## Related

- #{number}
```

Ask for user approval before creating the issue.

### Step 5: Create The Issue

Creating an issue writes to an external service. Only create it after the user
approves the draft or explicitly asked for immediate creation with a complete
body.

After creating, report the URL.

Offer to create a branch only if the user wants to start work now. Creating or
checking out branches must preserve local worktree changes.

## Critical Rules

- Search for duplicates first.
- Acceptance criteria must be testable.
- Ask before external writes.
- Do not create branches, push, or assign labels/reviewers unless requested or
  clearly approved.
- Reference real files or docs when relevant.

## Checklist

- [ ] Type classified
- [ ] Duplicates searched
- [ ] Context gathered
- [ ] Draft presented
- [ ] User approved creation
- [ ] Issue created and URL reported
