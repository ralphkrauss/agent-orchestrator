# Follow-up Review 5: Uncommitted Changes

Date: 2026-05-04
Scope: `git diff HEAD`, focused on whether the stale active plan contract from
follow-up review 4 was corrected.

## Findings

### P2: Active Out of Scope and Risk sections still say non-orchestrate project skills are not exposed

The Decisions table and Implementation Tasks table now have forward-looking
banners that correctly point future workers to the current post-merge contract.
That clears the table-specific finding from the previous pass.

However, two other active plan sections above the execution-log history still
describe the old skill model. The Out of Scope section says non-orchestrate
project skills are not allowed inside the supervisor envelope, and Risk #19 says
the ephemeral skill root contains only orchestrate-* skills and tests prove
non-orchestrate project skills are not exposed. The current implementation now
intentionally mirrors the target workspace `.claude/skills/` into the
redirected user skill root so `/skills` exposes workspace skills like `review`
and `commit` alongside `orchestrate-*`, without loading project settings.

Because these sections are not under the Decisions or Implementation Tasks
banners, branch-context workflows can still read them as current constraints and
steer future workers back toward the old no-user-skill model.

References:

- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:361`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:387`

## Cleared

- The Decisions table now has an authoritative current-state banner for
  Decisions 7, 22, 23, and 24.
- The Implementation Tasks table now has an authoritative current-state banner
  for CCS-9, CCS-15, CCS-16, CCS-19, and CCS-22.
- The pinned-monitor deliverable now enumerates the four Bash allow patterns
  and denied bypass shapes.
- The adjusted CCS rows are annotated to point at the current contract.

## Verification

No broad suite was run during this follow-up review. I inspected the relevant
plan sections. The user reported `pnpm test` clean: 238 passed, 1 skipped,
0 failed.

## Resolution

Resolved after review:

- The Out of Scope bullet now blocks user MCP servers, real user-level
  `~/.claude/skills/`, project settings, hooks, commands, and agents while
  explicitly allowing the intended target-workspace `.claude/skills/` mirror.
- Risk #19 now describes the actual risk as target-workspace Claude state
  silently changing supervisor behavior, and its mitigation distinguishes
  intentionally mirrored workspace skills from denied project settings/hooks/MCP
  and real user-level skills.
