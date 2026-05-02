---
name: create-pr
description: Create a pull request from the current branch. Use when the user says "create PR", "open PR", "make pull request", or wants to publish completed branch work for review.
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# Create PR

Create a pull request using repository conventions, plan artifacts, and
verification evidence.

## Instructions

### Step 1: Inspect Branch State

1. Get the current branch and upstream.
2. Check for uncommitted changes.
3. Identify the default base branch from the remote or repository docs.
4. Detect related issue numbers from branch name, commits, plan files, or user
   input.
5. Read `plans/{branch}/plan.md` and sub-plans when present.
6. Read recent review artifacts if present.

If there are uncommitted changes, ask whether to commit first, leave them out,
or stop.

### Step 2: Check Pre-PR Quality

If the repository has a branch-review workflow, check whether it has run. If not,
recommend it and ask whether to run, skip, or continue.

Do not block the user if they explicitly choose to proceed.

### Step 3: Build Title And Body

Follow the repository's PR title convention. If none exists, use:

```text
{Short imperative description}
```

If an issue is linked, include the issue reference according to the repo's
convention.

Use this body unless the repo has a better template:

```markdown
## Summary

- ...
- ...

## Issue

Closes #{issue-number}

## Verification

- [ ] {command or manual check}
```

Derive summary and verification from plans, test results, review artifacts, and
the diff. Do not claim checks passed unless they actually ran.

### Step 4: Confirm External Write If Needed

Creating a PR writes to the remote hosting service and usually requires pushing
the branch. If the user explicitly asked to create a PR, that is approval for a
normal push and PR creation unless repository instructions require a separate
confirmation.

Ask before:

- pushing with unusual options
- changing base branch from the detected default
- creating a draft when not requested
- adding labels/reviewers/milestones if not obvious

### Step 5: Push And Create

Push the current branch normally. Then create the PR with the selected title,
body, head, and base using available Git hosting tools or CLI.

Never force-push.

### Step 6: Report

Report:

- PR URL
- title
- base and head branches
- whether review was run or skipped
- verification included in the body

## Critical Rules

- Do not create a PR from a dirty worktree without asking.
- Do not invent verification results.
- Do not force-push.
- Follow repository title/body conventions when documented.
- Do not add reviewers, labels, or milestones unless requested or clearly
  documented.

## Checklist

- [ ] Branch and base identified
- [ ] Dirty worktree handled
- [ ] Related issue detected or requested
- [ ] Plan/review/test artifacts checked
- [ ] Title and body drafted
- [ ] Branch pushed normally
- [ ] PR created
- [ ] URL reported
