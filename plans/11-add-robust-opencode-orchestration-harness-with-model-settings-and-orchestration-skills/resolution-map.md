# PR #15 Resolution Map - Round 2

Branch: `11-add-robust-opencode-orchestration-harness-with-model-settings-and-orchestration-skills`
Created: 2026-05-02
PR: https://github.com/ralphkrauss/agent-orchestrator/pull/15
Head reviewed: `6207e65eede5ca71b1a8b24ec2dcd0571430eb0e`

New actionable review items: 4
To fix: 4 | To defer: 0 | To decline: 0 | To escalate: 0
CI status: green on Node 22 and Node 24 for workflow run https://github.com/ralphkrauss/agent-orchestrator/actions/runs/25256885513

## Previously Handled

- Exact manifest-only `external_directory` for the profiles manifest was fixed in `6207e65`.
- Skill discovery now ignores only missing `SKILL.md` and surfaces unreadable/broken files.
- Follow-up runs no longer inherit `worker_profile` provenance unless child metadata explicitly supplies it.
- Heuristic stderr text such as `0 errors` is no longer promoted into successful run errors.
- MCP `start_run` schema now advertises direct-mode versus profile-mode constraints.
- Claude model effort validation now uses exact normalized direct model ids for `xhigh` and known-model checks, preserving `claude-opus-4-7[1m]`.
- Local OpenCode session ids/log names were redacted from the plan.
- CI tarball smoke now uses the current package bins: `agent-orchestrator`, `agent-orchestrator-daemon`, and `agent-orchestrator-opencode`.

## Summary

| Item | Status | Severity | Decision | Files |
|---|---|---|---|---|
| 1 | to-fix | Minor | fix-as-suggested | `src/__tests__/integration/orchestrator.test.ts` |
| 2 | to-fix | Major | alternative-fix | `src/backend/claudeValidation.ts`, `src/__tests__/opencodeCapabilities.test.ts` |
| 3 | to-fix | Major | alternative-fix | `src/opencode/config.ts`, `src/__tests__/opencodeHarness.test.ts` |
| 4 | to-fix | Major | fix-as-suggested | `src/processManager.ts`, `src/__tests__/processManager.test.ts` |

## Item 1 | to-fix | Minor

- **Comment Type:** review-inline
- **File:** `src/__tests__/integration/orchestrator.test.ts:190`
- **Comment URL:** https://github.com/ralphkrauss/agent-orchestrator/pull/15#discussion_r3176937644
- **Author:** `coderabbitai[bot]`
- **Comment:** Prevent a false pass when follow-up status retrieval fails. The current assertion evaluates `followupStatus.ok && hasWorkerProfile` and compares it to `false`, so a failed status lookup still passes.
- **Independent Assessment:** Valid. Lines 186-190 currently check `followupStatus.ok && Object.hasOwn(...) === false`. If `getRunStatus()` returns `{ ok: false }`, the left side becomes `false` and the test passes without proving anything about child metadata.
- **Decision:** fix-as-suggested
- **Approach:** Assert `followupStatus.ok` first, then read metadata only from the success branch and assert `worker_profile` is absent. Keep the explicit child metadata case below it as-is, except consider applying the same `ok`-first style there if touching the block.
- **Files To Change:** `src/__tests__/integration/orchestrator.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. The follow-up metadata regression test now asserts status retrieval succeeded before checking that `worker_profile` was not inherited. <!-- agent-orchestrator:pr15:r2:c1 -->

## Item 2 | to-fix | Major

- **Comment Type:** review-inline
- **File:** `src/backend/claudeValidation.ts:20`
- **Comment URL:** https://github.com/ralphkrauss/agent-orchestrator/pull/15#discussion_r3176937648
- **Author:** `coderabbitai[bot]`
- **Comment:** Reject unsupported Claude `reasoning_effort` values. The helper currently rejects only `none` and `minimal`, so an arbitrary string can pass when a model is explicit.
- **Independent Assessment:** Valid as shared-helper hardening. Profile validation currently rejects unsupported efforts through the capability catalog before calling this helper, and direct `start_run` is also schema-constrained, but `validateClaudeModelAndEffort()` accepts `string | null | undefined` and should enforce its own documented effort set. That keeps future callers from bypassing the contract accidentally.
- **Decision:** alternative-fix
- **Approach:** Normalize effort once with `const effort = reasoningEffort?.trim().toLowerCase() ?? null;`. Add a module-level `knownClaudeReasoningEfforts` set containing `low`, `medium`, `high`, `xhigh`, and `max`. If `effort` is present and not in the set, return the existing "must be one of low, medium, high, xhigh, or max" message. Use `effort` for all subsequent checks instead of the raw `reasoningEffort`. Preserve exact direct model checks and `[1m]` normalization from the previous fix. Add a focused regression test that a Claude profile or helper path rejects `reasoning_effort: "ultra"` with an explicit valid model.
- **Files To Change:** `src/backend/claudeValidation.ts`, `src/__tests__/opencodeCapabilities.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. The shared Claude model/effort validator now normalizes effort values and rejects anything outside `low`, `medium`, `high`, `xhigh`, and `max`, even when a direct model id is present. <!-- agent-orchestrator:pr15:r2:c2 -->

