# PR #12 Resolution Map

Branch: `4-add-observability`
Created: 2026-05-02
Total comments: 5 | Fixed: 5 | To defer: 0 | To decline: 0 | To escalate: 0

## Comment 1 | fixed | minor

- **Comment Type:** review-inline
- **File:** `plans/4-add-observability/plans/4-observability-dashboard.md:188`
- **Comment ID:** `discussion_r3176428857`
- **Review ID:** `4214779327`
- **Thread Node ID:** unavailable
- **Author:** `coderabbitai[bot]`
- **Comment:** Update the recorded `pnpm test` evidence. Line 187 still says `pnpm test` passed with `52 tests across 14 suites`, but the PR verification section for this branch now records `69 passed, 1 skipped`.
- **Independent Assessment:** Valid. The final local verification after the stale-daemon fix ran `pnpm test` with 70 tests: 69 passed and 1 skipped. The plan artifact still records older evidence and should match the current branch state.
- **Decision:** fix-as-suggested
- **Approach:** Update the OBS-9 execution log evidence to record `pnpm test` as 69 passed and 1 skipped. Keep the existing build and diff-check evidence.
- **Files To Change:** `plans/4-add-observability/plans/4-observability-dashboard.md`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. The plan evidence now reflects the latest `pnpm test` result: 69 passed and 1 skipped. <!-- agent-orchestrator:pr12:c1 -->

## Comment 2 | fixed | minor

- **Comment Type:** review-inline
- **File:** `src/cli.ts:28`
- **Comment ID:** `discussion_r3176428859`
- **Review ID:** `4214779327`
- **Thread Node ID:** unavailable
- **Author:** `coderabbitai[bot]`
- **Comment:** Document `status --json` in the top-level help.
- **Independent Assessment:** Valid. `src/daemon/daemonCli.ts` supports `status --json`, and the top-level CLI help advertises `status --verbose` but not the JSON form.
- **Decision:** fix-as-suggested
- **Approach:** Add `agent-orchestrator-mcp-daemon status --json` to the daemon lifecycle help block in `src/cli.ts`. Update the CLI help test if needed.
- **Files To Change:** `src/cli.ts`, `src/__tests__/daemonCli.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. Top-level help now advertises `agent-orchestrator-mcp-daemon status --json`, and the help test asserts it. <!-- agent-orchestrator:pr12:c2 -->

## Comment 3 | fixed | minor

- **Comment Type:** review-body
- **File:** `src/contract.ts:192`
- **Comment ID:** `review-body-nitpick-1`
- **Review ID:** `4214779327`
- **Thread Node ID:** unavailable
- **Author:** `coderabbitai[bot]`
- **Comment:** Narrow `RunModelSettingsSchema` to the enum types, or explicitly document arbitrary persisted strings if intentional.
- **Independent Assessment:** Valid. Runtime inputs already validate `reasoning_effort` and `service_tier` through `ReasoningEffortSchema` and `ServiceTierSchema`; keeping persisted settings as arbitrary strings weakens the shared contract without an explicit forward-compatibility decision.
- **Decision:** fix-as-suggested
- **Approach:** Change `RunModelSettingsSchema.reasoning_effort` to `ReasoningEffortSchema.nullable().optional().default(null)` and `service_tier` to `ServiceTierSchema.nullable().optional().default(null)`. Leave `mode` as string/null because it is an internal display mode currently set to `normal`.
- **Files To Change:** `src/contract.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. `RunModelSettingsSchema` now uses the same `ReasoningEffortSchema` and `ServiceTierSchema` enums as the public inputs. <!-- agent-orchestrator:pr12:c3 -->

## Comment 4 | fixed | minor

- **Comment Type:** review-body
- **File:** `src/__tests__/integration/orchestrator.test.ts:147`
- **Comment ID:** `review-body-nitpick-2`
- **Review ID:** `4214779327`
- **Thread Node ID:** unavailable
- **Author:** `coderabbitai[bot]`
- **Comment:** Assert the specific validation failure instead of only `ok === false`.
- **Independent Assessment:** Valid. The test currently proves the requests fail, but an unrelated error would still satisfy the assertions.
- **Decision:** fix-as-suggested
- **Approach:** Add a small assertion helper for failed tool responses and assert `INVALID_INPUT` plus the expected validation-message pattern for each rejected model-setting case.
- **Files To Change:** `src/__tests__/integration/orchestrator.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. The model-setting validation test now asserts `INVALID_INPUT` and the expected message for each rejected case. <!-- agent-orchestrator:pr12:c4 -->

## Comment 5 | fixed | minor

- **Comment Type:** review-body
- **File:** `src/__tests__/daemonCli.test.ts:48`
- **Comment ID:** `review-body-nitpick-3`
- **Review ID:** `4214779327`
- **Thread Node ID:** unavailable
- **Author:** `coderabbitai[bot]`
- **Comment:** Add stale-daemon coverage for `watch` too.
- **Independent Assessment:** Valid. In non-TTY mode, `watch` uses the same snapshot path and exits after one render; it is cheap to cover and directly exercises the stale-daemon dashboard surface.
- **Decision:** fix-as-suggested
- **Approach:** Extend the stale-daemon daemon CLI test to run `watch` under `execFile` and assert the mismatch error plus empty snapshot count.
- **Files To Change:** `src/__tests__/daemonCli.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. The stale-daemon CLI test now covers non-TTY `watch` in addition to `runs` and `status --verbose`. <!-- agent-orchestrator:pr12:c5 -->

## Verification

- `pnpm build`
- `node --test dist/__tests__/daemonCli.test.js dist/__tests__/contract.test.js dist/__tests__/integration/orchestrator.test.js`
- `pnpm test` (70 tests total, 69 passed, 1 skipped)
- `git diff --check`
