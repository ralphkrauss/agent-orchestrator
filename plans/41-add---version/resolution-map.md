# PR #49 Resolution Map

Branch: `41-add---version`
Created: 2026-05-07
Total comments: 3 | To fix: 3 | To defer: 0 | To decline: 0 | To escalate: 0

AI reply prefix: `**[AI Agent]:**` (no repo-wide prefix configured; CLAUDE.md
requires AI authorship to be clear in GitHub comments).

## Comment 1 | to-fix | minor

- **Comment Type:** review-inline
- **File:** `plans/41-add---version/plans/41-add-version-flag.md:109-111`
- **Comment ID:** 3199226021
- **Review ID:** 4241502071
- **Thread Node ID:** PRRC_kwDOSRv-qs6-sFCl
- **Author:** coderabbitai[bot]
- **Comment:** *Fix inconsistent test totals in the Quality Gates block.*
  The counts conflict with Line 145 (`14 tests`) and the PR verification
  summary (`546 total / 544 pass / 2 skipped`).
- **Independent Assessment:** Valid. The Quality Gates checklist still says
  "544 tests, 542 pass, 2 skipped, 0 fail" with "12 tests" for cliVersion
  — those numbers are from the first test run, before the round-2 review fix
  added the two regression tests. Execution Log T5 (line 145) and the PR
  body already show the correct totals (546/544/2 with 14 new tests).
- **Decision:** fix-as-suggested
- **Approach:** Edit `plans/41-add---version/plans/41-add-version-flag.md`
  line 110: change `544 tests, 542 pass, 2 skipped, 0 fail (includes new
  cliVersion.test.ts with 12 tests)` to `546 tests, 544 pass, 2 skipped,
  0 fail (includes new cliVersion.test.ts with 14 tests)`. No other lines
  in the QG block are affected.
- **Files To Change:** `plans/41-add---version/plans/41-add-version-flag.md`
- **Reply Draft:**
  > **[AI Agent]:** Fixed in the follow-up commit. Quality Gates block now
  > matches the Execution Log (546 tests / 544 pass / 2 skipped, 14 tests in
  > `cliVersion.test.ts`).

## Comment 2 | to-fix | nitpick

- **Comment Type:** review-body (CodeRabbit summary, not a line-anchored thread)
- **File:** `src/__tests__/cliVersion.test.ts:53-60`
- **Author:** coderabbitai[bot]
- **Comment:** *`--version --json` output is only tested for the main bin
  — add coverage for the other three.* Suggests three additional tests
  (daemon spawn-based; claude and opencode in-process via `runXLauncher`).
- **Independent Assessment:** Valid. The four bins all flow through
  `formatVersionOutput(..., true)`, but the test file only asserts the JSON
  shape on the main bin. Adding the three missing JSON assertions is cheap
  and closes a real coverage gap. The diff CodeRabbit provided is sound and
  matches the existing test patterns in this file.
- **Decision:** fix-as-suggested
- **Approach:** Add three tests in `src/__tests__/cliVersion.test.ts`
  immediately after the existing `'returns single-line JSON when --version
  --json is passed'` test:
    1. `daemon --version --json` via spawn against `daemonCliPath`.
    2. `claude --version --json` via in-process `runClaudeLauncher` with
       a `CaptureStream` pair.
    3. `opencode --version --json` via in-process `runOpenCodeLauncher` with
       a `CaptureStream` pair.
  Each test parses `stdout`/`stdout.buffer` as JSON, asserts the parsed
  `name` and `version` against `getPackageMetadata()`, and asserts empty
  stderr.
- **Files To Change:** `src/__tests__/cliVersion.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Added in the follow-up commit. Three new tests in
  > `cliVersion.test.ts` cover `--version --json` for the daemon (spawn),
  > claude (in-process), and opencode (in-process) bins.

## Comment 3 | to-fix | nitpick

- **Comment Type:** review-body (CodeRabbit summary, not a line-anchored thread)
- **File:** `src/__tests__/cliVersion.test.ts:9-12`
- **Author:** coderabbitai[bot]
- **Comment:** *Merge the split imports from the same modules.*
  `parseClaudeLauncherArgs`/`runClaudeLauncher` and
  `parseOpenCodeLauncherArgs`/`runOpenCodeLauncher` are each imported in
  two separate statements.
- **Independent Assessment:** Valid. Strictly a style cleanup with no
  behavior change.
- **Decision:** fix-as-suggested
- **Approach:** Replace the four import lines with two consolidated
  imports (one per launcher module).
- **Files To Change:** `src/__tests__/cliVersion.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Cleaned up in the follow-up commit. The four split
  > imports are now consolidated into two `import { parser, run } from
  > '<launcher>'` statements.
