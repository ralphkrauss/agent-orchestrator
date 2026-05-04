# PR #25 Resolution Map

Branch: `16-add-coding-backend-for-cursor-sdk`
PR: https://github.com/ralphkrauss/agent-orchestrator/pull/25
Created: 2026-05-03 (Round 1) / Updated 2026-05-04 (Round 2 + CI failure triage; Open Human Decision 1 answered)

## Rounds

- **Round 1 (2026-05-03):** 9 CodeRabbit review comments — Comments 1-9 below. Resolved in commit `b03a30f` (see Implementation Evidence). 4 of 5 inline review threads now show as resolved on GitHub; only Comment 1 (deferred MD056 lint) remains unresolved per its `defer` decision.
- **Round 2 (2026-05-03):** Author self-review comment id `4366577087` posted by `ralphkrauss` as a PR conversation comment with 4 new findings (Comments 10-13 below). All four are now implemented in the working tree per "Implementation Evidence (Round 2, 2026-05-04)"; not yet committed/pushed.
- **CI status (2026-05-04):** GitHub Actions `Build, Test, and Pack on Node 22` and `Node 24` were both failing on commit `b03a30f`. Single root cause documented under "CI Failure Analysis" below; it overlapped with Comment 12 and is addressed by the Round-2 `pnpm.overrides` fix (`pnpm audit --prod` now exits clean locally). Re-evaluation against CI will happen on the next push.
- **Human decision (2026-05-04):** For Open Human Decision 1, the human (ralphkrauss) selected **option (b) Overrides** — add `pnpm.overrides`/top-level overrides for the vulnerable `@cursor/sdk` transitives, refresh the lockfile, and verify `pnpm audit --prod` + `pnpm test` (preserving the bundled optional SDK ergonomics if compatible). Comment 12 was reclassified from `escalate` to `fix-as-suggested` along the overrides path and has been implemented; no other open decisions remain.
- **Local reviewer note (2026-05-04):** A local reviewer note about Node v24.15.0 + missing `sqlite3` native binding was treated as Comment 14 (see below). The narrow code gap it exposed in `src/diagnostics.ts` `diagnoseCursorBackend` was fixed in scope; the environmental issue itself was left as a developer-side concern.

Round-1 totals: 9 actionable | fix-as-suggested 6 | defer 3 | decline 0 | escalate 0 — all from CodeRabbit, all independently verified.

Round-2 totals: 5 actionable (Comments 10-13 from author self-review + Comment 14 from local reviewer note) | fix-as-suggested 5 | defer 0 | decline 0 | escalate 0 (after the 2026-05-04 human decision; Comment 12 was originally escalated and is now `fix-as-suggested` along the overrides path) — all independently verified against the current code.

Aggregate open work after Round 2: 0 fix items remaining (Comments 10-14 implemented in the working tree, pending commit/push). Round-1 deferrals (Comments 1, 6, 7) remain deferred. No open human decisions.

## Comment 1 | defer | minor

- **Comment Type:** review-inline
- **File:** `plans/16-add-coding-backend-for-cursor-sdk/plans/16-cursor-agent-backend.md:86,89`
- **Comment ID:** 3177831321
- **Review ID:** 4216064364
- **Thread Node ID:** PRRT_kwDOSRv-qs5_LEau
- **Author:** coderabbitai[bot]
- **Comment:** MD056 — pipe characters inside table cells (lines 86 and 89) confuse the column count; suggest escaping `|` as `\|` inside cell text.
- **Independent Assessment:** Valid markdownlint warning. The rows include inline code spans like `` `kind: 'cli' \| 'sdk'` `` where the `\` escape doesn't apply inside backticks under GitHub-flavored markdown — the raw `|` inside the code span is parsed as a column boundary, which is exactly what MD056 reports. Effect is confined to an archived plan document; readers can still get the gist on GitHub but the affected rows do show as malformed (truncated/merged columns) under strict GFM table parsing.
- **Decision:** defer
- **Approach:** None for this PR. Plan archive doc is finalized; lint cleanup on archived plans is out of scope here. Optional follow-up: a janitorial pass that escapes raw pipes inside code spans across the plan archive (replace `'cli' \| 'sdk'` inside backticks with non-backtick wording like ``kind: 'cli' or 'sdk'`` or by splitting the code span).
- **Files To Change:** none
- **Reply Draft:**
  > **[AI Agent]:** Deferring as out of scope for this PR. The warning is real — `\|` doesn't escape pipes inside inline code spans under GFM, so MD056 fires on rows D3 and D6 — but the file is an archived plan document and lint cleanup on plan archives isn't in this PR's scope. Tracking as a janitorial follow-up if we sweep plan-archive lint warnings as a batch.

## Comment 2 | fix-as-suggested | minor

- **Comment Type:** review-inline
- **File:** `src/__tests__/opencodeCapabilities.test.ts:158`
- **Comment ID:** 3177831323
- **Review ID:** 4216064364
- **Thread Node ID:** PRRT_kwDOSRv-qs5_LEaw
- **Author:** coderabbitai[bot]
- **Comment:** Add a standalone happy-path test for the cursor profile (validates a minimal `cursor` manifest with just `model`).
- **Independent Assessment:** Valid. The existing test at lines 131-158 only proves rejection for `cursorBadEffort`/`cursorMissingModel`; the `cursorOk` entry is in the same manifest, so the assertion `result.ok === false` does not prove the happy-path validates. A separate test covering only `cursorOk` and asserting `result.ok === true` would close the regression hole.
- **Decision:** fix-as-suggested
- **Approach:** In `src/__tests__/opencodeCapabilities.test.ts` add a new `it('accepts a minimal cursor profile', ...)` block immediately after the existing `it('accepts cursor profiles that pass model only and rejects unsupported settings', ...)`. The new test parses a manifest containing only a `cursorOk` profile (`backend: 'cursor'`, `model: 'composer-2'`), runs `validateWorkerProfiles`, and asserts both `manifest.ok === true` and `result.ok === true`. Do not change the existing rejection test.
- **Files To Change:** `src/__tests__/opencodeCapabilities.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Done. Added a standalone `it('accepts a minimal cursor profile', ...)` test that validates a `cursor`+`model` profile and asserts `result.ok === true`, complementing the existing rejection coverage.

## Comment 3 | fix-as-suggested | major

