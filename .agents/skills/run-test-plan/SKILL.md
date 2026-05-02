---
name: run-test-plan
description: Run an interactive test session from a test plan. Use when the user says "run test plan", "start testing", "let's test", "test this branch", or wants to walk through scenarios.
---

# Run Test Plan

Guide a human-plus-agent test session from `plans/{branch}/test-plan.md` or the
repository's equivalent test runbook.

## Instructions

### Step 1: Load The Plan

Find and read the current branch test plan. If missing, suggest creating one
with `create-test-plan`.

Also read the implementation plan for context when present.

### Step 2: Check Prerequisites

Review the plan prerequisites:

- app/services running
- credentials
- databases/caches/queues
- browser access
- external services
- local tools

Ask before starting apps, writing external state, or using secrets.

### Step 3: Run Scenarios Interactively

For each scenario:

1. Explain what is being tested.
2. Execute setup steps the agent can safely perform.
3. Guide the user through manual actions.
4. Run verification steps.
5. Compare actual results to expected results.
6. Record pass/fail/blocked/skipped.

### Step 4: Investigate Failures

For failures:

- show expected vs actual
- gather logs or traces when available
- identify likely code areas
- ask whether to investigate, rerun, skip, or stop

### Step 5: Write Results

Write `plans/{branch}/test-results.md` or the repo's configured results path:

```markdown
# Test Results: {Feature}

Branch: `{branch}`
Tested: {date}
Test Plan: `{path}`

## Summary

| # | Scenario | Result | Notes |
|---|---|---|---|

## Failures

...
```

## Critical Rules

- Do not mark a scenario passed unless verification ran.
- Do not run apps or external writes unless approved.
- Record skipped and blocked scenarios honestly.
- Do not commit or push.

## Checklist

- [ ] Test plan loaded
- [ ] Prerequisites checked
- [ ] Scenarios executed or explicitly skipped
- [ ] Failures investigated
- [ ] Results written
