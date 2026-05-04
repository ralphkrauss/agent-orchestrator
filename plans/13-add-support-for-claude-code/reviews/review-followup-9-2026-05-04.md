# Review Follow-up 9 - 2026-05-04

Scope: implementation pass for the five PR #29 follow-up review comments F1-F5
recorded in `plans/13-add-support-for-claude-code/resolution-map.md`.

This pass touched only F1-F5 from the resolution map. The originally mapped
items A1-A8, B1-B3, N1 were not modified.

## Changes

- F1: `src/claude/launcher.ts:loadProfilesForLaunch` now returns
  `{ ok: false, errors: inspected.errors }` after `inspectWorkerProfiles()`
  when `options.profilesJson` is set and inspection produced errors. File-backed
  manifests still flow through diagnostics.
- F2: `src/claude/monitorPin.ts:buildMonitorBashCommand` rejects
  `jsonLine === false` with `Claude supervisor monitor commands must use
  --json-line` and unconditionally appends `--json-line`. No production call
  site (`src/claude/config.ts`) ever passed `false`.
- F3: `src/opencode/launcher.ts:loadProfilesForLaunch` mirrors F1 with the
  same fail-fast guard for inline manifests.
- F4: `src/orchestratorService.ts:atomicWriteWorkerProfiles` writes the new
  manifest to a same-directory temp file (mode `0o600`, unique
  `.<basename>.tmp-<pid>-<ts>-<counter>-<rand>` suffix) and then `rename()`s it
  onto the live manifest. Best-effort cleanup runs on failure. The
  per-manifest update mutex is preserved; this fix protects independent
  readers (`list_worker_profiles`, `start_run`, etc.) from observing a
  truncated manifest.
- F5: `src/processManager.ts:handleJsonLine` captures the last
  `assistant_message` text in stream order and calls
  `setLastAssistantMessage` immediately after `backend.parseEvent(raw)` and
  before any awaited persistence work. The for-loop over `parsed.events`
  only persists events. The empty-summary fallback in `finalizeRun` is
  unchanged.

## Tests Added

- `src/__tests__/claudeHarness.test.ts`:
  - "rejects inline --profiles-json that parses but fails inspectWorkerProfiles
    (semantic errors must also fail fast)" — F1.
  - "rejects the bare monitor form so all emitted commands stay inside the
    JSON-line allowlist" — F2: bare form throws; supported no-cursor and
    cursored forms still match the generated allow patterns and are not
    shadowed by deny rules.
- `src/__tests__/opencodeHarness.test.ts`:
  - "rejects inline profile JSON that parses but fails inspectWorkerProfiles
    (semantic errors must also fail fast)" — F3.
- `src/__tests__/integration/orchestrator.test.ts`:
  - "writes profiles atomically so concurrent readers never observe a partial
    manifest" — F4: a busy reader during 8 concurrent upserts only observes
    parseable manifest snapshots. The existing "serializes concurrent upserts"
    test continues to verify both changes persist.
- `src/__tests__/processManager.test.ts`:
  - "preserves stream order for the fallback assistant message even when an
    earlier line awaits longer" — F5: blocks the older line's `updateMeta`
    until the newer line completes; asserts the fallback is `NEW`, not the
    older `OLD`. The test fails on the pre-fix behavior because the older
    line's event loop would set the sink last.

## Verification

- `pnpm build` — clean.
- `node --test --test-name-pattern='monitor|inline|atomic|stream order'
  dist/__tests__/claudeHarness.test.js
  dist/__tests__/opencodeHarness.test.js
  dist/__tests__/processManager.test.js
  dist/__tests__/integration/orchestrator.test.js` — 20/20 passed including
  all new F1-F5 regression cases.
- `pnpm test` — 260 passed, 1 skipped, 0 failed.
- `just local claude --print-config` — local launcher still emits the two
  pinned `--json-line` Bash monitor allow patterns; the bare monitor form is
  no longer reachable from `buildMonitorBashCommand`.

## Residual Risks

- F4 leaves orphan temp files (`.<basename>.tmp-...`) only if the process
  crashes between `writeFile` and `rename`. The unique suffix prevents
  cross-operation collisions; cleanup is best-effort because re-raising a
  cleanup failure would mask the original write/rename error.
- F5 relies on each `assistant_message` payload exposing `text`. That matches
  the existing `assistantMessageText` helper used by the (now removed)
  in-loop sink update, so behavior is preserved.

No commit, push, or GitHub reply was performed in this pass.
