---
name: review
description: Review uncommitted session changes. Use when the user says "review", "check my changes", "review this", or wants a quick quality check before committing.
---

# Review

Review the current working tree diff for bugs, scope drift, missing tests, and
violations of repository guidance.

## Instructions

### Step 1: Determine Scope

Review:

```text
git diff HEAD
git diff HEAD --name-only
```

If there is no diff, report that there are no uncommitted changes to review.

### Step 2: Load Context

Read:

- root `AGENTS.md`
- nested `AGENTS.md` for changed paths
- relevant `.agents/rules/*.md`
- plan/context files for the current branch if present
- docs relevant to changed behavior

### Step 3: Review

Prioritize:

- correctness and behavioral regressions
- security and permission issues
- data integrity
- error handling and edge cases
- missing tests or verification
- API/contract compatibility
- performance risks
- unnecessary complexity
- unrelated changes

### Step 4: Save Artifact If The Repo Uses Review Artifacts

If the repository convention stores review artifacts, write one under something
like:

```text
plans/{branch}/reviews/review-{date}.md
```

Otherwise present findings directly.

### Step 5: Present Findings

Lead with findings ordered by severity. Include file/line references when
possible. If no findings are found, say so and mention remaining test risk.

For significant findings, ask whether to fix, defer, or dismiss.

## Critical Rules

- Review only uncommitted changes for this skill.
- Do not auto-fix unless the user asks.
- Findings must be evidence-based.
- Do not run broad test suites unless the user asks.

## Checklist

- [ ] Diff inspected
- [ ] Relevant rules/docs loaded
- [ ] Findings ordered by severity
- [ ] Test gaps noted
- [ ] Artifact saved if repo convention exists
