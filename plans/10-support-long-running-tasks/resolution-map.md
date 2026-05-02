# PR #19 Resolution Map

Branch: `10-support-long-running-tasks`
Created: 2026-05-02
PR: https://github.com/ralphkrauss/agent-orchestrator/pull/19

Total unique comments: 7 | To fix: 5 | To defer: 0 | To decline: 2 | To escalate: 0

Skipped:

- CodeRabbit walkthrough/conversation summary comment: informational bot output.
- CodeRabbit LGTM/additional praise comments: informational.
- Duplicate review-body stderr buffering note: covered by Comment 4.
- CodeRabbit docstring coverage warning: bot pre-merge check noise for this TypeScript repository.

Reply prefix: `**[AI Agent]:**`

## Summary

| # | Decision | Severity | Files |
|---|---|---|---|
| 1 | decline | low | `src/__tests__/observabilityFormat.test.ts`, `src/daemon/observabilityFormat.ts` |
| 2 | fix-as-suggested | high | `src/backend/common.ts`, `src/__tests__/backendErrorClassification.test.ts` |
| 3 | fix-as-suggested | medium | `src/observability.ts`, `src/__tests__/observability.test.ts` |
| 4 | fix-as-suggested | high | `src/processManager.ts`, `src/__tests__/processManager.test.ts` |
| 5 | alternative-fix | medium | `src/contract.ts`, `src/__tests__/contract.test.ts` |
| 6 | fix-as-suggested | medium | `src/__tests__/processManager.test.ts` |
| 7 | decline | low | none |

## Comment 1 | declined | low

- **Comment Type:** review-inline
- **File:** `src/__tests__/observabilityFormat.test.ts:34-35`
- **Comment ID:** `discussion_r3177021041`
- **Review ID:** `4215348230`
- **Thread Node ID:** unavailable from fetched payload
- **Author:** `coderabbitai[bot]`
- **Comment:** Assertion format appears out of sync with formatter output. The comment claims the formatter renders timeout as `execution=...` and latest error as `category "message"` style, and suggests changing expectations from `hard=...` plus parenthesized flags to `execution=...` plus quoted message style.
- **Independent Assessment:** Incorrect against current branch. `src/daemon/observabilityFormat.ts` currently renders `formatTimeoutPolicy()` with `hard=${...}` and `formatLatestError()` as `${message} (category=... source=... fatal=... retryable=...)`. The existing assertions in `src/__tests__/observabilityFormat.test.ts` match the implementation. Applying the suggested change would make the test wrong unless the formatter contract is intentionally changed elsewhere, which is not requested by the PR.
- **Decision:** decline
- **Approach:** No code change. Leave the test and formatter unchanged. Reply that the review comment was checked against the current formatter and is stale/incorrect.
- **Files To Change:** none
- **Reply Draft:**
  > **[AI Agent]:** Checked against the current formatter. `formatTimeoutPolicy()` still renders `hard=...`, and `formatLatestError()` still renders the message followed by parenthesized category/source/fatal/retryable flags, so the existing assertions are correct. No change needed. <!-- agent-orchestrator:pr19:c1 -->

## Comment 2 | fix-as-suggested | high

- **Comment Type:** review-inline
- **File:** `src/backend/common.ts:203`
- **Comment ID:** `discussion_r3177021047`
- **Review ID:** `4215348230`
- **Thread Node ID:** unavailable from fetched payload
- **Author:** `coderabbitai[bot]`
- **Comment:** Tighten fatal regexes before using them for fail-fast classification. Bare matches like `json`, `parse`, `connection`, or `timeout` are too broad and can promote routine stderr such as "parsed JSON successfully" or "retrying connection after timeout" to fatal backend errors.
- **Independent Assessment:** Valid. `classifyErrorCategory()` currently classifies protocol on bare `parse` or `json`, and backend availability on bare `connection` or `timeout`. Because `classifyBackendError()` sets `fatal: category !== 'unknown'`, these broad matches can kill a healthy run if harmless stderr text includes those words.
- **Decision:** fix-as-suggested
- **Approach:** In `src/backend/common.ts`, make protocol and backend availability classification require specific failure phrases or structured context.
  - Extract normalized `message`, `code`, `type`, and numeric/string `status` separately instead of relying only on one broad haystack.
  - Keep structured status/code evidence authoritative: `400` or known invalid-request/schema/parse codes can classify as `protocol`; `500`, `502`, `503`, `504`, `ECONN*`, `ETIMEDOUT`, or known service-unavailable codes can classify as `backend_unavailable`.
  - Replace protocol regex `\b(protocol|schema|malformed|invalid request|bad request|parse|json|400)\b` with phrase-specific checks such as `protocol error`, `schema validation`, `malformed`, `invalid request`, `bad request`, `json parse`, `parse error`, `failed to parse`, `invalid json`, `unexpected token`, or structured `400`.
  - Replace backend regex `\b(unavailable|connection|network|econn|etimedout|timeout|503|502|500)\b` with explicit failure phrases such as `service unavailable`, `backend unavailable`, `network error`, `connection refused`, `connection reset`, `connection failed`, `connection timed out`, `request timed out`, `timeout exceeded`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, or structured 5xx status.
  - Ensure informational text like "parsed JSON successfully" and "retrying connection after timeout" remains `category: 'unknown'`, `fatal: false`.
  - Add focused cases to `src/__tests__/backendErrorClassification.test.ts` for the benign messages above and for still-classified real failures.
