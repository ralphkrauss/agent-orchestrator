---
name: create-plan
description: Create a feature implementation plan through structured discussion. Use when the user says "create plan", "make a plan", "plan this feature", "let's plan", or wants to design an approach before coding.
---

# Create Plan

Create a repository-native implementation plan after inspecting existing code,
rules, docs, and user requirements.

## Instructions

### Step 1: Determine Plan Location

1. Get the current branch name.
2. Use the repository's configured plan root if documented. Otherwise default
   to `plans/{branch-name}/`.
3. If the branch name or user request references an issue, fetch or read the
   issue context when tools are available.
4. Derive a short kebab-case plan slug from the requested scope.
5. Use:
   - index: `plans/{branch-name}/plan.md`
   - sub-plan: `plans/{branch-name}/plans/{issue-number-if-present-}{slug}.md`
6. If a plan already exists, ask whether to continue, revise, or create a new
   sub-plan.

### Step 2: Load Project Context

Before asking design questions:

1. Read root `AGENTS.md`.
2. Read nested `AGENTS.md` files for likely affected directories.
3. Read relevant `.agents/rules/*.md` files.
4. Search docs and existing implementations for similar work.
5. Identify affected build/test commands.

Record the context sources in the plan.

### Step 3: Discuss Decisions

Ask only questions that materially affect implementation. Prefer one to three
questions per round.

Cover, when relevant:

- architecture approach
- data model or API contract
- user-facing behavior
- error handling
- idempotency and retries
- concurrency
- backward compatibility
- security and permissions
- migration and rollout
- testing strategy

For non-trivial decisions, present two or three options with tradeoffs and a
recommendation. Capture rejected alternatives so they are not revisited later.

### Step 4: Write The Plan

Create or update the sub-plan with this structure:

```markdown
# {Feature Title}

Branch: `{branch-name}`
Plan Slug: `{slug}`
Parent Issue: #{issue-number}
Created: {date}
Status: planning

## Context

{summary plus sources read}

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|

## Scope

### In Scope
- ...

### Out Of Scope
- ...

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|

## Quality Gates

- [ ] Affected build command passes.
- [ ] Affected tests pass.
- [ ] Relevant `.agents/rules/` checks are satisfied.

## Execution Log

### {task-id}: {title}
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending
```

Update the branch index:

```markdown
# Plan Index

Branch: `{branch-name}`
Updated: {date}

## Sub-Plans

| Plan | Scope | Status | File |
|---|---|---|---|
```

### Step 5: Self-Review The Plan

Before presenting it:

- Every task has testable acceptance criteria.
- Dependencies are explicit.
- No task is too broad for one focused implementation pass.
- Wiring, registration, docs, migrations, and tests are represented when
  applicable.
- Quality gates match repository rules and affected files.
- Ambiguous decisions are either resolved or called out.

### Step 6: Confirm With User

Summarize:

- important decisions
- in/out scope
- task order
- risks
- verification commands

Ask whether the plan should be revised before implementation.

## Critical Rules

- Do not write a plan before reading relevant project context.
- Do not invent build/test commands; infer them from the repo or ask.
- Do not commit or push.
- Capture uncertainty explicitly.
- Use repository-specific paths and terminology.

## Checklist

- [ ] Branch and plan paths determined
- [ ] Existing plans checked
- [ ] Project instructions and relevant rules read
- [ ] Similar implementation patterns checked
- [ ] User decisions captured
- [ ] Plan and index written
- [ ] Plan self-reviewed
- [ ] User asked for confirmation
