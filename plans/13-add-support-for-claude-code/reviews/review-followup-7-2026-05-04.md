# Review Follow-up 7 - 2026-05-04

Scope: uncommitted changes after the review-followup-6 fixes.

## Findings

### P2 - POSIX-quoted monitor paths can still be denied by the Bash deny list

`src/claude/monitorPin.ts` now quotes command tokens and the tests cover a CLI
path with a single quote. The generated command for `/opt/o'q/cli.js` contains
the standard POSIX escape sequence `'\''`, which includes a backslash. The
settings still include the defense-in-depth deny rule `Bash(*\\*)` in
`src/claude/permission.ts`. Because Claude permissions are deny-precedence in
practice, the pinned monitor allow pattern for a path containing a single quote
can be shadowed by the backslash deny. The same general issue applies to other
quoted path characters that are also denied by raw string patterns, such as a
semicolon in a quoted path matching `Bash(*;*)`.

Either narrow the claimed support to spaces/parentheses only and remove the
single-quote/metacharacter test/doc language, or change the allow/deny design so
the pinned monitor path remains runnable when its POSIX-quoted representation
contains characters that the generic Bash deny list blocks for ordinary
commands.

### P3 - CCS-17 current evidence still says `--debug-file` and `--bare` are allowed

`plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:634`
describes CCS-17 as current evidence and still lists `--debug-file` and
`--bare` under allowed passthrough flags. The actual code rejects both:
`src/claude/passthrough.ts` has `--bare` in `FORBIDDEN_FLAGS`, and
`src/__tests__/claudeHarness.test.ts` asserts both `--debug-file` forms are
rejected.

Later historical follow-up sections correctly describe those fixes, but this
current evidence line should be brought in sync so future workers do not infer
the old passthrough contract.

## Verification

Review only. I checked the prior review findings, searched current docs for the
old broad monitor pattern, inspected the changed code paths, and ran
`git diff --check`. I did not rerun the full test suite.
