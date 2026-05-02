---
name: resolve-pr-comments
description: Resolve pull request feedback through triage, user decisions, implementation planning, and final replies. Use when the user says "resolve PR comments", "fix PR feedback", "address review comments", or provides a PR number or URL to resolve.
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# Resolve PR Comments

Process PR feedback without rushing into code. Triage every actionable comment,
record a durable resolution map, plan fixes, implement only approved decisions,
then reply after the fixes are committed and pushed by explicit user action.

## Instructions

### Phase 1: Initialize

1. Identify the PR from the user input or current branch.
2. Fetch PR metadata, changed files, reviews, review comments, review threads,
   and conversation comments using available tools.
3. If checking out or updating a branch could overwrite local work, ask first.
4. Filter:
   - already resolved review threads
   - informational bot noise
   - prior AI replies with hidden correlation markers
5. Keep actionable human and AI review comments. AI reviewer comments must be
   independently verified against the code.

Present a summary:

```text
Found X unresolved comments on PR #N:
- A inline review comments
- B review body comments
- C conversation comments
- skipped D resolved/informational comments

Ready to triage one comment at a time?
```

### Phase 2: Triage One Comment At A Time

For each comment:

1. Read the full comment.
2. Read referenced files and surrounding code.
3. Read related files, docs, and existing patterns.
4. Verify whether the comment is valid, partially valid, or incorrect.
5. Present the comment, context, and your assessment.
6. Present options:
   - fix as suggested
   - alternative fix
   - decline with rationale
   - defer
   - escalate to a new issue
   - investigate further
7. Wait for the user's decision.

Do not edit code or post GitHub replies during triage.

### Phase 3: Record The Resolution Map

Create or update `plans/{branch-name}/resolution-map.md`. If the repository
installed `assets/templates/resolution-map.md.template`, use it as the starting
shape:

```markdown
# PR #{number} Resolution Map

Branch: `{branch-name}`
Created: {date}
Total comments: X | To fix: Y | To defer: Z | To decline: W | To escalate: V

## Comment 1 | {status} | {severity}

- **Comment Type:** review-inline | review-body | conversation
- **File:** {path:line if applicable}
- **Comment ID:** {id if applicable}
- **Review ID:** {id if applicable}
- **Thread Node ID:** {id if applicable}
- **Author:** {author}
- **Comment:** {full comment}
- **Independent Assessment:** {validity and reasoning}
- **Decision:** fix-as-suggested | alternative-fix | decline | defer | escalate
- **Approach:** {self-contained implementation instruction}
- **Files To Change:** {paths or none}
- **Reply Draft:**
  > {AI_REPLY_PREFIX}: {reply text}
```

The approach must be detailed enough for implementation without re-reading the
triage conversation.

Use the repository's configured AI reply prefix. If none exists, ask the user
whether to use a prefix such as `**[AI Agent]:**`.

### Phase 4: Align And Plan

After all comments are triaged:

1. Present a resolution summary table.
2. Ask for final user confirmation.
3. Create an implementation plan from only approved fix/escalate actions.
4. Skip repeated design discussion for decisions already captured in the
   resolution map.

### Phase 5: Execute Approved Work

Use `implement-plan` or an equivalent repository workflow to apply the approved
fixes.

Keep deferred and declined comments out of implementation scope. Escalated
comments may create issues only when the user approved external writes.

### Phase 6: Reply And Resolve

Before posting replies:

1. Confirm fixes are committed and pushed, or ask the user whether replies
   should wait.
2. Ask for explicit approval before posting GitHub replies or resolving threads.
3. Post the pre-drafted replies with hidden markers so future runs can detect
   handled comments.
4. Resolve review threads only for resolved or declined inline comments.
5. Leave deferred or escalated threads open unless the user says otherwise.

### Phase 7: Capture Lessons

Review resolved comments for generalizable patterns:

- If a rule would prevent recurrence, propose creating or updating a rule.
- Deduplicate against existing `.agents/rules/`, `AGENTS.md`, and docs.
- Ask before adding permanent rules.

## Critical Rules

- Triage is decision-only: no code changes and no replies.
- Verify AI-generated review comments independently.
- One comment at a time.
- Resolution map is the source of truth for later implementation and replies.
- Do not post replies before user approval.
- Do not commit or push unless explicitly asked.
- Do not resolve deferred or escalated threads by default.

## Checklist

- [ ] PR identified
- [ ] All comment types fetched
- [ ] Comments filtered carefully
- [ ] Each actionable comment independently assessed
- [ ] User decision recorded
- [ ] Resolution map completed
- [ ] Implementation plan created
- [ ] Approved fixes implemented and verified
- [ ] User approved external replies
- [ ] Replies posted and threads resolved where appropriate