- **Files To Change:** `src/backend/common.ts`, `src/__tests__/backendErrorClassification.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. The classifier now avoids bare `json`, `parse`, `connection`, and `timeout` matches and requires specific failure phrases or structured status/code evidence before marking protocol or backend-availability errors fatal. Added benign-regression coverage for routine stderr wording. <!-- agent-orchestrator:pr19:c2 -->

## Comment 3 | fix-as-suggested | medium

- **Comment Type:** review-inline
- **File:** `src/observability.ts:206` and `src/observability.ts:311`
- **Comment ID:** `discussion_r3177021050`
- **Review ID:** `4215348230`
- **Thread Node ID:** unavailable from fetched payload
- **Author:** `coderabbitai[bot]`
- **Comment:** Use the freshest timestamp, not just `last_activity_at`. `last_activity_at` is not advanced by every appended event, so sessions and prompt rows can look stale or misordered when newer event data exists.
- **Independent Assessment:** Valid. `buildSessions()` uses `run.activity.last_activity_at ?? run.activity.last_event_at ...`, and `sessionPrompt()` uses the same fallback order. If `last_activity_at` exists but is older than `last_event_at`, the newer event timestamp is ignored.
- **Decision:** fix-as-suggested
- **Approach:** In `src/observability.ts`, add a helper and use it in both affected locations:
  ```ts
  function latestObservedAt(run: ObservabilityRun): string {
    return maxIso([
      run.activity.last_activity_at,
      run.activity.last_event_at,
      run.run.finished_at,
      run.run.started_at,
      run.run.created_at,
    ].filter((value): value is string => value !== null));
  }
  ```
  Then:
  - Change `const updatedAt = maxIso(group.map(...))` to `const updatedAt = maxIso(group.map(latestObservedAt));`.
  - Change session prompt `last_activity_at` to `latestObservedAt(run)`.
  - Add or update an observability test where a run has `last_activity_at` earlier than `last_event_at`, then assert session `updated_at` and prompt `last_activity_at` use the later event timestamp.
- **Files To Change:** `src/observability.ts`, `src/__tests__/observability.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. Session `updated_at` and prompt `last_activity_at` now use the freshest observed timestamp across activity, events, and lifecycle times, and coverage pins the case where event activity is newer than persisted `last_activity_at`. <!-- agent-orchestrator:pr19:c3 -->

## Comment 4 | fix-as-suggested | high