- **Comment Type:** review-inline
- **File:** `src/backend/cursor/cursorEvents.ts:73-79`
- **Comment ID:** 3177831327
- **Review ID:** 4216064364
- **Thread Node ID:** PRRT_kwDOSRv-qs5_LEa0
- **Author:** coderabbitai[bot]
- **Comment:** `handleAssistant` pushes a raw `assistant_message` and then a second `assistant_message` whenever text is present, duplicating the same assistant turn downstream. Fold into a single normalized event.
- **Independent Assessment:** Valid bug. Lines 73 and 78 in `src/backend/cursor/cursorEvents.ts` both push `{ type: 'assistant_message', ... }` for the same `rec`. Existing `cursorEvents.test.ts:13-32` only checks `types.includes('assistant_message')` so the duplication is untested. Downstream consumers persist these events to `events.jsonl` via `processCursorMessage` → `store.appendEvent`, so duplicate emission ends up in the durable run log. Tool-use blocks are unaffected (handled separately in the loop after the message push).
- **Decision:** fix-as-suggested
- **Approach:** In `src/backend/cursor/cursorEvents.ts` modify `handleAssistant` so it pushes exactly one `assistant_message`. When extracted text exists, the payload is `{ text, raw: rec }`; otherwise the payload is the raw record. Keep the subsequent tool_use loop unchanged. Update `src/__tests__/cursorEvents.test.ts` so the assistant-message test asserts the count is exactly 1 (e.g., `assert.equal(types.filter((t) => t === 'assistant_message').length, 1)`) and that the payload has the expected `text` when text is present. Do not change the function signature or the `tool_use`/`filesChanged`/`commandsRun` extraction.
- **Files To Change:** `src/backend/cursor/cursorEvents.ts`, `src/__tests__/cursorEvents.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. `handleAssistant` now emits exactly one `assistant_message` event per Cursor turn, with payload `{ text, raw }` when text is present and the raw record otherwise. Updated `cursorEvents.test.ts` to assert the count and payload shape.

## Comment 4 | fix-as-suggested | major

- **Comment Type:** review-inline
- **File:** `src/backend/cursor/runtime.ts:258-273`
- **Comment ID:** 3177831329
- **Review ID:** 4216064364
- **Thread Node ID:** PRRT_kwDOSRv-qs5_LEa1
- **Author:** coderabbitai[bot]
- **Comment:** Cancellation timeout is bypassed for late cancel requests. `state.cancelStatus` is snapshot-checked once at lines 258 and 266; a `cancel()` arriving after those checks lets the path block on unbounded `await drainPromise` / `await state.run.wait()`, so `cancelDrainMs` is not enforced. Heavy-lift suggestion: track cancel as a `Promise<void>` signal and race remaining work against it.
- **Independent Assessment:** Verified bug and a D12 plan-compliance gap. Plan decision D12 (`plans/16-cursor-agent-backend.md:95`) commits the cursor backend to `run.cancel()` followed by a **bounded** drain. The current code in `drainAndFinalize` (`runtime.ts:258-273`) only honors that bound on the early branch where `state.cancelStatus` is already truthy at line 258. When a user cancel lands after that snapshot — the common shape, since `run.cancel()` is invoked from `handle.cancel(...)` independently of the drain loop — execution is on the `else` branch and waits unboundedly on `drainPromise`, then unboundedly on `state.run.wait()`. The bound only re-applies to `state.run.wait()` if `cancelStatus` was set by line 266; same race. So in the majority of real cancels the documented `cancelDrainMs` bound is not enforced. The SDK terminating the stream on `run.cancel()` is a happy-path mitigation, not a guarantee, and the plan does not allow the implementation to depend on it. Existing tests cover only early cancel. The fix is non-trivial but contained to `drainAndFinalize` plus one regression test, and lives entirely within the approved plan scope.
- **Decision:** fix-as-suggested
- **Approach:** In `src/backend/cursor/runtime.ts`, add a `cancelRequested` deferred to `CursorRunState` — a `Promise<void>` plus its resolver — initialized when the handle is created. In `handle.cancel(...)` (currently `runtime.ts:215-220`), resolve `cancelRequested` before invoking `state.run.cancel()` so the signal is observable independent of the `cancelStatus` snapshot. In `drainAndFinalize`, replace the two `if (state.cancelStatus) { ... } else { ... }` snapshot blocks (`runtime.ts:258-273`) with a single sequence that bounds both phases once cancel is requested: (1) `await Promise.race([drainPromise, state.cancelRequested])`; if cancel was requested but `drainPromise` has not resolved, `await Promise.race([drainPromise, sleep(state.cancelDrainMs)])`. (2) The same pattern for `state.run.wait()`: race against `cancelRequested`, then race the remaining `state.run.wait()` against `sleep(state.cancelDrainMs)`. Reuse the existing `setTimeout`-based sleep helpers already used at lines 261 and 271. The synthesized `runResult` fallback (`{ status: state.run.status }`) on the timeout path stays as today. Add a regression test in `src/__tests__/cursorRuntime.test.ts` using a fake `CursorRun` whose `stream()` and `wait()` ignore `run.cancel()` (i.e. never resolve naturally), call `service.cancelRun(...)` after the run is registered, and assert `service.waitForRun(...)` returns `cancelled` within roughly `cancelDrainMs * 2` (the helper added in Comment 8 can be reused for the active-handle wait).
- **Files To Change:** `src/backend/cursor/runtime.ts`, `src/__tests__/cursorRuntime.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed (D12 plan-compliance). Reworked `drainAndFinalize` to track cancel as a deferred `Promise<void>` resolved inside `handle.cancel(...)`, and to race both stream drain and `state.run.wait()` against `cancelDrainMs` once a cancel is observed regardless of when it arrives. Added a regression test that drives a late cancel against a fake SDK that ignores `run.cancel()` and asserts finalization completes within the bound.

## Comment 5 | fix-as-suggested | major

- **Comment Type:** review-inline
- **File:** `src/backend/cursor/sdk.ts:171-189`
- **Comment ID:** 3177831331
- **Review ID:** 4216064364
- **Thread Node ID:** PRRT_kwDOSRv-qs5_LEa3
- **Author:** coderabbitai[bot]
- **Comment:** `extractAgentApi()` throws when `@cursor/sdk` exists but lacks the expected `Agent` factory. In `available()` (line 177) this rejects the promise instead of returning `{ ok: false, reason }`, breaking the adapter contract and causing diagnostics to crash. Wrap the call in `available()` and `loadAgentApi()` in try/catch and convert to `{ ok: false, reason: error.message }`.
- **Independent Assessment:** Valid contract bug. `CursorSdkAdapter.available()` is documented at `sdk.ts:147` as returning `{ ok: false, reason }` rather than throwing; consumers (e.g. `runtime.ts:76`, diagnostics) rely on that. If a future or partially-incompatible `@cursor/sdk` exports something other than the expected `Agent` factory, `extractAgentApi` throws and breaks the contract. The reviewer's suggested diff for `loadAgentApi` has a small scope bug (declares `api` inside the `try` but uses it after) — must hoist `api` into the outer scope when implementing.
- **Decision:** fix-as-suggested (with the small scope correction)
- **Approach:** In `src/backend/cursor/sdk.ts` wrap the `extractAgentApi(result.module)` call in `available()` (around line 177) in a try/catch that sets `state.available = { ok: false, reason: errorMessage }` on throw and returns it. In `loadAgentApi()` (around line 187) declare `const api: CursorAgentApi` via `let api: CursorAgentApi`, wrap `extractAgentApi(result.module)` in a try/catch that, on throw, sets `state.available = { ok: false, reason: errorMessage }` and rethrows — preserving the existing behavior that `loadAgentApi` rejects when the SDK is unusable while keeping `available()` total. Add a unit test in `cursorRuntime.test.ts` (or a new dedicated file) that mocks `@cursor/sdk` to expose an unexpected shape and asserts `adapter.available()` resolves to `{ ok: false, reason: <Agent factory message> }` rather than rejecting.
- **Files To Change:** `src/backend/cursor/sdk.ts`, `src/__tests__/cursorRuntime.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. Wrapped `extractAgentApi` calls in both `available()` and `loadAgentApi()` so a malformed SDK shape now surfaces as `{ ok: false, reason }` from `available()` (preserving the contract) and is rethrown from `loadAgentApi()` after caching the failure. Added a regression test for the malformed-shape path.

## Comment 6 | defer | nit

- **Comment Type:** review-body (Nitpick, lines 27-34)
- **File:** `.agents/skills/orchestrate-create-plan/SKILL.md:27-34`
- **Comment ID:** (no separate inline comment; bundled in review body 4216064364)
- **Review ID:** 4216064364
- **Author:** coderabbitai[bot]
- **Comment:** Line 31-34 derives the GitHub issue from the branch name; suggest adding a one-step human confirmation (resolved issue URL/number + confirm/override) before workers fetch.
- **Independent Assessment:** Workflow-ergonomics suggestion. The current skill already says "Ask the human for an issue URL/number only when the branch and user request do not identify one clearly," which implicitly trusts the branch derivation. CodeRabbit suggests an explicit confirm step on every auto-derive. Reasonable but adds friction; this is a process choice the human (Ralph) should make rather than a bug.
- **Decision:** defer
- **Approach:** None in this PR. If accepted later, the change is a small wording tweak to step 1 (lines 27-34) of `.agents/skills/orchestrate-create-plan/SKILL.md` followed by `node scripts/sync-ai-workspace.mjs` to refresh projections.
- **Files To Change:** none
- **Reply Draft:**
  > **[AI Agent]:** Deferring. Adding an explicit confirm step on every auto-derive is a workflow-ergonomics choice for the supervisor flow, not a bug. The current wording already routes ambiguous cases to the human. Open to revisiting if the branch-derivation path produces a wrong-issue incident.

## Comment 7 | defer | nit

- **Comment Type:** review-body (Nitpick, lines 39-43)
- **File:** `.agents/skills/orchestrate-implement-plan/SKILL.md:39-43`
- **Comment ID:** (no separate inline comment; bundled in review body 4216064364)
- **Review ID:** 4216064364
- **Author:** coderabbitai[bot]
- **Comment:** Require the worker to report explicit dirty-state evidence (porcelain status / tracked+untracked file list) before implementation begins.
- **Independent Assessment:** Workflow-ergonomics suggestion. The current preflight already says "If unrelated or risky dirty files exist, stop and ask the human before implementation begins" — it relies on the worker to report before deciding. Adding a requirement for explicit porcelain output is reasonable but is a process refinement; not a bug.
- **Decision:** defer
- **Approach:** None in this PR. If accepted later, the change is a small wording tweak to step 1 (lines 39-43) of `.agents/skills/orchestrate-implement-plan/SKILL.md` followed by `node scripts/sync-ai-workspace.mjs`.
- **Files To Change:** none
- **Reply Draft:**
  > **[AI Agent]:** Deferring. The current preflight already requires the worker to report status before implementation; making porcelain output mandatory is a process refinement rather than a defect.

## Comment 8 | fix-as-suggested | nit

- **Comment Type:** review-body (Nitpick, lines 225-227, 541-543, 590-591)
- **File:** `src/__tests__/cursorRuntime.test.ts:225-227, 541-543, 590-591`
- **Comment ID:** (no separate inline comment; bundled in review body 4216064364)
- **Review ID:** 4216064364
- **Author:** coderabbitai[bot]
- **Comment:** Replace `setTimeout(50)` waits with a deterministic poll on the actual condition (active handle present, run not running, etc.) to remove CI flakiness.
- **Independent Assessment:** Valid. Lines 226, 542, and 590 each `setTimeout(resolve, 50)` to wait for the orchestrator to register the active run handle before cancel/timeout testing. This is a known flake-source pattern under load.
- **Decision:** fix-as-suggested
- **Approach:** In `src/__tests__/cursorRuntime.test.ts` add a small helper near the top (e.g. `async function waitForActiveHandle(service: OrchestratorService, runId: string, timeoutMs = 2_000)`). The helper polls `(service as unknown as { activeRuns: Map<string, unknown> }).activeRuns.has(runId)` (or equivalent) every 5-10ms until true, throwing on timeout. Replace each of the three `setTimeout(50)` calls with `await waitForActiveHandle(service, runId)`. Keep the rest of each test unchanged.
- **Files To Change:** `src/__tests__/cursorRuntime.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. Replaced the three `setTimeout(50)` waits with a polling helper that resolves as soon as `service.activeRuns` registers the run id, with a bounded timeout. Reduces flakiness without slowing down the happy path.

