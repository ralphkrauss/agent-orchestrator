# Follow-up Review: Uncommitted Changes

Date: 2026-05-04
Scope: `git diff HEAD`, focused on the four prior findings and their fixes.

## Findings

### P1: Claude Bash is still not enforceably read-only

The expanded Bash deny list closes many obvious write paths, but the model still
gets a generic `Bash` tool surface and enforcement remains a deny list. That is
not enough for a read-only shell contract. Examples that are not covered by the
current patterns include:

- `git -C . add README.md` or `git --git-dir=.git add README.md`: mutating git
  with global options before the subcommand does not match `Bash(git add *)`.
- `command touch /tmp/x`, `command cp a b`, etc.: shell command dispatch via the
  POSIX `command` builtin does not match the denied first-token command names.

The fix needs a positive allowlist for the read-only commands the supervisor may
run, or generic Bash should be removed and the monitor should be the only Bash
permission. A larger deny list still leaves bypasses.

References:

- `src/claude/permission.ts:66`
- `src/claude/permission.ts:85`
- `src/claude/permission.ts:90`
- `src/claude/permission.ts:141`

### P2: The branch plan still contains old Claude supervisor behavior in later sections

The top of the plan was updated, but later evidence/open-question sections still
describe the old behavior: ephemeral envelope, `--setting-sources ""`,
`--disable-slash-commands`, generic Bash denied, and orchestrate-* only skill
loading. These are still loaded by branch context workflows and can steer future
workers back toward the wrong behavior.

References:

- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:468`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:507`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:542`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:612`
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md:745`

## Cleared Prior Findings

- The `upsert_worker_profile` arbitrary-path issue is addressed for Claude MCP
  sessions by pinning `AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE` in the
  generated MCP server entry and enforcing it in `src/serverPolicy.ts`.
- The new `just local ...` and `just agent-orchestrator ...` recipes no longer
  paste variadic arguments into shell source; `just --dry-run local 'status; echo
  SHOULD_NOT_RUN'` keeps the recipe body as `"$@"`.

## Verification

No broad suite was run during this review. I inspected the current diff, loaded
repo rules and plan context, and used `just --dry-run` for the local recipe
expansion check.

## Resolution (2026-05-04, post-followup)

- **P1 generic-Bash bypass** addressed in `src/claude/permission.ts`:
  - The `--allowed-tools` Bash allowlist now contains a positive set of safe
    inspection commands: the pinned monitor, `Bash(pwd)`, `Bash(git status)`,
    and `Bash(git status *)`. Anything else is not in the allow list and is
    denied by the deny-by-default permission mode rather than relying on the
    deny list to enumerate every escape route.
  - The deny list adds bypass-resistant entries for the patterns the reviewer
    cited and similar shapes: `Bash(git -C *)`, `Bash(git -c *)`,
    `Bash(git --git-dir*)`, `Bash(git --work-tree*)`, `Bash(git --no-pager *)`,
    `Bash(git --exec-path*)`, `Bash(git --namespace*)`, `Bash(command *)`,
    `Bash(*/command *)`, `Bash(builtin *)`, and `Bash(*\\*)` (backslash
    escapes such as `\touch`).
  - The supervisor system prompt is updated: it now enumerates the four
    allowed Bash patterns explicitly and tells the supervisor that `cat`,
    `ls`, `head`, `tail`, `grep`, `find`, `jq`, `git log`, `git diff`, etc.
    are denied — use Read/Glob/Grep/MCP instead.
  - `src/__tests__/claudeHarness.test.ts` asserts the new allowlist shape and
    the new bypass-resistance deny entries.
- **P2 stale plan evidence** addressed in
  `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md`:
  - A "Authoritative current state" banner was added at the start of the
    "## Execution Log" section so the historical CCS-* "completed
    (2026-05-03)" evidence is read as evolution history rather than as the
    current contract.
  - CCS-9, CCS-15, CCS-16, CCS-22, and the "Closed by 2026-05-03 / Isolation
    boundary / Permission/tool allowlist / Skill curation" bullets at the
    foot of the Open Questions section were rewritten to describe the
    current behavior (target-workspace cwd, daemon-owned
    `claude-supervisor/{home,envelopes/}` state, `--setting-sources user`,
    no `--disable-slash-commands`, no `--add-dir`, no `--bare`,
    `Read,Glob,Grep,Bash,Skill` built-in surface with the positive Bash
    allowlist + comprehensive deny list, redirected user skill mirror
    populated from the workspace `.claude/skills/`, MCP-entry pin of
    `AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE`).
  - "Reviewer Follow-up #2 (2026-05-03)" got a header note linking forward
    to the later follow-ups that supersede its no-Bash claim.
  - The 2026-05-04 "Bash retired, MCP wake path" amendment got a header note
    linking forward to this post-merge fix; readers no longer need to infer
    that it was reversed.
- `pnpm test` (full suite) ran clean: 238 passed, 1 skipped, 0 failed.