- **Comment Type:** review-inline
- **File:** `src/processManager.ts:160`
- **Comment ID:** `discussion_r3177021052`
- **Review ID:** `4215348230`
- **Thread Node ID:** unavailable from fetched payload
- **Author:** `coderabbitai[bot]`
- **Comment:** Buffer stderr by line boundaries before classification, consistent with stdout handling. Raw `data` chunks are not line-aligned, so a fatal error can be split across chunks or multiple messages can be merged before `classifyBackendError()` sees them.
- **Independent Assessment:** Valid. `stdout` is parsed through `readline.createInterface()` and waits for `stdoutClosed`, but stderr classification currently runs directly on raw `data` chunks. That makes stderr error classification nondeterministic for split writes.
- **Decision:** fix-as-suggested
- **Approach:** In `src/processManager.ts`:
  - Keep `child.stderr.pipe(stderrStream)` so raw stderr artifacts are still complete.
  - Keep a raw `child.stderr.on('data')` listener only for activity tracking via `recordActivity('stderr')`.
  - Add `const stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });`.
  - Add `const stderrClosed = new Promise<void>((resolve) => { stderrLines.on('close', resolve); });`.
  - Move classification from raw `data` chunks into `stderrLines.on('line', (line) => { ... })`.
  - Trim the line, skip empty lines, classify the full line, call `recordObservedError(error)` when `shouldSurfaceStderrError()` passes, and append an error event with `{ stream: 'stderr', text: line, error }`.
  - In terminal finalization, await `stderrClosed` along with `stdoutClosed` before awaiting parse and persistence tasks.
  - Ensure existing fatal stderr behavior still fails fast after a complete line is emitted.
- **Files To Change:** `src/processManager.ts`, `src/__tests__/processManager.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. Stderr classification now uses a readline line buffer like stdout, while raw stderr is still persisted to the artifact and raw chunks still count as activity. Finalization waits for stderr line processing before marking the run terminal. <!-- agent-orchestrator:pr19:c4 -->

## Comment 5 | alternative-fix | medium

- **Comment Type:** review-body
- **File:** `src/contract.ts:52-63`
- **Comment ID:** review body nitpick in review `4215348230`
- **Review ID:** `4215348230`
- **Thread Node ID:** not applicable
- **Author:** `coderabbitai[bot]`
- **Comment:** Reconsider the open string union in the exported `RunTerminalReason` type. The runtime schema accepts any non-empty string for forward compatibility, but the exported type then allows misspellings like `backend_fatl_error` in internal code.
- **Independent Assessment:** Valid concern, but the forward-compatible runtime parsing is intentional for persisted/public run summaries. The fix should preserve runtime compatibility while restoring a closed internal type for values authored by this codebase.
- **Decision:** alternative-fix
- **Approach:** In `src/contract.ts`:
  - Introduce a closed schema for internally-authored values:
    ```ts
    export const KnownRunTerminalReasonSchema = z.enum([
      'completed',
      'worker_failed',
      'cancelled',
      'idle_timeout',
      'execution_timeout',
      'orphaned',
      'pre_spawn_failed',
      'backend_fatal_error',
      'finalization_failed',
    ]);
    export type RunTerminalReason = z.infer<typeof KnownRunTerminalReasonSchema>;
    export const RunTerminalReasonSchema = KnownRunTerminalReasonSchema.or(z.string().trim().min(1));
    ```
  - Keep `RunTerminalReasonSchema` forward-compatible for persisted/public `RunSummarySchema` parsing.
  - Let internal authoring surfaces continue importing `RunTerminalReason`, which becomes the closed type. This includes `RunTerminalOverride.reason`, `RunStore.markTerminal(... terminal.reason ...)`, and `terminalReasonFromStatus()`.
  - Add a contract test that `RunTerminalReasonSchema.parse('future_reason')` still succeeds for compatibility. Compile-time narrowing is covered by `tsc`.
- **Files To Change:** `src/contract.ts`, `src/__tests__/contract.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed with a compatibility-preserving split. Runtime parsing still accepts future terminal reasons from persisted/public summaries, while the exported `RunTerminalReason` type used by internal authoring paths is now closed to the known literals. <!-- agent-orchestrator:pr19:c5 -->

## Comment 6 | fix-as-suggested | medium

- **Comment Type:** review-body
- **File:** `src/__tests__/processManager.test.ts:350-384`
- **Comment ID:** review body nitpick in review `4215354407`
- **Review ID:** `4215354407`
- **Thread Node ID:** not applicable
- **Author:** `coderabbitai[bot]`
- **Comment:** Add a split-chunk stderr regression. The existing fatal stderr test covers a single `console.error()` write, but production currently classifies raw chunks, so a fatal message emitted across multiple writes would slip past.
- **Independent Assessment:** Valid and should be handled with Comment 4. The production fix should be line-buffered stderr classification; the regression should prove a fatal stderr line split across writes is still classified after the newline completes.
- **Decision:** fix-as-suggested
- **Approach:** In `src/__tests__/processManager.test.ts`, add a focused test or update the current fatal stderr test:
  - Use a mock worker that writes a fatal message across multiple stderr writes:
    ```js
    process.stderr.write('Authentication failed:');
    setTimeout(() => process.stderr.write(' invalid API key\n'), 10);
    setInterval(() => {}, 1000);
    ```
  - Start the worker through `ProcessManager`.
  - Race completion against a short timeout, as the current fatal stderr test does.
  - Assert `meta.status === 'failed'`, `meta.terminal_reason === 'backend_fatal_error'`, `meta.latest_error?.category === 'auth'`, `meta.latest_error?.source === 'stderr'`, `result?.summary === 'Authentication failed: invalid API key'`, and an error event includes the full line.
  - Keep the existing single-write stderr test if it remains useful, or convert it to the split-write variant to avoid redundant coverage.
