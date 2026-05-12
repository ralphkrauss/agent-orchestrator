# PR #60 Resolution Map

Branch: `58-issue-with-setting-sources`
Created: 2026-05-12
Total comments: 7 | To fix: 7 | To defer: 0 | To decline: 0 | To escalate: 0 | Human-approval required: 0

PR: https://github.com/ralphkrauss/agent-orchestrator/pull/60
Title: feat(workers): worker_posture for backend-native parity (#58)
Base: `main` ← Head: `58-issue-with-setting-sources`
Latest commit at triage time: `a18daad`

AI reply prefix: `**[AI Agent]:**` (per `CLAUDE.md:25` — "make the AI authorship
clear in GitHub comments"). No repo-wide override configured.

Correlation marker (embed as the last line of every posted reply so future
runs can detect handled comments and so the implementer can re-find them):
`<!-- agent-orchestrator:resolution-map:pr60:cN -->` where `N` is the comment
number in this map.

Reviewer is `coderabbitai[bot]` for every comment. All 6 inline threads are
unresolved + non-outdated + non-collapsed in the GraphQL view; the outside-diff
comment lives inside the review body (no inline thread node).

Thread-state verification: this triage run already queried
`repository.pullRequest.reviewThreads` via the GitHub GraphQL API with an
authenticated token and confirmed `isResolved=false`, `isOutdated=false`,
`isCollapsed=false` for every comment listed below. Subsequent map reviewers
do not need to re-verify thread state (and can skip this check if their
network egress is blocked).

---

## Comment 1 | to-fix | minor

- **Comment Type:** review-inline
- **File:** `docs/development/codex-backend.md:63`
- **Comment ID:** 3225541746
- **Review ID:** 4271291263
- **Thread Node ID:** PRRT_kwDOSRv-qs6BX3Ry
- **Author:** coderabbitai[bot]
- **Comment summary:** Fix blockquote formatting to avoid markdownlint MD028
  (blank line inside blockquote). Lines 56-62 are one `>` block and 64-68 are
  another, separated by a blank line 63.
- **Independent Assessment:** Valid. Verified `docs/development/codex-backend.md`
  has a `>` blockquote ending at line 62, a blank line at 63, and another `>`
  blockquote starting at line 64. markdownlint MD028 fires on this pattern.
  Behaviour-preserving doc fix.
- **Decision:** fix-as-suggested
- **Approach:** Replace the blank line 63 with a single `>` separator line so
  the two blockquotes are contiguous (markdownlint MD028 accepts a `>` line
  with no content as the separator). Concretely: change line 63 from empty to
  `>`. Verify with the project's markdownlint pass if one runs in CI, or by
  re-rendering the section. No other edits needed.
- **Files To Change:** `docs/development/codex-backend.md`
- **Reply Draft:**
  > **[AI Agent]:** Fixed — line 63 is now a `>` separator so the two
  > blockquotes are contiguous and MD028 no longer fires.
  >
  > `<!-- agent-orchestrator:resolution-map:pr60:c1 -->`

---

## Comment 2 | to-fix | minor

- **Comment Type:** review-inline
- **File:** `docs/development/codex-backend.md:220` (anchored on the
  fourth list item; heading is at line 204)
- **Comment ID:** 3225541750
- **Review ID:** 4271291263
- **Thread Node ID:** PRRT_kwDOSRv-qs6BX3R2
- **Author:** coderabbitai[bot]
- **Comment summary:** Heading at line 204 says "Three concrete migration
  options (still restricted posture)" but the list under it has four items,
  and the first item (`worker_posture: 'trusted'`) is *not* a restricted-posture
  option.
- **Independent Assessment:** Valid. Verified line 204
  (`### Three concrete migration options (still restricted posture)`) is
  followed by a four-item list (lines 208-220). Item 1 is the trusted-posture
  recommendation, items 2-4 are the three restricted-posture migration paths.
  The heading and content are out of sync — the trusted option was added as a
  fourth path during PR development without updating the heading.
- **Decision:** fix-as-suggested (heading correction; preserves content)
- **Approach:** Rewrite the section so the heading matches the content. Two
  acceptable shapes (pick the one that reads better in surrounding flow):
  1. **Preferred** — Change the heading to `### Migration options` (no count,
     no "restricted" qualifier) and add a one-line intro sentence above the
     list that says "Listed in increasing openness; the first option moves
     off restricted entirely, options 2-4 stay within restricted." Keep all
     four list items as-is.
  2. **Alternative** — Keep the count-style heading but split: a `#### Move
     off restricted entirely` subsection holding only item 1 (`worker_posture:
     'trusted'`), then `### Three concrete migration options (still restricted
     posture)` holding items 2-4 renumbered 1-3.
  Either way, do not change the *content* of the list items (they're cross-
  referenced from migration tables earlier in the doc). Prefer shape (1) as the
  smaller diff.
- **Files To Change:** `docs/development/codex-backend.md`
- **Reply Draft:**
  > **[AI Agent]:** Fixed — the heading no longer claims "three options /
  > still restricted" while listing four with the first being trusted. Renamed
  > to `Migration options` with an intro sentence noting option 1 moves off
  > restricted entirely and options 2-4 stay within restricted.
  >
  > `<!-- agent-orchestrator:resolution-map:pr60:c2 -->`

---

## Comment 3 | to-fix | minor

- **Comment Type:** review-inline
- **File:** `src/__tests__/cursorRuntime.test.ts:836` (assertion block at
  lines 832-836)
- **Comment ID:** 3225541752
- **Review ID:** 4271291263
- **Thread Node ID:** PRRT_kwDOSRv-qs6BX3R3
- **Author:** coderabbitai[bot]
- **Comment summary:** The ordering assertion `if (sdkSystemIdx >= 0) { …
  assert.ok(postureIdx < sdkSystemIdx) }` is conditional. If the SDK event
  match fails (e.g., agent_id shape changes), the test passes silently
  without validating the ordering invariant the test is named for.
- **Independent Assessment:** Valid. Verified lines 832-836 wrap the
  posture-precedes-SDK ordering check in `if (sdkSystemIdx >= 0)`. The
  comment block on lines 829-831 explicitly states this is the "Decision 18"
  ordering invariant; a test that can pass silently when the match misses
  defeats the purpose. Strengthening to assert presence first is purely a
  test-quality improvement, behaviour-preserving on the production code.
- **Decision:** fix-as-suggested
- **Approach:** Replace lines 833-836 with:
  ```ts
  assert.ok(sdkSystemIdx >= 0, 'expected at least one SDK lifecycle/system event');
  const postureIdx = stream.indexOf(posture!);
  assert.ok(postureIdx < sdkSystemIdx, 'worker_posture event must precede the first SDK system event');
  ```
  Keep the `sdkSystemIdx` `findIndex` predicate on line 832 unchanged. Run
  `pnpm test -- src/__tests__/cursorRuntime.test.ts` (or the equivalent
  package script) to confirm green.
- **Files To Change:** `src/__tests__/cursorRuntime.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Tightened — the SDK-event presence is now asserted before
  > the ordering compare, so a future predicate drift fails the test instead
  > of letting it pass silently.
  >
  > `<!-- agent-orchestrator:resolution-map:pr60:c3 -->`

---

## Comment 4 | to-fix | minor

- **Comment Type:** review-inline
- **File:** `src/__tests__/processManager.test.ts:778` (assertion block at
  lines 773-778, inside a `try { … } finally { restore PATH }`)
- **Comment ID:** 3225541769
- **Review ID:** 4271291263
- **Thread Node ID:** PRRT_kwDOSRv-qs6BX3SF
- **Author:** coderabbitai[bot]
- **Comment summary:** All retry-path assertions are inside `if (result.ok) {
  … }`. If `buildStartInvocation` fails for an unrelated reason the test
  passes without asserting anything. Assert success first.
- **Independent Assessment:** Valid. Verified lines 773-778: every assertion
  hides behind `if (result.ok)`. Strengthen by failing fast on `!result.ok`.
  Behaviour-preserving on production code; test-quality only.
- **Decision:** fix-as-suggested
- **Approach:** Replace lines 773-778 with:
  ```ts
  assert.equal(result.ok, true, 'expected buildStartInvocation to succeed for retry-shape assertions');
  if (!result.ok) return;
  assert.ok(result.invocation.initialEvents, 'retry invocation must keep initialEvents so a real retry spawn emits posture telemetry');
  assert.equal(result.invocation.initialEvents.length, 1);
  assert.equal((result.invocation.initialEvents[0]!.payload as { state?: string }).state, 'worker_posture');
  assert.equal(result.invocation.earlyEventInterceptor, undefined, 'single-shot enforcement still holds');
  ```
  Note the `!` after `initialEvents` is dropped on the `.length` access because
  the prior `assert.ok` narrows it; keep `[0]!` on the array index. Run
  `pnpm test -- src/__tests__/processManager.test.ts` to confirm green.
- **Files To Change:** `src/__tests__/processManager.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Tightened — `result.ok` is asserted first and the rest of
  > the retry-shape checks run unconditionally, so an unexpected
  > `buildStartInvocation` failure now fails the test instead of skipping it.
  >
  > `<!-- agent-orchestrator:resolution-map:pr60:c4 -->`

---

## Comment 5 | to-fix | major

- **Comment Type:** review-inline
- **File:** `src/backend/cursor/runtime.ts:240` (the unguarded
  `await store.appendEvent(...)` call at lines 229-239)
- **Comment ID:** 3225541779
- **Review ID:** 4271291263
- **Thread Node ID:** PRRT_kwDOSRv-qs6BX3SM
- **Author:** coderabbitai[bot]
- **Comment summary:** The `worker_posture` lifecycle append at lines 229-239
  is unguarded. If `store.appendEvent(...)` throws, `spawn()` returns to its
  caller after `agent.send()` already succeeded, leaving the agent and the
  cursor run undisposed (resource leak + orphaned worker). Guideline
  reference: every worker spawn must emit a lifecycle `worker_posture` event,
  and failure handling must not leave the accepted worker orphaned.
- **Independent Assessment:** Valid major issue. Verified `runtime.ts:229-239`
  performs an unguarded `await this.options.store.appendEvent(...)` after
  `agent.send()` resolves. The neighbouring failure paths (lines 196-202 for
  `Agent.create/resume`, 213-217 for `agent.send`) already follow the
  dispose-then-return-structured-failure pattern using
  `disposeAgentSafely(agent)` (defined line 611) and `cursorSpawnFailure(...)`
  (defined line 585). Aligning the append-event path with the same pattern is
  behaviour-preserving for the happy path and adds the missing cleanup leg.
  This is reinforced by `.claude/rules/worker-safety.md` (cursor must not
  weaken pre-#58 defaults; spawn failure handling matters).
- **Decision:** fix-as-suggested
- **Approach:** Wrap the existing `await this.options.store.appendEvent(...)`
  call (currently lines 229-239) in a `try { … } catch { … }` that:
  1. Calls `await disposeAgentSafely(agent)` to clean up the cursor SDK
     handle.
  2. Returns
     ```ts
     return {
       ok: false,
       failure: cursorSpawnFailure(
         'Failed to persist worker_posture lifecycle event',
         error,
         { phase: 'append_event' },
       ),
     };
     ```
     Match the existing failure shape used for the `send` phase on lines
     213-217. The `phase: 'append_event'` keeps the failure metadata
     distinguishable for telemetry / log parsing. Preserve the existing
     comment block at lines 220-228 (Issue #58 Decision 18 rationale) — only
     wrap the append call itself, do not move the comment.
  3. Verify `cursorSpawnFailure`'s signature accepts the third arg `{ phase:
     string }` (it does — same call pattern as `phase: 'send'` on line 216).

  Add or extend a test in `src/__tests__/cursorRuntime.test.ts` that follows
  the existing style in that file (see e.g. the `CursorSdkRuntime end-to-end
  orchestration with a fake SDK adapter` describe block around line 417):
  - Construct a `CursorSdkRuntime` via `new CursorSdkRuntime(fakeAdapter(api),
    { store, env, cancelDrainMs: 25 })` exactly like the existing tests
    (see `cursorRuntime.test.ts:104` and `:552`). Use the existing `fakeAgent`
    / `fakeRun` / `fakeAdapter` helpers — `Agent.create` + `agent.send` should
    succeed.
  - Drive it through the **public** entry point used by the other tests
    rather than the internal `spawn`: trigger the spawn the way the existing
    tests do (`await service.startRun({ backend: 'cursor', ... })` via the
    integration-style wiring already in the file, or — if a `CursorSdkRuntime`-
    only test is preferred — call the public `start(...)` method on the
    runtime). Do not reach into the private `spawn(...)` overload.
  - Make the store's `appendEvent` reject on the `worker_posture` lifecycle
    write only (let other writes succeed). The cleanest shape is a thin
    `RunStore` subclass that overrides `appendEvent` and rejects when
    `(event.payload as { state?: string }).state === 'worker_posture'` (the
    same pattern as the existing `ThrowingTerminalStore` / `ThrowingStream
    ActivityStore` extensions in `src/__tests__/processManager.test.ts:13,28`
    — see also the existing cursor regression-store fakes in this file).
  - Assert: the `start`/`startRun` result surfaces a `cursorSpawnFailure`
    with `phase: 'append_event'` (matching the new `failure.phase`), and
    `agent.dispose` was invoked exactly once.

  **Implementer note on dispose counting:** the existing `fakeAgent` helper
  in `cursorRuntime.test.ts` has an `async dispose()` method but does **not**
  currently track call counts, so a plain `fakeAgent` cannot satisfy the
  "disposed exactly once" assertion as-is. Pick one of:
  1. **Instrument the helper** — add a `disposeCount` counter (or a public
     `disposed: boolean` / `disposeCalls: number`) on `fakeAgent` that the
     `dispose` implementation increments. Update existing call sites if any
     read shape changes. This is the lower-churn option if other regression
     tests would benefit from the same counter.
  2. **Use a local custom agent in this test only** — define a small inline
     test double that satisfies the `CursorAgent` contract and records its
     own `dispose` invocations, then thread it through the test's
     `fakeAdapter` for this single case. This is the lower-blast-radius
     option if no other test needs the counter.
  Choose option 1 if `disposeAgentSafely` coverage will likely grow (e.g.
  future cursor failure paths); option 2 otherwise. Document the choice in
  the test file's surrounding describe-block comment so a follow-up reader
  understands why the helper grew (or why the local double exists).
- **Files To Change:**
  - `src/backend/cursor/runtime.ts`
  - `src/__tests__/cursorRuntime.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed — the `worker_posture` append is now wrapped in
  > try/catch that disposes the cursor agent via `disposeAgentSafely` and
  > returns a structured `cursorSpawnFailure('Failed to persist
  > worker_posture lifecycle event', error, { phase: 'append_event' })`,
  > matching the `phase: 'send'` failure shape next to it. Added a regression
  > test that injects an `appendEvent` rejection and asserts the agent is
  > disposed and the failure carries `phase: 'append_event'`.
  >
  > `<!-- agent-orchestrator:resolution-map:pr60:c5 -->`

---

## Comment 6 | to-fix | major (alternative-fix — reviewer's diff is incomplete)

- **Comment Type:** review-inline
- **File:** `src/orchestratorService.ts:848` (settings chain at lines
  836-844, validation `if (!settings.ok)` at 845-848)
- **Comment ID:** 3225541781
- **Review ID:** 4271291263
- **Thread Node ID:** PRRT_kwDOSRv-qs6BX3SO
- **Author:** coderabbitai[bot]
- **Comment summary:** In `send_followup`, if the request body sets
  `worker_posture` (and not the rest of the model-settings fields), the
  ternary chain takes the `parsed.data.worker_posture !== undefined` branch
  at line 840 and short-circuits with `{ ok: true, value: { …parent, …}}`
  *before* the `parsed.data.model || backendName === 'cursor'` branch (line
  842) that calls `validateInheritedModelSettingsForBackend`. So a
  `worker_posture + model` follow-up on Claude (or any cursor follow-up that
  sets `worker_posture`) skips backend model-setting validation.
- **Independent Assessment:** Valid major bug. Verified lines 836-844: the
  ternary is `hasModelSettingsInput` → … → `codex_network !== undefined` → …
  → **`worker_posture !== undefined`** → wraps parent + posture (no
  validation) → else `model || cursor` → `validateInheritedModelSettingsForBackend`.
  Verified `validateInheritedModelSettingsForBackend` at lines 2453-2467+:
  rejects cursor reasoning_effort/service_tier, requires explicit cursor
  model, and runs claude-model reasoning-effort compatibility checks. A
  follow-up that pairs `worker_posture` with a model change on Claude can
  persist an invalid `reasoning_effort` for the new model — the exact
  failure mode the validator exists to catch.

  **The reviewer's suggested diff is incomplete:** it introduces a new
  `validatedSettings` binding but does not update the downstream code (lines
  862-868 and beyond) that reads `settings.value` — `persistedSettings` is
  derived from `settings.value`, so applying the diff verbatim leaves the
  rest of the function on the un-validated value. The implementer must
  thread the validated settings through.
- **Decision:** alternative-fix (same intent as reviewer; corrected
  implementation that propagates the validation result)
- **Approach:** Refactor `orchestratorService.ts:836-848` so that:
  1. The posture-only branch becomes a *non-validating* settings build that
     stays inside the existing ternary — i.e. replace the existing nested
     ternary at lines 840-844 with:
     ```ts
     : {
         ok: true as const,
         value: parsed.data.worker_posture !== undefined
           ? { ...parent.meta.model_settings, worker_posture: parsed.data.worker_posture }
           : parent.meta.model_settings,
       };
     ```
     This keeps the `hasModelSettingsInput` / `codex_network` / posture /
     fallback ladder structurally identical except the posture branch no
     longer skips validation.
  2. After the existing `if (!settings.ok) { releaseLock?.(); return
     wrapErr(settings.error); }` guard at lines 845-848, **rebind** the
     settings variable through the backend validator:
     ```ts
     const validated = parsed.data.model || backendName === 'cursor'
       ? validateInheritedModelSettingsForBackend(backendName, model, settings.value)
       : settings;
     if (!validated.ok) {
       releaseLock?.();
       return wrapErr(validated.error);
     }
     ```
  3. Replace **every** downstream read of `settings.value` in this function
     (notably lines 862-868 — `childPosture`, `codexNormalized`,
     `persistedSettings`) with `validated.value`. Grep the function body
     between line 848 and the end of the `send_followup` handler to be sure
     no `settings.value` references are left.
  4. The behavioural change is: a follow-up that pairs `worker_posture` with
     a `model` override (or any cursor follow-up that sets `worker_posture`)
     now runs `validateInheritedModelSettingsForBackend` and rejects invalid
     combinations with `INVALID_INPUT`, the same way a non-posture model
     follow-up does today. This is a bug fix that brings posture follow-ups
     into line with the existing validation surface; it does not introduce
     new public-contract behaviour.

  Add the regression tests in `src/__tests__/integration/orchestrator.test.ts`
  — that file is the home of the existing
  `validateInheritedModelSettingsForBackend` integration coverage (Claude
  effort-mismatch assertions live there; see the existing
  `assertInvalidInput(claudeXhighFallback, /Claude xhigh effort requires
  claude-opus-4-7/)` patterns and neighbours around the Claude
  effort-validation describe block, around line 649 — grep for
  `/Claude .* effort/` and `/Claude effort levels are documented/` to find
  the right insertion point). Do not create a new
  `src/__tests__/orchestratorService.test.ts`; that file does not exist and
  the integration-test wiring needed to exercise `send_followup` end-to-end
  is already set up in the integration suite.

  The two new tests:
  - **Bug regression (failing on `main`, passing after the fix):** set up a
    Claude parent run with a reasoning_effort that is *incompatible* with a
    follow-up model (e.g. inherit a non-xhigh effort and target a model that
    `validateInheritedModelSettingsForBackend` would reject under the same
    Claude effort rules the existing tests exercise). Call `send_followup`
    with `{ worker_posture: 'restricted', model: '<the-incompatible-model>' }`.
    Assert `result.ok === false` and the error matches the same regex used by
    the neighbouring tests (e.g. `/Claude xhigh effort requires claude-opus-4-7/`
    or `/Claude effort levels are documented/`, whichever fits the chosen
    parent/child pair). Pick a parent/follow-up pair that exactly mirrors an
    existing `startRun` rejection in the file so the failure shape is already
    known to be stable.
  - **Happy-path regression-guard:** `send_followup` with only
    `worker_posture` set (no `model`, no other settings) on a Claude parent
    must still succeed. Assert `result.ok === true` and that the persisted
    `run_summary.model_settings.worker_posture` reflects the override. This
    guards against the new validator pass-through accidentally rejecting
    legacy parents where the inherited settings would not survive a strict
    re-validation against the unchanged parent model.
- **Files To Change:**
  - `src/orchestratorService.ts`
  - `src/__tests__/integration/orchestrator.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed with a small variation on the suggested shape — the
  > posture-only branch now folds into the settings build as a non-validating
  > value, and the backend validator runs unconditionally for `parsed.data.model
  > || backendName === 'cursor'` against the merged result, with the
  > validated value threaded through `childPosture` / `codexNormalized` /
  > `persistedSettings`. Added a Claude regression test for
  > `worker_posture + model` that previously slipped past validation, plus a
  > posture-only happy-path guard.
  >
  > `<!-- agent-orchestrator:resolution-map:pr60:c6 -->`

---

## Comment 7 | to-fix | major (outside-diff range — review body, no inline thread)

- **Comment Type:** review-body (outside-diff section of CodeRabbit review)
- **File:** `src/processManager.ts:245-254`
- **Comment ID:** *no inline databaseId — comment is embedded in the review
  body* (Review ID 4271291263). On reply, post into the PR conversation thread
  (not a code-anchored thread).
- **Review ID:** 4271291263
- **Thread Node ID:** *n/a (no inline review thread; reply goes to the PR
  conversation)*
- **Author:** coderabbitai[bot]
- **Comment summary:** `initialEvents` (including the backend's
  `worker_posture` lifecycle event) and the `status: started` marker are both
  fired through `trackPersistence(appendEventBuffered(...))` in the same
  synchronous tick — fire-and-forget. Ordering between them is therefore not
  guaranteed and `status: started` can race ahead of `worker_posture`,
  violating the documented invariant ("operators see them at the head of the
  run event stream").
- **Independent Assessment:** Valid major bug. Verified
  `src/processManager.ts:245-254` issues `trackPersistence(appendEventBuffered(initialEvent))`
  in a loop and then `trackPersistence(appendEventBuffered({status: 'started',
  …}))` without chaining. `appendEventBuffered` (line 232 in the same file)
  either pushes to an in-memory buffer (interceptor path — serial by array
  push, so safe in that mode) or returns `this.store.appendEvent(...)`
  directly. `RunStore.appendEvent` (`src/runStore.ts:232-244`) wraps writes
  in `withRunLock`, which is a **filesystem `O_EXCL` lock with EEXIST retry
  on a 10ms `setTimeout`** (`src/runStore.ts:1011+`). Two concurrent
  `appendEvent` calls race for the lock; the loser sleeps and retries, and
  there is no guarantee that the loop's earlier-issued call wins the race.
  In production runs (no interceptor — the standard path after retry
  buffering is disengaged), `status: started` can land before
  `worker_posture` in the events log. The in-code comment at lines 240-244
  explicitly documents the invariant the race violates ("flush
  backend-supplied initial lifecycle events … BEFORE the `status: started`
  marker"). The fix concept (chain the promises) restores the invariant
  without semantic change.
- **Decision:** fix-as-suggested
- **Approach:** Edit `src/processManager.ts:245-254` to chain the appends
  rather than fire them in parallel:
  ```ts
  let orderedInitialFlush: Promise<unknown> = Promise.resolve();
  if (invocation.initialEvents && invocation.initialEvents.length > 0) {
    for (const initialEvent of invocation.initialEvents) {
      orderedInitialFlush = orderedInitialFlush.then(() => appendEventBuffered(initialEvent));
    }
  }
  trackPersistence(
    orderedInitialFlush.then(() =>
      appendEventBuffered({
        type: 'lifecycle',
        payload: { status: 'started', pid: workerPid, pgid: workerPgid },
      }),
    ),
  );
  ```
  Notes:
  - We only need to `trackPersistence` on the **terminal** promise of the
    chain — the chain itself awaits the earlier appends transitively, so any
    rejection inside `orderedInitialFlush` will reject the final tracked
    promise and surface to the persistence tracker the same way today.
  - Do not wrap each step in its own `trackPersistence` — that would
    re-introduce a parallel-tracked path that defeats the chain.
  - Buffered (interceptor) mode is unaffected: `appendEventBuffered` returns
    `Promise.resolve()` synchronously in that path, so the chain collapses
    and the buffer order matches the call order, which was already correct.

  **Test design (this is the load-bearing part — a naive call-order
  assertion does not catch the bug, because the unpatched code already
  *invokes* `appendEventBuffered(worker_posture)` before
  `appendEventBuffered(status:'started')` synchronously in the same tick;
  the race is between the two writes' progress *inside* `appendEvent`, not
  between the call sites).** Use a gated-store regression test in
  `src/__tests__/processManager.test.ts` that proves `status:'started'` is
  not even *invoked* on the store until `worker_posture` has resolved on
  the store. Concretely:

  1. Define a small `RunStore` subclass in the test file (mirroring the
     existing `ThrowingTerminalStore` pattern at `src/__tests__/processManager.test.ts:13`
     and `ThrowingStreamActivityStore` at `:28`):
     ```ts
     class GatedAppendStore extends RunStore {
       readonly enterOrder: string[] = [];          // event tag at function entry
       readonly resolveOrder: string[] = [];        // event tag at function exit
       private postureGate: { promise: Promise<void>; resolve: () => void } | null = null;

       installPostureGate() {
         let resolveFn!: () => void;
         const promise = new Promise<void>((res) => { resolveFn = res; });
         this.postureGate = { promise, resolve: resolveFn };
       }

       releasePostureGate() {
         this.postureGate?.resolve();
         this.postureGate = null;
       }

       async appendEvent(runId: string, event: Omit<WorkerEvent, 'seq' | 'ts'>): Promise<WorkerEvent> {
         const tag =
           (event.payload as { state?: string }).state
           ?? (event.payload as { status?: string }).status
           ?? '?';
         this.enterOrder.push(tag);
         if (tag === 'worker_posture' && this.postureGate) {
           await this.postureGate.promise;
         }
         const result = await super.appendEvent(runId, event);
         this.resolveOrder.push(tag);
         return result;
       }
     }
     ```
     The gate lets the test hold `worker_posture` inside `appendEvent` while
     the rest of the spawn keeps progressing.

  2. Drive `ProcessManager.start(...)` (or the runtime path the existing
     `processManager.test.ts` describe block uses) with an `invocation`
     whose `initialEvents` contains exactly one `worker_posture` lifecycle
     event — match the shape that
     `src/__tests__/processManager.test.ts:771-776` uses for the retry-path
     test (`{ type: 'lifecycle', payload: { state: 'worker_posture', ... } }`).
     Install the posture gate **before** the `start(...)` call.

  3. After `start(...)` has scheduled the appends, **yield two microtask
     ticks** (e.g. `await Promise.resolve(); await Promise.resolve();`) to
     let the synchronous portion of the spawn settle. Then assert:
     ```ts
     assert.deepStrictEqual(store.enterOrder, ['worker_posture']);
     ```
     i.e. `status:'started'` must **not** have entered `appendEvent` yet,
     because the chain is blocked on the gated `worker_posture` write.
     On unpatched code this assertion fails — both events enter `appendEvent`
     in the same tick because each `appendEventBuffered(...)` is called
     synchronously back-to-back.

  4. Release the gate: `store.releasePostureGate()`. Await the persistence
     tracker (or the `ProcessManager` completion path the test already
     awaits) to settle. Then assert the full ordering both at the function
     boundary AND at the persisted-sequence level:
     ```ts
     assert.deepStrictEqual(store.enterOrder, ['worker_posture', 'started']);
     assert.deepStrictEqual(store.resolveOrder, ['worker_posture', 'started']);

     const page = await store.readEvents(runId); // RunStore.readEvents at
                                                  // src/runStore.ts:315 —
                                                  // returns `ReadEventsResult`
                                                  // with an `events` array;
                                                  // adjust the property
                                                  // destructure to match
                                                  // the actual shape.
     const events = page.events ?? page; // tolerate either shape
     const postureSeq = events.find((e: WorkerEvent) => (e.payload as { state?: string }).state === 'worker_posture')!.seq;
     const startedSeq = events.find((e: WorkerEvent) => (e.payload as { status?: string }).status === 'started')!.seq;
     assert.ok(postureSeq < startedSeq, 'worker_posture must be persisted with a lower seq than status:started');
     ```
     The persisted-seq assertion is the belt-and-braces guarantee: even if
     someone later removes the gate logic, the on-disk sequence still
     witnesses the invariant.

  5. Make the test resilient to the `interceptor` (buffered) path: this fix
     only matters in the **non-buffered** path (interceptor disengaged), so
     the test should configure the runtime/invocation such that
     `appendEventBuffered` calls into `store.appendEvent` directly. If the
     test wiring would enable the D-COR-Resume interceptor by default, pass
     an invocation shape that does not trigger it (the existing retry-shape
     test on `processManager.test.ts:760-782` already shows how to build an
     invocation that bypasses the interceptor — model the new test on that
     shape).

  This design directly fails on unpatched code (both events enter
  `appendEvent` in the same tick, breaking the step-3 assertion) and passes
  on patched code (chain blocks the second call until the first resolves),
  while *also* asserting the persisted on-disk sequence — covering both
  options the resolution-map reviewer offered.
- **Files To Change:**
  - `src/processManager.ts`
  - `src/__tests__/processManager.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed — the `initialEvents` writes are now chained via
  > `orderedInitialFlush = orderedInitialFlush.then(...)` and `status:
  > started` is appended only after that chain resolves, so `worker_posture`
  > is guaranteed to land before `status: started` in the events log even
  > when `RunStore`'s filesystem lock loses the race. Added a regression
  > test that uses a gated `RunStore` subclass to hold the `worker_posture`
  > write inside `appendEvent`, asserts (after a microtask tick) that
  > `status: started` has not yet entered the store, then releases the gate
  > and asserts the persisted on-disk event sequence shows `worker_posture`
  > strictly before `status: started`.
  >
  > `<!-- agent-orchestrator:resolution-map:pr60:c7 -->`

---

## Implementation Order (suggested)

A fresh implementer can apply these in any order, but the suggested order
minimises risk of merge conflicts in shared files:

1. Comment 1 — `docs/development/codex-backend.md:63` (1-line MD fix)
2. Comment 2 — `docs/development/codex-backend.md:204-220` (heading +
   intro sentence). Comments 1 and 2 touch the same file but disjoint
   ranges.
3. Comment 3 — `src/__tests__/cursorRuntime.test.ts:832-836` (test
   tightening; isolated)
4. Comment 4 — `src/__tests__/processManager.test.ts:773-778` (test
   tightening; isolated)
5. Comment 5 — `src/backend/cursor/runtime.ts:229-239` + new test in
   `cursorRuntime.test.ts` (production safety fix)
6. Comment 6 — `src/orchestratorService.ts:836-868` + new send_followup
   test (validation-bypass bug)
7. Comment 7 — `src/processManager.ts:245-254` + new ordering test in
   `processManager.test.ts` (race fix)

Run after each: the targeted test file plus `pnpm test` (or the configured
package script) before moving on to the next.

---

## Reviewer Questions

none

---

## Open Human Decisions

none
