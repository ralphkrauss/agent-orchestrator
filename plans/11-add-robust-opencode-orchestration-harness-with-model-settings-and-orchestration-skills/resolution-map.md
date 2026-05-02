# PR #15 Resolution Map

Branch: `11-add-robust-opencode-orchestration-harness-with-model-settings-and-orchestration-skills`
Created: 2026-05-02
PR: https://github.com/ralphkrauss/agent-orchestrator/pull/15
Head reviewed: `852222b13e3a2bd93db3fd3f0af9a87ae113cdcf`

Total actionable review items: 7
CI failures: 1 shared workflow issue across Node 22 and Node 24
Skipped: 3 resolved or outdated inline threads, 1 informational CodeRabbit summary conversation comment

## Skipped Or Already Handled

- `src/opencode/capabilities.ts` Claude `xhigh` matching comment is resolved/outdated on GitHub. A newer unresolved review-body item for the shared `src/backend/claudeValidation.ts` helper is tracked below as Item 7.
- `src/opencode/config.ts` read-only bash allowlist comment is resolved/outdated because bash is now denied outright.
- `src/opencode/launcher.ts` `--manifest`/`--profiles-file` alias conflict comment is resolved/outdated because `--manifest` now feeds the same profiles path.
- The CodeRabbit walkthrough conversation comment is informational. Its "Docstring Coverage" warning is a CodeRabbit pre-merge check, not the failing GitHub Actions build check. I did not include it as a required fix because this TypeScript codebase does not currently enforce docstring coverage.

## Summary

| Item | Status | Severity | Decision | Files |
|---|---|---|---|---|
| 1 | to-fix | Major | fix-as-suggested | `src/opencode/config.ts`, `src/__tests__/opencodeHarness.test.ts` |
| 2 | to-fix | Minor | fix-as-suggested | `src/opencode/skills.ts`, `src/__tests__/opencodeHarness.test.ts` |
| 3 | to-fix | Major | fix-as-suggested | `src/orchestratorService.ts`, `src/__tests__/integration/orchestrator.test.ts` |
| 4 | to-fix | Major | alternative-fix | `src/processManager.ts`, `src/__tests__/processManager.test.ts` |
| 5 | to-fix | Major | fix-as-suggested | `plans/.../plans/11-opencode-orchestration-harness.md` |
| 6 | to-fix | Major | fix-as-suggested | `src/mcpTools.ts`, `src/__tests__/mcpTools.test.ts` |
| 7 | to-fix | Minor | fix-as-suggested | `src/backend/claudeValidation.ts`, `src/__tests__/opencodeCapabilities.test.ts`, `src/__tests__/integration/orchestrator.test.ts` |
| CI | to-fix | High | fix workflow smoke | `.github/workflows/ci.yml` |

## Item 1 | to-fix | Major

- **Comment Type:** review-inline
- **File:** `src/opencode/config.ts:104`
- **Comment URL:** https://github.com/ralphkrauss/agent-orchestrator/pull/15#discussion_r3176779692
- **Author:** `coderabbitai[bot]`
- **Comment:** `external_directory` currently allows `join(dirname(manifestPath), '*')`, granting the supervisor access to every direct child file beside the profiles manifest instead of just the manifest.
- **Independent Assessment:** Valid. `profileManifestExternalDirectoryPermission()` currently emits `'*': 'deny'`, the exact manifest path, and a sibling wildcard. The launcher already creates the manifest directory before a non-print launch, so the wildcard is broader than needed for setup.
- **Decision:** fix-as-suggested
- **Approach:** Remove the sibling wildcard from `profileManifestExternalDirectoryPermission()`. Keep only `'*': 'deny'` and `[manifestPath]: 'allow'`. Update all harness config tests that currently expect the directory wildcard for repo-local and user-level manifests.
- **Files To Change:** `src/opencode/config.ts`, `src/__tests__/opencodeHarness.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. The OpenCode supervisor external-directory permission now allows only the exact profiles manifest path, and the harness tests assert that sibling files are not granted. <!-- agent-orchestrator:pr15:c1 -->

## Item 2 | to-fix | Minor

- **Comment Type:** review-inline
- **File:** `src/opencode/skills.ts:40`
- **Comment URL:** https://github.com/ralphkrauss/agent-orchestrator/pull/15#discussion_r3176779696
- **Author:** `coderabbitai[bot]`
- **Comment:** Only ignore a missing `SKILL.md`; permission or I/O failures should not silently remove a skill from discovery.
- **Independent Assessment:** Valid. `readProjectSkillNames()` currently catches every `access()` failure and ignores it. That hides unreadable or otherwise broken `SKILL.md` files.
- **Decision:** fix-as-suggested
- **Approach:** In the inner catch, inspect `error.code`. Continue only for `ENOENT`; rethrow everything else. Keep the outer `readdir()` `ENOENT` handling so a missing skill root still returns an empty list. Add a focused test that a candidate directory without `SKILL.md` is ignored, and, if stable on CI, one that an unreadable `SKILL.md` rejects instead of disappearing.
- **Files To Change:** `src/opencode/skills.ts`, `src/__tests__/opencodeHarness.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. Skill discovery now ignores only missing `SKILL.md` files and surfaces permission or I/O failures instead of silently hiding broken skills. <!-- agent-orchestrator:pr15:c2 -->

