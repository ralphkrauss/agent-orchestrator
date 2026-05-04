# Follow-up Review 3: Uncommitted Changes

Date: 2026-05-04
Scope: `git diff HEAD`, focused on the latest fixes for the remaining stale
Bash allowlist contract.

## Findings

### P2: Active plan decision/delivery tables still describe the old monitor-only Claude Bash contract

The top "Current implementation note" is now correct, and the source/docs named
in the latest fix line up with the four-pattern Bash allowlist. However, the
plan's active decision and delivery-plan tables still say the Claude supervisor
allows Bash only for the curated/pinned monitor command, denies generic Bash,
exposes only orchestrate-* skills, uses an ephemeral envelope, and expects the
Bash allowlist to match the pinned monitor exactly.

Those sections are above the execution-log banner, so they are not clearly
scoped as historical evidence. Branch context workflows can still load these
tables as current plan decisions and steer future workers back toward the
wrong monitor-only/no-user-skill model.

References:

- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:142`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:157`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:219`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:361`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:368`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:993`

## Cleared

- The top-of-plan "Current implementation note" now describes the exact Bash
  allowlist: pinned monitor, `Bash(pwd)`, `Bash(git status)`, and
  `Bash(git status *)`, with all other Bash denied by `dontAsk`.
- `src/claude/permission.ts` comments now match the source behavior.
- `src/claude/launcher.ts`, `README.md`, and
  `docs/development/mcp-tooling.md` now describe the four-pattern Bash
  allowlist and the denied bypass shapes coherently.

## Verification

No broad suite was run during this follow-up review. I inspected the relevant
plan, source, README, and MCP tooling docs. The user reported `pnpm test`
clean: 238 passed, 1 skipped, 0 failed.
