---
name: orchestrate-implement-plan
description: Orchestrate implementation of an approved repository plan with a fresh implementer run, a fresh reviewer run, iterative feedback follow-up, and commit/push after both roles align.
---

# Orchestrate Implement Plan

Coordinate implementation of an approved repository-native plan. The implementer
owns code changes and should use the repository `implement-plan` workflow or
skill when available. The reviewer independently reviews the implementation
against the approved plan. The supervisor coordinates the loop through worker
runs and does not directly edit source, commit, or push.

## Route And Profile Selection

- Use the validated `implementation` profile alias for the implementer.
- Use the validated `code-review` profile alias for the reviewer.
- Do not hard-code provider, model, effort, service tier, or context settings in
  this skill. The user controls those concrete settings in the profiles
  manifest.
- If the required validated profile aliases are unavailable, stop and ask the
  user to configure valid profiles before starting worker runs.

## Context Isolation Rules

- Start the implementer as a **new worker run**. Do not resume the plan-creation
  worker or include the plan-creation transcript. The approved plan and current
  repository state should be sufficient context.
- After the implementer finishes the initial implementation pass, start the
  reviewer as a **new worker run**. Do not resume plan-creation workers or reuse
  the supervisor's plan-creation discussion as reviewer context.
- During implementation review iterations, reuse the same implementer and
  reviewer sessions with follow-up prompts. The implementer keeps the context of
  the full implementation, and the reviewer keeps the context of prior findings
  and fixes.

## Workflow

1. **Preflight the workspace.** Confirm the target workspace cwd from supervisor
   context and check the current branch/status through a lightweight worker or
   the implementer. Treat existing uncommitted changes as user-owned unless they
   were created in the current orchestration. If unrelated or risky dirty files
   exist, stop and ask the human before implementation begins.
2. **Start the implementer.** Start a new worker run via agent-orchestrator MCP
   `start_run` using the `implementation` profile alias, the configured
   `profiles_file`, and the target workspace cwd. Ask it to:
   - follow the repository `implement-plan` workflow or skill;
   - locate the current branch plan/index using the repository workflow;
   - read `AGENTS.md`, relevant `.agents/rules/`, the approved plan, affected
     source, tests, and docs;
   - implement tasks narrowly and update plan evidence as required by the
     repository workflow;
   - run the narrowest meaningful verification, then broader checks if feasible;
   - avoid committing, pushing, or changing unrelated files during this pass;
   - report changed files, task status, verification commands/results, residual
     risks, and blockers.
3. **Monitor responsibly.** Use bounded waits and adaptive check-ins. First wait
   briefly to catch startup, auth, model, quota, or protocol failures, then
   inspect status/events as needed. Do not cancel a worker only because elapsed
   wall-clock time is high; cancel or escalate only on explicit human request,
   clear idle/fatal evidence, or a deliberate stop/restart recovery path.
4. **Start the reviewer after implementation.** Start a new worker run via
   `start_run` using the `code-review` profile alias, the configured
   `profiles_file`, and the target workspace cwd. Give the reviewer fresh
   context consisting of the approved plan location, current branch, repository
   instructions, and the current working tree diff. Ask it to:
   - review the code changes against the approved plan and acceptance criteria;
   - inspect relevant tests, docs, contracts, and affected call sites;
   - identify correctness, compatibility, error handling, persistence,
     cancellation, observability, security, and test coverage issues where
     relevant;
   - separate blocking findings from non-blocking suggestions and test gaps;
   - say explicitly when the implementation is ready.
5. **Iterate with existing sessions.** If the reviewer has blocking or material
   feedback, send that feedback to the existing implementer session with
   `send_followup`. Ask it to fix the findings, update plan evidence, rerun the
   relevant verification, and report what changed. Then send the implementer's
   response back to the existing reviewer session with `send_followup` for
   re-review. Continue until:
   - the reviewer says there are no blocking findings and the implementation is
     ready; and
   - the implementer agrees all review feedback has been addressed or explicitly
     documented as a non-blocking residual risk.
6. **Escalate only true blockers.** Human escalation is not needed for ordinary
   implementation tradeoffs or review fixes. Ask the human only when the plan
   cannot be implemented as written, a required product/scope decision blocks
   progress, a dependency or external-service action needs approval, or workers
   disagree on a material issue they cannot resolve from the plan and repo.
7. **Commit and push through the implementer after alignment.** Once implementer
   and reviewer are aligned and both approve the current implementation, ask the
   implementer to commit and push the implementation. The supervisor must not
   commit or push directly. The implementer should include only intended
   implementation files and plan evidence files, exclude unrelated/user-owned
   changes, and report the commit SHA, pushed branch, files committed, and any
   files intentionally left uncommitted.
8. **Finish with a handoff.** Tell the human the pushed branch/commit, concise
   implementation summary, reviewer outcome, verification evidence, residual
   risks or deferred work, and whether any local uncommitted files remain.

## Follow-Up Prompts

- Initial implementer: "Use the repository `implement-plan` workflow. Locate
  the approved plan for the current branch, implement it task by task, update
  plan evidence, run relevant verification, and report changed files, results,
  risks, and blockers. Do not commit or push yet."
- Initial reviewer: "Review the current working tree diff against the approved
  plan for this branch. Use the plan and repository context as your source of
  truth. Report blocking findings first, then non-blocking suggestions and test
  gaps. Say explicitly whether the implementation is ready."
- Reviewer feedback to implementer: "Address the reviewer feedback below in
  this existing implementation session. Keep changes scoped, update plan
  evidence, rerun relevant verification, and report what changed plus any
  remaining risks."
- Implementer response to reviewer: "Re-review the updated implementation in
  this existing review session. Focus on the prior findings, any new diff, and
  whether the implementation now satisfies the approved plan. Say explicitly
  whether it is ready."
- Final commit request to implementer: "The reviewer says the implementation is
  ready and you agree the plan feedback is addressed. Commit and push only the
  intended implementation and plan evidence files. Exclude unrelated or
  user-owned changes. Report commit SHA, pushed branch, files committed, and any
  files left uncommitted."

## Human Escalation Criteria

Escalate only when implementation is blocked by something the plan and
repository context cannot resolve, such as a required product/scope decision,
permission or dependency approval, external-service write, persistent failing
quality gate that changes acceptance, or an irreconcilable material disagreement
between implementer and reviewer.