## Item 3 | to-fix | Major

- **Comment Type:** review-inline
- **File:** `src/orchestratorService.ts:242` and follow-up inheritance around `src/orchestratorService.ts:306`
- **Comment URL:** https://github.com/ralphkrauss/agent-orchestrator/pull/15#discussion_r3176779697
- **Review Body Duplicate:** review `4215171821`
- **Author:** `coderabbitai[bot]`
- **Comment:** Do not persist live-profile provenance in generic metadata that follow-up runs inherit. A profile-started parent can create a child that still claims the original profile even when the child was not profile-resolved.
- **Independent Assessment:** Valid. `resolveStartRunTarget()` stores `worker_profile` inside `metadata`, and `sendFollowup()` clones `parent.meta.metadata` verbatim before overlaying child metadata. Follow-ups do not run profile resolution, so inherited `worker_profile` is misleading.
- **Decision:** fix-as-suggested
- **Approach:** Strip `worker_profile` from inherited metadata in `sendFollowup()` before merging child metadata. Suggested local shape:
  ```ts
  const { worker_profile: _workerProfile, ...inheritedMetadata } = parent.meta.metadata ?? {};
  const metadata = { ...inheritedMetadata, ...parsed.data.metadata };
  ```
  Keep `worker_profile` on runs started through `start_run` profile mode. Add or extend the live-profile integration test to start a profile-mode parent, send a follow-up with and without explicit overrides, and assert the child metadata does not include inherited `worker_profile` unless the user explicitly supplies one in child metadata.
- **Files To Change:** `src/orchestratorService.ts`, `src/__tests__/integration/orchestrator.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. Follow-up runs no longer inherit profile provenance from the parent metadata; profile provenance is attached only to runs actually resolved from a live profile. <!-- agent-orchestrator:pr15:c3 -->

## Item 4 | to-fix | Major

- **Comment Type:** review-inline
- **File:** `src/processManager.ts:99` and `src/processManager.ts:230`
- **Comment URL:** https://github.com/ralphkrauss/agent-orchestrator/pull/15#discussion_r3176779700
- **Author:** `coderabbitai[bot]`
- **Comment:** Do not promote arbitrary stderr chunks containing `"error"` into final run errors when the worker exits successfully and emits a valid result.
- **Independent Assessment:** Valid. The current `observedErrors` array mixes backend-classified parsed errors and heuristic stderr text. `finalizeRun()` passes deduped `observedErrors` into backend finalization even when `exitCode === 0`, so benign text such as `0 errors` can make a successful result look errored.
- **Decision:** alternative-fix
- **Approach:** Split backend-classified errors from heuristic stderr errors. Keep parsed backend errors in the finalization context because the backend classified them. Keep stderr logging/events, but only add heuristic stderr errors to the final result when the process fails or is otherwise terminal-failed. One implementation shape:
  - Replace `observedErrors` with `parsedErrors` and `stderrErrors`.
  - `handleJsonLine()` `addError` pushes into `parsedErrors`.
  - `child.stderr` pushes text into `stderrErrors` and may still append an error event for observability.
  - `finalizeRun()` builds errors as:
    - timeout/cancel: terminal override only
    - exit 0: `dedupeErrors(parsedErrors)`
    - nonzero exit: process-exit error plus `parsedErrors` plus `stderrErrors`
  Add a regression test where a worker exits 0 with a valid result while writing `0 errors` to stderr; assert the run completes without final result errors. Keep the existing failed parsed-error test passing.
- **Files To Change:** `src/processManager.ts`, `src/__tests__/processManager.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. Heuristic stderr text is still logged, but it is only promoted into final run errors for failed processes; successful worker results no longer inherit benign stderr messages. <!-- agent-orchestrator:pr15:c4 -->