## Comment 9 | fix-as-suggested | major

- **Comment Type:** review-body (Additional comments → `src/backend/cursor/errors.ts (1)`, lines 20-27 with "Also applies to: 54-65")
- **File:** `src/backend/cursor/errors.ts:20-65`
- **Comment ID:** (no separate inline comment; bundled in review body 4216064364 under "Additional comments")
- **Review ID:** 4216064364
- **Author:** coderabbitai[bot]
- **Comment:** Verify the SDK error-class mapping before relying on it. `ConfigurationError` is treated as `invalid_model` unless the message matches the agent-specific regex; if the Cursor SDK also uses that class for auth or transport failures, those runs will be categorized incorrectly and retry behavior will be off.
- **Independent Assessment:** Valid bug. Verified against the locally installed `@cursor/sdk` 1.0.12 type definitions at `node_modules/@cursor/sdk/dist/esm/errors.d.ts:74-81`: `ConfigurationError` is documented as covering 400/404 with examples **"Bad API key, invalid model name, invalid request parameters"** — i.e. it is intentionally overloaded for at least three categories. The current `knownClassCategory` map (`errors.ts:23`) sets `ConfigurationError → invalid_model`, and the sole reclassification block at `errors.ts:54-59` only catches stale-agent messages (rerouted to `protocol`). Bad-API-key cases under `ConfigurationError` are therefore reported as `invalid_model` instead of `auth`, which (a) misleads operators, (b) breaks retry semantics (auth is non-retryable but is not currently retried anyway, so the practical retry-policy regression is small), and (c) drives the wrong diagnostics hint. Note: `IntegrationNotConnectedError` extends `ConfigurationError` but is matched by class name first in `knownClassCategory` (→ `auth`), so that subclass is unaffected.
- **Decision:** fix-as-suggested (refine, not rewrite — keep `ConfigurationError → invalid_model` as the default, but add message-based reclassification for the two known overloads)
- **Approach:** In `src/backend/cursor/errors.ts`, extend the `if (errorClass === 'ConfigurationError')` block (lines 54-59) so it also reclassifies bad-API-key and invalid-request-parameter messages: when `lower` matches `/(api[ _]?key|unauthor[iz]ed|authentication)/` set `category = 'auth'`; when `lower` matches `/(invalid request|invalid parameter|missing parameter|bad request)/` set `category = 'protocol'`. Keep the existing stale-agent → `protocol` branch first so it remains authoritative for that case. Do **not** remove `ConfigurationError` from `knownClassCategory` — leaving it as `invalid_model` keeps the documented "invalid model name" example correct as the default. Add focused tests in `src/__tests__/cursorRuntime.test.ts` (or a new dedicated file) that drive `normalizeCursorSdkError` (or run a failing start through the existing test harness) for: (a) `ConfigurationError` with a "bad api key" message → `auth`, (b) `ConfigurationError` with an "invalid request parameter" message → `protocol`, and (c) the existing "Invalid model: composer-99 not found" case still → `invalid_model` (regression).
- **Files To Change:** `src/backend/cursor/errors.ts`, `src/__tests__/cursorRuntime.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. Verified against `@cursor/sdk` 1.0.12 (`errors.d.ts:74-81`): `ConfigurationError` is documented as covering bad API keys, invalid model names, and invalid request parameters. Extended the existing `ConfigurationError` reclassification block in `errors.ts` so bad-API-key messages map to `auth` and invalid-parameter messages map to `protocol`, while keeping `invalid_model` as the default for "invalid model name" (the stable case). Added regression tests for all three message shapes.

## Filtered (non-actionable)

- Conversation comment id=4365717132 (coderabbitai walkthrough summary) — auto-generated PR walkthrough, informational only.
- Review body "Additional comments" entries other than `errors.ts` (Comment 9 above) — affirmations of correctly-implemented decisions (`.agents/skills/orchestrate-create-plan/SKILL.md` 78-83, `.agents/skills/orchestrate-implement-plan/SKILL.md` 89-111 + 150-154, `package.json` 57-59, `src/contract.ts` 32-33, `src/opencode/capabilities.ts` 87-105 + 181-197, `src/__tests__/contract.test.ts` 3-10, `plans/.../plan.md` 1-10), no action.
- Review body "Review info / Path-based instructions / Files selected / Run configuration / Files ignored" — review metadata, no action.

## Comment 10 | fix-as-suggested | major (Round 2)

- **Comment Type:** review-body (author self-review, conversation comment)
- **File:** `src/backend/cursor/runtime.ts:386` (`buildFinalizeContext`) with finalize logic in `src/backend/common.ts:68-97` (`finalizeFromObserved`).
- **Comment ID:** 4366577087 (Round 2 wrapper; Finding #1)
- **Author:** ralphkrauss
- **Comment:** Cursor SDK terminal error runs can finish with no error evidence (high). `buildFinalizeContext()` builds a `resultEvent` for any `runResult`, including `{ status: 'error' }`, but only forwards `state.observedErrors` into `errors`. When the SDK reports `Run.status === "error"` without yielding a parseable error/status message, `finalizeFromObserved()` sees a present `resultEvent` and does not add the generic `'worker result event missing'` error. The run is marked `failed` but `WorkerResult.summary === ""`, `WorkerResult.errors === []`, and `RunSummary.latest_error === null`. Reproduced with a fake Cursor run whose `stream()` yields nothing and whose `wait()` returns `{ status: 'error' }`.
- **Independent Assessment:** Verified bug. `runtime.ts:386-392` always builds a non-null `stopReasonForResult` when `runResult` is truthy — including `{ status: 'error' }` with no `result` text — producing `{ summary: '', stopReason: 'error', raw: runResult }`. Passed in as `resultEvent` to `finalizeFromObserved`, this satisfies the gate at `common.ts:69` (`context.resultEvent || context.runStatusOverride`), so the missing-result `validationError` is **not** appended. With no `state.observedErrors` and no `overrideError` (status `failed`, not `cancelled`/`timed_out`), `errors` stays empty. `actionableErrorSummary([])` returns `""`, and `WorkerResult` ends up `{ status: <derived>, summary: '', errors: [] }`. Downstream `latest_error` (driven by `errors`) becomes null. This is a contract gap relative to "errored runs report durable error context", and is invisible to current tests because the existing `marks errored SDK runs as failed` test in `cursorRuntime.test.ts` always supplies an observed parse error, so the empty path is uncovered. Severity high — operators investigating a failed run see no diagnostic.
- **Decision:** fix-as-suggested
- **Approach:** In `src/backend/cursor/runtime.ts`, change `buildFinalizeContext` so that an SDK `runResult.status === 'error'` (and arguably any non-`'finished'` status when no `state.resultEvent` was observed) does **not** silently mask the missing-result fallback. Two clean options — pick the first unless it conflicts with other tests:
  1. **Synthesize a cursor run-failure `RunError` when terminal SDK status maps to `failed` and `state.observedErrors` is empty.** Add a helper `cursorMissingErrorRunError(runResult, runId)` near the other `cursorRunError`/`cursorRunFailureRunError` helpers in `src/backend/cursor/errors.ts` that returns a `RunError` with `message` like `'cursor run finished with status "error" but the SDK reported no error details'`, `category: 'protocol'` (or `'unknown'`), and `context: { sdk_run_id, sdk_run_status, sdk_run_result }`. In `buildFinalizeContext`, when `status === 'failed'` and `runResult` is truthy and `state.observedErrors.length === 0` and `overrideError === null`, push the synthesized `RunError` into `baseErrors` (not into `state.observedErrors`, to keep state immutable for finalize). Pass it through, and let `finalizeFromObserved` build `summary` via `actionableErrorSummary(errors)` (which now returns the synthesized message) and downstream `latest_error` via the existing `markTerminal` path.
  2. **Or** treat the `{ status: 'error', result: undefined }` case as no-result by setting `stopReasonForResult = state.resultEvent` (i.e. `null` when no parsed result) when `runResult.status === 'error'` and `runResult.result == null` and there is no `state.resultEvent`. That re-enables the existing `'worker result event missing'` fallback in `finalizeFromObserved`. This is more conservative but produces a less specific error message. Prefer (1) so the operator gets cursor-specific context.
  Add a regression test in `src/__tests__/cursorRuntime.test.ts` that uses a fake SDK whose `stream()` yields nothing (no error events) and whose `wait()` resolves to `{ status: 'error' }` (no `result`, no `error`). Drive a full `start_run → wait_for_run → get_run_result` cycle and assert: (a) `RunSummary.status === 'failed'`, (b) `RunSummary.latest_error.message` is the synthesized message, (c) `WorkerResult.errors.length === 1` with the same message, (d) `WorkerResult.summary` is non-empty and equals the synthesized message. Keep the existing `marks errored SDK runs as failed` test (which exercises the with-observed-errors path) unchanged.
- **Files To Change:** `src/backend/cursor/runtime.ts`, `src/backend/cursor/errors.ts`, `src/__tests__/cursorRuntime.test.ts`.
- **Reply Draft:**
  > **[AI Agent]:** Fixed. When the Cursor SDK reports `Run.status === 'error'` with no parsed error events, `buildFinalizeContext` now synthesizes a cursor-specific `RunError` (category `protocol`) carrying `sdk_run_id`/`sdk_run_status`/`sdk_run_result` context and feeds it through finalize so `WorkerResult.summary`, `WorkerResult.errors`, and `RunSummary.latest_error` are populated. Added a regression test using a fake SDK whose `stream()` yields nothing and whose `wait()` returns `{ status: 'error' }`, asserting all three durable fields surface the synthesized error.

## Comment 11 | fix-as-suggested | major (Round 2, plan-compliance)

- **Comment Type:** review-body (author self-review, conversation comment)
- **File:** `.agents/rules/ai-workspace-projections.md:23` (rule); affected projections: `.claude/skills/orchestrate-create-plan/SKILL.md`, `.claude/skills/orchestrate-implement-plan/SKILL.md`, `.claude/skills/orchestrate-resolve-pr-comments/SKILL.md`.
- **Comment ID:** 4366577087 (Round 2 wrapper; Finding #2)
- **Author:** ralphkrauss
- **Comment:** AI workspace projections are stale (high). The branch changes canonical `.agents/skills/orchestrate-*` files but does not update the generated `.claude/skills/*` projections. `node scripts/sync-ai-workspace.mjs --check` exits 1 listing the three stale projections. The repository rule explicitly says to regenerate projections with `node scripts/sync-ai-workspace.mjs`.
- **Independent Assessment:** Verified locally on the worktree at `2026-05-04`. `node scripts/sync-ai-workspace.mjs --check` exits with status 1 and the message `AI workspace projections are out of sync:` followed by the same three paths. This is a rule-compliance gap, not a CI failure (CI does not run `--check`); but it is enforced by the project rule and would be flagged by any reviewer or future supervisor consuming `.claude/skills/`. Bounded mechanical fix.
- **Decision:** fix-as-suggested
- **Approach:** From the worktree root, run `node scripts/sync-ai-workspace.mjs` (no flags). Confirm the diff is limited to the three `.claude/skills/orchestrate-*/SKILL.md` files and any other expected projection targets. Re-run `node scripts/sync-ai-workspace.mjs --check` and verify it exits 0. Stage and commit the regenerated files in a single commit (e.g. `chore(ai-workspace): regenerate Claude skill projections`). Do **not** hand-edit projections — they are generated. Do not rebase against `origin/main` unless drift is in fact caused by upstream changes; the canonical edits already on this branch are sufficient to need a regeneration.
- **Files To Change:** `.claude/skills/orchestrate-create-plan/SKILL.md`, `.claude/skills/orchestrate-implement-plan/SKILL.md`, `.claude/skills/orchestrate-resolve-pr-comments/SKILL.md` (any other paths the script touches should also be committed).
- **Reply Draft:**
  > **[AI Agent]:** Fixed. Ran `node scripts/sync-ai-workspace.mjs` and committed the regenerated projections under `.claude/skills/orchestrate-*/SKILL.md`. `node scripts/sync-ai-workspace.mjs --check` now exits 0.

## Comment 12 | fix-as-suggested | high (Round 2, also CI failure root cause; human-decision selected path: overrides)

- **Comment Type:** review-body (author self-review, conversation comment)
- **File:** `package.json:24` (verify script); transitively `pnpm-lock.yaml` and the `@cursor/sdk` dependency tree.
- **Comment ID:** 4366577087 (Round 2 wrapper; Finding #3)
- **Author:** ralphkrauss
- **Comment:** Release-quality verification is still blocked by production audit findings (high). `pnpm verify` is the repo release-quality check and includes `pnpm audit --prod`. The new optional `@cursor/sdk` dependency makes `pnpm audit --prod` fail with 12 advisories total — 6 high `tar`, 2 high `undici`, 3 moderate `undici`, and 1 low `@tootallnate/once` — all reaching production through `@cursor/sdk > sqlite3 > tar` and `@cursor/sdk > @connectrpc/connect-node > undici` (and one transitive `@tootallnate/once`). The branch cannot satisfy the plan's T8 quality gate or the documented release gate as-is. Recommendation: decide and implement the release policy (wait for upstream fix and refresh lockfile, add a justified override if compatible, or document and explicitly accept a scoped audit exception).
- **Independent Assessment:** Verified. The CI run for commit `b03a30f` (workflow run id `25280168979`) shows both `Build, Test, and Pack on Node 22` and `Node 24` failing at the `pnpm audit --prod` step with `12 vulnerabilities found` and exiting with `ELIFECYCLE Command failed with exit code 1`. The advisory log lists the same `node-tar` (`<7.5.7`/`<=7.5.10`/`<=7.5.9`/`<6.24.0`/etc.), `undici`, and `@tootallnate/once` shapes. All other CI steps (build, the 150 unit tests, publish-readiness, tag resolution) pass cleanly. So the CI failure is exactly this advisory set and nothing else.
- **Decision:** **fix-as-suggested — overrides path, selected by the human (ralphkrauss) on 2026-05-04.** Add `pnpm.overrides` for the vulnerable `@cursor/sdk` transitives (`tar`, `undici`, `@tootallnate/once`), refresh the lockfile, and verify with `pnpm audit --prod` + `pnpm test`. The human explicitly preferred preserving the bundled optional SDK ergonomics (i.e. **do not** move `@cursor/sdk` to `peerDependencies` and **do not** remove the manifest entry) **if** the overrides remain compatible with `@cursor/sdk`'s native deps. If overrides turn out to break `@cursor/sdk` at runtime (e.g. `sqlite3` build/import failure under the pinned `tar`, or `@connectrpc/connect-node` failure under the pinned `undici`), stop and escalate again rather than silently widening scope. The previously documented options (a) wait-for-upstream, (c) audit allowlist, and (d1)/(d2) re-package were considered and not selected. **Note for context:** demote-to-`optionalDependencies` was not on the table because `@cursor/sdk` is already in `optionalDependencies` (`package.json:57-58`) and `pnpm audit --prod` still fails — the optional-dep escape hatch has already been used.
- **Approach (overrides path — implementer instructions):**
  1. **Identify advisory groups and target patched versions.** Run `pnpm audit --prod --json > /tmp/audit.json` against the current branch and parse out the advisory IDs and `patched_versions` ranges. Authoritative grouping for triage is **6 high `tar` + 2 high `undici` + 3 moderate `undici` + 1 low `@tootallnate/once` = 12**. From the advisory `Patched in` lines, derive the lowest fully-fixed version for each direct override target. The CI log showed `tar` ranges of `<7.5.7`, `<=7.5.10`, `<=7.5.9`, `<=7.5.3`, `<=7.5.2` and legacy 6.x ranges (`<6.24.0`, `<6.23.0`); pin `tar` to the highest patched version that still resolves under `@cursor/sdk > sqlite3 > node-gyp/...` (start with `^7.5.11` or whatever the latest 7.x at implementation time is). The CI log showed `undici` ranges including `<6.24.0`/`<7.x`-style entries; pin `undici` to a version that satisfies all five advisories (start with the highest patched in the audit, typically a current 7.x). Pin `@tootallnate/once` to `^3.0.1` (satisfies GHSA-vpq2-c234-7xj6).
  2. **Add the overrides block.** In `package.json`, add a `pnpm.overrides` field at the top level (the repo uses pnpm; do **not** use the npm-style top-level `overrides` since pnpm-specific behavior is wanted). Shape:
     ```json
     "pnpm": {
       "overrides": {
         "tar": "^<patched-version>",
         "undici": "^<patched-version>",
         "@tootallnate/once": "^3.0.1"
       }
     }
     ```
     Replace `<patched-version>` with the highest version range from step 1. Do **not** scope override keys to `@cursor/sdk>tar` etc. unless step 4 verification reveals collisions with non-cursor consumers — start with broad keys for simplicity, narrow only on conflict.
  3. **Refresh the lockfile.** Run `pnpm install` (without `--frozen-lockfile`) to regenerate `pnpm-lock.yaml`. Inspect the diff — only the overridden packages and their dependents should change. If unrelated packages move, investigate before committing.
  4. **Verify.** Run, in order: `pnpm install --frozen-lockfile` (must succeed cleanly), `pnpm build` (must compile), `pnpm audit --prod` (**must exit 0** — this is the gating criterion), and `pnpm test` (all 150 tests must pass; pay particular attention to `defaultCursorSdkAdapter contract`, `CursorSdkRuntime missing-SDK behavior`, `CursorSdkRuntime success and cancellation paths`, and `CursorSdkRuntime end-to-end orchestration with a fake SDK adapter`, since those exercise the real `@cursor/sdk` import path or the test-seam adapter and would be the first to fail if a `tar`/`undici` override broke the SDK). Finally run `pnpm verify` end-to-end to confirm `npm pack --dry-run` also passes.
  5. **Compatibility-with-SDK check.** The human's preference is to preserve the bundled optional SDK ergonomics if compatible. If `pnpm install` or `pnpm test` shows `@cursor/sdk` (or its `sqlite3` / `@connectrpc/connect-node` transitives) failing under the new override versions — for example native `sqlite3` build errors, or `@connectrpc/connect-node` failing on a newer `undici` major — **do not** loosen the override or switch silently to a different policy path. Stop, restore Open Human Decision 1, and surface the incompatibility so the human can choose between (a) wait-for-upstream, (c) audit allowlist, or (d1)/(d2) re-packaging.
  6. **Document the overrides.** Add a short note in `PUBLISHING.md` under the release-gate section explaining that the `pnpm.overrides` block exists to clear the `pnpm audit --prod` gate against advisories pulled through `@cursor/sdk` transitives, list the advisory IDs it covers, and state the policy that overrides should be revisited each time `@cursor/sdk` ships a new minor — the goal is for upstream to ship a clean tree and for the override to be removable. Reference Comment 12 / Open Human Decision 1 in this resolution map for context. Also update `plans/16-add-coding-backend-for-cursor-sdk/plans/16-cursor-agent-backend.md` T8 evidence to record that the release gate now passes via the overrides policy.
  7. **Out of scope for this task:** do **not** also implement audit-allowlist scripts (option c), peer-dep moves (d1), or manifest removal (d2). Those were explicitly not selected.
- **Files To Change:** `package.json` (add `pnpm.overrides`), `pnpm-lock.yaml` (regenerated), `PUBLISHING.md` (short policy note), `plans/16-add-coding-backend-for-cursor-sdk/plans/16-cursor-agent-backend.md` (T8 evidence). Do **not** add new tests — the existing test suite already exercises the cursor SDK paths and is the regression signal for override compatibility.
- **Reply Draft:**
  > **[AI Agent]:** Resolved by the overrides path (selected by the maintainer). Added `pnpm.overrides` for `tar`, `undici`, and `@tootallnate/once` pinned to fixed versions, refreshed `pnpm-lock.yaml`, and confirmed `pnpm audit --prod` now exits 0, `pnpm test` still passes (150 ✔), and `pnpm verify` reaches `npm pack --dry-run` cleanly. `@cursor/sdk` remains in `optionalDependencies`, so the bundled-install ergonomics are preserved. Recorded the policy and the advisory IDs the overrides cover in `PUBLISHING.md`; the overrides should be revisited each time upstream `@cursor/sdk` ships a new minor.

## Comment 13 | fix-as-suggested | medium (Round 2)

- **Comment Type:** review-body (author self-review, conversation comment)
- **File:** `src/backend/cursor/sdk.ts:171` (current `importSdk` helper). Reporter at `src/backend/cursor/runtime.ts` (the install-hint message).
- **Comment ID:** 4366577087 (Round 2 wrapper; Finding #4)
- **Author:** ralphkrauss
- **Comment:** Installed-but-broken Cursor SDK is reported as "not installed" (medium). `defaultCursorSdkAdapter.available()` treats any dynamic import failure as `{ ok: false }`, and `CursorSdkRuntime` reports that as "`@cursor/sdk` module is not installed". In this checkout the package is installed and resolvable, but importing it fails because `sqlite3` has no native binding for the current Node runtime. The resulting install hint (`npm install @cursor/sdk`) is misleading for a built/native-dependency failure.
- **Independent Assessment:** Verified at `src/backend/cursor/sdk.ts:171-179`: `importSdk` does `await loadModule()` first and only calls `pathResolver()` if import succeeds (line 174). Any import error (including native-binding ENOENT from `sqlite3`) is caught at line 176 and returned as `{ ok: false, reason }` — losing the resolution-vs-import distinction. The runtime then surfaces this as a generic "not installed" + `npm install @cursor/sdk` hint, which is misleading for a resolvable-but-broken SDK. Bounded UX/diagnostic fix; in scope (cursor backend), low blast radius.
- **Decision:** fix-as-suggested
- **Approach:** In `src/backend/cursor/sdk.ts`, change `importSdk` to **probe resolution before import** so the two failure modes are distinguishable. Suggested shape:
  ```ts
  const importSdk = async (): Promise<
    | { ok: true; module: Record<string, unknown>; path: string | null }
    | { ok: false; reason: string; resolvedPath: string | null }
  > => {
    const path = pathResolver();
    try {
      const mod = await loadModule();
      return { ok: true, module: mod, path };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason, resolvedPath: path };
    }
  };
  ```
  Update the `available()` and `loadAgentApi()` callers to thread `resolvedPath` into `state.available.reason` (or a dedicated `state.available.resolvedPath` field — extend the discriminated-union return type accordingly). Then in `src/backend/cursor/runtime.ts` where the install hint is currently constructed (search for the `module is not installed` / `npm install @cursor/sdk` string), branch: if the failure carries a non-null `resolvedPath`, emit a hint such as `'@cursor/sdk is installed at <path> but failed to load: <reason>. This is usually a native dependency or Node version mismatch — try reinstalling with native rebuilds (e.g. `pnpm rebuild @cursor/sdk` or `npm install --build-from-source @cursor/sdk`).'`. If `resolvedPath` is null, keep the existing missing-package install hint. Add at least two unit tests in the existing `defaultCursorSdkAdapter contract` describe block: (a) `importer` throws, `resolveModulePath` returns a non-null path → `available()` returns `{ ok: false, reason }` and the runtime-level install hint reflects the "installed-but-broken" wording (introduce a small testable seam if needed); (b) `importer` throws, `resolveModulePath` returns `null` → existing not-installed hint preserved.
- **Files To Change:** `src/backend/cursor/sdk.ts`, `src/backend/cursor/runtime.ts` (or wherever the install hint string lives), `src/__tests__/cursorRuntime.test.ts`.
- **Reply Draft:**
  > **[AI Agent]:** Fixed. `defaultCursorSdkAdapter` now probes module path resolution before import, so an installed-but-broken `@cursor/sdk` (e.g. native `sqlite3` binding missing for the current Node) reports `{ ok: false, reason, resolvedPath }` instead of being indistinguishable from a missing package. The runtime install-hint branches on `resolvedPath`: missing → existing `npm install @cursor/sdk` wording; resolved-but-failed → a rebuild hint that names the resolved path and surfaces the import error. Added two regression tests covering both shapes.

## CI Failure Analysis (2026-05-04)

- **Source:** `gh pr checks 25` and workflow run id `25280168979`. Latest commit on the branch: `b03a30f` ("Resolve Cursor backend PR review comments").
- **Failing checks:** `Build, Test, and Pack on Node 22` (fail, 31s) and `Build, Test, and Pack on Node 24` (fail, 31s). `CodeRabbit` check passes ("No actionable comments were generated in the recent review").
- **Root cause (single):** The `pnpm verify` script is `pnpm build && pnpm test && node scripts/check-publish-ready.mjs && node scripts/resolve-publish-tag.mjs >/dev/null && pnpm audit --prod && npm pack --dry-run`. Build passes (`tsc` clean). Tests pass (150 ✔, 0 ✘). Publish-readiness and tag resolution pass. `pnpm audit --prod` exits 1 with `12 vulnerabilities found` total, broken down (per local audit) as **6 high `tar`** (advisory IDs observed in CI log include GHSA-34x7-hfp2-rc4v, GHSA-8qq5-rm4j-mr97, GHSA-83g3-92jg-28cx, GHSA-qffp-2rhf-9h96, GHSA-9ppj-qmqm-q256, GHSA-r6q2-hw4h-h46w), **2 high `undici` + 3 moderate `undici`** (IDs include GHSA-g9mf-h72j-4rw9, GHSA-2mjp-6q6p-2qxm, GHSA-4992-7rv2-5pvq, GHSA-vrm6-8vpv-qv8q, GHSA-v9p9-hfj2-hcw8), and **1 low `@tootallnate/once`** (GHSA-vpq2-c234-7xj6). (CI log advisory-ID enumeration is best-effort because `pnpm audit` prints overlapping `Vulnerable versions` lines per advisory — the **6/2/3/1 = 12** grouping comes from a fresh local `pnpm audit --prod` and is the authoritative count for triage purposes.) The pnpm `ELIFECYCLE` short-circuits the script before `npm pack --dry-run`. Both Node 22 and Node 24 jobs fail at the same step with the same advisory set.
- **In-scope for this PR?** Yes — the entire advisory set arrives via the `@cursor/sdk` dependency tree introduced in this PR (`@cursor/sdk > sqlite3 > tar`/`node-gyp/...` and `@cursor/sdk > @connectrpc/connect-node > undici`). On `origin/main` (without `@cursor/sdk`), `pnpm audit --prod` is clean.
- **Disposition:** Tracked as **Comment 12 above**. Originally escalated as Open Human Decision 1; the human (ralphkrauss) selected the **overrides path** on 2026-05-04, so Comment 12 is now `fix-as-suggested` along that path and the CI failure is no longer pending a decision. Implementing the overrides described in Comment 12 step-by-step will turn CI green.

## Open Human Decisions

Open Human Decisions: none.

### Resolved: Decision 1 — Cursor SDK production-audit policy (answered 2026-05-04)

Decided by: ralphkrauss (PR maintainer). Selected option: **(b) Overrides** — add `pnpm.overrides` for the vulnerable `@cursor/sdk` transitives (`tar`, `undici`, `@tootallnate/once`), refresh `pnpm-lock.yaml`, and verify `pnpm audit --prod` + `pnpm test`. Bundled optional SDK ergonomics are to be preserved if compatible (i.e. `@cursor/sdk` stays in `optionalDependencies`).

Implementer instructions live in **Comment 12 above** under "Approach (overrides path — implementer instructions)". Compatibility-failure escape hatch (step 5) is the only condition under which this decision should be re-opened: if pinned `tar`/`undici` versions break `@cursor/sdk`'s `sqlite3` or `@connectrpc/connect-node` at install or test time, stop and surface the incompatibility for re-decision rather than silently falling back to (a)/(c)/(d1)/(d2).

Options considered and not selected:

- (a) Wait for upstream `@cursor/sdk` to ship a clean transitive tree; keep PR open. **Cost:** unknown timeline; PR cannot land until then.
- (c) Add a documented, time-boxed audit exception (e.g. wrap `pnpm audit --prod` in `scripts/audit-prod.mjs` that allowlists the specific advisory IDs with an expiry date and a follow-up ticket). **Risk:** weakens release gate; needs `PUBLISHING.md` update.
- (d) Re-package `@cursor/sdk` so it is no longer a `--prod`-resolved transitive of this package. **Note:** demote-to-`optionalDependencies` is *not* an available sub-path — `@cursor/sdk` is already in `optionalDependencies` (`package.json:57-58`) and `pnpm audit --prod` still fails. Two sub-paths considered:
  - (d1) Move `@cursor/sdk` to `peerDependencies` with `peerDependenciesMeta['@cursor/sdk'].optional = true`; end-users install it themselves.
  - (d2) Remove the `@cursor/sdk` manifest entry entirely and rely on the runtime `await import('@cursor/sdk')` probe (improved by Comment 13) plus an explicit install hint.

All other Round-2 fix items (Comments 10, 11, 13) and Round-1 deferrals are unaffected by this decision and can proceed independently.

## Implementation Evidence (2026-05-03)

Fix-now items (Comments 2, 3, 4, 5, 8, 9) implemented; Comments 1, 6, 7 deferred per map.

- **Comment 2:** Added `it('accepts a minimal cursor profile', ...)` in `src/__tests__/opencodeCapabilities.test.ts` with a manifest containing only `cursorOk` (`backend: 'cursor'`, `model: 'composer-2'`) and asserting `manifest.ok === true` and `result.ok === true`.
- **Comment 3:** `handleAssistant` in `src/backend/cursor/cursorEvents.ts` now pushes exactly one `assistant_message`, with payload `{ text, raw }` when extracted text is present and the raw record otherwise. Updated `src/__tests__/cursorEvents.test.ts` to assert the count is exactly 1, validate the `{ text, raw }` payload shape, and added a no-text regression test that asserts the payload is the raw record.
- **Comment 4:** Added `cancelRequested: Promise<void>` plus `resolveCancelRequested` to `CursorRunState`. `handle.cancel(...)` now resolves the deferred before invoking `state.run.cancel()`, so the cancel signal is observable independent of the `cancelStatus` snapshot. `drainAndFinalize` races both stream drain and `state.run.wait()` against `cancelRequested` first, then bounds each phase by `cancelDrainMs` once cancel is observed (using the existing `setTimeout`-based fallback for `state.run.status`). Added regression test `bounds drain when a late cancel arrives against an SDK that ignores run.cancel()` in `src/__tests__/cursorRuntime.test.ts` driving a fake SDK whose `stream()`/`wait()` never resolve and whose `cancel()` is a no-op; asserts the run finalizes as `cancelled` within 2s with `cancelDrainMs: 25`.
- **Comment 5:** Wrapped `extractAgentApi` calls in both `available()` and `loadAgentApi()` in `src/backend/cursor/sdk.ts`. `available()` now returns `{ ok: false, reason }` on shape failure (preserving the contract); `loadAgentApi()` caches the failure on `state.available` and rethrows. Added `CursorSdkAdapterOptions` (test seam: `importer`, `resolveModulePath`) so `defaultCursorSdkAdapter` is testable without touching the real SDK. Added `defaultCursorSdkAdapter contract` describe block with two regression tests (malformed shape → `ok: false` from `available()`; `loadAgentApi()` rejects and caches failure).
- **Comment 8:** Added `waitForActiveHandle(service, runId, timeoutMs)` helper near the top of `src/__tests__/cursorRuntime.test.ts` that polls `(service as ...).activeRuns.has(runId)` every 5ms with a 2s default bound. Replaced all three `setTimeout(50)` waits (cancellation path, idle-timeout synthesis, user-cancel synthesis) with `await waitForActiveHandle(service, runId)`.
- **Comment 9:** Extended the `if (errorClass === 'ConfigurationError')` block in `src/backend/cursor/errors.ts` so the existing stale-agent → `protocol` branch remains authoritative, and additionally bad-API-key/authentication messages map to `auth` and invalid-request/parameter messages map to `protocol`. `ConfigurationError → invalid_model` remains the default in `knownClassCategory`. Added two regression tests in `src/__tests__/cursorRuntime.test.ts` ("Bad API key" → `auth`; "Invalid request parameter" → `protocol`); the existing "Invalid model: composer-99 not found" → `invalid_model` test confirms the default is preserved.

### Verification

- `pnpm build` — green (tsc compiles with no errors).
- `pnpm test` — 150 passed, 0 failed, 1 skipped (Windows-only IPC test). Suite duration ~14.2s. Includes:
  - `OpenCode worker capability profiles › accepts a minimal cursor profile` ✔
  - `cursor SDK event mapping` ✔ (including the new no-text and exact-count assertions)
  - `defaultCursorSdkAdapter contract` ✔ (both new tests)
  - `CursorSdkRuntime success and cancellation paths` ✔ (including the new late-cancel/no-op-cancel test)
  - `CursorSdkRuntime SDK error normalization` ✔ (including the two new ConfigurationError reclassification tests)
  - `CursorSdkRuntime finalize artifacts and timeout/cancel error synthesis` ✔ (still green after switching to `waitForActiveHandle`)

`pnpm verify` was not run (no release/publish-affecting changes; runtime/test changes only). No commit, push, or GitHub reply has been made.

### Files Changed

- `src/backend/cursor/cursorEvents.ts`
- `src/backend/cursor/runtime.ts`
- `src/backend/cursor/sdk.ts`
- `src/backend/cursor/errors.ts`
- `src/__tests__/cursorEvents.test.ts`
- `src/__tests__/cursorRuntime.test.ts`
- `src/__tests__/opencodeCapabilities.test.ts`
- `plans/16-add-coding-backend-for-cursor-sdk/resolution-map.md` (this evidence section)

## Implementation Evidence (Round 2, 2026-05-04)

Round-2 fix items (Comments 10, 11, 12, 13) implemented per the resolution map; Round-1 deferrals (Comments 1, 6, 7) remain deferred. Open Human Decision 1 was answered (overrides path) before this implementation.

- **Comment 10 — synthesized cursor RunError on terminal SDK error with no events.** `src/backend/cursor/runtime.ts` now defines `cursorMissingErrorRunError(runResult, runId)` (category `'protocol'`, retryable `false`, fatal `true`, context `{ sdk_run_id, sdk_run_status, sdk_run_result, cursor_run_id }`). `buildFinalizeContext` synthesizes this RunError and pushes it into `baseErrors` only when `status === 'failed'`, `runResult` is truthy, observed errors are empty, and there is no override error. The synthesized error's message is also threaded into `stopReasonForResult.summary` via the existing `??` fallback chain so `WorkerResult.summary`, `WorkerResult.errors`, and downstream `RunSummary.latest_error.message` all surface the cursor-specific diagnostic. (Note: `RunSummary.latest_error.category` is re-derived through `cursorError`/`classifyBackendError` so it falls back to `'unknown'` for this synthesized message — the durable diagnostic is the message + context payload, mirroring the existing user-cancel/timeout handling.) Regression test `synthesizes a cursor RunError when wait() returns terminal status with no result and no events` in `src/__tests__/cursorRuntime.test.ts` drives a fake SDK whose `stream()` yields nothing and `wait()` returns `{ status: 'error' }` with no result, asserting status `failed`, exactly 1 error, the `sdk_run_*` context payload, summary equals the synthesized message, and `RunSummary.latest_error.message` matches.
- **Comment 11 — AI workspace projection sync.** Ran `node scripts/sync-ai-workspace.mjs` (no flags). Updated `.claude/skills/orchestrate-create-plan/SKILL.md` and added `.claude/skills/orchestrate-implement-plan/SKILL.md` and `.claude/skills/orchestrate-resolve-pr-comments/SKILL.md` (these two were absent from the projection before). `node scripts/sync-ai-workspace.mjs --check` now exits 0 with "AI workspace projections are in sync."
- **Comment 12 — `pnpm.overrides` for `@cursor/sdk` transitives (Open Human Decision 1, overrides path).** Added a top-level `pnpm.overrides` block to `package.json` pinning `tar` to `^7.5.11`, `undici` to `^6.24.0`, and `@tootallnate/once` to `^3.0.1` (each chosen as the lowest version that satisfies all of the audit-reported `Patched in` ranges). Ran `pnpm install` to refresh `pnpm-lock.yaml`, then re-verified with `pnpm install --frozen-lockfile` (clean), `pnpm build` (compiles), `pnpm audit --prod` (exit 0, "No known vulnerabilities found"), and `pnpm test` (155 pass, 1 skipped, 0 fail). `@cursor/sdk` remains in `optionalDependencies` (per the human's preference to preserve bundled install ergonomics). Recorded the policy and per-advisory rationale in `PUBLISHING.md` under "`pnpm.overrides` policy for `@cursor/sdk` transitives", and updated `plans/16-add-coding-backend-for-cursor-sdk/plans/16-cursor-agent-backend.md` T8 evidence + "Audit status" to reflect the now-clean release gate.
- **Comment 13 — installed-but-broken vs missing SDK diagnostics.** `src/backend/cursor/sdk.ts` `importSdk` now probes `pathResolver()` before `loadModule()` and threads the resolved path through both branches: success → `{ ok: true, module, path }`; failure → `{ ok: false, reason, resolvedPath }`. The `CursorSdkAdapter.available()` return type is extended so `{ ok: false }` carries an optional `modulePath`. `available()` and `loadAgentApi()` populate `state.available.modulePath` on every failure path (import failure, malformed Agent shape). `src/backend/cursor/runtime.ts` `spawn()` now branches on `availability.modulePath`: when present, the install hint reads `@cursor/sdk resolves at <path> but failed to import — usually a native dependency or Node version mismatch. Try \`pnpm rebuild @cursor/sdk\` or reinstalling with native rebuilds (e.g. \`npm install --build-from-source @cursor/sdk\`).` and `details.resolved_path` is set; when null, the original `npm install @cursor/sdk` hint is preserved. The same branching is applied to the `loadAgentApi()` failure path so the runtime can describe an installed-but-broken SDK consistently. Two new unit tests in the `defaultCursorSdkAdapter contract` describe block exercise both shapes (importer throws + path resolves → modulePath in failure; importer throws + path null → modulePath null). Two end-to-end tests under a new describe `CursorSdkRuntime install hint differentiates missing vs installed-but-broken` drive a fake adapter through a full `start_run → wait_for_run → get_run_result` cycle and assert the install hint and `resolved_path` context fields surface as expected.

