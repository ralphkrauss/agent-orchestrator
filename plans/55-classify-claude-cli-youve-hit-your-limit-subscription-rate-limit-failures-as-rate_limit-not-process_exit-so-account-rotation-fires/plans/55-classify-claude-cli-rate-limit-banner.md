# Classify Claude CLI Subscription-Cap Banner As `rate_limit`

Branch: `55-classify-claude-cli-youve-hit-your-limit-subscription-rate-limit-failures-as-rate_limit-not-process_exit-so-account-rotation-fires`
Plan Slug: `55-classify-claude-cli-rate-limit-banner`
Parent Issue: #55
Created: 2026-05-11
Status: planning

## Context

When the Claude CLI worker exits because the Anthropic subscription / usage cap
was hit, the CLI emits a banner like:

> You've hit your limit · resets 12:20pm (UTC)

and exits with `code 1`. The daemon's worker pipeline currently classifies
that exit as a generic process-exit failure:

- `latest_error.category: process_exit`
- `latest_error.source: process_exit`
- `terminal_reason: worker_failed`

Because `OrchestratorService.evaluateRotation` only rotates on
`rate_limit` / `quota` (see `src/orchestratorService.ts:1080-1082` and the
post-terminal cooldown writer at `src/orchestratorService.ts:1573-1591`), the
exhausted account is **never** marked cooled-down and the next `send_followup`
re-uses the same account, hitting the same banner within seconds. This
silently defeats the multi-account rotation feature documented for Claude
profiles.

Issue #55 documents the symptom, the consequence, and a concrete two-run
reproduction (`alpha`-account double-hit on 2026-05-11). The proposed fix is
to detect the banner inside the captured worker output and promote the
terminal error category from `process_exit` to `rate_limit` so the existing
rotation + cooldown machinery fires.

### How the banner reaches the daemon today