## Item 5 | to-fix | Major

- **Comment Type:** review-inline
- **File:** `plans/11-add-robust-opencode-orchestration-harness-with-model-settings-and-orchestration-skills/plans/11-opencode-orchestration-harness.md:55`
- **Comment URL:** https://github.com/ralphkrauss/agent-orchestrator/pull/15#discussion_r3176823408
- **Author:** `coderabbitai[bot]`
- **Comment:** Remove real local OpenCode session handles and log paths from the committed plan.
- **Independent Assessment:** Valid. The plan includes actual-looking OpenCode session ids at lines 54 and 227 and a workstation log path at line 55. These are operational identifiers and should not be published in the public repo.
- **Decision:** fix-as-suggested
- **Approach:** Replace real session ids with placeholders such as `ses_<redacted>` or `local OpenCode session exports (redacted)`. Replace the exact log path with `~/.local/share/opencode/log/<redacted>.log` or a generic `local OpenCode log (redacted)`. Leave fake test inputs such as `ses_123` in tests/review evidence alone because they are synthetic examples.
- **Files To Change:** `plans/11-add-robust-opencode-orchestration-harness-with-model-settings-and-orchestration-skills/plans/11-opencode-orchestration-harness.md`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. The plan now redacts local OpenCode session handles and log names while preserving the useful implementation context. <!-- agent-orchestrator:pr15:c5 -->

## Item 6 | to-fix | Major

- **Comment Type:** review-body outside diff
- **File:** `src/mcpTools.ts:5`
- **Review ID:** `4215130711`
- **Author:** `coderabbitai[bot]`
- **Comment:** The exported MCP `start_run` JSON schema only requires `prompt` and `cwd`, while `StartRunInputSchema.superRefine()` rejects inputs missing both `backend` and `profile` and rejects profile mode mixed with direct settings.
- **Independent Assessment:** Valid. Tool consumers see a weaker schema than the daemon actually enforces. `src/__tests__/mcpTools.test.ts:26` currently asserts the weak required list.
- **Decision:** fix-as-suggested
- **Approach:** Encode the direct/profile union in `tools[0].inputSchema` using JSON Schema keywords. Keep `prompt` and `cwd` required globally, then add a `oneOf` like:
  ```json
  [
    { "required": ["backend"], "not": { "required": ["profile"] } },
    {
      "required": ["profile"],
      "not": {
        "anyOf": [
          { "required": ["backend"] },
          { "required": ["model"] },
          { "required": ["reasoning_effort"] },
          { "required": ["service_tier"] }
        ]
      }
    }
  ]
  ```
  Keep `profiles_file` optional for profile mode unless the TypeScript contract is also tightened. Update `mcpTools.test.ts` to assert the presence and shape of the union constraints instead of only `required: ['prompt', 'cwd']`.
