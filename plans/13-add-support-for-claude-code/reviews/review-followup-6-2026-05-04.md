# Review Follow-up 6 - 2026-05-04

Scope: uncommitted changes after implementing the PR #29 resolution map.

## Findings

### P2 - Current docs still advertise the old broad monitor allow pattern

The implementation replaced the broad `Bash(<prefix> monitor *)` allow rule
with explicit monitor shapes, but several current-facing docs still describe
the old contract:

- `README.md:353` shows
  `Bash(<node> <cli> monitor *)` in the `--allowed-tools` example.
- `README.md:404` and `docs/development/mcp-tooling.md:141` still say the Bash
  allowlist contains exactly four patterns.
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:58-75`
  is explicitly marked as the current implementation note but still says the
  pinned monitor pattern is `Bash(<absolute-bin> monitor *)`.
- The same plan's current evidence at `CCS-19` still names
  `bash_allowlist_pattern` and `${process.execPath} ${bin} monitor *`.
- `src/monitorCli.ts:90` still says the monitor CLI is for non-Claude clients,
  while README now says the Claude supervisor uses it as the current-turn wake
  path.

These are not just historical notes; they are active operator and future-agent
guidance. They should be updated to say the allowlist is two explicit monitor
patterns plus `Bash(pwd)`, `Bash(git status)`, and `Bash(git status *)`, and to
remove the stale non-Claude-only monitor wording.

### P2 - Skill curation now silently drops orchestrate skills on unexpected I/O errors

`src/claude/skills.ts:74-86` catches every error from `open`, fd `stat`, and
`readFile` and returns `null`. That is correct for the symlink-swap case the
review asked about, but it also hides `EACCES`, `EPERM`, `EIO`, and other
unexpected failures. The launcher can then start with required `orchestrate-*`
skills missing from the curated snapshot and embedded prompt, with no diagnostic.

This should fail closed. Skip only expected disappearance/symlink/non-regular
cases such as `ENOENT`/`ELOOP` and `!info.isFile()`, and rethrow permission or
I/O failures so the harness does not launch with an incomplete orchestration
surface.

### P3 - IPC policy context sends the raw pin, not the resolved pin

The resolved human decision said the MCP frontend should pass the resolved
harness-pinned profiles path through IPC. `harnessPolicyContext()` currently
returns the raw `AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE` value, and the daemon
then resolves it against the request `cwd`.

The Claude harness normally writes an absolute pin, so this is unlikely to break
the main path. But relative pins are already supported by
`enforceWritableProfilesPolicy`, and this daemon-side path can disagree with the
frontend for relative pins. Resolve the pin in `harnessPolicyContext()` before
sending it, and add a test covering a relative pin with a request `cwd` that
differs from the frontend cwd.

## Verification

Review only. I inspected `git diff HEAD` and ran `git diff --check`; no full test
suite was rerun in this review pass.
