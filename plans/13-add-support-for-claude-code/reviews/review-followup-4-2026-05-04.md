# Follow-up Review 4: Uncommitted Changes

Date: 2026-05-04
Scope: `git diff HEAD`, focused on whether the stale active plan contract from
follow-up review 3 was corrected.

## Findings

### P2: Active plan decision/delivery tables still describe the old monitor-only Claude Bash contract

The top implementation note, source comments, README, and MCP tooling docs now
describe the four-pattern Bash allowlist correctly. The active decision and
delivery-plan tables above the execution log still describe the old contract:
`Bash` only for the curated monitor command, generic Bash denied, only
orchestrate-* skills exposed, an ephemeral envelope, and leak tests expecting
the Bash allowlist to match the pinned monitor exactly.

Because these tables are above the execution-log historical banner, future
branch-context workflows can still read them as current plan decisions and steer
workers back toward the wrong monitor-only/no-user-skill model.

References:

- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:157`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:158`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:159`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:219`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:361`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:368`

## Cleared

- The top-of-plan implementation note now describes the four-pattern Bash
  allowlist and denied bypass shapes correctly.
- `src/claude/permission.ts`, `src/claude/launcher.ts`, `README.md`, and
  `docs/development/mcp-tooling.md` now match the four-pattern Bash allowlist.

## Verification

No broad suite was run during this follow-up review. I inspected the relevant
plan, source, README, and MCP tooling docs. The user reported `pnpm test`
clean: 238 passed, 1 skipped, 0 failed.

## Resolution (2026-05-04, follow-up 4)

The Decisions table and the Implementation Tasks table sit above the
Execution Log "Authoritative current state" banner, so future branch-context
workflows can read them as current plan decisions. Both sections now carry
their own banners pointing at the current contract:

- **Decisions banner (above Decisions table):** lists the current shape for
  Decisions 7 (target-workspace launch with stable per-workspace state under
  `claude-supervisor/{home,envelopes/}`, `--setting-sources user`, no
  `--add-dir`/`--bare`/`--disable-slash-commands`, MCP entry pin of
  `AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE`), 22 (four-pattern Bash allow
  list + comprehensive deny list, no MCP blocking wait tools), 23 (the
  pinned monitor pattern is one of the four allow patterns alongside `pwd`,
  `git status`, `git status *`), and 24 (curated orchestrate-* snapshot
  PLUS redirected user skill mirror populated from the workspace
  `.claude/skills/`).
- **Implementation Tasks banner (above CCS-* table):** spells out which
  tasks (CCS-9, CCS-15, CCS-16, CCS-19, CCS-22) have evolved post-merge and
  what the current shape is for each.
- **Stale Scope bullet at line 219** ("Bash allowlist matches only
  `<absolute-bin> monitor <run_id> ...`") rewritten to enumerate the
  four-pattern allow list and the deny list.
- **Stale CCS-9, CCS-15, CCS-16, CCS-19, CCS-22 status cells** annotated
  with `(adjusted post-merge: see banner above and Execution Log)` so the
  table-level signal cannot be misread as the current contract.
- `pnpm test` (full suite) still clean: 238 passed, 1 skipped, 0 failed.