- **Files To Change:** `src/mcpTools.ts`, `src/__tests__/mcpTools.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. The exported MCP schema now advertises the same direct-mode versus profile-mode constraints that the daemon validates at runtime. <!-- agent-orchestrator:pr15:c6 -->

## Item 7 | to-fix | Minor

- **Comment Type:** review-body duplicate item
- **File:** `src/backend/claudeValidation.ts:38`
- **Review ID:** `4215171821`
- **Author:** `coderabbitai[bot]`
- **Comment:** Use exact normalized Claude IDs for effort gating. Current substring checks let provider-prefixed or otherwise padded values satisfy `xhigh` and known-model validation.
- **Independent Assessment:** Valid. `isClaudeOpus47()` and `isKnownClaudeEffortModel()` use `includes()`. Since `normalizeClaudeModel()` only trims, lowercases, and removes `[1m]`, strings such as `anthropic/claude-opus-4-7` or `foo-claude-opus-4-7-bar` can pass checks that claim to require direct ids.
- **Decision:** fix-as-suggested
- **Approach:** Replace substring checks with exact membership after normalization:
  - `isClaudeOpus47(model)` should be `model === 'claude-opus-4-7'`.
  - `isKnownClaudeEffortModel(model)` should check a `Set` containing `claude-opus-4-7`, `claude-opus-4-6`, and `claude-sonnet-4-6`.
  - Keep `[1m]` support through `normalizeClaudeModel()`, so `claude-opus-4-7[1m]` normalizes to `claude-opus-4-7`.
  - Treat `model.includes('/claude-')` as a Claude model id for validation/error messaging, so provider-prefixed values are rejected instead of bypassing the known-model check.
  Add tests for rejected `anthropic/claude-opus-4-7` with `xhigh`, rejected `foo-claude-opus-4-7-bar` with `xhigh`, and accepted `claude-opus-4-7[1m]` with `xhigh`.
- **Files To Change:** `src/backend/claudeValidation.ts`, `src/__tests__/opencodeCapabilities.test.ts`, `src/__tests__/integration/orchestrator.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. Claude effort validation now uses exact normalized direct model ids, preserving the `[1m]` form while rejecting provider-prefixed or padded strings. <!-- agent-orchestrator:pr15:c7 -->

## CI Failure | to-fix | High

- **Check Runs:** `Build, Test, and Pack on Node 22`, `Build, Test, and Pack on Node 24`
- **Workflow Run:** https://github.com/ralphkrauss/agent-orchestrator/actions/runs/25255026980
- **Failing Step:** `Install packed tarball smoke test`
- **Observed Failure:** Both jobs pass `pnpm verify`, then fail with:
  ```text
  ./node_modules/.bin/agent-orchestrator-mcp: No such file or directory
  Process completed with exit code 127.
  ```
- **Independent Assessment:** Valid workflow failure. `.github/workflows/ci.yml:53-54` still calls the old package binary `agent-orchestrator-mcp`, but `package.json` now exposes `agent-orchestrator`, `agent-orchestrator-daemon`, and `agent-orchestrator-opencode`.
- **Decision:** fix workflow smoke
- **Approach:** Update the packed-tarball smoke step to call current bins. Recommended smoke:
  ```bash
  ./node_modules/.bin/agent-orchestrator --help
  ./node_modules/.bin/agent-orchestrator doctor --json
  ./node_modules/.bin/agent-orchestrator-daemon --help
  ./node_modules/.bin/agent-orchestrator-opencode --help
  ./node_modules/.bin/agent-orchestrator-opencode --print-config >/dev/null
  ./node_modules/.bin/agent-orchestrator opencode --print-config >/dev/null
  ```
  The two `--print-config` checks verify both OpenCode entry points without requiring the `opencode` binary on the CI runner.
- **Files To Change:** `.github/workflows/ci.yml`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. CI now smokes the current package entry points from the packed tarball instead of the removed `agent-orchestrator-mcp` bin. <!-- agent-orchestrator:pr15:ci -->

## Verification Plan

Run after implementing the map:

```bash
pnpm build
pnpm test
pnpm verify
node scripts/sync-ai-workspace.mjs --check
```

Also run a local packed-tarball smoke that mirrors CI with the new binary names:

```bash
repo_dir="$PWD"
package_file="$(npm pack --silent | tail -n 1)"
temp_dir="$(mktemp -d)"
cd "$temp_dir"
npm init -y >/dev/null
npm install "$repo_dir/$package_file" >/dev/null
./node_modules/.bin/agent-orchestrator --help
./node_modules/.bin/agent-orchestrator doctor --json
./node_modules/.bin/agent-orchestrator-daemon --help
./node_modules/.bin/agent-orchestrator-opencode --help
./node_modules/.bin/agent-orchestrator-opencode --print-config >/dev/null
./node_modules/.bin/agent-orchestrator opencode --print-config >/dev/null
```

After pushing, rerun or wait for PR checks. Expected result: both Node 22 and Node 24 jobs pass the `Install packed tarball smoke test` step.