### Verification (Round 2)

- `pnpm install --frozen-lockfile` ✅ — "Lockfile is up to date".
- `pnpm build` ✅ — `tsc` exits 0.
- `pnpm test` ✅ — 156 tests, 155 pass, 1 skipped (Windows-only IPC pipe), 0 fail; total 30 suites; duration ~14.7s. New tests added in this round:
  - `defaultCursorSdkAdapter contract › reports modulePath in failure when the SDK is resolvable but import throws (installed-but-broken)` ✔
  - `defaultCursorSdkAdapter contract › reports modulePath null when the SDK cannot be resolved at all (missing package)` ✔
  - `CursorSdkRuntime install hint differentiates missing vs installed-but-broken › uses the missing-package install hint when modulePath is null` ✔
  - `CursorSdkRuntime install hint differentiates missing vs installed-but-broken › uses the rebuild install hint when modulePath is set (installed-but-broken)` ✔
  - `CursorSdkRuntime success and cancellation paths › synthesizes a cursor RunError when wait() returns terminal status with no result and no events` ✔
- `node scripts/sync-ai-workspace.mjs --check` ✅ — "AI workspace projections are in sync."
- `pnpm audit --prod` ✅ — "No known vulnerabilities found".
- `pnpm verify` ✅ — full pipeline reaches `npm pack --dry-run` and produces `ralphkrauss-agent-orchestrator-0.1.2.tgz` (204.6 kB packed, 1.1 MB unpacked, 164 files).

