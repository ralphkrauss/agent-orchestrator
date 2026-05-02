---
name: resolve-issue-comments
description: Resolve issue comments through triage, decisions, and follow-up actions. Use when the user says "resolve issue comments", "address issue feedback", "process issue comments", "respond to issue", or provides an issue number or URL to resolve.
---

# Resolve Issue Comments

Triage issue comments one at a time, record decisions in a durable artifact, and
execute only approved follow-up actions.

## Instructions

### Phase 1: Initialize

1. Identify the issue from user input.
2. Fetch or read the issue title, body, state, labels, assignees, and comments
   using available tools.
3. Check for existing branches or PRs linked to the issue.
4. Filter status-only or already-resolved comments.
5. Categorize remaining comments:
   - action item
   - question
   - feedback
   - clarification
   - escalation

Present a summary and ask whether to begin triage.

### Phase 2: Triage One Comment At A Time

For each actionable comment:

1. Read the full comment.
2. Gather context from referenced code, docs, issues, and PRs.
3. Verify AI/bot claims independently.
4. Present the comment, context, and options.
5. Wait for the user's decision.

Options commonly include:

- answer now
- add to implementation scope
- already handled
- defer to another issue
- decline with rationale
- investigate further

Do not post replies, edit code, close issues, or create branches during triage.

### Phase 3: Record The Resolution Map

Create or update:

```text
plans/{branch}/issue-{issue-number}-resolution-map.md
```

If the repository installed `assets/templates/issue-resolution-map.md.template`,
use it as the starting shape.

Each entry must include:

- comment id
- author
- full comment
- gathered context
- decision
- self-contained approach
- files to change, if any
- draft reply

### Phase 4: Align And Execute

After all comments are triaged:

1. Present a summary table.
2. Ask for final user confirmation.
3. Create or update an implementation plan for approved code changes.
4. Execute approved work using the repository workflow.
5. Create new issues, post replies, or close the issue only after explicit
   approval for those external writes.

### Phase 5: Report

Report:

- comments handled
- actions taken
- replies posted
- issues/branches/PRs created
- deferred items
- files changed

## Critical Rules

- Triage is decision-only.
- One comment at a time.
- Ask before external writes.
- Do not close issues unless explicitly approved.
- Do not commit or push unless explicitly asked.
- Resolution map carries decisions into implementation.

## Checklist

- [ ] Issue identified
- [ ] Comments fetched/read
- [ ] Comments categorized
- [ ] Each actionable comment triaged
- [ ] Resolution map written
- [ ] User confirmed final actions
- [ ] Approved actions executed
- [ ] Summary reported
