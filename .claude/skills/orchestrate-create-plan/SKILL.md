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

1. **Confirm the branch and issue target.** Identify the current branch before
   asking the human for an issue. Prefer the supervisor context when it already
   contains the target workspace branch; otherwise ask the plan creator or a
   lightweight worker to inspect the repository branch with the repo's normal
   git tooling. If the branch name contains an issue number or issue slug,
   derive the GitHub issue target from it and have workers fetch/read that
   issue. Ask the human for an issue URL/number only when the branch and user
   request do not identify one clearly.
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
   - flag any proposed scope substitution, such as replacing the user's named
     technology, API, SDK, product surface, or acceptance target with a different
     implementation surface;
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
6. **Escalate scope substitutions before alignment.** If either worker proposes
   a material scope substitution, pause the loop and ask the human before
   accepting it. Present the original scope, proposed replacement, why the
   worker recommends changing scope, risks/tradeoffs, and a clear choice. Do
   not let reviewer/creator agreement override human intent for product scope,
   acceptance criteria, named technologies, or user-facing behavior.
7. **Iterate to alignment.** Pass reviewer answers and feedback to the plan
   creator, wait for an updated plan, then send the updated plan back to the
   reviewer. Continue until:
   - the reviewer says the plan is ready or has no blocking feedback; and
   - the plan creator agrees the open questions are resolved or explicitly
   documented as assumptions.
8. **Avoid over-specifying implementation.** The final plan should be complete
   enough to guide a developer, with clear scope, decisions, risks, tasks,
   acceptance criteria, and quality gates, but should not micromanage every
   implementation detail.
9. **Commit and push the plan through the plan creator.** Repository-native plan
   files and plan index files created by the create-plan workflow are normal
   workflow artifacts. After the reviewer and plan creator agree the plan is
   ready, ask the plan creator to commit and push only those plan workflow files
   unless the human says otherwise. The supervisor must not commit or push
   directly. The plan creator should report the commit SHA, pushed branch, and
   exact files included.
10. **Finish with an online handoff.** Give the human the GitHub URL for the
   pushed online plan, plus a concise summary of the plan, key decisions,
   assumptions, risks, and any human scope decisions made. Do not directly edit
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
- To the plan creator after approval: "The reviewer says the plan is ready.
  Commit and push only the create-plan workflow artifacts for this plan and the
  branch index. Do not include source changes. Report the commit SHA, pushed
  branch, files committed, and the GitHub URL for the plan."

## Human Escalation Criteria

Escalate to the user only for unclear product requirements that the reviewer
cannot answer confidently, such as final scope boundaries, user-facing behavior,
business rules, acceptance criteria, or tradeoffs that require product judgment.

Always escalate proposed material scope substitutions, even when the reviewer
and plan creator agree. The escalation must include the argument for changing
scope and the consequences of keeping the original scope.