No commit, push, or GitHub reply has been made.

### Files Changed (Round 2)

- `src/backend/cursor/runtime.ts` (Comments 10 + 13)
- `src/backend/cursor/sdk.ts` (Comment 13)
- `src/__tests__/cursorRuntime.test.ts` (Comments 10 + 13 regression tests)
- `package.json` (Comment 12 — added `pnpm.overrides`)
- `pnpm-lock.yaml` (Comment 12 — regenerated under the new overrides)
- `PUBLISHING.md` (Comment 12 — overrides policy and per-advisory rationale)
- `plans/16-add-coding-backend-for-cursor-sdk/plans/16-cursor-agent-backend.md` (Comment 12 — T8 evidence + "Audit status")
- `plans/16-add-coding-backend-for-cursor-sdk/resolution-map.md` (this evidence section)
- `.claude/skills/orchestrate-create-plan/SKILL.md` (Comment 11 — regenerated)
- `.claude/skills/orchestrate-implement-plan/SKILL.md` (Comment 11 — regenerated, new file)
- `.claude/skills/orchestrate-resolve-pr-comments/SKILL.md` (Comment 11 — regenerated, new file)

## Comment 14 | fix-as-suggested | minor (Round 2, local reviewer 2026-05-04)

- **Comment Type:** local reviewer note (pre-code-review), 2026-05-04.
- **File:** `src/diagnostics.ts:236` (`diagnoseCursorBackend`); regression test in `src/__tests__/diagnostics.test.ts`.
- **Author:** local reviewer (raised after Comment 13 implementation).
- **Comment:** "This worktree has `@cursor/sdk` present, but importing it currently fails because the `sqlite3` native binding is missing under Node v24.15.0. If you see that after updating, use Node 22 for the daemon or reinstall/rebuild native deps. The branch's newer runtime code has better installed-but-broken diagnostics for that case."
- **Independent Assessment:** Reviewer's environmental observation is **reproducible** in this worktree — `node v24.15.0`, `node_modules/@cursor/sdk` resolves to `…/@cursor+sdk@1.0.12/node_modules/@cursor/sdk/dist/cjs/index.js`, but `await import('@cursor/sdk')` throws `Could not locate the bindings file. Tried: …/sqlite3/lib/binding/node-v137-linux-x64/node_sqlite3.node` because no prebuilt binding exists for Node 24's ABI v137 and `sqlite3` was not built locally. Comment 13's runtime fix (the Round-2 implementation just landed) **did** correctly surface this in the start-run path: the `WORKER_BINARY_MISSING` failure now carries the rebuild hint and `resolved_path`. **However**, `src/diagnostics.ts` `diagnoseCursorBackend` (used by `agent-orchestrator doctor` / `mcp__agent-orchestrator__get_backend_status`) was **not** updated to read the new `availability.modulePath` failure field — it still emitted only the generic `Install @cursor/sdk … npm install @cursor/sdk` hint and reported `path: null` even when the package was on disk. So the reviewer's note exposed both an environmental issue (correctly diagnosed by the runtime path) and a **narrow code gap in the diagnostics path** that needed closing to complete Comment 13's contract.
- **Decision:** fix-as-suggested (narrow). The environmental issue itself is not in scope to "fix" in this PR — the local checkout is one developer's machine state, not a project policy change. The runtime spec (Node ≥22 in `package.json` engines) already permits Node 22 or 24; users who run Node 24 just need to either rebuild `sqlite3` locally or run the daemon under Node 22 until upstream `@cursor/sdk` ships prebuilt sqlite3 bindings for Node 24's ABI. **What is in scope is closing the diagnostics-path gap so operators get the rebuild hint regardless of whether they hit the SDK via runtime spawn or via `doctor`.**
- **Approach:**
  1. Update `diagnoseCursorBackend(adapter)` in `src/diagnostics.ts` so the failure branch reads `availability.modulePath` (now optional on the `{ ok: false }` shape per Comment 13). When non-null, set `BackendDiagnostic.path` to the resolved path and emit a single rebuild hint that names the resolved path, mentions the typical native-dependency / Node-ABI cause (with `sqlite3` called out explicitly because that is the documented failure mode), and suggests `pnpm rebuild @cursor/sdk` / `npm install --build-from-source @cursor/sdk`. When null, preserve the existing `Install @cursor/sdk …` hint exactly. Do not change the `auth` / `version` / `checks` fields beyond what the new branching requires.
  2. Add a regression test `reports cursor as installed-but-broken with a rebuild hint when the SDK resolves but import fails` in `src/__tests__/diagnostics.test.ts`. The fixture adapter returns `{ ok: false, reason, modulePath: '/fake/.../@cursor/sdk/dist/index.js' }` to mimic Node 24 + missing sqlite3 binding. Asserts `cursor.path === '/fake/.../index.js'`, exactly one hint, the hint contains `pnpm rebuild @cursor/sdk`, the resolved path, and the substring `sqlite3`.