- **Files To Change:** `src/__tests__/processManager.test.ts`
- **Reply Draft:**
  > **[AI Agent]:** Fixed. Added a split-write stderr regression that emits a fatal auth message across multiple chunks and verifies the line-buffered classifier still fails the run with the complete stderr line. <!-- agent-orchestrator:pr19:c6 -->

## Comment 7 | declined | low

- **Comment Type:** review-body
- **File:** `src/processManager.ts:52-60`, also `src/processManager.ts:114-117` and `src/processManager.ts:239-246`
- **Comment ID:** review body additional comment in review `4215354407`
- **Review ID:** `4215354407`
- **Thread Node ID:** not applicable
- **Author:** `coderabbitai[bot]`
- **Comment:** Verify these meta mutations are serialized per run. `recordActivity()` and `recordObservedError()` enqueue metadata updates without awaiting them while `handleJsonLine()` also updates metadata inline. If `RunStore` is a read-modify-write file store without a per-run queue, busy runs can race and lose `last_activity_*`, `latest_error`, `session_id`, or `observed_model`.
- **Independent Assessment:** Incorrect for field loss. `RunStore.updateMeta()`, `RunStore.appendEvent()`, `RunStore.markTerminal()`, and `RunStore.recordActivity()` all go through `withRunLock()`. Each metadata updater reads current meta while holding the lock and spreads the current object before changing its own fields. That serializes read-modify-write access and preserves unrelated fields such as `latest_error`, session IDs, and observed model values. No code change is required for the issue described by the comment.
- **Decision:** decline
- **Approach:** No code change. If future work wants stricter timestamp monotonicity for activity writes, that can be tracked separately, but it is not necessary to resolve this comment because the current store lock prevents the data-loss race described.
- **Files To Change:** none
- **Reply Draft:**
  > **[AI Agent]:** Checked. These mutations are serialized through `RunStore.withRunLock()`: `recordActivity()` delegates to `updateMeta()`, and `updateMeta()`, `appendEvent()`, and `markTerminal()` all hold the per-run lock while reading and writing. The updaters spread current meta under that lock, so unrelated fields are not lost. No code change needed for this one. <!-- agent-orchestrator:pr19:c7 -->

## Implementation Plan

1. Update `src/backend/common.ts` classification to remove broad fatal matches and add backend error classification tests.
2. Update `src/processManager.ts` to classify stderr by line with `readline`, wait for stderr line close before finalization, and keep raw stderr artifact/activity behavior.
3. Add the split-chunk stderr regression in `src/__tests__/processManager.test.ts`.
4. Update `src/observability.ts` to use a `latestObservedAt()` helper for session `updated_at` and prompt `last_activity_at`, then add focused observability coverage.
5. Split known/internal terminal reason typing from forward-compatible runtime parsing in `src/contract.ts`, then add a compatibility parse test.
6. Leave Comment 1 and Comment 7 unchanged, with the reply drafts above.
7. Run:
   - `git diff --check`
   - `node scripts/sync-ai-workspace.mjs --check`
   - `pnpm build`
   - `pnpm test`
   - `pnpm verify` if release-quality verification is needed and dependencies are installed

## Reply And Resolve Notes

- Do not post any replies until the fixes are committed and pushed, and the user explicitly approves posting GitHub replies.
- Resolve inline threads for Comments 1 through 4 after replies are posted. Comment 1 can be resolved as declined/incorrect if the maintainer agrees.
- Comment 5, Comment 6, and Comment 7 are review-body items, so there may be no thread to resolve; post a review or PR conversation reply only if requested.
