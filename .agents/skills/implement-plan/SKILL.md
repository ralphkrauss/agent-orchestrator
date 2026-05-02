---
name: implement-plan
description: Execute implementation plans with task-by-task verification and plan evidence. Use when the user asks to implement a plan, execute tasks, harden an implementation, or finish planned work.
---

# Implement Plan

Turn an approved plan into code while keeping the main agent responsible for
scope, quality, verification, and evidence.

## Instructions

### Step 1: Locate And Load The Plan

1. Get the current branch name.
2. Find the branch plan index, normally `plans/{branch-name}/plan.md`.
3. Read all referenced sub-plans relevant to the request.
4. Read root and nested `AGENTS.md` files for affected directories.
5. Read relevant `.agents/rules/*.md`.
6. Read `contexts/{branch-name}/context.md` if it exists.
7. Load cross-feature lessons if the repository has a lessons file.

If no plan exists for non-trivial work, stop and create one with
`create-plan` first.

### Step 2: Build The Task Graph

Extract:

- task id and title
- dependencies
- acceptance criteria
- likely files or modules
- verification commands
- quality gates

Mark one dependency-ready task as `in_progress` before editing. Keep plan status
accurate as work proceeds.

### Step 3: Implement One Task At A Time

For each task:

1. Re-read the most relevant local code before editing.
2. Keep changes scoped to the task.
3. Follow existing patterns over new abstractions.
4. If delegation is available, delegate at most one task per agent and give a
   bounded write scope.
5. Review implementation against the task acceptance criteria before moving on.
6. Update the plan with code evidence and verification evidence.

If the task turns out to be wrong, incomplete, or too large, update the plan and
ask the user before changing scope.

### Step 4: Verify

Use repository-approved commands from `AGENTS.md`, docs, or the plan.

Run the narrowest meaningful checks:

- format/lint for touched areas
- targeted build
- targeted tests
- type checks
- migration checks
- UI or runtime checks only when the repo allows app execution

Record the exact command and result in the plan. If a command cannot be run,
record why.

### Step 5: Hardening Pass

After planned tasks are feature-complete, inspect for:

- missed call sites
- null/empty/error states
- retries and idempotency where relevant
- concurrency risks
- permission or security gaps
- logging and observability gaps
- generated or unrelated diff noise
- missing docs or tests

Fix issues within scope. Ask before broad refactors or deferred work.

### Step 6: Completion Report

Update the plan:

- top-level status
- completed tasks
- evidence
- verification commands
- residual risks
- deferred work with rationale

Then report the same summary to the user.

## Critical Rules

- Do not skip or defer plan tasks without user approval.
- Do not mark a task complete without implementation and verification evidence.
- Do not commit or push unless explicitly asked.
- Do not run application servers unless repository instructions allow it or the
  user approves.
- Do not overwrite user changes.
- If tests fail repeatedly, diagnose and update the plan instead of retrying the
  same command blindly.

## Checklist

- [ ] Plan loaded
- [ ] Project instructions and rules loaded
- [ ] Task graph understood
- [ ] Tasks implemented one at a time
- [ ] Relevant verification run or documented as not run
- [ ] Plan updated with evidence
- [ ] Hardening pass complete
- [ ] Final summary provided