- **Files To Change:** `src/diagnostics.ts`, `src/__tests__/diagnostics.test.ts`.
- **Reply Draft:**
  > **[AI Agent]:** Confirmed reproducible on this worktree (Node v24.15.0; `sqlite3` has no prebuilt binding for Node ABI v137 and was not built locally). The runtime spawn path already surfaced the rebuild hint after the Comment 13 fix, but `src/diagnostics.ts` `diagnoseCursorBackend` was not threading the new `availability.modulePath` field, so `agent-orchestrator doctor` still printed the generic install hint with `path: null`. Closed that gap: diagnostics now report `path` = resolved path and a single rebuild hint (`pnpm rebuild @cursor/sdk` / `npm install --build-from-source @cursor/sdk`, calling out `sqlite3`) when the SDK is installed-but-broken, and preserve the original install hint when the package is not on disk. Added a regression test. The environment issue itself (Node 24 + unrebuilt `sqlite3`) is left as a developer-side fix — operators can run the daemon under Node 22 or rebuild native deps; no project-baseline change was made.

### Verification (Comment 14)

- `pnpm build` ✅.
- `pnpm test` ✅ — 157 tests, 156 pass, 1 skipped, 0 fail (added `reports cursor as installed-but-broken with a rebuild hint when the SDK resolves but import fails`).
- `pnpm verify` ✅ — full pipeline reaches `npm pack --dry-run`; "No known vulnerabilities found"; tarball produced.
- Live diagnostic check on this worktree (Node v24.15.0): `getBackendStatus()` for the cursor backend now returns `path` = `/home/ubuntu/worktrees-agent-orchestrator/16-add-coding-backend-for-cursor-sdk/node_modules/.pnpm/@cursor+sdk@1.0.12/node_modules/@cursor/sdk/dist/cjs/index.js`, `checks[0].message` = the real "Could not locate the bindings file …" output, and `hints[0]` is the new rebuild hint that names that resolved path and `sqlite3`.

### Files Changed (Comment 14)

- `src/diagnostics.ts`
- `src/__tests__/diagnostics.test.ts`
- `plans/16-add-coding-backend-for-cursor-sdk/resolution-map.md` (this section)

## Open Human Decisions (after Round 2 implementation, including Comment 14)

Open Human Decisions: none.

- Decision 1 was already resolved before Round 2 implementation (overrides path). The override block did not require widening or escape-hatch escalation — `pnpm install`/`pnpm test`/`pnpm audit --prod`/`pnpm verify` all succeed cleanly under the pinned versions, so the compatibility-failure branch of step 5 in the Comment 12 approach was not triggered.
- Comment 14 (local reviewer note about Node 24 + `sqlite3`) did not raise a new decision: the environmental issue is left as a developer-side concern (run daemon under Node 22 or rebuild native deps); the project baseline (`engines.node >= 22`) was intentionally left unchanged. The narrow code gap it exposed in `diagnoseCursorBackend` was fixed in scope.
