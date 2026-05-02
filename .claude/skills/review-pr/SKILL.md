---
name: review-pr
description: Review the full branch diff before opening or updating a pull request. Use when the user says "review PR", "review branch", "self-review", "pre-PR review", or "quality gate".
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# Review PR

Review the full branch diff against the base branch before PR creation or merge.

## Instructions

### Step 1: Determine Scope

1. Get current branch.
2. Determine base branch from repo conventions or remote default.
3. Inspect:

```text
git diff {base}...HEAD --stat
git diff {base}...HEAD --name-only
```

If there are no changes, report that there is nothing to review.

### Step 2: Load Context

Read:

- root and nested `AGENTS.md`
- relevant `.agents/rules/*.md`
- branch plans and sub-plans
- resolution maps, test plans, test results, and review artifacts
- docs for changed behavior

### Step 3: Review Dimensions

Review applicable dimensions:

- plan compliance and scope
- correctness
- data integrity
- security and permissions
- migrations/data compatibility
- API/contract compatibility
- tests and verification
- performance
- maintainability and simplification
- docs and release notes

### Step 4: Save Artifact

Write a durable artifact if the repo uses plan artifacts:

```text
plans/{branch}/reviews/review-pr-{date}.md
```

### Step 5: Present Findings

Use:

```markdown
# PR Review: {branch}

**Scope:** `{base}...HEAD`
**Verdict:** approve | needs-attention

## Findings

### 1. {title} ({severity})
- **File:** {path}:{line}
- **Issue:** ...
- **Recommendation:** ...

## Verification Gaps

- ...
```

Ask the user how to handle critical/high findings.

## Critical Rules

- Review the full branch, not just uncommitted changes.
- Do not auto-fix unless the user asks.
- Do not claim tests passed unless evidence exists.
- Keep findings grounded in code, docs, or plan requirements.

## Checklist

- [ ] Base branch determined
- [ ] Full diff inspected
- [ ] Plans/rules/docs loaded
- [ ] Findings recorded
- [ ] Verification gaps noted
- [ ] Artifact saved if applicable
