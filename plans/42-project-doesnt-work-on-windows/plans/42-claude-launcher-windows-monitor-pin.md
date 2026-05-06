# Fix Claude Launcher Monitor Pin On Windows

Branch: `42-project-doesnt-work-on-windows`
Plan Slug: `42-claude-launcher-windows-monitor-pin`
Parent Issue: #42
Created: 2026-05-06
Updated: 2026-05-06 (after plan review)
Status: implemented (T1–T4, T6, T7 — T5 manual Windows smoke pending operator)

## Context

### Issue Summary

Issue #42 ("project doesnt work on windows", opened by ralphkrauss, no
comments) shows `agent-orchestrator claude` failing immediately after
install on Windows 10 (cmd.exe, Node 24.11.1, npm-global install at
`C:\Users\ralph\AppData\Roaming\npm\node_modules\@ralphkrauss\agent-orchestrator\dist\cli.js`).

The thrown error originates in
`dist/claude/monitorPin.js` ->
`assertMonitorPathIsSupported` and reports:

> AGENT_ORCHESTRATOR_BIN contains a character that the Claude supervisor's
> Bash deny list would shadow even after POSIX quoting (forbidden: single
> quote, ;, &, |, <, >, $, \`, \\, CR, LF). Reinstall agent-orchestrator
> (and node, if needed) at a path that uses only shell-safe characters.

Cause: `resolveMonitorPin()` in `src/claude/monitorPin.ts` rejects any
absolute path that contains a backslash, because the supervisor settings
deny `Bash(*\\*)` and POSIX single-quote quoting of a literal backslash
would still produce a token that matches that deny pattern. Every
absolute Windows path contains backslashes, so on Windows every install
fails the check and the Claude launcher cannot start.

Issue #2 ("Add windows support") was previously closed and added
cross-platform daemon IPC, process termination, diagnostics, and run
store handling. The Claude supervisor surface (added later in
#13/#27) was not updated for Windows path shapes; #42 is the
follow-up specifically for the Claude launcher's monitor pin.

### Context Sources Read

- `AGENTS.md`: keep public package behavior stable; pnpm scripts; add
  focused tests when daemon/backend/MCP/release behavior changes; record
  build/test evidence; do not commit/install/publish without explicit
  permission.
- `.agents/rules/node-typescript.md`: Node 22+ compatibility, prefer
  built-ins, do not loosen TypeScript strictness, update schemas/docs/tests
  for MCP contract changes, verify both human-readable and JSON CLI
  outputs.
- `.agents/rules/ai-workspace-projections.md`: only relevant if `.agents/`
  files change; no projection edits are planned.
- `.agents/rules/mcp-tool-configs.md`: only relevant if MCP config or
  secret behavior changes; no such changes are planned.
- `plans/2-add-windows-support/plans/2-add-windows-support.md`: prior
  Windows plan; introduced platform branches in `daemon/paths.ts`,
  `processManager.ts`, `diagnostics.ts`, `runStore.ts`, and tests; uses
  the pattern of an optional `platform` parameter for deterministic
  unit tests.
- `src/claude/monitorPin.ts`: defines `resolveMonitorPin`,
  `quoteCommandTokens`, `assertMonitorPathIsSupported`,
  `FORBIDDEN_MONITOR_PATH_CHARACTERS = /[;&|<>$\`\\\r\n']/`. Imports
  `isAbsolute` from `node:path` (host-platform), which interprets a
  Linux test runner's `process.platform === 'linux'` and therefore does
  not treat `C:\Users\...` as absolute on Linux test hosts.
- `src/claude/launcher.ts`: calls `resolveMonitorPin(env)` from
  `buildClaudeEnvelope` to produce `command_prefix_string`,
  `monitor_command_patterns`, and `monitor_bash_allow_patterns`. These
  feed `buildClaudeHarnessConfig`, the supervisor system prompt, the
  generated `settings.json` Bash allow list, and
  `buildClaudeAllowedToolsList`.
- `src/claude/config.ts`: `assertMonitorPermissionInvariant` builds two
  probe monitor commands using `buildMonitorBashCommand` and asserts
  they match the generated supervisor allow patterns; this is the
  invariant that backslash paths would also break.
- `src/claude/permission.ts` (referenced): Bash deny entries include
  `Bash(*;*)`, `Bash(*&*)`, `Bash(*|*)`, `Bash(*<*)`, `Bash(*>*)`,
  `Bash(*$*)`, `Bash(*\`*)`, `Bash(*\\*)`. Backslash deny is the one
  that interacts with Windows install paths.
- `src/__tests__/claudeHarness.test.ts`: uses POSIX-shaped paths (e.g.
  `/opt/agent-orchestrator`) and explicit unsafe-path assertions. New
  Windows-branch tests will live in a focused
  `src/__tests__/monitorPin.test.ts` (reviewer preference).
- `src/processManager.ts`, `src/daemon/paths.ts`, `src/diagnostics.ts`,
  `src/runStore.ts`, `src/backend/common.ts`,
  `src/auth/userSecrets.ts`: existing Windows branches use
  `process.platform === 'win32'` and accept a `platform` override
  parameter for tests. This plan follows the same pattern.
- `src/claude/discovery.ts` and `spawnClaude()` in `src/claude/launcher.ts`:
  use raw `spawn()` paths and are not affected by the monitor-pin
  shape, but the Windows manual smoke covers them end-to-end so the
  fix exercises the actual launch flow, not just `--print-config`.
- `README.md` and `docs/development/mcp-tooling.md`: claim cross-platform
  daemon support after #2; do not currently call out the Claude
  launcher's Windows shell prerequisite or monitor-pin character
  constraints.

No code changes have been made yet on this branch.

## Confirmed Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Scope | Fix the Claude launcher path-shape failure on Windows by normalizing `bin` and `nodePath` to forward slashes for monitor-pin generation when running on `win32`. Keep all other Windows surfaces (daemon IPC, process termination, diagnostics, runStore, backend resolution, auth secrets) unchanged. | Issue #42 reports a single, specific Windows blocker in the Claude launcher; the rest of the package was made cross-platform under #2. The minimal fix unblocks Windows users without touching unrelated Windows code paths or the Bash deny model. | Broad Windows audit; rewrite of supervisor permission model; switching transports. |
| 2 | Normalization strategy | In `resolveMonitorPin`, after resolving `bin` and `nodePath`, replace `\` with `/` only when the resolved platform is `win32`. Keep the existing `assertMonitorPathIsSupported` regex unchanged so any remaining backslash on POSIX still fails fast. | Node, npm shims, and Git Bash on Windows accept absolute paths with forward slashes (e.g. `C:/Users/ralph/.../cli.js`, `C:/Program Files/nodejs/node.exe`). The deny list `Bash(*\\*)` then never fires because the emitted command never contains a literal backslash. POSIX-quoting still wraps tokens with spaces or parentheses (`Program Files`) using single quotes, which are not in the deny list. | Removing or weakening `Bash(*\\*)`; using 8.3 short paths (still backslash-bearing); rewriting paths to bare `node` (loses pinning of the running interpreter). |
| 3 | Platform plumbing | Accept an optional second argument on `resolveMonitorPin` shaped as an options object `{ platform?: NodeJS.Platform; nodePath?: string }`, with `platform` defaulting to `process.platform` and `nodePath` defaulting to `process.execPath` (see decision #9). Tests use the options-object call shape `resolveMonitorPin(env, { platform, nodePath })` to drive both branches deterministically without cross-compiling. Existing production callers (`launcher.ts`, `config.ts`, `claudeHarness.test.ts`) keep calling with the env-only signature; the options object is fully optional and additive. | Mirrors the existing pattern in `getBackendStatus`, `daemonIpcEndpoint`, `ensureSecureRoot`, `prepareWorkerSpawn`, and `terminateProcessTree`. Options-object shape (rather than positional `platform, nodePath`) keeps the call site readable and allows adding further test-only overrides later without breaking signatures. Lets `pnpm test` validate both POSIX and Windows behavior on a Linux runner. | Spying on `process.platform`; adding a global mutable shim; positional overrides that mix env and platform values at the call site. |
| 4 | Platform-aware absoluteness | The `platform` override must drive both slash normalization **and** the absoluteness check. The implementation uses `path.win32.isAbsolute` when `platform === 'win32'` and `path.posix.isAbsolute` (or the existing host `isAbsolute` re-exported from `node:path` when running on POSIX) otherwise. Without this, deterministic Linux tests for the Windows branch silently fall back to `packageCliPath()` because the host-`isAbsolute` does not recognize `C:\...`, masking real production behavior. | Reviewer-flagged correctness gap. The normalization-only fix in the prior draft was insufficient because path absoluteness selection is also platform-sensitive. | Keeping host `isAbsolute` and accepting that Linux tests do not exercise the Windows branch faithfully. |
| 5 | UNC path handling | Reject UNC paths (paths whose pre-normalization form starts with `\\` on Windows, or post-normalization form starts with `//`) with a dedicated, clear error distinct from the forbidden-character error. Mapped network drives (`Z:\...`) are treated as normal drive-letter paths and supported. | UNC validation is correctness-preserving and avoids silently shipping a Bash pattern shape that has not been verified end-to-end. The npm install layout in #42 is never UNC, so this scope cut does not block the reported failure. | Best-effort UNC conversion to `//server/share/...`; pretending UNC works. |
| 6 | `AGENT_ORCHESTRATOR_BIN` semantics on Windows | Keep accepting both backslash and forward-slash absolute paths from the environment. Apply the same forward-slash normalization to `AGENT_ORCHESTRATOR_BIN` as to the package-derived path before validation, so users who set the variable from cmd.exe (where `\` is normal) see the same successful behavior. The platform-aware `isAbsolute` selection (decision #4) governs whether the env value is treated as absolute. | Operators commonly set this variable from cmd or PowerShell where backslashes are natural. The variable value is operator-controlled and not user content, so normalization is acceptable. | Demanding forward-slash-only env values; documenting a foot-gun without fixing it. |
| 7 | Public surface | No MCP contract change. No CLI surface change. The error message produced by `assertMonitorPathIsSupported` gains a Windows-only branch that mentions backslash auto-normalization; the POSIX message is preserved byte-for-byte. UNC rejection produces a separate dedicated error. | The fix is path-shape internal to the harness envelope generation. Preserving the POSIX error verbatim avoids any churn for existing operators. | Adding new flags or env variables; rewriting the POSIX message. |
| 8 | Test placement and strategy | Add a focused new file `src/__tests__/monitorPin.test.ts`. `claudeHarness.test.ts` is already broad and keeps its existing harness/config tests. Add at most one assertion in `claudeHarness.test.ts` that proves the `assertMonitorPermissionInvariant` invariant still holds when `monitorPin` is constructed under `platform: 'win32'`, so the integration boundary is exercised. | Reviewer preference. Keeps the new unit coverage co-located with the function under test and avoids further bloat in the harness suite. | Stuffing all new cases into `claudeHarness.test.ts`. |
| 9 | `process.execPath` injection for tests | Carry a `nodePath?: string` field inside the same options object introduced in decision #3 (`resolveMonitorPin(env, { platform, nodePath })`), defaulting to `process.execPath`. Production callers do not pass it; tests do, so they can drive `nodePath = 'C:\\Program Files\\nodejs\\node.exe'` from a Linux runner. | Keeps production behavior identical and avoids monkey-patching `process.execPath`. Co-locating with `platform` in one options object keeps test call sites self-explanatory. | Mocking `process`; refactoring callers; a separate fourth positional parameter. |
| 10 | Windows shell prerequisite (behavior invariant) | Windows Claude orchestration requires **Git Bash** (i.e. an MSYS-flavored bash interpreter discoverable to Claude Code). Claude Code on Windows uses Git Bash for the `Bash` tool when present and falls back to PowerShell otherwise; this harness pins the `Bash` tool via `--tools Read,Glob,Grep,Bash,Skill`, so PowerShell-only Claude Code installs are explicitly **out of scope** for `agent-orchestrator claude`. The `agent-orchestrator claude` UX and docs treat Git Bash as a hard prerequisite for Windows. | Reviewer-confirmed answer to Q1. The harness depends on Bash-shaped permission rules and Bash-shaped monitor commands; without Git Bash, the supervisor's allow/deny list does not apply correctly. Documenting Git Bash as a prerequisite makes the constraint explicit instead of implicit. | Attempting to support PowerShell as a fallback; silently relying on the user happening to have Git Bash installed. |
| 11 | Windows manual smoke surface | The Windows manual smoke (T5) must exercise both `agent-orchestrator claude --print-config` (proves monitor-pin generation) **and** `agent-orchestrator claude` with a real worker run started, monitored with `--json-line`, and cancelled (proves `discoverClaudeSurface()`, `spawnClaude()`, and the Bash monitor command actually function inside the Windows Claude Code process). | Reviewer-confirmed answer to Q6. `discovery.ts` and `spawnClaude()` use raw `spawn()` paths the unit tests do not cover; only the manual smoke verifies they work on Windows. | Smoking only `--print-config`. |
| 12 | Windows CI | Do **not** add a Windows CI runner in this plan. Windows CI is a separate follow-up and is excluded unless the human explicitly scopes workflow changes in. | Reviewer-confirmed answer to Q5. Manual smoke from the issue reporter (or another Windows operator) is sufficient verification for #42, matches the deferral in #2, and avoids touching `.github/workflows/`. | Bundling a Windows CI job into this fix. |

## Assumptions

These are residual assumptions after the reviewer's answers were
incorporated. They are technical claims that hold given documented
behavior of Node and the supervisor permission model.

- Node on Windows treats forward-slash absolute paths as equivalent to
  backslash absolute paths for `require`/`import`/script-arg
  resolution. Documented Node behavior; `path.win32` and `path.posix`
  already coexist in `daemon/paths.ts` for related purposes.
- Git Bash, when launched by Claude Code on Windows, accepts
  `C:/Program Files/nodejs/node.exe` and `C:/Users/ralph/.../cli.js`
  via MSYS path translation. (Plan-level invariant; verified end-to-end
  by the manual smoke in T5.)
- The supervisor's Bash deny list (`Bash(*\\*)`, etc.) remains as-is.
  The fix avoids backslashes by construction rather than by changing
  deny rules.
- `process.execPath` on Windows is typically
  `C:\Program Files\nodejs\node.exe` or
  `C:\Program Files (x86)\nodejs\node.exe`. After `\` -> `/` it becomes
  `C:/Program Files/nodejs/node.exe` (or with `(x86)`), both of which
  are POSIX-quote-safe (single-quoted whole token; deny list does not
  cover space or parentheses).
- Issue #42's reported install path
  (`C:\Users\ralph\AppData\Roaming\npm\...`) is a normal drive-letter
  path. After `\` -> `/` it becomes `C:/Users/ralph/AppData/Roaming/npm/...`,
  which contains only characters from the unquoted-safe set plus `:`.
  `:` is already in the unquoted-safe set used by `quoteToken`.

## Reviewer Questions

`none` — all six original questions were answered in the plan review.
Their resolutions are recorded above as confirmed decisions or
assumptions: Q1 -> decision #10, Q2 -> decision #5, Q3 -> decision #8,
Q4 -> decision #7, Q5 -> decision #12, Q6 -> decision #11.

## Open Human Decisions

`none` — no remaining product, scope, or policy questions for the
human. The reviewer resolved all open questions; remaining items are
implementation correctness (handled by the task list) and verification
(handled by T5).

## Human Approval Triggers

- **Bash deny list weakening**: Any change that removes or weakens
  `Bash(*\\*)`, `Bash(*;*)`, `Bash(*&*)`, etc. The current fix does NOT
  weaken these — it makes the emitted command never contain those
  characters on Windows. If implementation discovers this is
  insufficient and the deny list must change, halt and ask.
- **Public CLI/MCP contract change**: Adding new flags, env vars, or
  changing existing tool schemas is out of scope. The optional
  `platform` and `nodePath` parameters on `resolveMonitorPin` are
  test-internal and undocumented; if any of them needs to become a
  public flag or env var, halt and ask.
- **New runtime dependencies**: AGENTS.md and
  `.agents/rules/node-typescript.md` require asking before adding
  dependencies. None are anticipated.
- **CI workflow changes**: Adding a Windows runner to GitHub Actions
  changes the release-quality surface. Decision #12 excludes it from
  this plan; halt and ask before editing `.github/workflows/`.
- **Release / publish behavior**: Out of scope. No version bump or
  dist-tag change.
- **PowerShell support for Windows Claude orchestration**: Decision
  #10 declares Git Bash a hard prerequisite. Any work that attempts
  PowerShell-only support is out of scope; halt and ask before
  expanding.

## Scope

### In Scope

- `src/claude/monitorPin.ts`: add Windows-aware path normalization and
  platform-aware absoluteness selection to `resolveMonitorPin`; accept
  an optional `{ platform?, nodePath? }` options object as a second
  argument for testability (call shape
  `resolveMonitorPin(env, { platform, nodePath })`); refine the
  `assertMonitorPathIsSupported` error message to mention Windows
  normalization on the `win32` branch only; reject UNC paths with a
  dedicated error.
- `src/__tests__/monitorPin.test.ts` (new): focused unit tests for
  `resolveMonitorPin` and `assertMonitorPathIsSupported` covering both
  POSIX and Windows branches, including the issue-reported
  Windows install path, the `Program Files` `nodePath`, UNC
  rejection, post-normalization forbidden-character rejection, and
  unchanged POSIX behavior.
- `src/__tests__/claudeHarness.test.ts`: add at most one assertion
  proving `assertMonitorPermissionInvariant` (via
  `buildClaudeHarnessConfig`) succeeds when `monitorPin` is built
  under `platform: 'win32'`. No other changes.
- `README.md`: short Windows note in the existing cross-platform
  section stating (a) Git Bash is required for `agent-orchestrator
  claude` on Windows and (b) the supervisor uses forward-slash paths
  internally on Windows. Keep it factual.
- `docs/development/mcp-tooling.md`: only update if it currently
  states POSIX-only assumptions about supervisor commands; otherwise
  no change.

### Out Of Scope

- Adding a Windows CI runner (decision #12).
- Changing the Bash deny list (decision #2).
- Changing supervisor settings (`permission.ts`) beyond what is
  required for the fix (no changes anticipated).
- Touching `processManager.ts`, `daemon/paths.ts`, `runStore.ts`,
  `diagnostics.ts`, `backend/common.ts`, or `auth/userSecrets.ts`.
- Renaming or removing `posix_supported` or any other diagnostic
  field.
- Codex / OpenCode / Cursor backend Windows behavior. Each has its
  own resolution path; they are unaffected by this fix.
- Worker-side path handling. Workers run as their own processes and
  do not run inside the supervisor Bash allowlist.
- PowerShell-only Claude Code support (decision #10).
- UNC-path support (decision #5).
- Publishing, tagging, dist-tag, or release automation.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | Windows operator does not have Git Bash installed; Claude Code falls back to PowerShell; supervisor Bash patterns do not behave as expected. | Document Git Bash as a hard prerequisite (decision #10). Manual smoke (T5) is run with Git Bash. README explicitly calls this out. PowerShell-only support is out of scope (Human Approval Trigger). | Docs update; manual smoke. |
| 2 | UNC install path slips through. | Add explicit UNC rejection (decision #5) with a dedicated error message and assert it in tests. | New unit test. |
| 3 | A drive-letter path with embedded forbidden char (e.g. `C:\Users\Ralph;Foo\...`) survives normalization and reaches the supervisor. | Keep `assertMonitorPathIsSupported` regex; backslash drops out of forbidden set on the Windows branch but `;`, `&`, `$`, etc. remain. Test with such a synthetic path. | New unit test. |
| 4 | Linux tests for the Windows branch silently take the POSIX branch because host `isAbsolute` does not match `C:\...`. | Decision #4: select `isAbsolute` from `path.win32` or `path.posix` based on the resolved platform. Add a regression test that asserts a Windows-shaped `AGENT_ORCHESTRATOR_BIN` is honored under `platform: 'win32'` (i.e. the env value is used and not silently replaced by `packageCliPath()`). | New unit test. |
| 5 | `process.execPath` returns a non-canonical or short-name (`C:\PROGRA~1\nodejs\node.exe`). | Tilde and `~` are in the unquoted-safe set; otherwise the path is single-quoted as a whole. No special handling needed. | Unit test with `nodePath` override. |
| 6 | POSIX behavior regresses. | Keep `process.platform === 'win32'` gate; existing POSIX tests unchanged; add an explicit assertion that POSIX-shaped inputs continue to fail on `\` and succeed on plain absolute paths. | Existing + new POSIX tests. |
| 7 | Generated supervisor system prompt embeds a literal forward-slash Windows path (`C:/Users/...`) that surprises POSIX-trained reviewers reading transcripts. | Documented in README/Windows note; system prompt remains a faithful echo of the actual command shape. | Docs update. |
| 8 | `assertMonitorPermissionInvariant` in `config.ts` constructs probe commands and asserts they match the deny/allow rules. After normalization the forward-slash form must continue to satisfy this invariant on Windows. | Test in `claudeHarness.test.ts` that exercises `buildClaudeHarnessConfig` with `monitorPin` produced under `platform: 'win32'` and asserts no exception is thrown (decision #8). | New unit assertion. |
| 9 | Operators set `AGENT_ORCHESTRATOR_BIN` to a forward-slash-only Windows path like `C:/path/cli.js` (already shell-safe). | Normalization is idempotent (`replaceAll('\\', '/')`); existing forward-slash input is unchanged. Platform-aware `isAbsolute` accepts both forms on `win32`. | Unit test. |
| 10 | `node.exe` invoked with forward-slash script path on Windows fails to find the script for some installer layouts. | Documented Node behavior is to accept `/`. Re-confirmed by the Windows smoke (T5). | Manual Windows smoke. |
| 11 | `discoverClaudeSurface()` or `spawnClaude()` exhibits a Windows-specific failure unrelated to the monitor pin (e.g. shim resolution, `.cmd` handling) that blocks the launcher even after the fix. | Manual smoke (T5, decision #11) covers the full launch flow, not just `--print-config`. Any newly observed Windows blocker becomes a follow-up issue rather than scope-creeping into this plan. | Manual smoke. |
| 12 | A future Windows path uses a character outside the existing forbidden set but still trips Bash on Windows (e.g. `%`, `^`). | Out of scope for #42. Document as "open follow-up if observed" rather than expanding the regex preemptively. | Docs note. |

## Implementation Tasks

| Task ID | Title | Depends On | Acceptance Criteria |
|---|---|---|---|
| T1 | Make `resolveMonitorPin` platform-aware | none | `resolveMonitorPin` accepts an optional second argument shaped as an options object `{ platform?: NodeJS.Platform; nodePath?: string }`, with `platform` defaulting to `process.platform` and `nodePath` defaulting to `process.execPath`. The call shape used by tests is `resolveMonitorPin(env, { platform, nodePath })`. The function (a) selects `path.win32.isAbsolute` for `platform === 'win32'` and `path.posix.isAbsolute` (or the host `node:path` `isAbsolute`) otherwise, so an explicit `AGENT_ORCHESTRATOR_BIN` like `C:\Users\ralph\...\cli.js` is treated as absolute under `platform: 'win32'` even on a Linux test runner; (b) when `platform === 'win32'`, replaces `\` with `/` in resolved `bin` and `nodePath` before validation; (c) rejects UNC paths (pre- or post-normalization beginning with `\\` or `//` on the Windows branch) with a dedicated error message distinct from the forbidden-character error; (d) leaves the POSIX branch byte-for-byte unchanged (resulting `command_prefix`, `command_prefix_string`, `monitor_command_patterns`, `monitor_bash_allow_patterns` are identical for any input that previously succeeded). |
| T2 | Refine `assertMonitorPathIsSupported` error message | T1 | When `platform === 'win32'`, the error mentions that backslashes are auto-normalized and the remaining forbidden characters apply; on POSIX the existing message is preserved verbatim (string-equality assertion in tests). The function still rejects single-quote, `;`, `&`, `|`, `<`, `>`, `$`, backtick, `\` (POSIX only — backslash is normalized away on Windows before the regex check), CR, and LF. UNC rejection (T1) is its own dedicated error and does not reuse this message. |
| T3 | Add focused `monitorPin.test.ts` | T1, T2 | New file `src/__tests__/monitorPin.test.ts` covers: (a) `resolveMonitorPin({ AGENT_ORCHESTRATOR_BIN: 'C:\\Users\\ralph\\AppData\\Roaming\\npm\\node_modules\\@ralphkrauss\\agent-orchestrator\\dist\\cli.js' }, { platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe' })` succeeds and the env-supplied bin is used (regression test for the platform-aware `isAbsolute` from decision #4); (b) emitted patterns contain `'C:/Program Files/nodejs/node.exe'` (single-quoted because of the space) and unquoted forward-slash `cli.js` path (no special chars); (c) emitted patterns contain no `\`; (d) `\\\\server\\share\\cli.js` rejected with the dedicated UNC error; (e) Windows path with embedded `;` rejected with the Windows-aware forbidden-character message; (f) POSIX `/opt/agent-orchestrator/cli.js` test continues to succeed and produces unchanged output bytes vs. the existing `claudeHarness.test.ts` expectations; (g) POSIX path containing `\` continues to be rejected with the existing POSIX message verbatim. |
| T4 | Add one harness/config integration assertion | T1, T2, T3 | In `src/__tests__/claudeHarness.test.ts`, add a single test that calls `buildClaudeHarnessConfig` with `monitorPin = resolveMonitorPin({ AGENT_ORCHESTRATOR_BIN: 'C:\\Users\\ralph\\...\\cli.js' }, { platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe' })` and asserts `assertMonitorPermissionInvariant` does not throw. No other changes to the file. |
| T5 | Manual Windows smoke (issue reporter or maintainer) | T1, T2, T3, T4 | On a Windows host with **Git Bash installed** and the same install layout reported in #42: (a) `agent-orchestrator claude --print-config` runs to completion and the printed `command_prefix_string` and `monitor_command_patterns` use forward slashes; (b) `agent-orchestrator claude` launches Claude Code without throwing; (c) a trivial worker run started via `start_run` is monitored end-to-end via the pinned `--json-line` Bash command; (d) cancellation works. Smoke transcript or log excerpts attached to the PR. If Git Bash is not available, the smoke is allowed to fail at step (b) and the failure is captured as evidence that the Git Bash prerequisite (decision #10) is necessary. |
| T6 | Documentation updates | T1, T2 | README's Windows section (added in #2) gains a brief note that (i) `agent-orchestrator claude` on Windows requires Git Bash and (ii) the supervisor's monitor command is generated with forward-slash paths on Windows. `docs/development/mcp-tooling.md` is reviewed; updated only if it asserts POSIX-only supervisor behavior. No public flag/env documentation is added. |
| T7 | Quality gates | T1–T6 | Record `pnpm build`, `pnpm test`, and (if reviewer scopes it in) `pnpm verify` outputs in the implementation log. Confirm `git diff --check` passes and that no `.agents/`, MCP config, secret, hook, or external-service files were modified outside this plan's scope. |

## Acceptance Criteria

- A Windows operator with **Git Bash installed** and `agent-orchestrator`
  installed at `C:\Users\<name>\AppData\Roaming\npm\node_modules\@ralphkrauss\agent-orchestrator\...`
  can run `agent-orchestrator claude` from cmd.exe (or PowerShell or
  Git Bash) and the command no longer throws from
  `assertMonitorPathIsSupported`.
- The generated supervisor `settings.json` `permissions.allow` array
  on Windows contains forward-slash-only Bash patterns and matches
  the actual monitor commands produced by `buildMonitorBashCommand`.
- UNC install paths are rejected with a clear, dedicated error
  message before any monitor pattern is generated.
- `pnpm test` passes on Linux with the new Windows-branch unit tests
  in `src/__tests__/monitorPin.test.ts` and the new harness/config
  integration assertion.
- POSIX behavior of `resolveMonitorPin` and the supervisor settings is
  unchanged byte-for-byte for any input that succeeded before, and
  the POSIX `assertMonitorPathIsSupported` error message is unchanged
  byte-for-byte.
- README documents (i) Git Bash as a hard prerequisite for
  `agent-orchestrator claude` on Windows and (ii) the Windows
  monitor-pin forward-slash behavior, in one or two sentences each.
- No changes to MCP tool schemas, CLI flags, or env variable surface
  (beyond the new test-only `platform` and `nodePath` overrides on
  `resolveMonitorPin`, which are undocumented).

## Quality Gates

- [ ] `pnpm build` passes.
- [ ] `pnpm test` passes (existing tests + new
      `monitorPin.test.ts` + new harness/config assertion).
- [ ] `pnpm verify` passes, or any failure is recorded with concrete
      output and an explicit follow-up.
- [ ] Manual Windows smoke recorded (T5) per decision #11. Without
      Git Bash present, smoke is allowed to fail at the launch step
      with that captured as evidence of the Git Bash prerequisite.
- [ ] `git diff --check` passes.
- [ ] `.agents/rules/node-typescript.md` checks satisfied: no new
      dependencies, Node 22 compatibility preserved, TypeScript
      strictness intact, MCP contract unchanged.
- [ ] No commits, pushes, secrets, hooks, dependency installs, or
      external-service writes have been performed without explicit
      user approval.

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | Cross-platform path generation that flows into shell-pattern allowlists must be normalized at the producer (e.g. forward slashes on Windows) rather than at the consumer (allowlist regex), and any platform override accepted for tests must drive both `isAbsolute` selection and slash normalization. | Future supervisor / launcher / harness path-generation work. | Only if a second instance of the same pattern emerges; one fix in `monitorPin.ts` is not enough to justify a repo-wide rule. |

## Implementation Evidence

| Task | Status | Evidence |
|---|---|---|
| T1 | done | `src/claude/monitorPin.ts`: added `ResolveMonitorPinOptions` (`platform`, `nodePath`); `resolveMonitorPin(env, options)` selects `path.win32.isAbsolute` vs `path.posix.isAbsolute` based on `platform`; on `win32` normalizes `\\` → `/` and then calls `assertMonitorPathIsNotUnc` against the **post-normalization** form so mixed-separator UNC inputs (e.g. `\/server/share/...` or `/\server/share/...`) are caught alongside the canonical `\\server\share\...` and `//server/share/...` forms before `assertMonitorPathIsSupported`. |
| T2 | done | `src/claude/monitorPin.ts`: `assertMonitorPathIsSupported` accepts an `AssertMonitorPathOptions` `{ platform? }` arg. POSIX branch keeps the original message byte-for-byte; the `platform === 'win32'` branch adds a single sentence "On Windows, backslashes in this path are auto-normalized to forward slashes before this check; the remaining forbidden characters still apply." UNC rejection lives in a new `assertMonitorPathIsNotUnc` with a dedicated message. |
| T3 | done | `src/__tests__/monitorPin.test.ts` (new, 10 tests): platform-aware `isAbsolute` regression, forward-slash Bash allow patterns for the issue-reported install layout, dedicated UNC error for both `bin` and `nodePath` in canonical `\\\\...` form, **mixed-separator UNC `bin` and `nodePath` (`\/...` and `/\...`) that only become `//...` after normalization** (regression lock for the post-normalization UNC check), Windows-aware forbidden-character message, POSIX absolute success, POSIX backslash rejection (verbatim message), and explicit byte-exact POSIX-message lock for the assert function. |
| T4 | done | `src/__tests__/claudeHarness.test.ts`: single new assertion in the `Claude harness config builder` suite proving `buildClaudeHarnessConfig` (which runs `assertMonitorPermissionInvariant` internally) does not throw when `monitorPin` is built under `platform: 'win32'`. |
| T5 | pending | Manual Windows smoke is owned by the issue reporter or another Windows operator with Git Bash installed (per decision #11). Not runnable on the Linux implementation host. |
| T6 | done | `README.md`: added a short Windows note under the cross-platform paragraph: Git Bash hard prerequisite for `agent-orchestrator claude`, supervisor monitor pin emits forward-slash paths on Windows. `docs/development/mcp-tooling.md` reviewed; no POSIX-only assertions found that needed updating. |
| T7 | done (with caveat) | See verification log below. `pnpm build` and `pnpm test` pass. `pnpm verify` fails only on the pre-existing `pnpm audit --prod` advisory for the transitive `ip-address` package via `@modelcontextprotocol/sdk` → `express-rate-limit`; reproduced on the base commit `cf50a6f` without these changes, so unrelated. |

### Verification Log

- `pnpm install --frozen-lockfile`: succeeded.
- `pnpm build`: succeeded (tsc clean) on both passes.
- `node --test dist/__tests__/monitorPin.test.js`: 10/10 pass after the post-normalization-UNC follow-up (was 8/8 on the first pass; +2 tests for mixed-separator UNC `bin` and `nodePath`).
- `node --test dist/__tests__/claudeHarness.test.js`: 29/29 pass (includes the T4 invariant assertion under `platform: 'win32'`).
- `pnpm test`: 335 pass, 1 skipped, 0 fail across the repo suite (was 333 pass before the +2 mixed-separator UNC tests).
- `pnpm verify`: build + test + publish-ready + dist-tag resolve + npm pack dry-run all succeed; `pnpm audit --prod` reports a single moderate advisory `GHSA-v2v4-37r5-5v8g` against transitive `ip-address` (path `@modelcontextprotocol/sdk → express-rate-limit → ip-address`). Reproduced from `cf50a6f` with the working tree stashed, so it is pre-existing and unrelated to this fix.
- `git diff --check`: clean.

### Files Changed

- `src/claude/monitorPin.ts` (modified): platform-aware `resolveMonitorPin`, `AssertMonitorPathOptions`, `assertMonitorPathIsNotUnc`.
- `src/__tests__/monitorPin.test.ts` (new): 10 focused unit tests.
- `src/__tests__/claudeHarness.test.ts` (modified): one new `assertMonitorPermissionInvariant` integration assertion under `platform: 'win32'`.
- `README.md` (modified): one Windows note (Git Bash prereq + forward-slash supervisor paths).
- `plans/42-project-doesnt-work-on-windows/plans/42-claude-launcher-windows-monitor-pin.md` (this file): status, evidence section.

### Residual Risks / Open Items

- T5 manual Windows smoke is the only remaining quality gate. It must be run on a Windows host with Git Bash installed against the issue-reported install layout before the fix can be considered fully verified.
- The pre-existing `ip-address` audit advisory blocks `pnpm verify` end-to-end. It is independent of this change and should be tracked separately.
- No public surface changed: the `options` argument on `resolveMonitorPin` and `assertMonitorPathIsSupported` is undocumented and additive. MCP, CLI, env, dependency, lockfile, and Bash deny-list surfaces are untouched.
