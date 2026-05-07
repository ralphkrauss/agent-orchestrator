# Claude Worker Bypass-Permissions Fix

Branch: `47-claude-workers-lose-bypass-permissions-under-generated-settings`
Plan Slug: `47-claude-worker-bypass-permissions`
Parent Issue: #47
Created: 2026-05-06
Status: complete

## Context

Claude-backed daemon worker runs fail in non-interactive workflows because the
generated per-run settings file `claude-worker-settings.json` only contains
`{ "disableAllHooks": true }`. Combined with `--setting-sources user`, this
causes Claude Code to start with `permissionMode: "default"` instead of
inheriting the user's configured bypass posture, so routine Bash calls such as
`gh pr list` return `This command requires approval` and the worker stalls.

Issue #47 verified empirically that adding
`permissions.defaultMode = "bypassPermissions"` plus
`skipDangerousModePermissionPrompt = true` to the worker settings body restores
`permissionMode: "bypassPermissions"` on init and unblocks the harness, with
both `0.2.1-beta.0` and `0.2.1` reproducing the broken state.

The chosen v1 worker isolation method (issue #40, Decisions 9 / 26) is the
per-run `--settings <path>` + `--setting-sources user` pair, with no
`CLAUDE_CONFIG_DIR` redirect. This plan extends that same envelope with the
permission posture, rather than introducing a new isolation surface, so the
existing T5 / T13 hook-isolation contract stays intact. The supervisor envelope
in `src/claude/launcher.ts` already passes both an in-settings `defaultMode`
and a `--permission-mode` CLI flag; the worker will follow the same parity
pattern with `bypassPermissions` rather than `dontAsk`.

### Sources read

- Issue #47 (body and acceptance criteria).
- `src/backend/claude.ts` — `CLAUDE_WORKER_SETTINGS_BODY`,
  `prepareWorkerIsolation`, `start`, `resume`.
- `src/backend/common.ts` — `BaseBackend`, `invocation`.
- `src/__tests__/claudeWorkerIsolation.test.ts` — existing T5 / T13 tests.
- `src/claude/launcher.ts:540-587` — supervisor `buildClaudeSpawnArgs`
  reference for the `defaultMode` + `--permission-mode` parity pattern.
- `src/claude/permission.ts:327-355` — supervisor settings shape reference.
- `plans/40-make-tmux-status-and-remote-control-reliable-for-claude-orchestrator-supervisors/plans/40-orchestrator-status-hooks.md`
  Decisions 9, 9b, 26, T5, T13.
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md`
  Decisions 7 / 21 — confirms `--dangerously-skip-permissions` is forbidden
  on the supervisor surface; this plan keeps that invariant for workers too.
- `AGENTS.md`, `CLAUDE.md`, `.agents/rules/node-typescript.md`.

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Worker permission mode | `bypassPermissions` | Mirrors the user's normal interactive Claude Code posture and is the only mode the issue verified end-to-end (Bash incl. `gh` works without approval). Hook isolation is independent and preserved. | `acceptEdits` (rejected: still prompts on Bash, does not fix the issue). `dontAsk` with explicit allow patterns (rejected: workers have no curated Bash allowlist today; would require a separate design). `--dangerously-skip-permissions` (rejected: explicitly forbidden across the harness per #13 Decisions 7 / 21). |
| 2 | Where to set the mode | Both: in-settings `permissions.defaultMode` plus `--permission-mode bypassPermissions` on the spawn argv. | Parity with the supervisor envelope (`buildClaudeSpawnArgs` sets both). Survives Claude Code version drift where the CLI flag may take precedence over file settings. | Settings-file only (rejected: brittle if CLI flag becomes authoritative, asymmetric with supervisor). CLI-flag only (rejected: leaves the on-disk worker contract underspecified and `skipDangerousModePermissionPrompt` still belongs in the file). |
| 3 | Add `skipDangerousModePermissionPrompt: true` to the settings body | Yes | Empirically required by issue #47 to suppress the dangerous-mode meta-prompt that otherwise blocks non-interactive runs that opt into `bypassPermissions`. | Omitting the flag (rejected: reproduces the original break). Conditional injection (rejected: workers are always non-interactive in v1; the flag is always correct). |
| 4 | Static vs profile-configurable | Static — hardcoded into the worker isolation body for v1, no profile knob. | All Claude worker invocations today are non-interactive daemon runs. A profile-level override has no caller, and adding one would expand the public profile schema and tests for no current benefit. Mirrors how `disableAllHooks: true` is hardcoded. | Per-profile permission mode (rejected: no caller, schema bloat, defers to a later plan if real demand emerges). Env-var override (rejected: invisible coupling, no caller). |
| 5 | Hook-isolation contract | Unchanged: `disableAllHooks: true` stays in the body; no `CLAUDE_CONFIG_DIR` redirect; `--setting-sources user` retained. | Issue #47 only changes the permission posture; Decisions 9 / 26 / T5 / T13 from #40 must keep holding. | Switching to Decision 9b's `CLAUDE_CONFIG_DIR` redirect (rejected: unrelated to this issue, broader blast radius). Removing `disableAllHooks` (rejected: violates T5 acceptance). |
| 6 | Legacy / direct-caller behavior | Unchanged: when `runId`/`store` are absent, `prepareWorkerIsolation` still emits zero isolation flags. | Required by the existing `claudeWorkerIsolation.test.ts` "omits worker isolation flags when no run id is supplied" case and by callers who construct `ClaudeBackend` without a store. The issue does not ask for behavior change here. | Always emitting `--permission-mode` even without a runId (rejected: would change a documented contract for non-daemon callers and is out of scope). |
| 7 | Test surface | Update `claudeWorkerIsolation.test.ts` for both `start()` and `resume()` to assert the new effective settings body and the new CLI argv pair, plus extend the user-hook fixture test to assert the new shape. Keep the legacy/direct-caller test asserting no flags. | The issue's acceptance criterion explicitly calls for tests covering effective permission configuration, not only `disableAllHooks: true`. The shape is small enough that wire-contract assertions in unit tests are sufficient; no live Claude binary is required. | Adding a live-binary integration test (rejected: out of scope and gated behind the existing opt-in `AGENT_ORCHESTRATOR_RC_LIVE_SMOKE` path). |
| 8 | Documentation framing | Update the doc comment above `CLAUDE_WORKER_SETTINGS_BODY` to record the worker permission posture honestly: workers are intentionally trusted-local, full-access, non-interactive daemon workers running as the same user under the daemon harness. `--permission-mode bypassPermissions` removes Claude Code's interactive approval prompts so the non-interactive worker can complete its run; it does **not** restrict the tool surface. `disableAllHooks: true` preserves hook isolation (issue #40 T5/T13) but is **not** a tool sandbox. No README/AGENTS.md change. | Acceptance criterion 5 in the issue requires documentation that clarifies the intended posture. Honest framing prevents future readers from assuming a sandbox exists where none does, while still recording why this posture is correct for the daemon's non-interactive worker contract. README and AGENTS.md don't currently document worker internals at this level. | Earlier draft language claiming the tool surface is "gated by the daemon profile manifest" (rejected as inaccurate: profile manifest controls backend/model/account/settings, not Claude Code tools, and the worker spawn does not pass `--tools`/`--allowed-tools`). Updating README/AGENTS.md (rejected: no existing parallel documentation to extend). |

## Open Human Decisions

none — the reviewer's second pass confirmed there are no open product decisions. `bypassPermissions` is the chosen worker mode, both surfaces (file `defaultMode` + CLI `--permission-mode`) are set, `skipDangerousModePermissionPrompt: true` stays in the body, the supervisor envelope is out of scope, and `--dangerously-skip-permissions` remains banned.

## Reviewer Questions

none open. Prior reviewer feedback (security framing of `bypassPermissions`, drift-coverage claims in Risks 1/2, and additional T3 assertions) has been incorporated above; any remaining wording around external Claude CLI behavior is recorded as a non-blocking accepted risk in Risks 1 and 2.

## Scope

### In Scope
- Update `CLAUDE_WORKER_SETTINGS_BODY` in `src/backend/claude.ts` to include
  `permissions.defaultMode = "bypassPermissions"` and
  `skipDangerousModePermissionPrompt = true`, alongside the existing
  `disableAllHooks: true`.
- Append `--permission-mode bypassPermissions` to the isolation argv emitted
  by `prepareWorkerIsolation()`, used by both `start()` and `resume()`.
- Update the in-source doc comment to record the worker permission posture
  honestly: workers are trusted-local, full-access, non-interactive daemon
  workers; `bypassPermissions` removes Claude approval prompts (it is not a
  tool sandbox); hook isolation via `disableAllHooks: true` is independent
  and preserved.
- Update `src/__tests__/claudeWorkerIsolation.test.ts`:
  - Replace/extend the `deepStrictEqual` against `CLAUDE_WORKER_SETTINGS_BODY`
    so both the existing exported constant and the on-disk file include the
    new keys.
  - Assert `--permission-mode bypassPermissions` is present in both `start()`
    and `resume()` invocations and is positioned in the isolation block.
  - Extend the user-hook fixture test to also assert the new permission keys
    on disk, keeping its existing T5/T13 assertions.
  - Keep the legacy/direct-caller "no runId" test asserting no isolation
    flags (including no `--permission-mode`).

### Out Of Scope
- Profile-level worker permission configuration (Decision 4).
- Touching the supervisor envelope (`src/claude/launcher.ts` /
  `src/claude/permission.ts`); only the worker backend changes.
- `CLAUDE_CONFIG_DIR` redirect / Decision 9b fallback (still gated on T13
  failure, which is not happening).
- `--dangerously-skip-permissions` introduction anywhere (forbidden per #13).
- README/AGENTS.md edits (Decision 8).
- Any Codex / Cursor / OpenCode backend changes.
- Live-binary smoke beyond the existing opt-in `AGENT_ORCHESTRATOR_RC_LIVE_SMOKE`
  surface.
- Backporting to older Claude Code versions that may not support
  `--permission-mode`. The repo's supervisor path already requires that flag,
  so the worker can rely on it too.
- Any change to the Codex `gh` outbound issue (#31) or the broader CLI
  surface.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | Future Claude Code release renames `permissions.defaultMode` or `skipDangerousModePermissionPrompt` keys, silently dropping the bypass posture. | **Accepted external-drift risk.** Wire-contract tests in this package only prove that the harness writes those exact keys and the matching `--permission-mode` argv; they do **not** prove the external Claude CLI still honors them. CI catches harness regressions only. A real CLI rename would surface to the operator as the worker stalling on approvals again (the same symptom that produced issue #47), and would optionally be observable through the existing opt-in `AGENT_ORCHESTRATOR_RC_LIVE_SMOKE` path or manual evidence. No new live-smoke task is added by this plan. | Task 4 (harness contract only). |
| 2 | Future Claude Code release rejects unknown keys (e.g. tightens settings schema) and refuses to start the worker. | **Accepted external-drift risk.** The chosen keys mirror documented Claude Code surfaces already used by the supervisor (`defaultMode`) and by typical user `~/.claude/settings.json`. If a future CLI rejects them, the worker process surfaces a structured `error` event and the daemon harness propagates it; the operator pins the Claude version or files an upstream issue. CI does not (and cannot) catch this — it is operator-surfaced, optionally via `AGENT_ORCHESTRATOR_RC_LIVE_SMOKE` or manual evidence. No new live-smoke task is added by this plan. | Existing backend `error` event handling in `parseEvent` (`src/backend/claude.ts:93-98`). |
| 3 | A direct/legacy caller (no `runId` / no `RunStore`) needs the new permission posture. | Out of scope per Decision 6: such callers continue to receive zero isolation flags, matching the existing test. If a future caller needs the posture, that is a separate change with its own decision. | Existing "omits worker isolation flags when no run id is supplied" test. |
| 4 | The CLI flag and the settings file disagree (e.g. someone sets a different `defaultMode` upstream). | This change controls both surfaces from the same harness path, so they cannot diverge in practice. The new tests assert that both are present and consistent. | Tasks 1, 2, 4. |
| 5 | `--permission-mode` flag ordering in argv breaks an unrelated assertion (e.g. tests that index by position rather than by `indexOf`). | Existing tests use `indexOf`/`findIndex` against flag names rather than positional indexing, so appending a new flag is safe. The new assertions also use `indexOf`. | Tasks 1, 4. |
| 6 | `bypassPermissions` widens what a worker can do beyond what the operator expects. | **This is the intended posture, framed honestly.** Workers are trusted-local, full-access, non-interactive daemon workers running as the same user the daemon runs as, in the run cwd. `--permission-mode bypassPermissions` removes Claude Code's interactive approval prompts so the non-interactive worker can complete its run; it does not, and is not intended to, restrict the tool surface. There is no tool sandbox here: the worker spawn does not pass `--tools`/`--allowed-tools`, and the profile manifest controls backend/model/account/settings rather than Claude tools. `disableAllHooks: true` preserves hook isolation per issue #40 T5/T13 but is also not a tool sandbox. The user's own `~/.claude/settings.json` is already configured this way for normal interactive use. `--dangerously-skip-permissions` remains banned per issue #13 Decisions 7 / 21. The new in-source comment records this rationale explicitly per Decision 8. | Task 3 (comment) + acceptance criterion 5. |
| 7 | Hook isolation regression: the new permission keys somehow re-enable user hooks. | `disableAllHooks: true` is preserved verbatim. The user-hook fixture test continues to assert the on-disk shape and that the argv builder does not execute user hooks. | Task 4 (extended test). |
| 8 | Resume path drift from start path. | A single `prepareWorkerIsolation()` builds the argv for both, and tests assert both code paths see the new flag. | Tasks 1, 4. |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T1 | Extend `CLAUDE_WORKER_SETTINGS_BODY` and `prepareWorkerIsolation` argv | — | complete | `CLAUDE_WORKER_SETTINGS_BODY` exports `{ disableAllHooks: true, permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }` (typed `as const`). `prepareWorkerIsolation()` returns `['--settings', settingsPath, '--setting-sources', 'user', '--permission-mode', 'bypassPermissions']`, used by both `start()` and `resume()`. The on-disk JSON file content matches the constant byte-for-byte (modulo the trailing newline). The legacy "no `runId`" branch still returns `[]`. |
| T2 | Update worker isolation doc comment | T1 | complete | The block comment above `CLAUDE_WORKER_SETTINGS_FILENAME` records, in honest framing: (a) workers are intentionally trusted-local, full-access, non-interactive daemon workers running as the same OS user as the daemon, in the run cwd; (b) `--permission-mode bypassPermissions` (mirrored by `permissions.defaultMode = 'bypassPermissions'` in the file) removes Claude Code's interactive approval prompts so the non-interactive worker can complete — it does **not** restrict the tool surface, and the worker is not sandboxed; (c) `skipDangerousModePermissionPrompt: true` is required so the bypass mode does not surface a dangerous-mode confirmation prompt that the harness cannot answer; (d) `disableAllHooks: true` preserves hook isolation per issue #40 T5/T13 but is **not** a tool sandbox; (e) the `--permission-mode` CLI flag is set in addition to the file value to mirror the supervisor envelope and survive precedence drift; (f) `--dangerously-skip-permissions` is forbidden everywhere per issue #13 Decisions 7 / 21 and is **not** used here. References issue #47 and prior Decisions 9 / 26 from issue #40. |
| T3 | Update `claudeWorkerIsolation.test.ts` for the new effective settings | T1 | complete | `start` test asserts the on-disk JSON contains all three keys (`disableAllHooks`, `permissions.defaultMode === 'bypassPermissions'`, `skipDangerousModePermissionPrompt === true`) and that the invocation argv contains `--permission-mode bypassPermissions` adjacent to (or after) `--setting-sources user`. The `resume` test makes the same argv assertion **and** reads the on-disk per-run settings file (since `resume()` runs the same `prepareWorkerIsolation()` path) and asserts the same three keys (`disableAllHooks`, `permissions.defaultMode === 'bypassPermissions'`, `skipDangerousModePermissionPrompt === true`). Both the `start` and `resume` tests additionally assert that the invocation argv does **not** include `--dangerously-skip-permissions` (e.g. `assert.ok(!args.includes('--dangerously-skip-permissions'))`), enforcing the issue #13 Decisions 7 / 21 ban. The user-hook fixture test (T13/D9) gains the same on-disk assertions in addition to the existing `disableAllHooks` one and the sentinel non-existence check. The legacy "no runId" test is kept exactly as currently planned: it asserts the argv contains neither `--settings` nor `--setting-sources` nor `--permission-mode` (zero isolation flags). The exported constant assertion (`deepStrictEqual` against `CLAUDE_WORKER_SETTINGS_BODY`) continues to pass after the constant is widened. |
| T4 | Run repository quality gates | T1, T2, T3 | complete | `pnpm build` succeeds. `pnpm test` passes, with the targeted file `src/__tests__/claudeWorkerIsolation.test.ts` showing the new assertions executing. `pnpm verify` succeeds (build + tests + publish-readiness + audit + dist-tag + npm pack dry run). Evidence captured in the Execution Log. |
| T5 | Update plan execution log and link evidence | T4 | complete | Each task's Execution Log entry is filled in with the actual command output (test names, exit codes), the plan Status flips to `complete`, and the parent index `plan.md` Status mirrors that. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | "Claude worker isolation body changes must update both the on-disk JSON test and the user-hook fixture test." | `.agents/rules/` cross-cutting rule. | Only if a future change again forgets the second test. Skip for now. |
| 2 | "Per-run harness-owned settings files for any worker backend should pin both the in-file `defaultMode` and the matching CLI permission flag, mirroring supervisor parity." | `.agents/rules/` cross-cutting rule. | Defer until a second backend hits the same issue (Codex backend currently has no equivalent). |

## Quality Gates

- [x] `pnpm build` passes.
- [x] `pnpm test` passes (with `claudeWorkerIsolation.test.ts` exercising the
      new assertions).
- [x] `pnpm verify` passes end-to-end.
- [x] Hook isolation invariant (T5 / T13 from issue #40) still holds: the
      user-hook fixture test still asserts no sentinel side effect and
      `disableAllHooks: true` on disk.
- [x] No `--dangerously-skip-permissions` is introduced anywhere (rules from
      issue #13 Decisions 7 / 21).
- [x] Legacy direct-caller (no `runId`) behavior unchanged: zero isolation
      flags emitted.

## Execution Log

### T1: Extend `CLAUDE_WORKER_SETTINGS_BODY` and `prepareWorkerIsolation` argv
- **Status:** complete
- **Evidence:** `src/backend/claude.ts` — `CLAUDE_WORKER_SETTINGS_BODY` widened to `{ disableAllHooks: true, permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true } as const`. `prepareWorkerIsolation()` now returns `['--settings', settingsPath, '--setting-sources', 'user', '--permission-mode', 'bypassPermissions']` when a `runId` and `store` are present; the legacy "no `runId`" branch still returns `[]`. Both `start()` and `resume()` consume the same argv via the existing call sites.
- **Notes:** No public schema change — the constant is internal-but-exported for tests. `bypassPermissions` is hardcoded per Decision 4 (no profile knob).

### T2: Update worker isolation doc comment
- **Status:** complete
- **Evidence:** `src/backend/claude.ts` — block comment above `CLAUDE_WORKER_SETTINGS_FILENAME` now records: workers run non-interactively under the daemon harness as the same OS user; `permissions.defaultMode: 'bypassPermissions'` (mirrored by `--permission-mode bypassPermissions`) removes Claude Code's interactive approval prompts and is **not** a tool sandbox; `skipDangerousModePermissionPrompt: true` is required so the bypass mode does not surface a dangerous-mode confirmation prompt that the harness cannot answer; `disableAllHooks: true` preserves hook isolation per issue #40 T5/T13 and is **not** a tool sandbox; the `--permission-mode` CLI flag is set in addition to the file value to mirror `buildClaudeSpawnArgs` and survive precedence drift; `--dangerously-skip-permissions` is forbidden per issue #13 Decisions 7 / 21 and is **not** used here. References issue #47 and Decisions 9 / 26 from issue #40.
- **Notes:** Comment placement preserved (immediately above the exported filename/body pair). No README or AGENTS.md change per Decision 8.

### T3: Update `claudeWorkerIsolation.test.ts` for the new effective settings
- **Status:** complete
- **Evidence:** `src/__tests__/claudeWorkerIsolation.test.ts` — (1) `start` test now asserts `--permission-mode bypassPermissions` is present and positioned after `--setting-sources user`, asserts `!invocation.args.includes('--dangerously-skip-permissions')`, and asserts the on-disk JSON has `disableAllHooks === true`, `permissions.defaultMode === 'bypassPermissions'`, and `skipDangerousModePermissionPrompt === true`; the existing `deepStrictEqual` against `CLAUDE_WORKER_SETTINGS_BODY` continues to pass after the constant is widened. (2) `resume` test now reads the on-disk per-run settings file and asserts the same three keys, asserts the same `--permission-mode bypassPermissions` argv pair adjacent/after `--setting-sources user`, and asserts no `--dangerously-skip-permissions`. (3) The user-hook fixture test (T5 / T13 / D9) gains assertions for `permissions.defaultMode === 'bypassPermissions'` and `skipDangerousModePermissionPrompt === true` on disk while preserving the existing `disableAllHooks: true` and sentinel non-existence checks. (4) The legacy "no `runId`" test now also asserts `!invocation.args.includes('--permission-mode')`.
- **Notes:** All assertions use `findIndex`/`indexOf` rather than positional indexing, matching the existing style and Risk #5 mitigation.

### T4: Run repository quality gates
- **Status:** complete
- **Evidence:**
  - `pnpm build` — succeeded (no tsc output; exit 0).
  - `pnpm test` — `tests 532 / pass 530 / fail 0 / skipped 2 / duration_ms 33921`. Targeted suite line: `▶ Claude worker isolation (issue #40, T5 / Decision 9) … ✔ start emits --settings <per-run-path>, --setting-sources user, --permission-mode bypassPermissions, and writes the bypass+disableAllHooks settings on disk (17.978858ms) … ✔ Claude worker isolation (issue #40, T5 / Decision 9) (29.892802ms)`.
  - `pnpm verify` — `tests 532 / pass 530 / fail 0`, followed by `[publish-ready] package metadata is ready for publish`, `[publish-tag] @ralphkrauss/agent-orchestrator@0.2.1 will publish with npm dist-tag latest`, `pnpm audit --prod` clean, and `npm pack --dry-run` producing `ralphkrauss-agent-orchestrator-0.2.1.tgz` (454.6 kB / 276 files). Exit 0.
- **Notes:** No new dependencies, no `tsconfig.json` changes, no install. The two skipped tests are pre-existing skips unrelated to this change.

### T5: Update plan execution log and link evidence
- **Status:** complete
- **Evidence:** This Execution Log filled in (T1–T5), task table `Status` flipped to `complete`, plan front-matter `Status` flipped to `complete`, Quality Gates checked, and parent `plans/47-…/plan.md` index Status mirrored to `complete`.
- **Notes:** No commit/push performed (per task instructions).
