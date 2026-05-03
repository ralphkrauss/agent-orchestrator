---
name: orchestrate-create-plan
description: Orchestrate an issue-based planning loop between a plan creator using the repository create-plan workflow and a reviewer who answers most clarification questions and critiques the plan until both are aligned.
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# Orchestrate Create Plan

Coordinate a plan-creation loop for a GitHub issue. The plan creator owns the
plan and should use the repository create-plan skill or workflow when available;
the reviewer studies the issue, answers most clarification questions, and
critiques drafts until the plan is complete.

## Route And Profile Selection

- Use the validated `implementation` route, or a validated plan-creator profile
  alias if one is explicitly configured, for the plan creator.
- Use the validated `review` route, or a validated plan-reviewer profile alias if
  one is explicitly configured, for the reviewer.
- Do not hard-code provider, model, effort, service tier, or context settings in
  this skill. The user controls those concrete settings in the routing manifest.
- If the required validated routes or profile aliases are unavailable, stop and
  ask the user to provide a valid routes file or routes JSON before starting
  worker runs.

## Workflow

1. **Confirm the issue target.** Identify the GitHub issue URL or issue number
   from the user request. If it is missing, ask the user for it before starting
   workers.
2. **Start workers through agent-orchestrator.** Start or resume worker runs via
   agent-orchestrator MCP tools, using the selected validated profile alias
   settings for each route and the target workspace cwd from supervisor context.
   Wait for each worker response, inspect the output, and send follow-up prompts
   through the same worker sessions as the loop continues.
   Use bounded waits and adaptive check-ins: first wait about 30 seconds to catch
   startup, auth, model, quota, or protocol failures, then inspect
   `get_run_status` and recent events. Compare `last_activity_at`,
   `last_activity_source`, `latest_error`, `timeout_reason`, and
   `terminal_reason` with the previous check-in. If activity is advancing and no
   fatal latest error is present, back off toward roughly 2 minutes, 5 minutes,
   and then a 10-15 minute ceiling appropriate for the task. Do not cancel a
   worker only because elapsed wall-clock time is high; cancel or escalate only
   on explicit user request, clear no-activity evidence past the idle window, a
   fatal latest error, or a deliberate stop/restart recovery path. For known
   quiet work, choose a larger `idle_timeout_seconds` when starting the run.
3. **Start the plan creator.** Ask the plan creator to create an implementation
   plan for the issue using the repository create-plan skill or workflow if
   available. Instruct it to:
   - inspect the issue and relevant repository context;
   - ask only clarification questions that materially affect the plan;
   - write or update the repository-native plan in the location selected by
     the create-plan workflow;
   - clearly separate confirmed decisions, assumptions, open questions, risks,
     and implementation tasks.
4. **Start the reviewer.** Ask the reviewer to get familiar with the same issue,
   repository context, and current plan draft. Instruct it to:
   - answer the plan creator's clarification questions when confidence is high;
   - flag when a question depends on product intent or requirements that cannot
     be inferred from the issue or codebase;
   - review the plan for unclear, underspecified, incorrect, risky, or missing
     content;
   - provide concise, actionable feedback for the plan creator.
5. **Bridge questions without defaulting to the human.** When the plan creator
   asks questions, send them to the reviewer first. Only ask the human when both
   conditions are true:
   - the question affects product requirements, user-facing behavior, scope, or
     acceptance criteria; and
   - the reviewer is not confident answering from the issue and repository
     context.
6. **Iterate to alignment.** Pass reviewer answers and feedback to the plan
   creator, wait for an updated plan, then send the updated plan back to the
   reviewer. Continue until:
   - the reviewer says the plan is ready or has no blocking feedback; and
   - the plan creator agrees the open questions are resolved or explicitly
     documented as assumptions.
7. **Avoid over-specifying implementation.** The final plan should be complete
   enough to guide a developer, with clear scope, decisions, risks, tasks,
   acceptance criteria, and quality gates, but should not micromanage every
   implementation detail.
8. **Finish with a handoff.** Summarize the final plan location, key decisions,
   any assumptions, and whether human input was required. Do not directly edit
   source files or implement the plan from the supervisor.

## Follow-Up Prompts

Use short, role-specific follow-ups during the loop:

- To the reviewer: "Review the updated plan for the issue. Answer any open
  plan-creator questions you can answer confidently from the issue and repo
  context. Identify only blocking or materially useful feedback. Say when the
  plan is ready."
- To the plan creator: "Incorporate the reviewer feedback, update the plan, and
  list any remaining questions. Only keep questions open when they materially
  affect implementation or product requirements."

## Human Escalation Criteria

Escalate to the user only for unclear product requirements that the reviewer
cannot answer confidently, such as final scope boundaries, user-facing behavior,
business rules, acceptance criteria, or tradeoffs that require product judgment.
