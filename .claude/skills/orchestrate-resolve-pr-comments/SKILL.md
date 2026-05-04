---
name: orchestrate-resolve-pr-comments
description: Orchestrate resolution of pull request comments with triage, resolution-map review, implementation, code review, commit/push, and automatic GitHub replies after push.
---
<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->


# Orchestrate Resolve PR Comments

Coordinate resolution of pull request feedback using the repository
`resolve-pr-comments` workflow as the triage source of truth. The supervisor
coordinates worker runs and does not directly edit source, commit, push, or post
GitHub replies. The resolution map drives implementation and final replies.

## Route And Profile Selection

- Use the validated `pr-comment-triage` profile alias for fetching comments,
  independently assessing them, and creating/updating the resolution map.
- Use the validated `pr-comment-reviewer` profile alias for reviewing the
  resolution map before implementation.
- Use the validated `implementation` profile alias for implementing approved
  resolution-map fixes.
- Use the validated `code-review` profile alias for reviewing implemented fixes.
- Use the validated `pr-comment-responder` profile alias for posting replies and
  resolving GitHub threads after fixes are committed and pushed.
- Do not hard-code provider, model, effort, service tier, or context settings in
  this skill. The user controls concrete settings in the profiles manifest.
- If required profile aliases are unavailable, stop and ask the user to
  configure valid profiles before starting worker runs.

## Workflow

1. **Preflight.** Confirm the target workspace cwd, current branch, PR number or
   URL, profiles file, and working tree state. Treat unrelated dirty files as
   user-owned. If risky dirty files exist, stop and ask before proceeding.
2. **Start triage as a fresh run.** Start `pr-comment-triage` with
   `start_run` using `profile`, `profiles_file`, and supervisor cwd. Ask it to
   use the repository `resolve-pr-comments` skill to:
   - identify the PR from the prompt, branch, or GitHub metadata;
   - fetch PR metadata, changed files, reviews, review comments, review
     threads, and conversation comments;
   - filter already resolved threads, bot noise, and prior AI replies with
     hidden correlation markers;
   - independently verify AI reviewer comments against the code;
   - create or update `plans/{branch-name}/resolution-map.md`;
   - override any interactive "one comment at a time" behavior in the base
     workflow: triage every actionable comment in one pass, do not stop after
     each comment, and do not ask the human questions during initial triage;
   - make routine decisions itself when safe: fix as suggested, obvious
     alternative fix, decline incorrect comments with rationale, defer clearly
     out-of-scope polish, or mark follow-up issue candidates without creating
     issues yet;
   - collect unresolved uncertainties as **Reviewer Questions** in the
     resolution map instead of asking the human directly; reserve **Open Human
     Decisions** only for questions that remain after reviewer review;
   - treat verified bugs, regressions, test gaps, and plan-compliance gaps that
     are within the PR's approved scope as fix items by default, even when the
     fix is non-trivial;
   - include reply drafts and enough implementation detail for a fresh
     implementer to work from the map without re-reading the triage transcript.
3. **Review the resolution map as a fresh run.** Start `pr-comment-reviewer`
   with fresh context: PR identifier, branch, resolution-map path, repository
   instructions, and current diff. Ask it to verify:
   - every actionable unresolved comment was included or explicitly skipped with
     a defensible reason;
   - comments were not incorrectly declined, deferred, or escalated;
   - human-escalation items are correctly identified;
   - implementation approaches and files-to-change are complete enough;
   - reply drafts are accurate and safe;
   - answer or resolve the map's **Reviewer Questions** when repository context,
     approved plans, existing behavior, or reviewer judgment is sufficient;
   - promote only true unresolved decisions to the final **Open Human
     Decisions** section: product or scope changes, requested behavior changes,
     plan/acceptance ambiguity, security or release policy,
     dependency/external-service approval, creating follow-up issues, comments
     that invalidate the approved plan, or material reviewer/triage
     disagreement;
   - the map has final **Reviewer Questions** and **Open Human Decisions**
     sections, using `none` when empty.
4. **Iterate triage/reviewer.** Send reviewer feedback to the existing triage
   session with `send_followup`; then ask the existing map reviewer to re-review.
   Continue until the reviewer says the map is ready for the human-decision
   checkpoint, or ready for implementation when no open human decisions remain.
5. **Ask remaining human decisions in one batch.** After the reviewer has
   answered or resolved all reviewer-answerable questions, present only the
   remaining **Open Human Decisions** as a numbered list with options and
   consequences. Bundle decisions instead of interrupting after each comment.
   Include proposed follow-up issue creation/escalation because creating issues
   is an external write that requires human approval. Do not continue to
   implementation until the human answers or explicitly defers each decision. If
   none remain, record `Open Human Decisions: none`.
6. **Start implementation as a fresh run.** Start `implementation` with the
   approved resolution map, PR identifier, branch, and repo instructions. Ask it
   to implement only approved fix actions from the map, skip deferred/declined
   items, update plan evidence, run relevant verification, and avoid GitHub
   replies. Do not commit or push yet.
7. **Review implemented fixes as a fresh run.** Start `code-review` with fresh
   context: resolution map, current working tree diff, PR identifier, and repo
   instructions. Ask it to verify each approved fix, ensure no declined/deferred
   items were implemented accidentally, inspect tests/docs/contracts, and state
   whether the implementation is ready.
8. **Iterate implementation/review.** Send blocking or material reviewer
   feedback to the existing implementer session. Then send the implementer's
   response back to the existing code-review session. Continue until both align.
