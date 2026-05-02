---
name: create-test-plan
description: Create an interactive manual test plan for a branch or feature. Use when the user says "create test plan", "test plan", "testing plan", "write test plan", or wants a human-plus-agent verification runbook.
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# Create Test Plan

Create a current-branch runbook that an AI assistant and human can execute
together. The plan should set up state, guide actions, and verify outcomes
using the repository's real tools and data surfaces.

## Instructions

### Step 1: Gather Context

1. Get the current branch.
2. Read the implementation plan under `plans/{branch-name}/` if present.
3. Inspect the branch diff and changed file list.
4. Read relevant `AGENTS.md`, `.agents/rules/`, and docs.
5. Identify affected features, APIs, UI surfaces, jobs, migrations, integrations,
   data stores, and external services.

### Step 2: Determine Runtime And Tooling

Identify what the tester needs:

- local app or service URLs
- database access
- cache access
- queue or event tooling
- browser automation
- logs/traces
- CLI commands
- external credentials or staging access

Ask before assuming apps may be run or external services may be used.

### Step 3: Design Scenarios

Cover the risks introduced by the change:

- happy path
- important edge cases
- invalid input
- permission or authorization boundaries
- idempotency and retry behavior
- concurrency where relevant
- empty/null/missing data
- UI states when relevant
- rollback or recovery behavior

Each scenario must include:

- setup
- action
- verification
- expected result
- cleanup notes when needed

Prefer concrete commands and queries. Use placeholders only for values the
runner must discover, such as `{generated_id}`.

### Step 4: Write The Plan

Create `plans/{branch-name}/test-plan.md`:

```markdown
# Test Plan: {Feature}

Branch: `{branch-name}`
Implementation Plan: `plans/{branch-name}/plan.md`
Created: {date}

## Use This File

{how to run this plan and where to record results}

## Current Scope

{in scope, out of scope, ownership boundaries}

## Prerequisites

- [ ] {runtime prerequisite}
- [ ] {credential or data prerequisite}

## Runtime Variables

| Name | How To Resolve | Example |
|---|---|---|

## Tools Used

| Tool | Purpose |
|---|---|

## Evidence Surfaces

- database rows
- logs or traces
- API responses
- files or generated artifacts
- UI state

## Scenario Coverage Map

| Area | Scenarios |
|---|---|

## Scenarios

### 1. {Scenario Title}

**What we're testing:** {why this matters}
**Category:** happy-path | edge-case | idempotency | error-handling | concurrency | ui-state | operational

#### Setup

```text
{setup commands, queries, or user actions}
```

#### Action

```text
{trigger}
```

#### Verify

```text
{verification commands and expected output}
```

#### Result

- [ ] Pass
- [ ] Fail - Notes:
- [ ] Blocked - Reason:
- [ ] Skipped - Reason:
- [ ] Partial - Notes:
```

### Step 5: Validate The Runbook

Before finishing:

- Use actual schema, endpoints, scripts, and command names.
- Avoid vague steps such as "verify it worked."
- Include expected outputs.
- Mark staging-only or credential-dependent scenarios clearly.
- Keep the scenario count focused on meaningful risk.
- Include cleanup boundaries for stateful tests.

## Critical Rules

- This is a manual runbook, not an automated test suite.
- Do not assume external access or running apps is allowed.
- Be concrete enough for another agent to execute the setup and verification.
- Do not commit or push.

## Checklist

- [ ] Branch and diff inspected
- [ ] Implementation plan read when available
- [ ] Runtime prerequisites identified
- [ ] Scenarios cover meaningful risks
- [ ] Setup/action/verify are concrete
- [ ] Expected results included
- [ ] Test plan written
