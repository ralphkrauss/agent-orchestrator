# Follow-up Review 2: Uncommitted Changes

Date: 2026-05-04
Scope: `git diff HEAD`, focused on the claimed fixes for the prior follow-up findings.

## Findings

### P2: The authoritative top-of-plan summary still says Bash is monitor-only

The implementation and lower plan sections now describe the current Bash allow
list as the pinned monitor plus `Bash(pwd)`, `Bash(git status)`, and
`Bash(git status *)`. The top "Current implementation note", however, still
says Bash is exposed only with a pinned monitor allowlist entry. The execution
log banner explicitly tells future workers to trust this top-of-plan summary as
authoritative, so this remaining stale sentence can still steer future
orchestrated runs back toward the wrong contract.

The same stale wording appears in a nearby defense-in-depth code comment, though
the code itself builds the correct allow list.

References:

- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:58`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:402`
- `src/claude/permission.ts:51`

## Cleared

- The Bash enforcement code now uses a positive Bash allowlist for the pinned
  monitor, `pwd`, `git status`, and `git status *`, with the expanded deny list
  as defense in depth. The named bypasses (`git -C . add ...`, `command touch
  ...`, and adjacent forms) are not allowlisted and are also covered by explicit
  deny entries.
- The rewritten CCS-9, CCS-15, CCS-16, CCS-22, closed open-question bullets,
  and superseded notes now describe the current target-workspace launch,
  redirected user skill mirror, writable-profile pin, and Bash allowlist model.

## Verification

No broad suite was run during this follow-up review. I inspected the relevant
source, tests, and plan sections. The user reported `pnpm test` clean: 238
passed, 1 skipped, 0 failed.

## Resolution (2026-05-04, follow-up 2)

- **P2 top-of-plan summary** (`plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:58`)
  rewritten to describe the four-pattern Bash allowlist (pinned monitor,
  `Bash(pwd)`, `Bash(git status)`, `Bash(git status *)`) and to enumerate the
  specific bypass shapes denied by the comprehensive deny list (`git -C *`,
  `git --git-dir*`, `git --work-tree*`, `command *`, `builtin *`,
  backslash-escaped commands, etc.). The execution-log banner that points
  future workers at this summary now points at correct text.
- **`src/claude/permission.ts:51`** defense-in-depth comment updated. It
  previously said "the primary security boundary is the allowlist (only the
  pinned monitor command)"; it now correctly identifies the primary boundary
  as the positive allowlist of pinned monitor + `pwd` + `git status` + `git
  status *`. The docstring on `CLAUDE_SUPERVISOR_BASH_INSPECTION_ALLOWLIST`
  was also rewritten so the four-pattern story reads cleanly.
- **`src/claude/launcher.ts`** spawn-args comment updated to enumerate the
  four allowlist patterns explicitly instead of saying "Bash is present only
  for the pinned monitor command".
- **README "Claude Code Orchestration Mode" + supervisor tool surface**
  sections rewritten so the `--allowed-tools` example shows the four Bash
  patterns and the prose explicitly lists `cat`/`ls`/`head`/`tail`/`grep`/
  `find`/`jq`/`git log`/`git diff`/`git show`/`git rev-parse`/`git branch`
  as denied, including via `git -C dir add` / `git --git-dir=...` shapes.
- **`docs/development/mcp-tooling.md` Claude harness section** rewritten with
  the same four-pattern allowlist framing and explicit bypass-shape denies.
- `pnpm test` (full suite) still clean: 238 passed, 1 skipped, 0 failed.
