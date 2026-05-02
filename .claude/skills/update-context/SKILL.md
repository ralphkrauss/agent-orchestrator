---
name: update-context
description: Refresh branch context with recent git, plan, review, and PR state. Use when the user says "update context", "refresh context", or wants to resume with current branch status.
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# Update Context

Refresh existing branch context artifacts with the latest local and remote state.

## Instructions

### Step 1: Find Existing Context

Look for:

- `contexts/{branch}/context.md`
- `plans/{branch}/plan.md`
- review artifacts
- PR metadata/comments when available

If no context exists, offer to create one or use `load-context` instead.

### Step 2: Gather Updates

Collect:

- recent commits
- working tree status
- plan task status
- review findings
- test results
- PR status and unresolved comments when available
- new risks or blockers

### Step 3: Update The Artifact

Update only the status/current-state sections. Avoid rewriting stable research
unless it is wrong.

If the context format is unknown, append a clearly dated "Session Update"
section.

### Step 4: Report

Summarize what changed and what remains open.

## Critical Rules

- Do not erase prior context.
- Do not mark tasks complete without evidence.
- Do not claim tests passed unless they actually ran.
- Ask before external service reads if credentials or network access are
  sensitive.

## Checklist

- [ ] Existing context located
- [ ] Recent state gathered
- [ ] Artifact updated conservatively
- [ ] Open items summarized
