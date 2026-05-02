---
name: load-context
description: Load existing branch context and planning artifacts. Use when the user says "load context", "read context", "get context", or wants to resume work on a branch.
---

# Load Context

Load the relevant branch context without changing files.

## Instructions

### Step 1: Locate Artifacts

Get the current branch and look for:

- `contexts/{branch}/context.md`
- `plans/{branch}/plan.md`
- `plans/{branch}/plans/*.md`
- `plans/{branch}/resolution-map.md`
- `plans/{branch}/test-plan.md`
- `plans/{branch}/test-results.md`
- `plans/{branch}/reviews/*.md`
- repository-specific equivalents

### Step 2: Read Core Instructions

Read:

- `AGENTS.md`
- nested `AGENTS.md` for likely affected paths
- relevant `.agents/rules/*.md`

### Step 3: Summarize

Report:

- objective
- current plan status
- completed work
- pending tasks
- risks and open decisions
- verification already run
- recommended next action

## Critical Rules

- Do not edit files.
- Do not assume missing artifacts exist.
- Separate evidence from inference.

## Checklist

- [ ] Branch detected
- [ ] Context artifacts searched
- [ ] Instructions/rules loaded
- [ ] Status summarized
- [ ] Next action recommended
