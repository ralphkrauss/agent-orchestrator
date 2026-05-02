---
name: commit
description: Create a scoped git commit from relevant working tree changes. Use when the user says "commit", "commit this", "commit changes", or "commit and push".
---

# Commit

Create a focused commit from changes that belong to the current request. Push
only when the user explicitly asked for it.

## Instructions

### Step 1: Inspect The Working Tree

Run:

```text
git status --short
git diff --stat
git diff HEAD --stat
```

If there are no changes, report "Nothing to commit" and stop.

### Step 2: Select The Commit Scope

Stage only files related to the user's request.

Include durable workflow artifacts when they belong to the work, such as:

- implementation plans
- resolution maps
- test plans
- test results
- review artifacts
- docs created as part of the task

Skip:

- secrets and local env files
- unrelated user changes
- generated noise unrelated to the request
- package lock changes unless dependencies actually changed

Use explicit paths. Do not use `git add .` or `git add -A`.

Ask only if scope is genuinely ambiguous, such as unrelated changes mixed into
the same file or untracked files that may not belong.

### Step 3: Draft The Message

Read the staged diff:

```text
git diff --cached
```

Use a concise message:

```text
{type}: {imperative summary}

- {optional detail}
- {optional detail}
```

Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.

Follow repository commit conventions if documented.

### Step 4: Commit

If the user asked to commit and the scope is clear, the request is approval to
commit. Create the commit and report:

- commit hash
- commit message
- changed file count or short stat

Do not add AI co-author trailers unless the repository explicitly requires
them.

### Step 5: Push Only If Asked

Push only when the user explicitly said "push" or "commit and push".

If pushing:

- use a normal push, never force push
- set upstream if the branch has none
- report the remote branch

## Critical Rules

- Never commit secrets.
- Never amend, rebase, reset, or force-push unless explicitly requested.
- Never push unless explicitly requested.
- Respect hook failures. Do not bypass hooks with `--no-verify` unless the user
  explicitly approves after seeing the failure.
- Preserve unrelated user changes.

## Checklist

- [ ] Working tree inspected
- [ ] Relevant files staged by explicit path
- [ ] Secrets and unrelated files skipped
- [ ] Staged diff reviewed
- [ ] Commit message follows repository convention
- [ ] Commit created
- [ ] Push done only if explicitly requested