- `ClaudeBackend.parseEvent` (`src/backend/claude.ts:135-142`) reads the
  stream-json `result` event and stores `getString(rec.result) ?? getString(rec.summary)`
  into `parsed.resultEvent.summary`. The issue's evidence (`result.summary:
  "You've hit your limit · resets 12:20pm (UTC)"`) confirms the banner travels
  through this event field — i.e. the CLI emits a structured `result` event
  even when the run failed.
- `finalizeFromObserved` (`src/backend/common.ts:68-99`) writes that text into
  the final `WorkerResult.summary` but never classifies it.
- Process-exit synthesis (`src/processManager.ts:684-712`) only injects a
  `process_exit` synthetic when the stream produced no structured (non-`process_exit`)
  error. Because no structured error event accompanied the banner, the
  synthetic wins and the terminal `latest_error.category` becomes
  `process_exit`.

### Critical processManager invariants that decide `terminal_reason`

This is the load-bearing detail that the first plan draft got wrong; the
reviewer caught it. When a `RunError` with `fatal: true` is pushed via
`recordObservedError` (`src/processManager.ts:281-302`), the function calls
`cancel('failed', { reason: 'backend_fatal_error', latest_error, ... })`
immediately. That populates `terminalOverride = 'failed'` and
`terminalOverrideDetails.reason = 'backend_fatal_error'` synchronously, before
the child process exits.

Then in `finalizeRun` (`src/processManager.ts:585-648`):

- Line 593-597: when `terminalOverride` is set, `errors = [terminalOverrideError(...)]`,
  **bypassing** `buildTerminalErrorList`. So the synthetic `process_exit`
  error is never appended — exactly the dedup outcome we want, but via the
  override path, not via the dedup path the first draft claimed.
- Line 640-647: `terminalDetails` keeps the override's `reason`
  (`backend_fatal_error`), not the `'worker_failed'` fallback used when there
  is no override.
- `RunStore.markTerminal` (`src/runStore.ts:337-364`) persists
  `terminal_reason: terminal?.reason ?? terminalReasonFromStatus(status)` —
  so the durable `terminal_reason` becomes `'backend_fatal_error'`.

This is **already** how every structured rate-limit failure terminates today.
The fake-claude `TRIGGER_RATE_LIMIT` path emits a `type: 'error'` event with
`type: 'rate_limit_error'`, which `errorFromEvent` classifies as
`rate_limit` (fatal), and `recordObservedError` then cancels with
`reason: 'backend_fatal_error'`. The processManager test suite locks this in
at `src/__tests__/processManager.test.ts:428, 470, 513, 554`
(`terminal_reason === 'backend_fatal_error'` for fatal backend errors).

Promoting banner-driven failures to ride the same path therefore makes the
wire shape **consistent across structured-event rate_limit and
banner-driven rate_limit** — it does not invent a new terminal reason.

### Existing classifier surface

- `classifyErrorCategory` (`src/backend/common.ts:195-227`) decides the
  `RunErrorCategory` from message text + structured `code`/`type`/`status`/
  `subtype`. The current rate-limit regex is
  `/\b(rate.?limit|too many requests|429)\b/`, which does **not** match the
  CLI banner "You've hit your limit".
- `classifyBackendError` (`src/backend/common.ts:177-193`) wraps the category
  decision into a `RunError` with `retryable = category === 'rate_limit' || category === 'backend_unavailable'`
  and `fatal = category !== 'unknown'`.
- The category enum is fixed by `RunErrorCategorySchema` in
  `src/contract.ts:67-80` (already includes `rate_limit`). The source enum is
  `RunErrorSourceSchema` in `src/contract.ts:83-91`: `backend_event`, `stderr`,
  `process_exit`, `pre_spawn`, `watchdog`, `finalization` — `backend_event`
  is the natural fit because the banner arrives inside a stream-json
  backend `result` event.

### How rotation / cooldown consumes the classification

- `evaluateRotation` (`src/orchestratorService.ts:1072-1184`) only proceeds when
  `parent.latest_error.category === 'rate_limit' || 'quota'`. Terminal reason
  is **not** consulted.
- The terminal-cooldown writer (`src/orchestratorService.ts:1573-1591`) gates
  on the same category. Also not on terminal reason.
- `markAccountCooledDown` (`src/claude/accountRegistry.ts:409-431`) sets
  `cooldown_until_ms = now + cooldownSeconds * 1000` and persists
  `last_error_category`.
- `pickHealthyAccount` (`src/claude/accountRegistry.ts:537-552`) skips cooled
  accounts via `accountStatusAt`.

So once `latest_error.category === 'rate_limit'` is true, the rest of the
chain is already correct and already covered by `claudeRotation.test.ts:238-432`.

### Sources read

- Issue #55 body, acceptance criteria, and the two evidence runs.
- `src/backend/claude.ts` — `parseEvent`, `result` event handling.
- `src/backend/common.ts` — `classifyErrorCategory`,
  `classifyBackendError`, `errorFromEvent`, `finalizeFromObserved`.
- `src/backend/resultDerivation.ts` — `deriveObservedResult` and the
  worker-status / run-status decision tree.
- `src/processManager.ts` — `handleJsonLine`, `recordObservedError`,
  `finalizeRun`, `buildTerminalErrorList`, `processExitError`,
  `workerResultError`, `shouldSurfaceStderrError`, `terminalOverrideError`.
- `src/runStore.ts` — `markTerminal` and how it persists `terminal_reason`.
- `src/orchestratorService.ts` — `evaluateRotation`, the post-terminal
  cooldown writer, `resolveBindingForFollowup`.
- `src/claude/accountRegistry.ts` — `markAccountCooledDown`,
  `pickHealthyAccount`, `clearExpiredCooldowns`, `AccountEntry` schema.
- `src/contract.ts` — `RunErrorCategorySchema`, `RunErrorSourceSchema`,
  `RunTerminalReasonSchema`, `RunLatestErrorSchema`.
- `src/__tests__/backendErrorClassification.test.ts` — existing classifier
  unit tests (style + assertion shape).
- `src/__tests__/claudeRotation.test.ts` — fake-claude driver, the
  `TRIGGER_RATE_LIMIT` prompt path, and the rotation test that this plan
  reuses for an analogous banner-driven test.
- `src/__tests__/processManager.test.ts` — confirms `backend_fatal_error` is
  the canonical terminal_reason for structured fatal backend errors today.
- `AGENTS.md`, `CLAUDE.md`, `.agents/rules/node-typescript.md`.

## Confirmed Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Where the banner is detected | Inside `ClaudeBackend.parseEvent` when a `result` event arrives, gated on **(a)** structured-failure signals on the event itself AND **(b)** the new banner regex matching the event's text. Synthesize a `RunError` with `category: 'rate_limit'` and push it onto `parsed.errors` so the existing parse pipeline calls `recordObservedError` and triggers `cancel('failed', { reason: 'backend_fatal_error', ... })`. | The banner already arrives via the `result` event (issue evidence). Gating on (a) + (b) prevents false positives on successful runs whose summary happens to contain "limit" wording. Routing through `recordObservedError` reuses the exact path that structured rate-limit failures already use today, so the wire-shape across "structured rate_limit error event" and "banner-only rate_limit" stays consistent. | A. Generic regex in `classifyErrorCategory` only, without the parseEvent hook (rejected: classifier never sees `is_error`/`subtype`/`stop_reason` on the event, so a banner-shaped string in unrelated assistant prose could pre-classify as `rate_limit`). B. Post-finalize re-classification in `processManager.finalizeRun` from `result.summary` (rejected: re-derives state that `parseEvent` already touched; harder to test in isolation). C. Detect from stderr (rejected: the CLI prints the banner inside the stream-json `result` event). D. A new `ParsedBackendEvent` channel that bypasses `recordObservedError` to preserve `terminal_reason: 'worker_failed'` (rejected: invasive change to `processManager`, `WorkerBackend`, and every backend's parser for no observable consumer benefit — see Decision 5 for the terminal-reason rationale). |
| 2 | Structured-failure gate (RQ5 resolved) | Synthesize the banner-error **only** when the `result` event carries at least one of: `rec.is_error === true`, `getString(rec.subtype)?.toLowerCase() === 'error'`, or a normalized stop-reason equal to `'rate_limit_error'`. The normalized stop-reason is computed exactly the way `parseEvent` already computes `resultEvent.stopReason` at `src/backend/claude.ts:138`: `getString(rec.stop_reason) ?? getString(rec.stopReason)` (both snake_case and camelCase, with `getString` already lowercase-tolerant via the regex match — apply `.toLowerCase()` before comparison). If none of these three signals fire, do not synthesize even if the regex matches the result text. | Removes the entire false-positive surface where a successful run's assistant-authored summary happens to include banner-shaped phrasing. The CLI's failure-path `result` event reliably carries `is_error: true` (the existing `TRIGGER_RATE_LIMIT` fake-claude path at `src/__tests__/claudeRotation.test.ts:144-150` exercises this exact shape: `subtype: 'error'`, `is_error: true`, `stop_reason: 'rate_limit_error'`). Mirroring `parseEvent`'s snake_case + camelCase tolerance for stop-reason avoids a future drift bug where the CLI moves to camelCase keys and the gate silently stops firing. | A. No structural gate, regex only (rejected: false-positive risk on successful runs whose assistant text references the model's own rate limits in some narrative way). B. Gate on `stop_reason === 'rate_limit_error'` alone (rejected: real CLI is observed to sometimes omit `stop_reason`; `is_error: true` is the more reliable signal). C. Gate only on snake_case `stop_reason` (rejected: `parseEvent` already reads both casings at line 138, so the gate should match). |
| 3 | Regex shape (RQ3 resolved — keep narrow) | Match an explicit Claude-CLI banner phrase: `/\byou(?:'|ʼ|’|`)ve\s+(?:hit|reached)\s+your\s+(?:usage\s+|rate\s+|monthly\s+)?limit\b/i`, optionally followed by a `resets HH(:MM)?\s*(am|pm)?\s*(\(?[A-Z]{2,5}\)?)?` clause. Run the match against the trimmed `resultEvent.summary` only. Do not preemptively widen to marketing strings ("subscription paused", "usage cap reached") without captured fixtures. | Anchored on "you've ... your limit" so user-prompt text that merely mentions the word "limit" cannot misfire. Curly-quote variant and the `hit|reached` alternation cover the wordings observed in the issue evidence and historical CLI text. Banner widening can ride on the same hook when a future operator submits a captured fixture. | A. Strict literal `^You've hit your limit\b` (rejected: misses curly-quote variants observed in real CLI output and the equivalent "reached your limit" wording). B. Pattern-match any "resets HH:MM" string (rejected: too lax; assistant-authored markdown commonly contains time strings). C. Locale-aware regex (rejected: Claude CLI ships in English; no captured non-English samples). |
| 4 | Category and flags emitted | `category: 'rate_limit'`, `retryable: true`, `fatal: true`, `source: 'backend_event'`, `backend: 'claude'`, `context.banner: '<matched-text>'`, `context.subkind: 'claude_cli_banner'`. | Mirrors what `classifyBackendError({ source: 'backend_event', message: '<banner>' })` would emit once the regex is extended (Decision 6), which keeps the wire shape identical to the structured-rate-limit path tested in `backendErrorClassification.test.ts:43-53`. RQ1 resolved: `source: 'backend_event'` is correct (the banner arrived inside a backend event) and `context.subkind: 'claude_cli_banner'` gives operators/observability a Claude-specific traceability tag without requiring a `RunErrorSourceSchema` enum change. | A. New `RunErrorSource` value `claude_cli_banner` (rejected: schema change with downstream observability/notification impact; the subkind context tag carries the same information). B. `source: 'stderr'` (rejected: the banner did not come from stderr). C. `source: 'process_exit'` (rejected: would re-trigger the dedup that suppresses structured errors). |
| 5 | Terminal reason (corrects the first plan draft; human-approved Option A on 2026-05-11) | `terminal_reason` for banner-driven failures will be `'backend_fatal_error'`, not `'worker_failed'`. This is **a consequence of routing through `recordObservedError`**, which calls `cancel('failed', { reason: 'backend_fatal_error', ... })` synchronously on any fatal `RunError`. See Decision #14 for the human-approval record. | Two reasons. (1) **Consistency with existing structured-rate-limit failures.** The fake-claude `TRIGGER_RATE_LIMIT` path already terminates with `terminal_reason: 'backend_fatal_error'` (locked in by `src/__tests__/processManager.test.ts:428-554`). Adopting the same reason for banner-driven failures collapses both "structured rate_limit event" and "banner-only rate_limit" onto a single wire shape. (2) **Avoiding a deeper refactor.** The rejected alternative (preserving `'worker_failed'`) would require either (i) adding a new `ParsedBackendEvent` channel that bypasses `recordObservedError`, plus plumbing through `handleJsonLine` and `finalizeRun` to add deferred errors to `observedErrors` at finalization time, or (ii) deciding inside `recordObservedError` whether a given fatal error should cancel — both are invasive changes affecting every backend (Codex, Cursor, OpenCode) for no consumer benefit, since `evaluateRotation` and the cooldown writer key on `latest_error.category`, not on `terminal_reason`. The terminal_reason change is observable (Human Approval Trigger #3) but has no functional impact on rotation, cooldown, notifications, or aggregate-status. | Preserve `'worker_failed'` via deferred-error channel (rejected per the rationale above; human approved the trade-off on 2026-05-11). |
| 6 | Classifier extension | Also extend `classifyErrorCategory` so the rate-limit branch matches the same banner phrasing. Pattern added to the existing `\b(rate.?limit|too many requests|429)\b` alternation. | Single source of truth: `ClaudeBackend.parseEvent` calls `classifyBackendError`/`classifyErrorCategory` rather than hardcoding a category, so the regex lives with the other rate-limit patterns and one unit test covers it. Also catches the same banner if it ever arrives via stderr or a structured backend `error` event in the future. The change is technically to a shared classifier, but is observationally benign for non-Claude backends because (a) the regex is anchored on "you've ... your limit" wording the Codex/Cursor/OpenCode binaries do not emit, and (b) no Codex/Cursor/OpenCode test fixture contains that phrasing (verified pre-implementation by grep across `src/__tests__/`). | A. Hardcode `category: 'rate_limit'` inline in `parseEvent` (rejected: bypasses the shared classifier, splits regex maintenance, harder to unit-test). |
| 7 | Process-exit error dedup | The terminal-override path replaces `buildTerminalErrorList` entirely (`src/processManager.ts:593-594`). No synthetic `process_exit` error reaches `latest_error`. | This is the documented behavior of the override path. `terminalOverrideError` returns the override's `latest_error` directly (`src/processManager.ts:672`), so the errors list is exactly `[bannerError]`. | Relying on `buildTerminalErrorList`'s dedup (the first draft's claim — incorrect because the override path bypasses dedup). |
| 8 | Cooldown source (RQ2 resolved — defer) | Continue to use `claude_cooldown_seconds` from the rotation state. Do **not** plumb a `resets_at` deadline into `markAccountCooledDown` for v1. Reset-time-aware cooldown is recorded as a follow-up below. | Issue calls reset-time-aware cooldown "optional but useful"; cooldown timing change is a behavior/contract surface that warrants its own change (banner-time parser tolerant of `HH:MM am/pm (TZ)` shapes, plumbing a `cooldown_until_ms` override into `markAccountCooledDown`, new test for the override). v1 unblocks rotation; the reset-time refinement is a quality-of-life follow-up. | Extend cooldown to `max(cooldown_until_ms, resets_at_ms)` in v1 (deferred to follow-up). |
| 9 | Stdout scope (RQ4 resolved — JSON-only) | v1 covers banners that arrive inside the stream-json `result` event only. Plain non-JSON stdout banners (where `handleJsonLine` drops the line at `src/processManager.ts:488-494` because `JSON.parse` fails) are **explicitly out of scope**. | Issue #55 evidence (`result.summary: "You've hit your limit · resets 12:20pm (UTC)"`) shows the banner travelled through `parsed.resultEvent.summary`, which is only populated by JSON-parsed `result` events. There is no evidence today of the CLI ever printing this banner outside the JSON envelope on the failure path. If a future operator captures such a run, a separate plan can add a stdout-line scanner; the current change set does not need it to fix the reported symptom. | Adding a non-JSON stdout scanner in v1 (rejected: speculative, no evidence; would broaden the change to a new line-handling surface in `processManager`). |
| 10 | Tests | (a) Unit: `backendErrorClassification.test.ts` covers the new banner phrasings → `rate_limit` with `retryable: true, fatal: true`. (b) Backend unit: a focused `parseEvent` test that feeds a stream-json `result` event carrying the banner with `is_error: true` and asserts `parsed.errors[0].category === 'rate_limit'`; **plus a negative case** feeding a `subtype: 'success'` result event with banner-shaped result text and asserting `parsed.errors.length === 0`. (c) Backend unit (gate proof): feed a `result` event with the banner text but **no** structural failure signal (`is_error: false`, `subtype: 'success'`) and assert no error is synthesized. (d) Backend unit (no `process_exit` dedup needed): assert the override path keeps `errors === [bannerError]` (no `process_exit` synthetic) — proven by either a focused processManager test or an end-to-end assertion on `finalized.result.errors` not containing `process_exit`. (e) End-to-end: extend `claudeRotation.test.ts`'s fake-claude with a `TRIGGER_HIT_LIMIT` branch that emits a `result` event with `subtype: 'error', is_error: true, result: '<banner>'` and **no** preceding `type: 'error'` event, exits 1. The new `it()` asserts (i) parent `latest_error.category === 'rate_limit'`, (ii) parent `latest_error.context?.subkind === 'claude_cli_banner'`, (iii) parent `terminal_reason === 'backend_fatal_error'`, (iv) parent `result.errors` does not contain a `process_exit` entry, (v) prior account cooled-down with `last_error_category === 'rate_limit'`, (vi) `send_followup` rotates to the next account with `terminal_context.kind === 'fresh_chat_after_rotation'`. | Reuses the existing fake-claude/rotation fixtures so the only Claude-banner-specific test surface is the new prompt branch + the new unit tests. The negative cases (b-second, c) are the explicit non-blocking suggestion the reviewer requested and the explicit safety net for the structured-failure gate. |
| 11 | Docs | No README / AGENTS.md / CLAUDE.md changes. Inline TypeScript comment on the new regex documents the source (issue #55) and the wire shape. | The README and AGENTS.md do not document the worker classifier surface today; in-source comment is the canonical place. Mirrors how `T-COR-Classifier` comments live next to `classifyErrorCategory`. | README mention of "rate-limit banner detection" (rejected: no precedent and adds maintenance burden). |
| 12 | Banner variants beyond `rate_limit` | Out of scope for this plan: `quota` ("Out of credits"), `auth` ("not logged in"), or any non-rate-limit banner. | Issue scopes to the rate-limit banner specifically. A quota/auth banner extension can ride on the same hook in `parseEvent` later if/when evidence shows up. | Generalised banner-to-category table (rejected: speculative). |
| 13 | End-to-end test breadth (resolved by reviewer) | Assert **rotation happened**: parent terminates with `latest_error.category === 'rate_limit'` and the prior account cooled-down; `send_followup` produces a child bound to the next priority account with `terminal_context.kind === 'fresh_chat_after_rotation'`. Do **not** require the child run to succeed end-to-end. | Matches the existing rotation-test shape at `src/__tests__/claudeRotation.test.ts:238` exactly. The bugfix is "rotation fires", not "rotation produces a working child"; the existing rotation chain is already test-covered for child-success in the original `TRIGGER_RATE_LIMIT` test, so re-asserting it on the banner path would be redundant. | Asserting child-run success on the new banner-driven path (rejected: redundant with existing structured-rate-limit child-success coverage; the bug scoped by issue #55 is the missing rotation, not the post-rotation child run). |
| 14 | `terminal_reason` for banner-driven failures (human-approved 2026-05-11) | **Option A — accept `terminal_reason: 'backend_fatal_error'`.** Banner-driven Claude rate-limit failures terminate with the same `terminal_reason` value every structured rate-limit failure already produces (locked in by `src/__tests__/processManager.test.ts:428, 470, 513, 554`). The implementation routes the synthesised fatal `RunError` through the existing `recordObservedError` → `cancel('failed', { reason: 'backend_fatal_error', ... })` path; `runStore.markTerminal` persists that reason at `src/runStore.ts:361`. | Two reasons. (1) Consistency: collapses structured-rate-limit and banner-only-rate-limit onto a single wire shape. (2) Cost: Option B (preserve `'worker_failed'`) would require either a new `ParsedBackendEvent.deferredErrors` channel plumbed through every backend's parser + `processManager.handleJsonLine` + `finalizeRun` (B-i), or a Claude-specific carve-out inside the shared `recordObservedError` cancel path (B-ii); both add code with no functional consumer benefit because rotation, cooldown, fatal-error notifications, terminal notifications, and aggregate-status all key on `latest_error.category` and `latest_error.fatal`, never on `terminal_reason`. The user-visible cost is a one-time wire change: external dashboards / log queries that match on `terminal_reason === 'worker_failed'` to detect these banner exits will stop matching (no such consumer in this repo; verified by grep). Human approved this trade-off on 2026-05-11. | Option B-i — preserve `'worker_failed'` via a `deferredErrors` channel across every backend's parser. Rejected: invasive multi-backend change, no functional consumer benefit. Option B-ii — preserve `'worker_failed'` via a Claude-specific carve-out inside `recordObservedError`. Rejected: asymmetric Claude-specific branch in the shared cancel path; brittle for future backends. |

## Assumptions

1. The Claude CLI emits a JSON stream-json `result` event with the banner
   text in the `result` (or `summary`) field, and with at least one of the
   structural failure signals (`is_error: true`, `subtype: 'error'`,
   `stop_reason: 'rate_limit_error'`), even when it exits 1 due to the
   subscription cap. This matches the issue's evidence and the existing
   fake-claude `TRIGGER_RATE_LIMIT` shape.
2. The banner is never printed to stdout outside the stream-json envelope on
   the failure path (Decision 9). If a future capture proves otherwise, a
   follow-up plan adds a stdout-line scanner.
3. The user-prompt content does not influence classification: the classifier
   sees `result` event text (worker output), not the user prompt or
   assistant messages — assistant text travels via `assistant_message`
   events, which carry `lastAssistantMessage` and never feed
   `parsed.resultEvent.summary` or `parsed.errors`.
4. Rotation/cooldown infrastructure is otherwise correct; the only missing
   piece is the *category* into the existing path. The existing rotation
   tests at `claudeRotation.test.ts:238-432` already prove the rest of the
   chain works once `latest_error.category === 'rate_limit'`.
5. `recordObservedError` synchronously sets `terminalOverride` on the first
   fatal error (`src/processManager.ts:281-302`); subsequent errors in the
   same run do not overwrite it. So if a real CLI ever emits both a
   `type: 'error'` rate_limit event AND a banner-shaped `result` event, the
   first-arriving fatal error wins and the second is appended to
   `observedErrors` but not promoted to `latest_error` — this matches
   existing structured-error behavior and is acceptable.

## Reviewer Questions

none — all five RQs resolved by reviewer feedback and folded into Confirmed
Decisions:

- RQ1 → Decision 4 (`source: 'backend_event'` + `context.subkind:
  'claude_cli_banner'`; no enum extension).
- RQ2 → Decision 8 (defer reset-time-aware cooldown to a follow-up).
- RQ3 → Decision 3 (narrow regex; no preemptive widening).
- RQ4 → Decision 9 (v1 covers JSON `result` events only; plain stdout
  banner deferred).
- RQ5 → Decision 2 (structured-failure gate: `is_error` / `subtype:
  'error'` / `stop_reason: 'rate_limit_error'`).

## Open Human Decisions

none — the human approved Option A (`terminal_reason: 'backend_fatal_error'`
for banner-driven Claude rate-limit failures) on 2026-05-11. See
Confirmed Decision #14 for the recorded choice and rationale.

## Human Approval Triggers

The following behaviors are public/durable surfaces touched by this plan.
Reviewer must confirm them before implementation can land:

1. **`latest_error.category` migrates from `process_exit` to `rate_limit`**
   for banner-driven Claude failures. Observable wire change in run
   metadata; any external integration pattern-matching on
   `latest_error.category === 'process_exit'` to detect "banner-caused
   exits" will stop matching. No such caller exists in this repo (verified
   by grep).
2. **`latest_error.source` migrates from `'process_exit'` to
   `'backend_event'`** for these runs. `context.subkind` is added with
   value `'claude_cli_banner'` so operators can still discriminate
   banner-driven cases from structured-event cases in observability if
   needed.
3. **`terminal_reason` migrates from `'worker_failed'` to
   `'backend_fatal_error'`** for these runs (Confirmed Decision #14,
   human-approved 2026-05-11). This change is consistent with every
   structured rate-limit failure that already terminates with
   `backend_fatal_error` today, but is an observable wire change for any
   external consumer that pattern-matches on the old value.
4. **Account cooldown will be written for banner-driven failures.** Prior
   to this fix, `cooldown_until_ms` is never set on the exhausted account.
   After the fix, the same `claude_cooldown_seconds` value used for
   structured rate-limit errors will be applied. Operators expecting the
   account to remain selectable will see it skipped until the cooldown
   expires.
5. **Rotation will fire on `send_followup`.** This is the documented
   intended behavior and the user-visible bugfix; operators relying
   (knowingly or not) on the old "stays pinned to the exhausted account"
   behavior will see a different account on the followup.
6. **`RunErrorSourceSchema` and `RunTerminalReasonSchema` enums are NOT
   extended.** All existing enum values are reused; the new fields go into
   `latest_error.context` (`subkind`, `banner`) which the schema already
   declares as `z.record(z.unknown()).optional()` (`src/contract.ts:281`).
7. **Notification kinds are unchanged.** The fatal-error notification path
   in `runStore.markTerminal` (`src/runStore.ts:388-389`) already fires on
   `latest_error.fatal === true`; banner-driven failures will now fire
   it (previously, the `process_exit` synthetic was fatal too, so the
   *frequency* of fatal notifications does not change — only the
   `latest_error.category` carried in the payload).

## Scope

### In Scope

- `src/backend/common.ts` `classifyErrorCategory`: extend the rate-limit
  branch with the new banner regex (Decision 3). Keep all existing patterns
  intact. The regex is shared, but the only callers that can produce the
  banner phrasing are the Claude `parseEvent` and any future Claude-specific
  pathway — no Codex/Cursor/OpenCode behavior changes (Decision 6).
- `src/backend/claude.ts` `ClaudeBackend.parseEvent`: when parsing a
  `result` event, run a structured-failure-gated banner check (Decisions 1,
  2). Gate first on **any** of: (a) `rec.is_error === true`;
  (b) `getString(rec.subtype)?.toLowerCase() === 'error'`;
  (c) the normalized stop-reason `(getString(rec.stop_reason) ??
  getString(rec.stopReason))?.toLowerCase() === 'rate_limit_error'` —
  mirroring the existing snake_case/camelCase tolerance at
  `src/backend/claude.ts:138`. If the gate fires, classify the effective
  result text via `classifyBackendError({ backend: 'claude',
  source: 'backend_event', message: <result-text>, context: { banner:
  <result-text>, subkind: 'claude_cli_banner' } })`. If the resulting
  category is `'rate_limit'`, push the `RunError` onto `parsed.errors`.
- `src/__tests__/backendErrorClassification.test.ts`: add cases for the
  Claude banner phrasings (`You've hit your limit · resets 12:20pm (UTC)`,
  curly-quote variant, `You've reached your limit`, with and without the
  resets clause) → `category: rate_limit, retryable: true, fatal: true`.
- New focused unit test for `ClaudeBackend.parseEvent` (file
  `src/__tests__/claudeBackendBannerDetection.test.ts` or appended to an
  existing Claude backend parser test):
  - Positive: `result` event with `is_error: true, subtype: 'error'`,
    `result: "You've hit your limit · resets 12:20pm (UTC)"` →
    `parsed.errors[0].category === 'rate_limit'`,
    `parsed.errors[0].source === 'backend_event'`,
    `parsed.errors[0].backend === 'claude'`,
    `parsed.errors[0].retryable === true`,
    `parsed.errors[0].fatal === true`,
    `parsed.errors[0].context?.banner` contains the banner text,
    `parsed.errors[0].context?.subkind === 'claude_cli_banner'`,
    `parsed.resultEvent?.summary` equals the original banner text.
  - Negative (false-positive guard): `result` event with
    `subtype: 'success', is_error: false, stop_reason: 'end_turn',
    result: "You've hit your limit of 5 retries"` → `parsed.errors.length
    === 0` (structured gate refuses).
  - Negative (no banner): `result` event with `subtype: 'error',
    is_error: true, result: 'something else broke'` →
    `parsed.errors.length === 0` (regex refuses).
- `src/__tests__/claudeRotation.test.ts`: extend the existing fake-claude
  with a `TRIGGER_HIT_LIMIT` branch that emits `{type:'system',
  subtype:'init', session_id:<sid>}` followed by `{type:'result',
  subtype:'error', is_error:true, result:"You've hit your limit · resets
  12:20pm (UTC)", session_id:<sid>}` and exits 1, with **no** preceding
  `type:'error'` event. Add an `it()` modelled on `claudeRotation.test.ts:238-287`
  that uses `prompt: 'TRIGGER_HIT_LIMIT please'` and asserts:
  - parent `latest_error.category === 'rate_limit'`
  - parent `latest_error.source === 'backend_event'`
  - parent `latest_error.context?.subkind === 'claude_cli_banner'`
  - parent `terminal_reason === 'backend_fatal_error'`
  - parent `result.errors` contains no entry with `category: 'process_exit'`
    (non-blocking suggestion #1 satisfied)
  - `claude_rotation_state.accounts === ['work','alt']`
  - parent `claude_account_used === 'work'`
  - after `send_followup`: child `claude_account_used === 'alt'`,
    child `terminal_context.kind === 'fresh_chat_after_rotation'`
  - on-disk `accounts.json`: `work.cooldown_until_ms > now - 1000` and
    `work.last_error_category === 'rate_limit'`.
- In-source comment on the new regex and the new `parseEvent` hook
  documenting them as the "Claude CLI subscription-cap banner" path with a
  reference to issue #55 and to Decision 5's terminal-reason consequence.

### Out Of Scope

- Adding `RunErrorSourceSchema` values (`stdout`, `claude_cli_banner`) —
  Decision 4 (subkind in `context` carries the same information).
- Adding `RunTerminalReasonSchema` values (`rate_limited`) — Decision 5.
- Preserving `terminal_reason: 'worker_failed'` via Option B —
  Decisions 5 and 14 (human-approved Option A on 2026-05-11).
- Reset-time-aware cooldown deadlines — Decision 8 (deferred to follow-up).
- Banner detection for `quota` / `auth` / other categories — Decision 12.
- Non-JSON stdout line scanning for the banner — Decision 9 (deferred to
  follow-up; no captured evidence today).
- Codex / Cursor / OpenCode backend behavior changes. The shared classifier
  regex change in Decision 6 is observable only when a backend emits the
  banner phrasing; no such backend exists today and no fixture matches.
- Any change to `OrchestratorService.evaluateRotation`,
  `markAccountCooledDown`, `pickHealthyAccount`, or notification taxonomy.
- README, AGENTS.md, CLAUDE.md edits — Decision 11.
- Live-binary smoke; the new test relies on the existing fake-claude
  driver only.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | A future Claude CLI release renames the banner ("Subscription paused", "Usage cap reached"), and the regex stops matching. | **Accepted external-drift risk.** Tests pin the harness contract for the *current* banner shape, including curly-quote and "reached" variants. A real rename would re-introduce the original issue #55 symptom (account never cooled-down) and the operator would file a new banner sample for the regex. | T1 (regex), T2 (parse test), T5 (end-to-end test) — wire-contract only. |
| 2 | A future Claude CLI also emits a structured `error` event before the banner-bearing `result`, causing the structured event to win and the banner detection to no-op. | This is the *desired* behavior: structured rate-limit events already classify correctly today (the existing `TRIGGER_RATE_LIMIT` test path). The banner hook is a safety net for the banner-only case. `recordObservedError` ignores subsequent fatal errors once `terminalOverride` is set (Assumption 5), so duplicate classification cannot poison terminal state. | Existing structured-rate-limit test coverage + Assumption 5. |
| 3 | User-prompt text contains the literal phrase "you've hit your limit". | The classifier sees `result` event text (worker output) not the user prompt. The structured-failure gate (Decision 2) additionally requires `is_error: true` or equivalent, which a successful run does not carry. | Decision 2 + T2 negative cases. |
| 4 | A real successful `result` event contains banner-shaped prose (e.g. assistant explains why a tool said "you've hit your limit of 5 retries"). | Structured-failure gate (Decision 2) refuses synthesis when `is_error !== true && subtype !== 'error' && stop_reason !== 'rate_limit_error'`. T2's first negative case pins this. | Decision 2 + T2 negative case #1. |
| 5 | Banner arrives but the parser cannot extract `resets_at`. | `context.resets_at` is not produced in v1 (Decision 8). The presence/absence of a parseable time has no effect on classification or cooldown. | Out of scope. |
| 6 | Banner is the *only* output and arrives as plain stdout (non-JSON). | v1 explicitly out of scope (Decision 9). The run continues to classify as `process_exit` — the *current* broken behavior — until a follow-up adds a stdout scanner with captured evidence. | Decision 9. |
| 7 | The synthesized error duplicates the banner content in both `result.summary` and `latest_error.message`. | Acceptable and consistent with the structured-rate-limit path (where `TRIGGER_RATE_LIMIT` sets both fields to `'simulated rate limit'`). | T5. |
| 8 | A test fixture writes a banner-shaped string into a result event for an unrelated test, accidentally triggering rate_limit classification. | Decision 3's regex anchors on "you've (hit/reached) your limit"; Decision 2's structural gate additionally requires `is_error`/`subtype: 'error'`/`stop_reason: 'rate_limit_error'`. A pre-implementation grep confirms no existing fixture matches both gates. | Pre-implementation grep + Decision 2 + Decision 3. |
| 9 | The shared-classifier regex change accidentally promotes a non-Claude backend's error to `rate_limit`. | The Claude banner phrasing is specific enough that Codex/Cursor/OpenCode emit nothing matching it (verified by grep). If a future fixture matches, the corresponding backend can guard via its own `parseEvent`. | Decision 6 + grep. |
| 10 | `RunLatestErrorSchema` validation rejects `context.banner` or `context.subkind` (unexpected fields). | `RunLatestErrorSchema` declares `context: z.record(z.unknown()).optional()` (`src/contract.ts:281`), so arbitrary context keys are allowed. No schema change needed. | Existing schema. |
| 11 | The `terminal_reason` change from `'worker_failed'` to `'backend_fatal_error'` breaks an external consumer pattern-matching on the old value. | Human-approved 2026-05-11 (Decision #14). Captured under Human Approval Trigger #3. The new value matches what every structured rate-limit failure already terminates with today, so the wire shape is *more* consistent, not less. No in-repo consumer matches on `terminal_reason === 'worker_failed'` (verified by grep). | Human approval recorded in Decision #14. |
| 12 | Hook isolation, env scrub, profile manifest, or other adjacent contracts regress. | This change touches `classifyErrorCategory`, one line in `ClaudeBackend.parseEvent`, and new test files. No worker-isolation, profile, or rotation code paths are modified. `pnpm verify` catches schema and contract regressions. | T6. |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T1 | Extend `classifyErrorCategory` rate-limit regex | — | pending | The rate-limit alternation in `src/backend/common.ts:214` matches all of: `You've hit your limit · resets 12:20pm (UTC)`, `You've reached your limit`, the curly-apostrophe variant `You’ve hit your limit`, `You've hit your usage limit`, `You've hit your rate limit`. Existing rate-limit-positive cases (`429 rate limit exceeded`, `too many requests`) continue to match. No previously-`unknown` message regresses to a different category (spot-check the existing `backendErrorClassification.test.ts` cases). |
| T2 | Synthesize a `RunError` from banner-bearing `result` events in `ClaudeBackend.parseEvent`, gated on structured failure | T1 | pending | `parseEvent` for a `type: 'result'` event checks **first** that at least one of: (a) `rec.is_error === true`; (b) `getString(rec.subtype)?.toLowerCase() === 'error'`; (c) a normalized stop-reason equal to `'rate_limit_error'`, where the stop-reason is computed exactly as `parseEvent` already does at `src/backend/claude.ts:138` — `getString(rec.stop_reason) ?? getString(rec.stopReason)` — then `.toLowerCase()`'d before comparison (both snake_case and camelCase variants must trigger the gate). If yes, the effective result text (the same string used for `parsed.resultEvent.summary`) is passed to `classifyBackendError({ backend: 'claude', source: 'backend_event', message: text, context: { banner: text, subkind: 'claude_cli_banner' } })`. If the resulting `category === 'rate_limit'`, the `RunError` is pushed onto `parsed.errors`. The `resultEvent.summary` value is unchanged so downstream summary rendering is preserved. When the structural gate refuses, `parsed.errors` is unchanged regardless of regex match. When the regex refuses, `parsed.errors` is unchanged. |
| T3 | Unit-test the new classifier patterns | T1 | pending | `src/__tests__/backendErrorClassification.test.ts` gains a new `it()` (or extends the existing rate-limit one) asserting all of T1's positive samples classify to `{ category: 'rate_limit', retryable: true, fatal: true }`. Negative cases (`I hit a limit in my analysis`, `the loop's limit was 10`) classify to `unknown`. |
| T4 | Unit-test `ClaudeBackend.parseEvent` banner synthesis and structured-failure gate | T2 | pending | A new test (file `src/__tests__/claudeBackendBannerDetection.test.ts` or appended to an existing Claude backend parser test) covers: (a) positive (issue-evidence shape) — `result` with `is_error: true, subtype: 'error', result: "You've hit your limit · resets 12:20pm (UTC)"` synthesises one error with the exact wire shape listed in In Scope; (b) positive (snake_case stop-reason variant) — `result` with `is_error: false, subtype: 'success', stop_reason: 'rate_limit_error', result: "You've reached your limit"` synthesises one rate_limit error (proves the stop-reason gate fires independently of `is_error`); (c) positive (camelCase stop-reason variant) — `result` with `is_error: false, subtype: 'success', stopReason: 'rate_limit_error', result: "You've hit your usage limit"` synthesises one rate_limit error (proves the normalised stop-reason extraction reads both casings, matching `src/backend/claude.ts:138`); (d) negative (gate refusal) — `result` with `subtype: 'success', is_error: false, stop_reason: 'end_turn', result: "You've hit your limit of 5 retries"` synthesises no error; (e) negative (regex refusal) — `result` with `subtype: 'error', is_error: true, result: 'something else broke'` synthesises no error; (f) the `parsed.resultEvent.summary` value is the original banner/result text in all five cases. |
| T5 | End-to-end rotation test driven by the banner (asserts rotation happened, per Decision 13) | T1, T2, T3, T4 | pending | `src/__tests__/claudeRotation.test.ts`'s fake-claude script gains a `TRIGGER_HIT_LIMIT` branch that emits `{type:'system', subtype:'init', session_id:<sid>}` followed by `{type:'result', subtype:'error', is_error:true, stop_reason:'rate_limit_error', result:"You've hit your limit · resets 12:20pm (UTC)", session_id:<sid>}` and exits 1 — **without** a preceding `type:'error'` event. A new `it()` modelled on `claudeRotation.test.ts:238-287` uses `prompt: 'TRIGGER_HIT_LIMIT please'` for the parent and asserts that **rotation happened**: parent `latest_error.category === 'rate_limit'`; parent `latest_error.source === 'backend_event'`; parent `latest_error.context?.subkind === 'claude_cli_banner'`; parent `terminal_reason === 'backend_fatal_error'`; parent `result.errors` contains no entry with `category: 'process_exit'`; `claude_rotation_state.accounts === ['work','alt']`; parent `claude_account_used === 'work'`; after `send_followup`, child `claude_account_used === 'alt'` and child `terminal_context.kind === 'fresh_chat_after_rotation'`; on-disk `accounts.json` has `work.cooldown_until_ms > now - 1000` and `work.last_error_category === 'rate_limit'`. The test does **not** assert child-run success (Decision 13); child success is already covered for the structured-rate-limit path by the existing `claudeRotation.test.ts:238-287` test, so asserting it on the banner path adds no signal. |
| T6 | Run repository quality gates | T1, T2, T3, T4, T5 | pending | `pnpm build` succeeds. `pnpm test` passes with the new tests visibly executing (capture pass counts and the names of the new `it()` blocks). `pnpm verify` succeeds end-to-end (build + tests + publish-readiness + audit + dist-tag + npm pack dry run). Evidence captured in the Execution Log. |
| T7 | Update plan execution log and link evidence | T6 | pending | Each task's Execution Log entry is filled in with actual command output, the plan Status flips to `complete`, and the parent index `plan.md` Status mirrors that. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | "Synthesising a fatal `RunError` from a parsed event triggers `recordObservedError` → `cancel('failed', { reason: 'backend_fatal_error', ... })`. Plans that promise `terminal_reason: 'worker_failed'` for such failures are wrong unless they also describe how they avoid the override path." | `.agents/rules/` cross-cutting rule on backend error wiring. | **Defer** until a second plan repeats the same mistake. The institutional lesson from this issue is durably recorded in Decisions 5 and 14, plus Risk #11 of this plan; future authors who research backend-classification work will read those before drafting. Promoting it to a `.agents/rules/` file is only worth the projection-sync overhead (`node scripts/sync-ai-workspace.mjs`) once the same pitfall is caught in a second plan. Tracked here so the reviewer can promote on the next recurrence. |
| 2 | "When promoting a backend-specific CLI banner to a `RunErrorCategory`, gate on a structured failure signal on the same event (`is_error`/`subtype: 'error'`/`stop_reason`) in addition to the regex, so successful-run text cannot misfire." | `.agents/rules/` cross-cutting rule on backend classification false-positive prevention. | Create only if a second backend (Codex, Cursor, OpenCode) hits a similar "banner ≠ structured error" issue. Skip for now. |
| 3 | "Banner-driven detection in stream-json `result` events should not modify `result.summary`; the structured `RunError` is the durable signal and the summary remains the human-readable banner string." | `.agents/rules/` rule on classifier vs summary boundary. | Defer until a regression risks rewriting `result.summary`. |

## Follow-Ups (Deferred From This Plan)

These items were considered and deferred. None block landing v1.

1. **Reset-time-aware cooldown deadline.** Parse a `resets_at` timestamp
   from the banner (when shaped like `resets HH:MM am|pm (TZ)`), compute
   `resets_at_ms`, and pass `cooldown_until_ms: max(now +
   cooldownSeconds * 1000, resets_at_ms)` into `markAccountCooledDown`.
   Requires extending the `MarkCooledDownInput` interface
   (`src/claude/accountRegistry.ts:402-407`) and adding a test for the
   override path. Tracked as the natural successor to v1.
2. **Plain non-JSON stdout banner scanner.** Add a line predicate to
   `handleJsonLine` (or a sibling stdout-line tap) that, when JSON parse
   fails, runs the banner regex against the raw line and synthesises the
   same `RunError` shape. Requires captured evidence first.
3. **Banner extension to `quota` / `auth` categories.** Same hook, new
   regex per banner shape. Requires captured fixtures.

## Quality Gates

- [ ] `pnpm build` passes.
- [ ] `pnpm test` passes, including the new unit and end-to-end tests.
- [ ] `pnpm verify` passes end-to-end.
- [ ] No regression in the existing rotation tests
      (`claudeRotation.test.ts`, `claudeRotationRace.test.ts`) — both
      continue to pass.
- [ ] `RunErrorSourceSchema` and `RunTerminalReasonSchema` are **not**
      modified.
- [ ] No new runtime dependency introduced.
- [ ] Banner regex anchors on "you('|’|ʼ|`)ve (hit|reached) your ... limit";
      a grep through `src/__tests__/` confirms no pre-existing fixture
      string accidentally matches the new pattern.
- [ ] `result.summary` text on the affected runs is preserved
      byte-for-byte (no classifier-driven rewrite).
- [ ] Structured-failure gate is provably enforced: T4 negative case #1
      (success-shape result event with banner-shaped text) yields
      `parsed.errors.length === 0`.
- [ ] No `process_exit` synthetic error appears in `result.errors` for
      banner-driven failures (asserted in T5).

## Execution Log

### T1: Extend `classifyErrorCategory` rate-limit regex
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T2: Synthesize a `RunError` from banner-bearing `result` events in `ClaudeBackend.parseEvent`, gated on structured failure
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T3: Unit-test the new classifier patterns
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T4: Unit-test `ClaudeBackend.parseEvent` banner synthesis and structured-failure gate
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T5: End-to-end rotation test driven by the banner
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T6: Run repository quality gates
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T7: Update plan execution log and link evidence
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending
