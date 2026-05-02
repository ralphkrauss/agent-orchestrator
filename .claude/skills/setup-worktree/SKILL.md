---
name: setup-worktree
description: Set up or switch to a branch/worktree safely. Use when the user says "setup worktree", "checkout branch", "start feature", or provides an issue or branch name to begin work.
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# Setup Worktree

Prepare a branch or worktree without overwriting local changes.

## Instructions

### Step 1: Inspect Current State

Run:

```text
git status --short
git branch --show-current
git remote -v
just worktree-list
```

If there are uncommitted changes, ask before switching branches or creating a
new worktree.

### Step 2: Resolve Target

Determine whether the input is:

- issue number
- branch name
- feature slug
- PR branch

If an issue number is provided, fetch issue details when available and derive a
branch name using repository conventions.

### Step 3: Check Existing Branches And Worktrees

Check local and remote branches. If the branch is already checked out in another
worktree, stop and ask how to proceed.

### Step 4: Create Or Checkout

Use the repository worktree command:

```text
just worktree <branch>
```

This creates or attaches the worktree under
`~/worktrees-agent-orchestrator/`. If the branch does not exist locally or
on `origin`, the command creates it from `origin/main` or local `main`.

Do not push a new branch automatically unless the user asks.

### Step 5: Report

Report:

- working directory
- branch
- latest commit
- upstream status
- existing plan/context files
- next recommended command

## Critical Rules

- Do not overwrite uncommitted changes.
- Do not force checkout.
- Do not push automatically.
- Stop on worktree conflicts.

## Checklist

- [ ] Current state inspected
- [ ] Target branch resolved
- [ ] Existing branches checked
- [ ] Worktree conflicts checked
- [ ] Branch/worktree prepared
- [ ] Status reported