9. **Final human-decision checkpoint.** Before commit/push, present a final
   **Open Human Decisions** section. If there are no remaining decisions, say
   `Open Human Decisions: none.` Do not hide release, dependency, external-write,
   or behavior-changing decisions under residual risks.
10. **Commit and push through a worker.** After alignment and final human
    decisions are answered or explicitly deferred, ask the implementer to commit
    and push only intended PR-comment-resolution files and plan evidence. The
    supervisor must not commit or push directly. The implementer must report the
    commit SHA, pushed branch/ref, verification evidence, files committed, files
    intentionally left uncommitted, and residual risks.
11. **Reply and resolve after push.** Start `pr-comment-responder` only after the
    commit is pushed. Give it the final resolution map, pushed commit/branch,
    PR identifier, and repository `resolve-pr-comments` reply rules. It may
    automatically post replies and resolve threads according to the approved
    resolution map without asking again, provided the map's final
    `Open Human Decisions` section is `none` or all listed decisions were
    explicitly answered/deferred by the human. It should:
    - post the pre-drafted replies with hidden/correlation markers;
    - resolve only threads marked resolved or declined;
    - leave deferred or escalated threads open unless the map says otherwise;
    - report each reply posted, each thread resolved, and each skipped thread.
12. **Finish with a handoff.** Tell the human the pushed commit, PR URL,
    responder outcome, verification evidence, residual risks, final working tree
    state, and final **Open Human Decisions** section.

## Follow-Up Prompts

- Triage: "Use the repository `resolve-pr-comments` skill, but override its
  interactive one-comment-at-a-time loop. Fetch unresolved PR comments,
  independently assess every actionable comment in one pass, and create/update
  the resolution map. Do not ask the human questions during triage. Make routine
  decisions yourself when safe. Put unresolved uncertainties in a Reviewer
  Questions section for the resolution-map reviewer to answer first, not in a
  human prompt. Do not escalate verified in-scope bugs, regressions, test gaps,
  or plan-compliance gaps just because the fix is non-trivial; mark them as fix
  items. Include final Reviewer Questions and Open Human Decisions sections,
  using `none` when empty. Do not edit code, commit, push, or post replies."
- Resolution-map review: "Review the resolution map against the PR comments and
  code. Check completeness, decisions, human escalations, implementation
  instructions, and reply drafts. Verify that in-scope bugs and plan-compliance
  gaps are not incorrectly escalated merely because they require a larger fix.
  Answer every Reviewer Question you can from repository context, approved
  plans, existing behavior, and reviewer judgment. Promote only true unresolved
  product/scope, behavior, policy, dependency/external-write, issue-creation,
  plan-invalidating, or material disagreement questions to Open Human Decisions.
  Report blocking findings first and say whether the map is ready."
- Map feedback to triage: "Address the resolution-map reviewer feedback in this
  existing triage session. Update the map, incorporate reviewer answers to
  Reviewer Questions, and report what changed plus any remaining Reviewer
  Questions and Open Human Decisions."
- Implementation: "Implement only approved fix actions from the final resolution
  map. Skip deferred/declined items. Update evidence, run verification, and
  report changed files, results, risks, and blockers. Do not commit, push, or
  post GitHub replies yet."
- Code review: "Review the current working tree diff against the final
  resolution map. Verify every approved fix and that no deferred/declined items
  were implemented accidentally. Report blocking findings first and say whether
  it is ready."
- Final commit: "The resolution-map reviewer and code reviewer say this is
  ready, and final Open Human Decisions are answered or none. Commit and push
  only intended files. Report commit SHA, pushed branch/ref, files committed,
  verification evidence, and residual risks."
- Reply/resolve: "Using the final resolution map and pushed commit, post the
  drafted GitHub replies with correlation markers and resolve only threads marked
  resolved or declined. Leave deferred/escalated threads open unless the map says
  otherwise. Report every reply, resolved thread, skipped thread, and errors."

## Human Escalation Criteria

Escalate only true decisions the workers cannot safely decide from the PR,
resolution map, approved plan, and repository context: product/scope changes,
requested behavior changes, plan/acceptance ambiguity, security/release policy,
dependency/external-service approval, creating follow-up issues, or material
disagreement between workers.

Do **not** escalate verified bugs, regressions, missing tests, or
plan-compliance gaps merely because the fix is non-trivial, touches important
code, or was labeled major by a reviewer. If the comment points to behavior the
approved plan already requires, or a defect in the implementation under review,
the default decision is to fix it in the PR. Escalate only if fixing it would
require changing the approved behavior, expanding scope beyond the PR/plan,
choosing between materially different product semantics, accepting a known
deviation, or creating external follow-up work.

Routine code fixes, obvious alternatives, verified in-scope bugs, and incorrect
comments should be handled by the workers and recorded in the resolution map.

Do not interrupt the flow for each individual decision unless continuing would
cause wasted work or unsafe changes. Prefer collecting all uncertainties into
the resolution map as Reviewer Questions, having the resolution-map reviewer
answer them first, then asking the human only the remaining Open Human Decisions
in one bundled checkpoint before implementation.

## Critical Rules

- Resolution map first; implementation second; GitHub replies last.
- Do not post replies or resolve threads before fixes are committed and pushed.
- The responder may post/resolve automatically after push only according to the
  approved final resolution map.
- Initial triage must not use one-comment-at-a-time human interaction; it should
  triage all comments and batch uncertainties for reviewer review.
- The resolution-map reviewer should answer reviewer-answerable questions before
  any human decision checkpoint.
- Always include a final **Open Human Decisions** section. If none remain, say
  `Open Human Decisions: none.`