## Item 3 | to-fix | Major

- **Comment Type:** review-inline
- **File:** `src/opencode/config.ts:83`
- **Comment URL:** https://github.com/ralphkrauss/agent-orchestrator/pull/15#discussion_r3176937649
- **Author:** `coderabbitai[bot]`
- **Comment:** Allow out-of-workspace orchestration skills in `external_directory`. `edit` allows skill files under `skillRoot`, but `external_directory` now allows only the manifest, so shared skill roots outside `targetCwd` remain blocked.
- **Independent Assessment:** Valid. `setupEditPermission()` includes `join(skillRoot, 'orchestrate-*', 'SKILL.md')`, but `profileManifestExternalDirectoryPermission()` returns only `'*': 'deny'` and `[manifestPath]: 'allow'`. When `skillRoot` is outside the workspace, OpenCode needs an `external_directory` allow for the same skill file pattern before the edit rule can be useful.
- **Decision:** alternative-fix
- **Approach:** Replace `profileManifestExternalDirectoryPermission(manifestPath)` with a broader but still narrow helper, for example `externalDirectoryPermission(targetCwd, skillRoot, manifestPath)`. It should always return `'*': 'deny'` and the exact `[manifestPath]: 'allow'`. It should add exactly `join(skillRoot, 'orchestrate-*', 'SKILL.md'): 'allow'` only when that skill pattern is outside `targetCwd` according to the existing `relative(targetCwd, pattern)` logic. Do not add a directory wildcard or sibling manifest wildcard. Add harness tests for:
  - repo-local/default skill root keeps only the exact manifest in `external_directory`;
  - out-of-workspace `skillRoot` adds only the exact `orchestrate-*/SKILL.md` pattern plus the manifest.
- **Files To Change:** `src/opencode/config.ts`, `src/__tests__/opencodeHarness.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. `external_directory` still grants only the exact profiles manifest by default, and now also grants the exact out-of-workspace `orchestrate-*/SKILL.md` pattern when a shared skill root is configured outside the workspace. <!-- agent-orchestrator:pr15:r2:c3 -->

## Item 4 | to-fix | Major

- **Comment Type:** review-inline
- **File:** `src/processManager.ts:240`
- **Comment URL:** https://github.com/ralphkrauss/agent-orchestrator/pull/15#discussion_r3176937652
- **Author:** `coderabbitai[bot]`
- **Comment:** Do not persist parsed worker errors on successful exits. A worker can emit a recoverable or diagnostic error event, then emit a success result and exit 0; the completed result should not carry final `errors`.
- **Independent Assessment:** Valid. `finalizeRun()` currently uses `exitCode === 0 ? dedupeErrors(parsedErrors) : ...`, so backend-classified parsed errors still appear in the stored successful result. In this codebase, `result.errors` represents terminal run errors, not warning history; successful terminal state should keep historical error events in the event log, not in final result errors.
- **Decision:** fix-as-suggested
- **Approach:** Change the success branch to `exitCode === 0 ? [] : ...`. Keep timeout/cancel behavior unchanged, and keep parsed plus stderr errors on nonzero exits. Add a regression test where the mock backend emits an error event, then a valid success result, exits 0, and the final status/result has `errors: []`. Keep the existing failed-run aggregation tests proving parsed errors are preserved for failures.
- **Files To Change:** `src/processManager.ts`, `src/__tests__/processManager.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. Successful worker exits now store an empty terminal `errors` array; parsed and stderr errors remain surfaced for failed processes. <!-- agent-orchestrator:pr15:r2:c4 -->

## Verification Plan

Run focused checks after implementing the four items:

```bash
pnpm build
pnpm test
pnpm verify
node scripts/sync-ai-workspace.mjs --check
```

Recommended targeted checks before the full verify:

```bash
pnpm build
node --test dist/__tests__/integration/orchestrator.test.js
node --test dist/__tests__/opencodeCapabilities.test.js
node --test dist/__tests__/opencodeHarness.test.js
node --test dist/__tests__/processManager.test.js
```

After pushing, wait for PR checks. Expected result: both `Build, Test, and Pack on Node 22` and `Build, Test, and Pack on Node 24` remain green.
