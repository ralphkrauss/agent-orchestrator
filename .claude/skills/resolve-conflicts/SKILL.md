---
name: resolve-conflicts
description: Resolve git merge, rebase, or cherry-pick conflicts safely. Use when the user says "resolve conflicts", "merge conflicts", "rebase conflict", "branch is behind", or wants to port stale branch changes.
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# Resolve Conflicts

Resolve conflicts by preserving user work, understanding both sides, and
verifying the result.

## Instructions

### Step 1: Identify State

Inspect:

```text
git status --short
git status
git diff --name-only --diff-filter=U
```

Determine whether the repo is in merge, rebase, cherry-pick, or normal state.

### Step 2: Protect User Work

Do not reset, abort, checkout over files, or discard changes without explicit
approval.

If unrelated uncommitted changes are present, call them out and avoid touching
them.

### Step 3: Understand Both Sides

For each conflicted file:

- inspect base/current/incoming versions when available
- read surrounding code
- read relevant tests/docs/rules
- identify the intended behavior from each side

### Step 4: Resolve

Edit conflicts deliberately. Preserve behavior from both sides unless the user
chooses otherwise.

After each resolved file, inspect the result for duplicated code, missing
imports, broken formatting, or inconsistent APIs.

### Step 5: Verify

Run targeted validation appropriate for touched files. If verification cannot be
run, report why.

### Step 6: Continue Or Stop

If in rebase/cherry-pick/merge flow, ask before continuing the operation when
continuation may create commits or alter history. Do not force-push.

## Critical Rules

- Never use destructive git commands without explicit approval.
- Do not choose one side blindly.
- Preserve unrelated user changes.
- Verify after resolving.
- Do not force-push.

## Checklist

- [ ] Conflict state identified
- [ ] Conflicted files listed
- [ ] Both sides understood
- [ ] Conflicts resolved
- [ ] Targeted verification run or documented
- [ ] Continuation handled with user approval when needed
