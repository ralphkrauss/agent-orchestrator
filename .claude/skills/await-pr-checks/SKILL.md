---
name: await-pr-checks
description: Monitor pull request checks and help diagnose failures. Use when the user says "wait for checks", "monitor CI", "watch PR", "await checks", or asks whether CI has passed.
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# Await PR Checks

Monitor CI for a pull request, diagnose failures, and apply local fixes only
when appropriate.

## Instructions

### Step 1: Identify The PR

Use the PR number/URL from the user, or detect the open PR for the current
branch using available hosting tools.

### Step 2: Poll Checks

Fetch check status until:

- all checks pass
- a check fails
- checks are cancelled
- the user stops the monitoring
- a reasonable retry/time limit is reached

Use a calm polling interval such as 30 seconds.

### Step 3: Diagnose Failures

For failed checks:

1. Fetch details and logs when available.
2. Classify the failure:
   - build/type/lint failure
   - test failure
   - formatting failure
   - infrastructure/flaky failure
   - review-bot feedback
3. Read relevant source files before proposing a fix.

### Step 4: Fix Only Code/Test Failures

If the failure is a clear code or test issue:

- apply a focused local fix
- run the relevant local verification command
- leave changes uncommitted unless the user asks to commit
- tell the user to commit/push before monitoring the next CI run

If the failure is infrastructure or flaky, do not invent code fixes. Report the
evidence and suggest rerun/manual intervention.

If a review bot posted comments, switch to `resolve-pr-comments` rather than
auto-fixing comments without triage.

### Step 5: Report

Report:

- checks passed/failed/running
- failures and likely cause
- local fixes applied, if any
- verification run
- next action

## Critical Rules

- Do not loop forever.
- Do not fix infrastructure failures with code changes.
- Do not change test expectations just to make CI pass unless the test is
  genuinely wrong and you explain why.
- Do not commit or push unless explicitly asked.
- Review comments go through comment triage.

## Checklist

- [ ] PR identified
- [ ] Checks fetched
- [ ] Failures classified
- [ ] Logs inspected where available
- [ ] Local fixes applied only when appropriate
- [ ] Results reported
