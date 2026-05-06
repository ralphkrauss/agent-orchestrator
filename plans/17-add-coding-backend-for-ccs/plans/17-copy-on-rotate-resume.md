# Cross-Account Session Resume Via Copy-On-Rotate

Branch: `17-add-coding-backend-for-ccs`
Plan Slug: `copy-on-rotate-resume`
Parent Issue: #17
Created: 2026-05-06
Updated: 2026-05-06 (post-reviewer-pass-3 — two further blocking findings
  addressed: D-COR-Lock now reconstructs the claimed-destinations set
  from on-disk run-summary metadata across daemon restart, with a
  durable-write ordering that ensures the new child's meta.json is
  fsync'd before the lock releases; D-COR-Resume-Layer now codifies the
  runtime-level interception contract via an additive optional
  `RuntimeStartInput.earlyEventInterceptor` field on `processManager.ts`,
  with the retry mechanics living in ProcessManager (cancel + discard +
  lifecycle event + re-spawn with caller-supplied `retryInvocation`) and
  the OrchestratorService side responsible only for constructing the
  block. Plus stale-wording cleanup: D-COR2 reordered to chmod-before-
  rename on the temp file, matching D-COR-PathHard. New T-COR-Race
  Test 8 simulates daemon-restart durability of the claimed set. New
  T-COR-Resume-Layer task with seven hermetic tests in
  `claudeResumeInterceptor.test.ts`. Pass 1+2 history: RQ-COR1..7
  promoted to Confirmed Decisions; error-category widening as HAT-COR3;
  api_env restriction as D-COR-API; same-parent rotation race captured
  as T-COR-Race; D-COR-PathHard ordering corrected — mkdir before
  realpath, `path.relative` containment instead of `startsWith`.)
Status: planning
Supersedes: D8 / A3 / T8 of `17-claude-multi-account.md`, **for in-priority
  rotation between two `config_dir` accounts only** — see HAT-COR2.

## Context

The companion sub-plan `17-claude-multi-account.md` (status: implementation
landed but uncommitted on this branch) shipped native multi-account support
for the `claude` backend and rotation on `rate_limit` / `quota`. That plan
locked three decisions about rotation behaviour:

- **D8 / A3** — rotated follow-ups always call `runtime.start()`; never
  `runtime.resume()`.
- **BI3** — rotation always produces a fresh chat, regardless of whether the
  underlying resume call returned 0.
- **T8** — implemented exactly that, tagging the run with
  `terminal_context.kind === "fresh_chat_after_rotation"` so the supervisor
  sees the loss of conversation continuity.

The rationale was that "Claude's session DB is per `CLAUDE_CONFIG_DIR`, so
cross-account resume is unreachable." A second deep-dive of upstream
`@kaitranntt/ccs@7.65.3` proved that conclusion incorrect:

- ccs's `--share-context` mechanism syncs `projects/` between profiles in the
  same `context_group` via **symlinks**
  (`shared-manager.js:412`, `shared-manager.js:1048` `fs.promises.symlink`).
- A shared `projects/` makes `claude --resume <session_id>` succeed across
  profiles, because Claude's session JSONLs live at
  `<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<session_id>.jsonl` and the
  symlinked tree makes that JSONL reachable from both profiles. The "session
  DB" framing in the previous plan was wrong: there is no opaque DB — there
  is a directory of plain JSONL files, one per session.
- Local verification on this branch wrote a live JSONL at
  `<run_store>/claude/accounts/smoketest/projects/-home-ubuntu-worktrees-agent-orchestrator-17-add-coding-backend-for-ccs/8bb342f7-...6f6e2.jsonl`
  using the documented encoded-cwd rule (replace path separators with `-`).

Symlinks are not portable (Windows requires admin or developer mode for
`CreateSymbolicLink`; directory junctions for the `projects/` parent have
edge cases). The user has approved a **copy-on-rotate** approach instead:
when rotation fires, copy the parent run's session JSONL from the old
account's `projects/` tree to the new account's analogous path, then spawn
the child run with `claude --resume <observed_session_id>`. Plain file
operations, fully portable, no symlink concerns.

The user's exact ask on issue #17 was "switch between chats when rate limit
is hit." The current implementation surfaces every rotation as a fresh
chat; this plan makes the user-visible behaviour an actual continuation
when feasible, with a clear, observable fallback to the existing fresh-chat
shape when copy or resume fails.

### What changed in this revision (post-reviewer pass)

1. **api_env accounts cannot use copy-on-rotate.** `api_env` mode injects
   `ANTHROPIC_API_KEY` and never sets `CLAUDE_CONFIG_DIR`, so a JSONL placed
   under `<run_store>/claude/accounts/<name>/projects/...` is invisible to
   Claude when running under that account. Rotations where source OR target
   is `api_env` are **skipped at the copy stage** and fall back to fresh-chat
   with `copy_skip_reason: "api_env_in_rotation_path"`. Captured as
   D-COR-API and BI-COR11.
2. **Resume-failure semantics are now explicit and consistent.** Single-shot
   rotation per `send_followup` with one transparent in-run retry **only**
   for stream-classified `session_not_found`; any other terminal error
   stops the child run and surfaces normally. `claude_rotation_state` is
   preserved across all paths (matching today's `applyRotationMetadata`
   behaviour at `orchestratorService.ts:1541`). State diagram below.
3. **A new error category `session_not_found` is added** to
   `RunErrorCategorySchema` (additive enum widening — HAT-COR3) keyed off
   structured stream-json `subtype`/`code` first, with stderr regex as a
   backup classifier. New T-COR-Classifier task.
4. **Same-parent rotation race is enforced by a per-parent rotation lock**
   in `OrchestratorService`. New T-COR-Race task; BI-COR7 reworded to cite
   the lock.
5. **Path hardening for the JSONL copy.** `sessionId` regex validation,
   `lstat`+regular-file check, `realpath` containment check, `mode 0o600`
   on rename target, try/finally temp cleanup. Tightened in T-COR1.
6. **Daemon-restart durability of the claimed-destinations set
   (pass-3).** D-COR-Lock now reconstructs `claimed` from on-disk
   run-summary metadata on cache miss (e.g. after restart). The lock
   resolution is gated on the new child's `meta.json` being durably
   written, so post-restart reconstruction is always at least as
   up-to-date as the in-memory cache was. New T-COR-Race Test 8.
7. **Runtime-level interceptor contract (pass-3).** The in-run retry is
   now plumbed through an additive optional
   `RuntimeStartInput.earlyEventInterceptor` field; mechanics live in
   `processManager.ts`, OrchestratorService just constructs the block
   and supplies the retry invocation. Backward-compatible (undefined
   = no behaviour change). New T-COR-Resume-Layer task; D-COR2 wording
   reordered to chmod-before-rename for consistency with
   D-COR-PathHard.

### Sources read

- `plans/17-add-coding-backend-for-ccs/plans/17-claude-multi-account.md`
  (D8, A3, BI3, T8, BI6, BI8, the env-scrub deny list, the registry
  layout under `<run_store>/claude/accounts/<name>/`).
- `src/orchestratorService.ts` — current `sendFollowup` rotation flow
  (lines ~510–626), `evaluateRotation` helper (lines ~629–691),
  `applyRotationMetadata` (lines ~1536–1552; `claude_rotation_state` is
  preserved on every rotated child).
- `src/claude/accountBinding.ts` — `ClaudeRotationState`,
  `appendRotationEntry`, `ClaudeRotationHistoryEntry`.
- `src/contract.ts` — `RunSummarySchema.terminal_context` is
  `z.record(z.unknown()).nullable()` (`src/contract.ts:305`); `kind` is a
  free-form payload key, **not** a schema-enforced enum (so the new
  `"resumed_after_rotation"` value is an additive payload value on an open
  record schema, not a Zod enum widening — see HAT-COR1).
  `RunErrorCategorySchema` is a closed Zod enum
  (`src/contract.ts:67`–`80`); adding `session_not_found` IS a Zod enum
  widening (HAT-COR3).
- `src/backend/common.ts:150` `errorFromEvent` and `:173` `classifyBackendError`
  — current ignores `subtype`; preserves `type`/`code`/`status` only on
  context. Extended in T-COR-Classifier.
- `src/processManager.ts:341` `terminalOverride`-aware error synthesis;
  needs to NOT mask a structured stream-json error if one was already
  classified.
- `src/backend/runtime.ts` — `RuntimeStartInput.accountSpawn`, the
  existing `start()` vs `resume(sessionId)` runtime entry points.
- Upstream `@kaitranntt/ccs@7.65.3` files cited above
  (`shared-manager.js:412`, `:483`, `:1048`).

## Goal And Scope

### Goal

When rotation fires (terminal `rate_limit` / `quota`, parent run has a
priority array, **both prior and new accounts are `config_dir` mode**),
attempt a true cross-account resume by copying the parent run's session
JSONL from the old account's `projects/` tree to the new account's
analogous path, then invoking `claude --resume <observed_session_id>`
under the new account. On a **classifier-detected `session_not_found`**
resume failure (T-COR-Classifier), the daemon transparently retries with
`runtime.start()` within the **same managed run** via a pre-terminal
stream interceptor (D-COR-Resume-Layer) so the supervisor sees a single
clean fresh-chat run instead of two. **All other resume failures** (auth,
rate_limit, quota, protocol, backend_unavailable, process_exit, …)
terminate the run with their normal error path; the supervisor's next
`send_followup` re-evaluates rotation against the now-bound account.
Source-missing, copy failure, byte-collision, api_env participation, and
unsafe-input rejections fall back to today's fresh-chat shape with a
structured `copy_skip_reason` — observable, durable, identical to today.

### In Scope

- New helper module `src/claude/sessionCopy.ts` (T-COR1) implementing the
  encoded-cwd rule, atomic copy, path hardening, and cycle-collision
  handling.
- Rotation flow update in `OrchestratorService.sendFollowup` (T-COR2):
  pre-spawn copy attempt → choose `runtime.resume()` vs `runtime.start()`
  based on outcome.
- Same-parent rotation race enforcement via a per-parent
  `Map<run_id, Promise<rotation>>` lock in `OrchestratorService`
  (T-COR-Race).
- Error-classifier extension (T-COR-Classifier): preserve `subtype` on
  `latest_error.context`, add `session_not_found` to
  `RunErrorCategorySchema`, route stream-json structured errors through
  even when the worker exits non-zero.
- Transparent in-run retry on `session_not_found` (one shot, scoped to
  the same managed run): re-spawn with `runtime.start()` under the
  newly-bound account; tag with `kind: "fresh_chat_after_rotation"`,
  `resume_attempted: true`, `resume_failure_reason: "session_not_found"`.
- New `terminal_context` payload values: `kind === "resumed_after_rotation"`
  for successful copy + resume, plus the existing
  `kind === "fresh_chat_after_rotation"` shape extended with structured
  `copy_skip_reason` / `resume_failure_reason` / `resume_attempted` fields
  for every fallback path.
- Additive optional `resumed?: boolean` on
  `ClaudeRotationHistoryEntry` (T-COR3) — defined as **"resume was
  attempted in this rotation step"** (selected and spawned), not "child
  succeeded". Easier to make durable; less ambiguous on partial failures.
- Tests (T-COR4) — see Implementation Tasks for the full coverage list.
- Docs (T-COR5) — `docs/development/claude-multi-account.md` rotation
  section rewrite, optional live-smoke procedure, embedded
  issue-comment-draft note (in the parent plan only — single-threaded
  history).

### Out Of Scope

- Symlink-based sharing (rejected for portability).
- A first-class "rotation group" concept on the account registry. Any two
  `config_dir`-mode accounts named in `claude_account_priority` are
  rotation-resume candidates; no group registration needed.
- **api_env-mode rotation participation in copy-on-resume.** `api_env`
  accounts may still appear in the priority array and still rotate, but
  rotations where source OR target is `api_env` skip the copy step
  entirely (D-COR-API / BI-COR11).
- Replaying MCP-server-set differences or other per-account config
  differences across rotation. Risk R-COR2.
- Periodic pruning of stale JSONL copies in old accounts. Future Option.
- Symlinks on Windows / WSL.
- A new MCP tool or new CLI subcommand for rotation control.
- Bumping any dependency.
- Mid-run pre-emptive rotation. Still a Future Option per the parent
  plan.
- Auto-respawn after **non-`session_not_found`** resume failures. Those
  surface as a normal terminal error on the child; the next user-driven
  `send_followup` is treated as a fresh rotation evaluation (the
  just-rotated-to account is now the new "active" account, so the
  parent plan's rotation eligibility check runs again from there).

## Confirmed Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| D-COR1 | Mechanism for cross-account resume | Copy the source JSONL into the new account's `projects/<encoded-cwd>/` then `claude --resume <sid>` under the new account. Symlinks are explicitly rejected. | Plain file operations are portable across all supported platforms; no admin / developer-mode requirement on Windows; no junction edge cases. | (a) Symlinks — non-portable, breaks Windows. (b) Reflinks (CoW) — not portable beyond btrfs/xfs. (c) Move (not copy) — destroys the parent's audit trail in the old account's tree. |
| D-COR2 | Atomic write strategy | `fs.copyFile(src, tmp)` to a sibling `<sid>.jsonl.tmp.<pid>.<8-char-random>` in the destination directory, **then `fs.chmod(tmp, 0o600)` BEFORE the rename**, then `fs.rename(tmp, dst)` to publish. Destination parent directories are created with `mode: 0o700` if missing. Sequence is `copyFile → chmod(tmp, 0o600) → rename(tmp, dst)` — the rename publishes the destination atomically already at mode `0o600`, so there is no observable mode-change race between rename completion and a follow-up chmod. The temp file is unlinked in a `try { … } finally { … }` block on every failure path so a leak cannot persist. **`fs.rename` will replace an existing destination atomically** — the same-parent rotation race fix (T-COR-Race) means we cannot rely on "one winner" semantics; idempotency is delegated to D-COR3's byte-equal short-circuit instead. | `rename` is atomic within a filesystem; readers either see the old destination state (or absence) or the fully-written file — never a half-written file. The chmod-on-tmp ordering means the file appears at its final path with the daemon-owned `0o600` mode from the very first observable moment; matches the parent plan's daemon-owned-secret posture. The `try/finally` cleanup is a security invariant (don't leak partially-written copies of session content into the destination tree). | (a) `fs.copyFile(src, dst, COPYFILE_EXCL)` direct — refuses overwrite but is not atomic mid-write and cannot express "byte-equal => no-op". (b) `fs.writeFile(dst, await fs.readFile(src))` — buffers entire JSONL in memory; large sessions are real. (c) Stream copy — atomic only with rename anyway; copyFile is simpler and good enough. (d) `chmod(dst)` after `rename` — leaves a brief mode-default window during which the file is at its final path with the default umask; rejected. |
| D-COR3 | Cycle handling A → B → A (resolves RQ-COR3) | When copying back to A and a JSONL with the same `session_id` already exists in A's `projects/`, **compare bytes**. **Equal** = no-op-as-success (write `terminal_context.collision_resolution: "noop"`; `claude --resume` proceeds against the existing file). **Different** = refuse the copy with `OrchestratorErrorCode === "INVALID_STATE"` / `details.reason === "session_jsonl_collision"` reported on the helper outcome, then fall through to fresh-chat with `copy_skip_reason: "session_jsonl_collision"`. **Note:** A → B → A after B has appended turns will likely refuse and fall through; that is the right behaviour — B's appended turns are not representable in A's old JSONL, and forcing `--resume` against a stale file would produce a hallucinated continuation. | A's tree owns A's history; silently overwriting it with a divergent copy from B would corrupt A's audit trail. Equality-as-no-op handles the common idempotent case (no new turns). The same-parent race (T-COR-Race) also lands here: the second concurrent rotation that picks the same destination sees the first call's already-written copy and short-circuits as no-op. | (a) Always overwrite — risks losing turns recorded in A but not B. (b) Always refuse — pessimistic; loses the common idempotent case. (c) Append-merge — JSONL semantics across two divergent histories are undefined for `claude --resume`. |
| D-COR4 | Encoded-cwd rule (resolves RQ-COR2) | `encodeProjectCwd(absoluteCwd) = absoluteCwd.replace(/\//g, '-')`. Example: `/home/ubuntu/worktrees-agent-orchestrator/17-add-coding-backend-for-ccs` → `-home-ubuntu-worktrees-agent-orchestrator-17-add-coding-backend-for-ccs`. The leading slash becomes a leading `-`. **Confirmed against the live on-disk path on this branch:** `accounts/smoketest/projects/-home-ubuntu-worktrees-agent-orchestrator-17-add-coding-backend-for-ccs/8bb342f7-...6f6e2.jsonl`. T-COR1 includes a unit test pinning the encoder against this exact round-trip. | Documented Claude Code behaviour; matches on-disk evidence. If Claude changes the encoding, the helper surfaces `session_jsonl_not_found` (BI-COR8) and rotation falls back. | (a) URL-encoding — does not match observed paths. (b) Hashing — does not match observed paths. (c) Raw path — illegal characters on Windows and not what Claude writes. |
| D-COR5 | Failure handling — scoped, observable, never blocks rotation | **Pre-spawn failures** (every helper outcome plus the api_env / no-observed-session-id / source-missing gates) fall back to today's fresh-chat path: `terminal_context.kind === "fresh_chat_after_rotation"` plus the additive `terminal_context.copy_skip_reason` field describing why (`"source_missing"`, `"source_disappeared_during_copy"`, `"source_not_regular_file"`, `"unsafe_session_id"`, `"path_escape"`, `"copy_failed"`, `"session_jsonl_collision"`, `"api_env_in_rotation_path"`, `"no_observed_session_id"`, `"session_jsonl_not_found"`). **Post-spawn resume failures** are split: a classifier-detected `session_not_found` triggers the in-run interceptor retry (D-COR-Resume-Layer) — child terminates with `kind: "fresh_chat_after_rotation"`, `resume_attempted: true`, `resume_failure_reason: "session_not_found"`; **all other resume failures** (auth, rate_limit, quota, protocol, backend_unavailable, process_exit, …) terminate the run normally with their original error category and `kind: "resumed_after_rotation"` intact — no transparent retry, no fresh-chat masking. The supervisor's next `send_followup` against that child re-evaluates rotation. | Matches BI-COR5: a copy or pre-spawn hiccup must never make rotation worse than today's fresh-chat behaviour, but the daemon must NOT mask real auth / quota / protocol failures by silently retrying as fresh-chat — those are bugs the user needs to see. The structured `copy_skip_reason` / `resume_failure_reason` is observable so users can distinguish copy path, resume retry path, and normal terminal failure. | (a) Hard-fail rotation on any pre-spawn issue — regresses today's behaviour. (b) Transparent retry on any resume failure — masks auth/quota errors. (c) Silent fallback with no observability — fails BI-COR5's "tell the supervisor what happened" intent. |
| D-COR6 | Public-contract surface | Schema-level changes: **only one Zod enum widening** — `RunErrorCategorySchema` gains `"session_not_found"` (HAT-COR3 / T-COR-Classifier). Everything else is additive on already-open record schemas: a new `terminal_context.kind` payload value `"resumed_after_rotation"` (`terminal_context` is `z.record(z.unknown())` — `src/contract.ts:305` — so adding a new `kind` value is **not** an enum widening); additive optional `metadata.claude_rotation_history[i].resumed?: boolean`; additive `terminal_context.copy_skip_reason` / `resume_failure_reason` / `resume_attempted` / `collision_resolution` keys. `BackendSchema`, `RunSummarySchema`, `WorkerProfileSchema` are unchanged. | Matches the parent plan's additivity discipline. The new error category is the only Zod enum widening; documented under HAT-COR3 because supervisors that filter by `latest_error.category` will need to know about it. | A new top-level field on `RunSummarySchema` — premature. A schema enum for `terminal_context.kind` — would have required wider refactoring (today nothing constrains `kind`). |
| D-COR-API | api_env accounts are skipped from copy-on-rotate | When **either** the prior account or the newly-bound account in a rotation step is `api_env` mode, the daemon **skips the copy step entirely** and falls through to today's fresh-chat shape with `copy_skip_reason: "api_env_in_rotation_path"` plus `details: { prior_mode, new_mode }`. The rotation itself still happens (cooldown is still set on the prior account; the new account is still bound; `runtime.start()` is still called) — only the JSONL copy and the `runtime.resume()` path are skipped. **`api_env` accounts may still appear in the priority array** and still participate in rotation as fresh-chat targets / sources; this is unchanged from the parent plan. | `api_env` mode injects `ANTHROPIC_API_KEY` and never sets `CLAUDE_CONFIG_DIR`. A JSONL placed under `<run_store>/claude/accounts/<name>/` is invisible to Claude when running under `api_env`, so a copy would be wasted I/O and a `--resume` would reliably fail. Skipping at the rotation-flow level (not at the helper) keeps `sessionCopy.ts` ignorant of account modes and the policy-vs-mechanism split clean. **No OHD** — this does not widen api_env's binding contract; it documents an invariant that already holds in the parent plan's design. | (a) Try the copy anyway and rely on `claude --resume` to fail — wastes I/O and burdens the resume-failure retry path. (b) Disallow api_env in rotation priorities — overreach; the user explicitly approved api_env-as-rotation-target in the parent plan. (c) Inject `CLAUDE_CONFIG_DIR` for api_env accounts in this slice — out of scope and contradicts the parent plan's BI8 (api_env accounts deliberately do not own a config dir). |
| D-COR-Resume | Resume failure semantics (high-level) | **Single-shot rotation per `send_followup`.** Pre-spawn check: source JSONL existence is verified via `fs.lstat` BEFORE the spawn decision. If missing, the spawn is `runtime.start()` and `kind: "fresh_chat_after_rotation"` with `copy_skip_reason: "source_missing"`. If present, the helper performs the copy; on success the spawn is `runtime.resume(<sid>)` and `kind: "resumed_after_rotation"`. **In-run retry on session_not_found:** if the resume worker emits a classifier-detected `session_not_found` event early in the stream (mechanics in D-COR-Resume-Layer), the daemon transparently re-spawns within the same managed run using `runtime.start()` against the same newly-bound account; the resulting run record carries `kind: "fresh_chat_after_rotation"` plus `resume_attempted: true` and `resume_failure_reason: "session_not_found"`. **One-shot only**, scoped strictly to `session_not_found` detected within the threshold (D-COR-Resume-Layer). **All other resume failures terminate the child normally** (auth, rate_limit, quota, protocol, backend_unavailable, process_exit, …); `kind: "resumed_after_rotation"` stands; the supervisor's next `send_followup` against that child is a fresh rotation evaluation. **`claude_rotation_state` is preserved on every path** — matching today's `applyRotationMetadata` behaviour at `orchestratorService.ts:1541`. | Single explicit semantic, easy to reason about, observable end-to-end. The transparent retry is the user's "I expect rotation to just work" contract for the one error class that is genuinely benign (the JSONL got copied but Claude rejected the session id — stale binary version, truncated file, etc.). All other failures are real and should be visible. | (a) No transparent retry — surfaces a confusing extra `send_followup` step for what is essentially a copy that "didn't take". (b) Transparent retry on any resume failure — can mask real auth / quota errors. (c) Strip `claude_rotation_state` after a failed resume — fights the rest of the rotation machinery (cooldown bookkeeping, rotation-history truncation, etc.). |
| D-COR-Resume-Layer | Runtime-level interception contract for the in-run retry (resolves pass-2 finding #2; pass-3 finding #2 codifies the `RuntimeStartInput.earlyEventInterceptor` surface) | The retry **cannot** live at `ProcessManager.finalizeRun` because by then `RunStore.markTerminal` has already fired and the run record is frozen. The current `OrchestratorService.startManagedRun` (`src/orchestratorService.ts:942`) likewise has no hook to abort-and-retry — it only sees the runtime handle and the final completion promise; events are parsed and appended internally by `ProcessManager` (`src/processManager.ts:150`). The retry therefore needs a new **interception contract** plumbed through the runtime layer. **Field shape on `RuntimeStartInput`:** add an optional `earlyEventInterceptor?: { thresholdEvents: number; thresholdMs: number; classify: (event: WorkerEvent) => "continue" \| "retry_with_start"; retryInvocation: WorkerInvocation; }`. When set, `ProcessManager.start` (or its wrapper `CliRuntime.start`) processes events as today AND, for each event observed within the early window (event count `< thresholdEvents` AND wall-clock ms since spawn `< thresholdMs`), additionally invokes `classify(event)`. **Classifier outcomes:** `"continue"` → no-op, normal event flow continues. `"retry_with_start"` → enter the retry path. **Retry path mechanics inside `ProcessManager`:** (1) cancel the current worker via the existing `cancelRun` machinery (kill the process group); (2) discard buffered events from this attempt — do NOT call `appendEvent` or `markTerminal` for any event captured during the cancelled attempt (the events are still in the in-memory interceptor buffer; ProcessManager simply does not flush them); (3) emit one structured `lifecycle` event via the existing event-append surface with payload `{ type: "lifecycle", subtype: "session_not_found_in_run_retry", killed_pid, resume_attempt_duration_ms, observed_events }`; (4) re-spawn the worker using the caller-supplied `retryInvocation`; (5) the retry worker's events flow normally to `appendEvent` and finally to `finalizeRun` / `markTerminal`. **Single-shot:** the interceptor is NOT applied to the retry worker — `retryInvocation` does not carry an `earlyEventInterceptor`. If the retry worker also fails (any error), it terminates with that error. **Threshold expiry:** when event count crosses `thresholdEvents` OR wall-clock crosses `thresholdMs`, the interceptor disengages — `classify` is no longer invoked for subsequent events, and `"retry_with_start"` returned past the threshold has no effect. The threshold is bounded so a slow worker cannot sit indefinitely in interceptor mode. **Backward compatibility:** when `earlyEventInterceptor` is undefined (every existing caller, every non-rotation run), `ProcessManager.start` behaves exactly as today — there is no observable difference for non-rotation runs, no env-policy changes (parent plan's BI8 still holds), no event-flow changes. **Single-shot, single-flight:** at most one retry per child run id; `markTerminal` is invoked exactly once per child run id regardless of whether the interceptor fired. **`OrchestratorService.startManagedRun` integration:** for rotation runs that decided on `runtime.resume(<sid>)`, `startManagedRun` constructs the `earlyEventInterceptor` block with `thresholdEvents: 50`, `thresholdMs: 5_000` (named constant `SESSION_NOT_FOUND_INTERCEPT_THRESHOLD` in `orchestratorService.ts`), `classify: e => e.latestErrorCategory === "session_not_found" ? "retry_with_start" : "continue"` (using the T-COR-Classifier output on `latest_error`), and `retryInvocation` = a new `WorkerInvocation` derived from the same `accountSpawn`, same prompt, same model + settings, but with no session id (`runtime.start()` shape, not resume). For non-rotation runs and for the retry worker itself, `earlyEventInterceptor` is undefined. **Observability invariants:** `events.jsonl` for the child run contains exactly one `lifecycle / session_not_found_in_run_retry` event when the interceptor fired, zero otherwise. The events from the cancelled attempt are NOT flushed (they are visible only in the lifecycle event's `observed_events` count). `markTerminal` is invoked exactly once per child run id. | The pass-3 review correctly identified that the pass-2 wording assumed a hook on `OrchestratorService.startManagedRun` that does not exist; events flow through `ProcessManager` not through `startManagedRun`. The interceptor must be a `processManager.ts` change, but additive — the `earlyEventInterceptor` field is optional, defaults to no interception, and matches the parent plan's discipline of additive runtime-input fields (precedent: `accountSpawn` from parent T2). The single-shot, threshold-bounded design avoids the "interceptor that never disengages" failure mode. The lifecycle event keeps the retry observable so it cannot be confused with a daemon bug. | (a) Retry inside `ProcessManager.finalizeRun` — too late; run is already marked terminal. (b) Retry by issuing a follow-up `start_run` from outside — creates a second run record, contradicts the "transparent" goal. (c) Subscribe at `OrchestratorService` layer with no `processManager` change — events do not flow through `startManagedRun`; would require duplicating event parsing. (d) Always retry on any pre-terminal `session_not_found` — could loop if the start() retry also surfaces the category. (e) No threshold — could mask legitimate late-stream failures that look like `session_not_found` because the model wrote those words. (f) Surface the interceptor as a free-form callback exposed to user-supplied profiles — too much surface area; v1 keeps it daemon-internal. |
| D-COR-Lock | Same-parent rotation lock + claimed-destinations set, durable across daemon restart (resolves pass-1 finding #4, pass-2 finding #1, pass-3 finding #1) | `OrchestratorService` carries a per-parent rotation tracker: `private rotationTrackers: Map<string, { lock: Promise<RotationDecision>; claimed: Set<string>; reconstructed: boolean }>`. The `claimed` set is **the source-of-truth view** of "destinations already bound to a child run of this parent"; the durable on-disk truth is the run store itself (each rotated child's `meta.json` carries `metadata.claude_rotation_state.parent_run_id` and `metadata.claude_account_used`). The in-memory tracker is just a cache. **Reconstruction algorithm:** when `evaluateRotation(parent)` is called and the tracker either does not exist or has `reconstructed === false`, the daemon: (a) iterates run summaries via the existing `RunStore.listRuns` / `loadRun` surface filtered to `metadata.claude_rotation_state.parent_run_id === parent.run_id`; (b) for each match, reads `metadata.claude_account_used` and adds it to `claimed`; (c) sets `reconstructed = true` and stores the tracker on the map. This pass is **O(N children of the parent)** which is bounded by the rotation-history cap (BI-COR6 cap is 32 entries → at most ~32 children per parent), so the cost is negligible. The pass is performed only on cache miss — subsequent calls hit the in-memory tracker. **Durable-write ordering:** when a new rotation publishes a child, the destination is added to `tracker.claimed` AND the daemon `await`s the `RunStore` write of the child's `meta.json` (the existing `markCreated` / `markStarted` writes that record `metadata.claude_rotation_state` and `metadata.claude_account_used`) BEFORE the tracker `lock` promise resolves. This guarantees that even if the daemon crashes immediately after the lock release, the next reconstruction will find the child on disk and re-add it to `claimed`. **The priorAccount filter is applied separately** — `priorAccount` is the parent's own active account, which may not yet appear in any child's metadata (it never will, in fact, because the parent itself does not have a `claude_rotation_state` entry); rotation evaluation always excludes `priorAccount` regardless of the reconstructed `claimed` set. **Lifetime:** the tracker entry is removed from the map only when the parent run is pruned from the run store; until then it stays cached. A daemon restart loses the cache but the next call re-runs the reconstruction. **The lock entry's promise still resolves only after the prior account is marked cooled-down on disk AND the new child's meta.json is durably written** so a second waiter (or a post-restart caller) sees both signals. **Priority exhaustion error** when `claimed ∪ cooled-down ∪ {priorAccount}` covers every priority entry: `INVALID_STATE` with `details.reason === "priority_exhausted_for_parent"` and `details.{ claimed, cooled_down, priority }` payload. **JSONL copy idempotency** via D-COR3's byte-equal short-circuit remains a belt-and-braces guard. | The pass-1 lock-only design serialised evaluation but did not bind a destination once chosen. The pass-2 in-memory `claimed` set fixed that for the live process but lost durability on daemon restart — a second `send_followup` after restart would see an empty `claimed` set and pick the same destination as the pre-restart followup. The pass-3 reconstruction-from-run-store algorithm closes the durability gap without adding any new persistence surface (no new disk file, no new schema). The "await the meta.json write before releasing the lock" ordering ensures the durable record is always at least as up-to-date as the in-memory cache. | (a) Lock-only — fails for back-to-back concurrent followups. (b) In-memory claimed only — fails after daemon restart (pass-3 gap). (c) Persist a separate `<run_store>/claude/rotation_claims.json` — duplicates state already in run-summary metadata; new failure mode if the file diverges from the run store. (d) Cool down B preemptively at rotation decision — pollutes the cooldown signal across the daemon for non-rate-limit reasons. (e) Eager scan at startup — wasted work for parents that never get a follow-up; lazy reconstruction is cheaper. |
| D-COR-PathHard | JSONL-copy path hardening (resolves pass-1 finding #5; pass-2 finding #3 corrects ordering / containment / chmod-rename atomicity) | The session-copy helper enforces every step in this order: **(i) Validate inputs.** `sessionId` matches `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` (no path separators, no `..`, leading-alphanumeric anchor) — reject `unsafe_session_id`. Account names validated via `isValidAccountName`. **(ii) Compute paths and prepare destination tree.** `sourcePath`, `sourceProjectsRoot`, `targetPath`, `targetProjectsRoot`, `targetParent`. Run `fs.mkdir(targetParent, { recursive: true, mode: 0o700 })` BEFORE any `realpath` call so the resolution can succeed; `mkdir` is idempotent and creates intermediate components with the same mode. **(iii) lstat the source** — `isFile()` must be true; symlinks, FIFOs, devices, sockets refused with `source_not_regular_file`. **(iv) Containment check using `path.relative`** (NOT `startsWith`, which would treat `/foo/bar` as a prefix of `/foo/bar2`): for both source-side (`fs.realpath(sourcePath)` resolved against `fs.realpath(sourceProjectsRoot)`) and target-side (`fs.realpath(targetParent)` resolved against `fs.realpath(targetAccountRoot)/projects`), compute `rel = path.relative(root, resolved)` and reject `path_escape` if `rel === ''` (the resolved path equals the root) OR `rel.startsWith('..' + path.sep)` OR `rel === '..'` OR `path.isAbsolute(rel)` (which fires on Windows when the resolution crosses drive boundaries). **(v) Cycle handling** — if destination JSONL exists, `lstat` it for regular-file invariant, byte-compare via `fs.readFile` + `Buffer.equals`. Equal: success / `collision_resolution: "noop"`. Different: `session_jsonl_collision`. **(vi) Atomic copy with mode set on the temp file BEFORE rename:** `tmp = <target>.tmp.<process.pid>.<8-char-hex>`. `try { await fs.copyFile(source, tmp); await fs.chmod(tmp, 0o600); await fs.rename(tmp, target); } catch (err) { … } finally { await fs.rm(tmp, { force: true }) }`. The rename publishes the file at its final path with mode `0o600` already set — there is **no observable mode-change race** between `rename` and a follow-up `chmod`. On `ENOENT` from `copyFile`: `source_disappeared_during_copy`. On any other `fs.*` error: `copy_failed` with `details: { code, syscall }`. **(vii) Never throw out of the helper** — every failure mode is captured in the discriminated `CopyOutcome.reason` union. | The pass-2 review correctly identified three concrete gaps in the pass-1 wording: `realpath` on a target parent that doesn't exist yet always fails; `startsWith` containment checks are vulnerable to sibling-path prefix matches; `chmod` after `rename` leaves a mode-window during which the file is at its final path with default mode. The corrected order (mkdir → realpath → containment → lstat → copy → chmod → rename) closes all three. Using `path.relative` for containment is the canonical Node idiom and is correct on both POSIX and Windows. Rejecting symlinks via `lstat` closes a TOCTOU vector. | (a) Trust the registry — fails defence in depth. (b) `path.normalize` only — does not resolve symlinks. (c) Skip the regular-file check — misses TOCTOU and FIFO/device read-blocks. (d) `chmod` after rename — leaves a brief mode-default window. (e) `realpath` before `mkdir` — fails on first-run when the target's parent does not yet exist. (f) `startsWith` for containment — vulnerable to sibling prefixes. |
| D-COR-Classifier | Add `session_not_found` to `RunErrorCategorySchema`; preserve `subtype` on context (resolves RQ-COR1) | `RunErrorCategorySchema` (`src/contract.ts:67`) gains `"session_not_found"` as an additive enum value. `errorFromEvent` (`src/backend/common.ts:150`) is extended to read `subtype` from both the nested `error` object and the top-level event record, copy it onto `context.subtype`, and pass it through `classifyBackendError`. `classifyErrorCategory` gets a new branch that **first** checks structured indicators (`context.subtype === "session_not_found"` or `context.code === "session_not_found"` — case-insensitive) and **falls back** to a stderr regex `/session\s+not\s+found/i` + `/no\s+(?:such\s+)?session/i` on `source: 'stderr'` events. `processManager.ts:341` (the `process_exit` synthesis path) is updated to NOT mask a structured `session_not_found` (or any other classified) error — when `dedupeErrors(observedErrors)` already contains a non-`process_exit` classified error, the `processExitError` is suppressed. **HAT-COR3** is required because this widens the public Zod enum. | The reviewer correctly noted that today's classifier loses `subtype` and that `process_exit` masks structured failures. Both are pre-existing bugs that this slice has to fix to make the resume-retry semantics work. The structured-first ordering avoids false positives from arbitrary user prompts mentioning the phrase. | (a) Classify as `protocol` and inspect `context.subtype` downstream — the reviewer explicitly asked for the new category; downstream supervisors filter by `category` and would otherwise miss it. (b) stderr-only classification — fragile across Claude Code versions. (c) Leave `process_exit` masking in place — keeps the bug; rotation retry would not see the structured category. |

## Assumptions

- **A-COR1.** `claude --resume <sid>` succeeds when `<sid>.jsonl` is present
  at the runtime's `CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/`. Tested
  hermetically by the fake-claude binary; see T-COR4.
- **A-COR2.** The encoded-cwd rule is `replace('/', '-')` over the absolute
  cwd (D-COR4). If Claude changes the rule, the helper raises
  `session_jsonl_not_found` and rotation falls back.
- **A-COR3.** A session JSONL written under account A is forward-compatible
  with `claude --resume` under account B when the binary version, the
  `cwd`, the model, and the prompt formatting all match. Parent plan's
  `send_followup` already pins model + validated `model_settings` across
  rotation (`orchestratorService.ts:540`–`548`).
- **A-COR4.** `fs.rename` is atomic within the same filesystem. The helper
  always writes the temp file as a sibling of the target so this holds.
- **A-COR5.** The cooldown registry write and the JSONL copy are
  independent: a failed copy does not block the cooldown write, and a
  failed cooldown write does not block the copy. Best-effort semantics
  are unchanged from the parent plan's T8 post-review fix.
- **A-COR6.** Concurrent rotations off the **same** parent are serialised
  by D-COR-Lock and therefore evaluate against successively updated
  cooldown state — they cannot both pick the same destination unless
  the priority is exhausted (in which case the second call returns
  `INVALID_STATE`). Concurrent rotations off **different** parents are
  independent and need no lock.
- **A-COR7.** `runtime.resume(sessionId, input)` already exists on
  `WorkerRuntime` (`src/backend/runtime.ts:49`); the in-run retry on
  `session_not_found` re-uses `runtime.start()` against the same managed
  run id (no new run record).

## Behavior Invariants

- **BI-COR1.** Single-account runs (no `claude_account_priority`) are
  unchanged: no copy, no cross-account resume, behaviour identical to the
  parent plan today.
- **BI-COR2.** During rotation, the OLD account's `projects/` tree is
  treated as **read-only** by daemon code (no writes back, no deletions).
- **BI-COR3.** Target JSONL writes use the atomic `copyFile + rename`
  pattern (D-COR2). No mid-write state is observable to a concurrent
  reader. Temp files are always cleaned up on failure (D-COR-PathHard).
- **BI-COR4.** Auth / identity state (`<config_dir>/.claude.json`,
  `<config_dir>/.credentials.json`, `<config_dir>/settings.json`,
  registered MCP servers, OAuth tokens, plugins) is **never** read or
  written by daemon copy code. Only the per-session JSONL under
  `projects/<encoded-cwd>/<sid>.jsonl` is touched. Tested by `fs.*` spy
  AND a target-tree-byte-identity assertion in T-COR4.
- **BI-COR5.** On any copy or resume failure, the rotation falls back to
  the fresh-chat shape; the child run still produces a clean terminal
  status; `terminal_context.kind === "fresh_chat_after_rotation"` and a
  structured `copy_skip_reason` (or `resume_failure_reason`) describes
  why.
- **BI-COR6.** `metadata.claude_rotation_history[i].resumed` is `true`
  iff resume was **attempted** in that rotation step (the daemon
  selected and spawned `runtime.resume()`). It does NOT track whether
  the child later succeeded or got rejected for `session_not_found` —
  those outcomes live in `terminal_context` on the run record itself.
- **BI-COR7.** Concurrent rotations off the same parent target distinct
  destinations, enforced by **two independent guards (D-COR-Lock):**
  (a) a per-parent **lock** that serialises the picker so concurrent
  callers do not race the cooldown write; and (b) a per-parent
  **claimed-destinations set** that filters already-bound destinations
  out of priority resolution at decision time, so the second caller
  cannot pick the same account as the first even though that account is
  not yet (and may never be) cooled-down. Priority exhaustion against
  `claimed ∪ cooled-down` returns `INVALID_STATE` /
  `priority_exhausted_for_parent`. D-COR3's byte-equal short-circuit
  remains a belt-and-braces idempotency guard against any future
  regression that bypasses `claimed`.
- **BI-COR8.** If the source JSONL is not at the path computed via
  D-COR4's encoded-cwd rule, the helper surfaces
  `session_jsonl_not_found` and the rotation falls back. Forward-
  compatibility hatch.
- **BI-COR9.** The env-scrub policy (parent plan's BI8 / D12 deny list) is
  unchanged by this slice. The new account's spawn still scrubs
  `ANTHROPIC_*` / `CLAUDE_CONFIG_DIR` / `CLAUDECODE` / vendor-token
  globs from the inherited daemon env exactly as today.
- **BI-COR10.** The daemon never reads or writes user-owned
  `CLAUDE_CONFIG_DIR` paths outside `<run_store>/claude/accounts/`.
  Helper reads only from `<run_store>/claude/accounts/<old>/projects/...`
  and writes only to `<run_store>/claude/accounts/<new>/projects/...`,
  with `realpath`-containment checks on both sides (D-COR-PathHard).
- **BI-COR11.** **api_env restriction.** When source OR target account is
  `api_env` mode, the copy step is skipped and rotation falls back to
  fresh-chat with `copy_skip_reason: "api_env_in_rotation_path"`. The
  rotation otherwise proceeds (cooldown set on prior, new account bound,
  `runtime.start()` called). See D-COR-API.
- **BI-COR12.** `claude_rotation_state` is preserved on every rotation
  child run, regardless of which path was taken (resumed, source-missing,
  copy-failed, session-not-found retry). This matches the existing
  `applyRotationMetadata` behaviour and is a regression target in T-COR4.

## Rotation State Diagram

```
                                send_followup(parent)
                                          |
                                          v
                       evaluateRotation (D-COR-Lock)
                       lock-await + claimed-set filter + cooldown filter
                                          |
            +-- not eligible / single-account -----> return error / non-rotation followup (unchanged)
            |
            +-- priority exhausted (all claimed or cooled-down) ---> INVALID_STATE
            |                                                       reason: "priority_exhausted_for_parent"
            |                                                       details: { claimed, cooled_down, priority }
            |
            v eligible — destination D selected, added to tracker.claimed atomically with lock release
                  |
                  v
          +-- prior or new account mode is api_env --+ copy_skip_reason: "api_env_in_rotation_path"
          |                                            kind: "fresh_chat_after_rotation"
          |                                            resumed: false
          |                                            runtime.start()  (BI-COR11 / D-COR-API)
          |
          v BOTH are config_dir
                  |
                  v
          observed_session_id present?
                  |
          +-- no -+  copy_skip_reason: "no_observed_session_id" / kind: "fresh_chat_after_rotation"
          |          resumed: false / runtime.start()
          |
          v yes
                  |
                  v helper steps (D-COR-PathHard order)
                  |
       (i)   sessionId regex                 ─ fail ─> copy_skip_reason: "unsafe_session_id"
       (ii)  mkdir target parent (idempotent)
       (iii) lstat source                    ─ ENOENT ─> "source_missing"
                                              ─ !isFile ─> "source_not_regular_file"
       (iv)  realpath + path.relative both sides ─ escape ─> "path_escape"
       (v)   destination exists?
                  |
            +-- yes, byte-equal ---> success no-op (collision_resolution: "noop")
            |
            +-- yes, byte-different -> copy_skip_reason: "session_jsonl_collision"
            |
            v no
       (vi)  copyFile -> chmod 0o600 -> rename (atomic, finally rm tmp)
                  |
                  +-- ENOENT mid-copy -----> copy_skip_reason: "source_disappeared_during_copy"
                  +-- EACCES / ENOSPC / etc -> copy_skip_reason: "copy_failed" + details.code
                  |
                  v success
       (vii) [Some Claude versions return session_jsonl_not_found late
             at the resume site even when the helper succeeded — that
             is the post-spawn "session_not_found" path below.]

           every fallback above lands in:
             kind: "fresh_chat_after_rotation"
             copy_skip_reason: <one of the named values>
             resumed: false
             runtime.start()

           helper success lands in:
             kind: "resumed_after_rotation"
             payload: { resumed_session_id, source_path, target_path,
                        copied_bytes, copy_duration_ms, collision_resolution? }
             resumed: true
             runtime.resume(sessionId)
                  |
                  v worker emits stream events
                  |
        D-COR-Resume-Layer pre-terminal interceptor watches first
        min(50 events, 5s) for classifier-detected session_not_found
                  |
        +-- early session_not_found --+ kill resume worker; discard buffered events;
        |                              | append lifecycle / session_not_found_in_run_retry;
        |                              | runtime.start() in same managed run id;
        |                              | terminal: kind = "fresh_chat_after_rotation"
        |                              |           resume_attempted: true
        |                              |           resume_failure_reason: "session_not_found"
        |                              |           resumed (history) stays true (BI-COR6)
        |                              v
        |
        +-- late session_not_found (after threshold) --+ NORMAL terminal:
        |                                                kind = "resumed_after_rotation"
        |                                                latest_error.category = "session_not_found"
        |                                                no retry
        |
        +-- any other error -----------+ NORMAL terminal:
        |                                kind = "resumed_after_rotation" intact
        |                                latest_error reflects the underlying category
        |                                (claude_rotation_state preserved per BI-COR12;
        |                                 next user send_followup re-evaluates rotation)
        |
        +-- success ---> normal terminal
```

## Human Approval Triggers

- **HAT-COR1.** Adding `"resumed_after_rotation"` as a `terminal_context.kind`
  payload value. **Not** a Zod enum widening (`terminal_context` is an
  open record schema — `src/contract.ts:305`). HAT still applies because
  supervisors observe a new value alongside the existing
  `"fresh_chat_after_rotation"`.
- **HAT-COR2.** Reverting D8 / A3 / T8 from the existing plan ("rotation
  always calls `runtime.start()`"). **Scope of the reversion:** in-priority
  rotation between two `config_dir` accounts only. All other paths
  (single-account, api_env source/target, source missing, copy failure,
  session-not-found, all other resume failures) still preserve the
  original fresh-chat shape and still call `runtime.start()`. The
  non-rotation `send_followup` path (same account) is untouched and
  still uses `runtime.resume()` exactly as today.
- **HAT-COR3.** Widening `RunErrorCategorySchema` (`src/contract.ts:67`)
  with the additive enum value `"session_not_found"`. Public-contract
  Zod enum change; supervisors that filter by `latest_error.category`
  will need to know about it. Tied to the classifier-extension task
  T-COR-Classifier.

## Reviewer Questions

none. RQ-COR1 through RQ-COR7 are all resolved as Confirmed Decisions
(D-COR-Classifier, D-COR4, D-COR3, D-COR2, terminal_context payload
fields under D-COR5, `resumed?: boolean` semantic under BI-COR6, optional
live-smoke procedure under T-COR5).

## Open Human Decisions

none. The api_env restriction (D-COR-API) does not widen api_env's
binding contract; the resume-retry semantics (D-COR-Resume) and the
rotation-race lock (D-COR-Lock) are mechanical follow-throughs on the
parent plan's invariants; the error-category widening (HAT-COR3) is an
additive enum value scoped strictly to enabling D-COR-Resume's retry
condition. None of these resolutions widen scope beyond what the user
already approved.

## Risks

| # | Risk | Likelihood | Mitigation | Surface |
|---|---|---|---|---|
| R-COR1 | **Encoded-cwd rule drift.** A future Claude Code release changes the rule (D-COR4); the helper looks at the wrong path and `session_jsonl_not_found` fires on every rotation. | low | BI-COR8 + D-COR5 fallback; integration test pinning the encoder; diagnostic check Future Option. | rotation correctness |
| R-COR2 | **MCP-server-set divergence across accounts.** When account B is bound, the model gets B's MCP set. The resumed conversation may suddenly find tools missing or different. | medium | Documented in `claude-multi-account.md`; acceptable trade-off; resolving it would contradict BI-COR4. | observability |
| R-COR3 | **Partial JSONL on parent crash.** Source is byte-faithfully truncated; `claude --resume` rejects it. | medium | Falls under the `session_not_found` retry path (D-COR-Resume) — the user sees one transparent retry into a clean fresh-chat run; observable via `resume_failure_reason: "session_not_found"`. | rotation success rate |
| R-COR4 | **Large JSONL latency.** Long sessions add visible latency to `send_followup`; copy is on the critical path. | low (sessions are bounded by Claude's context limit) | `fs.copyFile` is kernel-level, no userspace buffering; `copied_bytes` and `copy_duration_ms` recorded in `terminal_context` for observability; hard cap is a Future Option. | latency |
| R-COR5 | **Same-parent concurrent followups.** Without the lock, two `send_followup` calls off the same parent could both pick the same destination. | medium without mitigation, very low with it | D-COR-Lock + D-COR3 byte-equal short-circuit; T-COR-Race regression test. | data integrity / cooldown bookkeeping |
| R-COR6 | **TOCTOU on the source JSONL** (symlink swap between `lstat` and `copyFile`). | very low | `lstat` regular-file check + `realpath`-containment check on the resolved path (D-COR-PathHard). Symlinks refused with `copy_skip_reason: "source_not_regular_file"`. | security |
| R-COR7 | **Classifier change risks misclassifying unrelated errors as `session_not_found`.** Stderr regex (`/session\s+not\s+found/i`) could match user-supplied prompt content echoed in stderr. | low | Structured `subtype` / `code` checks fire **first**; stderr regex is the backup classifier (D-COR-Classifier). Hermetic test ensures unrelated stderr lines (e.g. a user prompt mentioning the phrase) do not trigger the category. | observability |
| R-COR8 | **api_env-target rotation users may be surprised** that resume isn't attempted even when the priority array contains an api_env account. | medium | Documented in `claude-multi-account.md` as the rotation behaviour table; `terminal_context.copy_skip_reason: "api_env_in_rotation_path"` is observable so supervisors can detect and surface to the user. | UX / docs |

## Implementation Tasks

### T-COR1 — Session-copy helper

**Scope.**
Create `src/claude/sessionCopy.ts` exporting:

- `encodeProjectCwd(absoluteCwd: string): string` — implements D-COR4
  (`replace(/\//g, '-')`).
- `computeSessionJsonlPath(opts: { accountsRoot: string; account: string; cwd: string; sessionId: string }): string`.
- `async function copySessionJsonlForRotation(input: {
    accountsRoot: string;
    priorAccount: string;
    newAccount: string;
    cwd: string;
    sessionId: string;
    now?: () => number;
  }): Promise<CopyOutcome>`

`CopyOutcome` is a discriminated union:

- `{ ok: true; resumed_session_id: string; source_path: string; target_path: string; copied_bytes: number; copy_duration_ms: number; collision_resolution?: "noop" }`
- `{ ok: false; reason: "source_missing" | "source_disappeared_during_copy" | "source_not_regular_file" | "unsafe_session_id" | "path_escape" | "copy_failed" | "session_jsonl_collision" | "session_jsonl_not_found"; details: Record<string, unknown> }`

Behaviour (D-COR-PathHard, corrected order from pass-2 review):

1. **Validate inputs.** `sessionId` against `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` →
   on mismatch return `{ ok: false, reason: "unsafe_session_id" }`. Both
   account names via `isValidAccountName` from
   `src/claude/accountValidation.ts`.
2. **Compute paths.** `sourcePath`, `sourceProjectsRoot = <accountsRoot>/<priorAccount>/projects`,
   `targetPath`, `targetProjectsRoot = <accountsRoot>/<newAccount>/projects`,
   `targetParent = path.dirname(targetPath)`.
3. **Prepare destination tree FIRST so `realpath` can resolve.**
   `await fs.mkdir(targetParent, { recursive: true, mode: 0o700 })`.
   Idempotent; intermediate components inherit the same mode.
4. **lstat source.** `ENOENT` → `source_missing`. Not `isFile()` →
   `source_not_regular_file` (rejects symlinks, FIFOs, devices,
   sockets).
5. **Containment check via `path.relative` (NOT `startsWith`).** For
   each (resolved, root) pair — source against `sourceProjectsRoot`,
   targetParent against `targetProjectsRoot`:
   ```
   const resolved = await fs.realpath(<path>);
   const rootResolved = await fs.realpath(<root>);
   const rel = path.relative(rootResolved, resolved);
   if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return path_escape;
   ```
   The empty-string check guards "resolved equals root", which would
   skip the projects/<encoded-cwd>/<sid>.jsonl scoping. The
   `path.isAbsolute` check guards Windows cross-drive resolutions.
6. **Cycle handling.** If destination JSONL already exists: `lstat` it
   (must be regular file too — non-regular existing destination is
   treated as `path_escape`), then `await Promise.all([fs.readFile(source),
   fs.readFile(target)])` and compare via `Buffer.equals`. Equal:
   return `{ ok: true, collision_resolution: "noop", source_path,
   target_path, copied_bytes: 0, copy_duration_ms: <measured> }`.
   Different: `session_jsonl_collision`.
7. **Atomic copy with mode pre-set on the temp file.**
   ```
   const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
   try {
     await fs.copyFile(source, tmp);
     await fs.chmod(tmp, 0o600);          // mode set BEFORE rename
     await fs.rename(tmp, target);        // publishes atomically with 0o600
   } catch (err) {
     // map ENOENT -> source_disappeared_during_copy; everything else -> copy_failed
   } finally {
     await fs.rm(tmp, { force: true });   // never leak the temp file
   }
   ```
   The chmod-on-tmp ordering means the file appears at its final path
   already at mode `0o600` — no observable mode-change race after
   rename.
8. **Return success.** `{ ok: true, resumed_session_id: sessionId,
   source_path, target_path, copied_bytes: <stat.size>,
   copy_duration_ms: <delta> }`.

**Verification.**
Unit tests in `src/__tests__/claudeSessionCopy.test.ts` (exhaustive list
in T-COR4 below). Pinned encoder round-trip:
`encodeProjectCwd('/home/ubuntu/worktrees-agent-orchestrator/17-add-coding-backend-for-ccs')`
returns
`'-home-ubuntu-worktrees-agent-orchestrator-17-add-coding-backend-for-ccs'`.

### T-COR-Classifier — Stream-error classifier extension

**Scope.**

- Extend `errorFromEvent` (`src/backend/common.ts:150`) to also read
  `subtype` from both `nestedError` and the top-level event record, copy
  it onto `context.subtype`.
- Extend `classifyErrorCategory` to accept a new structured-first branch
  before `protocol`: if `context.subtype === "session_not_found"` (case-
  insensitive) OR `context.code === "session_not_found"` → return
  `"session_not_found"`.
- Add a stderr-source-only fallback regex
  `/session\s+not\s+found/i` plus `/no\s+(?:such\s+)?session/i` triggered
  only when `source === 'stderr'` and the structured branch did not
  fire — keeps user-supplied prompt content (which lives in event
  payloads, not stderr) from misclassifying.
- Add `"session_not_found"` to `RunErrorCategorySchema`
  (`src/contract.ts:67`). Update derived types and any
  exhaustive-switch consumers (search via Grep before touching).
- Update `processManager.ts:341` (the `errors` array synthesis): when
  `dedupeErrors(observedErrors)` already contains a non-`process_exit`
  classified `RunError` AND `exitCode !== 0`, suppress the
  `processExitError` push. The `terminalOverride` branch is unchanged.
  Document the behaviour change as "structured stream-classified errors
  are no longer masked by process_exit synthesis".
- Make `RunError.retryable` for `session_not_found` = `false` (we handle
  retry above the classifier in T-COR2; the classifier itself does not
  describe rotation retry semantics).

**Verification.**

- New file `src/__tests__/claudeSessionNotFoundClassifier.test.ts`:
  - Stream `error` event with `subtype: "session_not_found"` →
    `category === "session_not_found"`, `context.subtype === "session_not_found"`.
  - Stream `error` event with `code: "session_not_found"` (capital S) →
    same outcome.
  - Stderr line `"Error: session not found"` → category from stderr
    fallback.
  - Stream `error` event with arbitrary `subtype` (e.g.
    `"rate_limit_exceeded"`) → category `rate_limit` (existing), but
    `context.subtype === "rate_limit_exceeded"` is preserved (regression
    target — today's classifier drops it).
  - Process exits non-zero with a stream `session_not_found` already in
    `observedErrors` → `latest_error.category === "session_not_found"`,
    NOT `process_exit`.
  - Process exits non-zero with no observed errors → `process_exit`
    (regression target — existing path).
- `src/__tests__/contract.test.ts` extension: `RunErrorCategorySchema`
  parses `"session_not_found"`.
- All existing classifier tests still pass.

### T-COR-Race — Per-parent rotation lock + claimed-destinations set, durable across daemon restart

**Scope.**

- Add `private rotationTrackers: Map<string, { lock: Promise<RotationDecision>; claimed: Set<string>; reconstructed: boolean }>` to `OrchestratorService`. The flag distinguishes "freshly created, claims not yet rebuilt from run store" from "claims are current".
- Implement `private async reconstructClaimedDestinations(parentRunId: string): Promise<Set<string>>`:
  - Iterate run summaries via the existing `RunStore.listRuns` /
    equivalent surface, filtered to entries with
    `metadata.claude_rotation_state.parent_run_id === parentRunId`.
  - For each match, read `metadata.claude_account_used`. Skip entries
    that are missing or schema-invalid. Add the rest to a fresh
    `Set<string>`. Return it.
  - Cost: bounded by the rotation-history cap (BI-COR6 cap is 32 →
    at most ~32 children per parent), so O(N) with N ≤ ~32.
- `evaluateRotation(parent)` flow:
  1. Get-or-create the tracker for `parent.run_id` on the map.
  2. If the tracker has an existing in-flight `lock`, `await` it
     (catching errors so a prior failure does not poison subsequent
     calls). Treat tracker as still valid post-await.
  3. If `tracker.reconstructed === false`, run
     `reconstructClaimedDestinations(parent.run_id)` and assign the
     result to `tracker.claimed`; set `tracker.reconstructed = true`.
     This pass runs at most once per tracker lifetime (i.e. once per
     daemon-process per parent), hidden behind the lock so concurrent
     callers do not duplicate the scan.
  4. Filter `priority` by
     `priority.filter(p => p !== priorAccount && !tracker.claimed.has(p))`,
     further filtered by registry cooldown state at `Date.now()`.
  5. If the filtered list is empty: return `INVALID_STATE` with
     `details.reason === "priority_exhausted_for_parent"` and payload
     `{ claimed: Array.from(tracker.claimed), cooled_down: <summary>, priority }`.
     Tracker stays in the map; do not mutate `claimed`.
  6. Otherwise pick the first surviving candidate D. Add D to
     `tracker.claimed` immediately. Install a new `tracker.lock`
     deferred that will resolve once both:
     - the prior account's cooldown is durably written to disk
       (existing best-effort write inside the rotation branch of
       `sendFollowup`); AND
     - the new child run's `meta.json` is durably written via
       `RunStore.markCreated` / `markStarted` (carrying
       `metadata.claude_rotation_state` and
       `metadata.claude_account_used`). The `await` for this write
       MUST happen before the lock resolves.
  7. Resolve the lock and return the rotation decision.
- Lifetime: tracker entries are not removed on lock resolution; they
  live until the parent run is pruned from the run store (no manual
  reset API in this slice — Future Option). On daemon restart, the
  in-memory map is empty and the next call's `reconstructed === false`
  branch repopulates `claimed` from on-disk meta files. The
  reconstruction is idempotent and cheap.
- Surface the new `priority_exhausted_for_parent` reason via the
  existing `INVALID_STATE` code with a structured `details.reason` —
  no new top-level error code; matches parent plan's additivity
  discipline.

**Verification.**

- `src/__tests__/claudeRotationRace.test.ts`:
  - **Test 1 — Distinct destinations.** Parent priority `[A, B, C]`,
    parent's `latest_error.category === "rate_limit"` against A. Spawn
    two `send_followup(parent.run_id)` calls via `Promise.all`. Assert:
    one child run binds B, the other binds C. Assert tracker.claimed
    contains both B and C after both followups land. Assert the registry
    shows A cooled down (only A, not B or C, because the test fixture
    does not simulate further rate-limits).
  - **Test 2 — Priority exhausted.** Same setup but priority `[A, B]`.
    Two parallel `send_followup` calls. Assert: one child binds B; the
    other returns `INVALID_STATE` with `details.reason ===
    "priority_exhausted_for_parent"` and `details.claimed === ["B"]`,
    `details.priority === ["A","B"]`.
  - **Test 3 — Sequential followups respect prior claims.** Same setup
    `[A, B, C]`. Followup 1 → B. Followup 1's child terminates normally.
    Followup 2 (sequential, after followup 1's terminal) → must bind C,
    NOT B, because tracker.claimed still includes B.
  - **Test 4 — Claimed survives terminal of bound child.** Followup 1 →
    B, B's child terminates with rate_limit (so B is also now cooled-
    down). Followup 2 → C. Followup 3 → `priority_exhausted_for_parent`.
  - **Test 5 — Different parents, no contention.** Two parents P1 and P2
    with overlapping priority `[A, B]`. Two parallel followups, one off
    each parent. Both succeed and may bind the same destination
    (different parents, different trackers).
  - **Test 6 — Lock resolution timing.** Use a fake clock + a controlled
    cooldown-write deferred. Assert that the second waiter's
    re-evaluation reads the cooldown-write effects before its own
    picker runs.
  - **Test 7 — Lock failure does not poison subsequent calls.** Force
    the first evaluation to throw mid-picker. Assert: the second
    waiter's await catches the rejection and proceeds to its own
    evaluation (which then succeeds normally).
  - **Test 8 — Daemon restart durability of claimed set.** Parent
    priority `[A, B, C]`. Followup 1 → binds B → child meta.json
    written → followup 1's terminal completes. Tear down the
    `OrchestratorService` instance (in-memory tracker map is dropped).
    Instantiate a fresh `OrchestratorService` against the same
    `RunStore` root. Dispatch followup 2. Assert: followup 2 binds C
    (NOT B) because the lazy reconstruction reads B's child
    `meta.json` from disk and re-adds B to the new tracker's
    `claimed` set. Variant: dispatch followup 3 after restart against
    priority `[A, B]` only → expect `priority_exhausted_for_parent`
    with `details.claimed === ["B"]`. Variant: parent has zero
    rotation children before restart → reconstruction returns an
    empty set, followup 1 binds B as expected.

### T-COR2 — Rotation flow integration

**Scope.**
Update `src/orchestratorService.ts.sendFollowup` so the rotation branch
implements D-COR-Resume's state diagram. Specifically, in the existing
`if (isRotation && rotationDecision.rotation)` block at
`orchestratorService.ts:554`:

1. Compute `priorMode = registry account mode for rotation.priorAccount`
   and `newMode = registry account mode for rotation.binding.account.name`.
2. Compute `observedSessionId = parent.meta.observed_session_id ??
   parent.meta.session_id`.
3. **api_env gate (D-COR-API).** If `priorMode === "api_env" || newMode
   === "api_env"`:
   - `terminalContext = { kind: "fresh_chat_after_rotation",
     copy_skip_reason: "api_env_in_rotation_path",
     details: { prior_mode, new_mode }, parent_run_id, prior_account,
     new_account, parent_error_category }`.
   - `resumed = false`. Use `runtime.start()` (today's path).
   - Skip to step 7.
4. **Source-existence gate.** If `observedSessionId` is null:
   `copy_skip_reason: "no_observed_session_id"`, `runtime.start()`.
   Otherwise call `copySessionJsonlForRotation(…)`.
5. On `{ ok: false, reason }`: set
   `kind: "fresh_chat_after_rotation"`, `copy_skip_reason: reason`,
   `details: outcome.details`, `resumed: false`. Use `runtime.start()`.
6. On `{ ok: true, resumed_session_id, source_path, target_path,
   copied_bytes, copy_duration_ms, collision_resolution? }`: set
   `kind: "resumed_after_rotation"`, `payload: { resumed_session_id,
   source_path, target_path, copied_bytes, copy_duration_ms }` (per
   RQ-COR5 default), optional `collision_resolution`, `resumed: true`.
   Use `runtime.resume(resumed_session_id, …)`.
7. Set `requested_session_id` on the rotated child run **only when
   resume succeeds at step 6** (current rotation-create path sets it
   `null` per `orchestratorService.ts:594`–`595`; relax that to set it
   to `resumed_session_id` on the resume path).
8. Pass `resumed` into `applyRotationMetadata` (T-COR3 extension) so it
   lands on the `claude_rotation_history[i].resumed` field.

**In-run retry: see T-COR-Resume-Layer below for the runtime-level
interceptor contract and integration.** This T-COR2 task wires the
`OrchestratorService` side: building the `earlyEventInterceptor` block
on the `RuntimeStartInput` for rotation-resume runs, supplying the
`retryInvocation`, and merging the post-retry `terminal_context` keys
(`resume_attempted: true`, `resume_failure_reason: "session_not_found"`,
`kind: "fresh_chat_after_rotation"`). The retry's mechanics live in
`processManager.ts` (T-COR-Resume-Layer step 1).

**Verification.**
Hermetic tests in T-COR4 below; the interceptor-internal mechanics are
covered by T-COR-Resume-Layer's own tests.

### T-COR-Resume-Layer — Runtime interceptor contract + OrchestratorService integration

**Scope.**

This task implements D-COR-Resume-Layer in two ordered steps.

**Step 1 — `processManager.ts` interceptor surface (additive, backward compatible).**

- Extend `RuntimeStartInput` (in `src/backend/runtime.ts`) with optional
  `earlyEventInterceptor?: { thresholdEvents: number; thresholdMs: number; classify: (event: WorkerEvent) => "continue" | "retry_with_start"; retryInvocation: WorkerInvocation; }`.
- Thread the field through `CliRuntime` (`src/backend/runtime.ts`)
  into `WorkerInvocation` analogously to the existing `accountSpawn`
  threading. Add a corresponding optional `earlyEventInterceptor` on
  `WorkerInvocation` so `ProcessManager.start` can read it.
- In `ProcessManager.start` (`src/processManager.ts:150`), when
  `invocation.earlyEventInterceptor` is set:
  - Maintain a per-spawn counter `eventsObserved` and a wall-clock
    `spawnedAt = Date.now()`.
  - For each event the parser yields, compute `withinThreshold =
    eventsObserved < thresholdEvents && (Date.now() - spawnedAt) < thresholdMs`.
    If `withinThreshold`, invoke `classify(event)`. Increment
    `eventsObserved` after the classify call.
  - If `classify` returns `"retry_with_start"`:
    1. Stop processing further events for this spawn.
    2. Cancel the worker via the existing kill-process-group path
       (same as `cancelRun`'s internal kill, but without the
       "cancelled" terminal-override write).
    3. Discard the in-memory event buffer for this attempt — do NOT
       call `appendEvent` for any captured event from this spawn,
       and do NOT call `finalizeRun`/`markTerminal`.
    4. Emit one structured lifecycle event via the existing
       event-append surface:
       `{ type: "lifecycle", subtype: "session_not_found_in_run_retry",
          killed_pid, resume_attempt_duration_ms: Date.now() - spawnedAt,
          observed_events: eventsObserved }`.
    5. Re-enter `ProcessManager.start` once with
       `invocation = invocation.earlyEventInterceptor.retryInvocation`
       and `earlyEventInterceptor` UNSET on the retry call (single-
       shot enforcement).
    6. Subsequent events flow normally to `appendEvent` and finally
       to `finalizeRun` / `markTerminal`.
  - If `classify` returns `"continue"`, the event flows normally.
  - When `eventsObserved >= thresholdEvents` OR
    `(Date.now() - spawnedAt) >= thresholdMs`, the interceptor
    disengages — `classify` is no longer invoked, all subsequent
    events flow normally.
- When `invocation.earlyEventInterceptor` is undefined,
  `ProcessManager.start` behaves exactly as today (no event-flow
  changes, no env-policy changes, no perf cost beyond a single
  `if` per spawn).

**Step 2 — `OrchestratorService.startManagedRun` integration.**

- Define a single named constant
  `SESSION_NOT_FOUND_INTERCEPT_THRESHOLD = { events: 50, ms: 5_000 }`
  in `orchestratorService.ts`. Not exposed on the public contract.
- For rotation runs that decided on `runtime.resume(<sid>)` (i.e.
  T-COR2 step 6 path), construct an `earlyEventInterceptor` block:
  - `thresholdEvents: SESSION_NOT_FOUND_INTERCEPT_THRESHOLD.events`.
  - `thresholdMs: SESSION_NOT_FOUND_INTERCEPT_THRESHOLD.ms`.
  - `classify: (event) => { const err = errorFromEvent(eventRecord(event), 'claude'); return err?.category === "session_not_found" ? "retry_with_start" : "continue"; }`
    (using T-COR-Classifier output; reuse the existing helper).
  - `retryInvocation`: a `WorkerInvocation` derived from the same
    `accountSpawn`, same prompt, same model + validated `model_settings`,
    but constructed via the runtime's `start()` argv shape (no session
    id; the resume `--resume <sid>` argv is not present). The
    `earlyEventInterceptor` field on `retryInvocation` is undefined
    (single-shot enforcement at construction time, in addition to
    Step 1's runtime check).
- For all non-rotation runs and for the retry worker itself,
  `earlyEventInterceptor` is undefined — every existing caller path is
  unaffected.
- After the worker terminates (regardless of whether the interceptor
  fired), if the `lifecycle / session_not_found_in_run_retry` event is
  present in `events.jsonl`, merge `kind: "fresh_chat_after_rotation"`,
  `resume_attempted: true`, `resume_failure_reason: "session_not_found"`
  into the run's `terminal_context`. `resumed` in
  `claude_rotation_history` stays `true` (BI-COR6).

**Verification.**

- `src/__tests__/claudeResumeInterceptor.test.ts`:
  - **Test 1 — Interceptor fires on early `session_not_found`.** Fake
    `claude` binary emits a stream-json event with
    `{ type: "error", subtype: "session_not_found" }` as the first
    event then sleeps. The interceptor classifies → `retry_with_start`
    → kills resume worker → appends lifecycle event → re-spawns the
    `retryInvocation` (a different fake invocation that emits a
    normal `result` event and exits 0) → run terminates with
    `kind: "fresh_chat_after_rotation"`, `resume_attempted: true`,
    `resume_failure_reason: "session_not_found"`. `events.jsonl`
    contains exactly one `lifecycle/session_not_found_in_run_retry`
    event AND no events from the cancelled attempt. `markTerminal`
    invoked exactly once.
  - **Test 2 — Threshold expiry: late `session_not_found` ignored.**
    Fake binary emits 60 normal events first, then `session_not_found`.
    `thresholdEvents: 50`. `classify` is no longer called past event
    50. Run terminates normally with the underlying error category
    surfaced; no lifecycle marker; no retry.
  - **Test 3 — Threshold expiry: time-based.** Fake binary stalls 6s
    then emits `session_not_found`. `thresholdMs: 5_000`. Interceptor
    has disengaged; no retry; run terminates normally.
  - **Test 4 — Single-shot enforcement at runtime.** Force the retry
    worker to also emit `session_not_found` early. The retry
    invocation has `earlyEventInterceptor` undefined → the second
    `session_not_found` flows to terminal as the underlying error
    category, no second retry, exactly one lifecycle marker.
  - **Test 5 — `classify` returning `continue` on a non-matching
    error.** Fake binary emits a `protocol`-class error → classify
    returns `continue` → no retry; child terminates normally with
    the underlying error category.
  - **Test 6 — Backward compatibility.** Run a non-rotation `start_run`
    against the existing `claude` backend. Assert: events flow
    identically to today; no measurable perf delta on event throughput
    (sanity check — measure via a 100-event burst and compare against
    a pre-change baseline if available; otherwise just assert no
    `lifecycle/session_not_found_in_run_retry` event ever appears in
    a non-rotation run).
  - **Test 7 — Cancelled attempt's events are NOT appended.** Fake
    binary emits 3 normal events then `session_not_found`. Interceptor
    fires. `events.jsonl` contains the lifecycle marker and the retry
    worker's events, NOT the 3 cancelled-attempt events.
- The `OrchestratorService` integration tests live in T-COR4 (e.g.
  test 11/11b/11c there); this task's tests are scoped to the
  `processManager.ts` interceptor mechanics in isolation.

### T-COR3 — Rotation history `resumed` flag

**Scope.**

- Extend `ClaudeRotationHistoryEntry` in `src/claude/accountBinding.ts`
  with optional `resumed?: boolean` (default `false` for legacy entries
  read off disk).
- Update `appendRotationEntry` — no behaviour change (already accepts
  `ClaudeRotationHistoryEntry`); type-only addition.
- Update `readRotationHistory` to surface the new field when present.
- Update `applyRotationMetadata` in `orchestratorService.ts` (~line 1536)
  to take an additional `resumed: boolean` and forward it onto the
  appended entry.
- Update `src/__tests__/claudeAccountValidation.test.ts` (existing
  truncation regression suite) to mix `resumed: true / false / undefined`
  values across the 100-append loop.

**Verification.**
Existing rotation history truncation regression remains green; new tests
read back `resumed` from `claude_rotation_history`.

### T-COR4 — Hermetic tests

**Scope.**
Extend `src/__tests__/claudeRotation.test.ts` and add a new
`src/__tests__/claudeSessionCopy.test.ts` plus
`src/__tests__/claudeRotationRace.test.ts` and
`src/__tests__/claudeSessionNotFoundClassifier.test.ts` (the latter is
T-COR-Classifier's surface).

End-to-end rotation test cases:

1. **Happy path.** Two `config_dir` accounts. Parent rate-limits → JSONL
   written under A's `projects/<encoded-cwd>/<sid>.jsonl` → rotate to B
   → JSONL copied → child runs with `--resume <sid>` → `kind ==="resumed_after_rotation"` with
   `resumed_session_id`, `prior_account === "A"`, `new_account === "B"`,
   `copied_bytes > 0`, `copy_duration_ms >= 0`,
   `metadata.claude_rotation_history[-1].resumed === true`. Fake-claude
   asserts it received `--resume <sid>` on argv.
2. **api_env gate (D-COR-API / BI-COR11).** Rotation A (config_dir) → B
   (api_env): expect `kind: "fresh_chat_after_rotation"`,
   `copy_skip_reason: "api_env_in_rotation_path"`, `resumed: false`,
   prior cooldown still set.
3. **api_env source.** Rotation A (api_env) → B (config_dir): same shape
   as #2.
4. **Source missing.** Parent terminates without writing JSONL (fake
   binary supports `--no-write-session`) → `copy_skip_reason: "source_missing"` → fresh-chat.
5. **Source disappeared mid-copy.** Stub `fs.copyFile` to delete source
   between lstat and copy → `copy_skip_reason: "source_disappeared_during_copy"`.
6. **Source not regular file.** Replace source with a symlink pointing
   into the same projects dir → `copy_skip_reason: "source_not_regular_file"`.
7. **Path escape.** Construct a symlink chain whose realpath escapes
   `<account>/projects/` → `copy_skip_reason: "path_escape"` (use
   `fs.symlink` to a sibling temp dir; the realpath check refuses).
8. **Unsafe sessionId.** Inject `parent.meta.observed_session_id` value
   `"../../etc/passwd"` (via store-level mutation in the test) →
   `copy_skip_reason: "unsafe_session_id"`. (Defence-in-depth: the
   scenario is contrived because `observed_session_id` flows from
   Claude's session_id field, but the helper must not trust it.)
9. **EACCES.** chmod the destination parent to `0o500` → helper returns
   `copy_failed` with `details.code === "EACCES"` → fresh-chat.
10. **ENOSPC.** Stub `fs.copyFile` to reject with `ENOSPC` → `copy_failed`.
11. **Resume rejected EARLY — interceptor fires (D-COR-Resume-Layer).**
    Source JSONL exists, copy succeeds, fake-claude emits
    `{ type: "error", subtype: "session_not_found" }` as one of the
    first 5 events within 1 second of spawn → interceptor kills the
    resume worker, appends a `lifecycle` event with
    `subtype: "session_not_found_in_run_retry"`, spawns a fresh
    `runtime.start()` against the same target → child's terminal record
    carries `kind: "fresh_chat_after_rotation"`, `resume_attempted:
    true`, `resume_failure_reason: "session_not_found"`. Asserts:
    `events.jsonl` contains exactly one
    `lifecycle / session_not_found_in_run_retry` event with non-null
    `killed_pid` and `resume_attempt_duration_ms`; `markTerminal`
    invoked exactly once for this run id; `claude_rotation_history`
    `resumed` stays `true`.
11b. **Resume rejected LATE — interceptor does NOT fire.** Same setup
    but fake-claude emits 60 normal stream events first, then the
    `session_not_found` error. Threshold `events: 50` exceeded → no
    retry; child terminates with `kind: "resumed_after_rotation"`
    intact and `latest_error.category === "session_not_found"`. Asserts
    `events.jsonl` contains zero `session_not_found_in_run_retry`
    lifecycle events.
11c. **Interceptor is single-shot.** Fake-claude emits early
    `session_not_found` on the resume worker → interceptor kills, runs
    start() → start() worker ALSO fails (any error, e.g. simulated
    `process_exit`) → child terminates with that second error; NO
    second retry; `events.jsonl` contains exactly ONE
    `session_not_found_in_run_retry` lifecycle event.
12. **Resume rejected (other failure, no retry).** Same happy-path
    setup, but fake-claude exits early with a `protocol`-class error
    that is NOT `session_not_found` → child terminates normally with
    `kind: "resumed_after_rotation"` intact and
    `latest_error.category === "protocol"`. No retry; `events.jsonl`
    has zero retry-lifecycle events.
13. **Resume succeeds, claude_rotation_state preserved (BI-COR12).** End
    state of #1 has `metadata.claude_rotation_state` populated on the
    child run; the next `send_followup` against the child correctly
    re-enters rotation evaluation if it terminates with `rate_limit`.
14. **Cycle A → B → A, idempotent (D-COR3).** B does not append turns;
    second copy back to A finds byte-equal existing JSONL → `collision_resolution: "noop"` →
    resume succeeds.
15. **Cycle A → B → A, divergent.** Inject a trailing line into A's JSONL
    between rotations → second copy refuses with
    `copy_skip_reason: "session_jsonl_collision"` → fresh-chat.
16. **Cross-account isolation (BI-COR4).** Rotation step copies the JSONL
    to B's `projects/`; before-and-after assertion compares
    `<accounts/B>/.claude.json`, `.credentials.json`, `settings.json`,
    plus any MCP/plugin files (whatever exists in the test fixture) for
    byte-identity. Only the new JSONL was added under
    `projects/<encoded-cwd>/`. Combined with the existing `fs.*` spy
    (parent plan's BI6 invariant) for spawned-process reads.
17. **Concurrency / same-parent race (T-COR-Race).** Two
    `send_followup(parent.run_id)` in parallel with priority
    `[A, B, C]` (A is the parent's account) → first followup binds B,
    second followup binds C, both succeed independently. Tracker
    `claimed` shows `{B, C}` afterwards. Variant with priority
    `[A, B]`: first binds B, second returns `INVALID_STATE` with
    `details.reason === "priority_exhausted_for_parent"` and
    `details.claimed === ["B"]`. Variant where followup 2 is
    sequential (not parallel) after followup 1's terminal: still
    binds C, never B, because B remains `claimed`.
18. **Concurrency / different parents.** Two `send_followup(differentParents)` in
    parallel → no lock contention; both proceed normally; if both
    happen to target the same destination account (different priority
    arrays) the JSONL paths differ (different parent runs have different
    session_ids) so no collision.
19. **Daemon restart between parent terminal and follow-up.** Persist
    parent + cooldown + observed_session_id; tear down
    `OrchestratorService`; reload from disk; `send_followup` finds the
    rotation_state, the JSONL on disk, copies, resumes successfully.
20. **Atomic write observability.** Stub `fs.copyFile` to a slow stream
    that yields multiple times; parallel `setInterval` reads the
    destination — must be either ENOENT or fully-written, never
    partial. Temp file is unlinked after success.
20b. **Mode `0o600` immediately after rename (D-COR-PathHard chmod-on-tmp).**
    Run a successful copy, then immediately `fs.stat(target)` and
    assert `mode & 0o777 === 0o600`. Variant: a parallel `setInterval`
    polls `fs.stat(target).mode` while the copy runs in the
    foreground — must NEVER observe a non-`0o600` mode (i.e. there is
    no observable mode-change race because the chmod happens on the
    temp file before the rename publishes).
21. **Temp leak on failure.** Stub `fs.copyFile` to reject; assert no
    `<dst>.tmp.*` file remains in the destination dir afterwards.
22. **`requested_session_id` on resumed child** is set to
    `observed_session_id` (today's create call sets it `null` per
    `orchestratorService.ts:594`–`595`); regression test asserts the
    new behaviour on success and the old behaviour (`null`) on every
    fallback path.
23. **Encoder round-trip (T-COR1 unit).** `encodeProjectCwd('/home/ubuntu/worktrees-agent-orchestrator/17-add-coding-backend-for-ccs')` →
    `'-home-ubuntu-worktrees-agent-orchestrator-17-add-coding-backend-for-ccs'`. Plus
    `'/'` → `'-'`, `'/foo'` → `'-foo'`, `'/a/b'` → `'-a-b'`.

All tests use the fake-`claude` test binary; none read `~/.claude/` or
contact Anthropic.

**Verification.**
`pnpm test` — total count rises from 381 to roughly 405 (≈ 24 new across
T-COR1, T-COR-Race, T-COR-Classifier, T-COR2 retry path, BI-COR4
target-tree byte-identity).

### T-COR5 — Docs

**Scope.**

- Update `docs/development/claude-multi-account.md` "Rotation behavior":
  - Default behaviour is now copy-on-rotate cross-account resume between
    `config_dir` accounts; fresh-chat is the documented fallback.
  - api_env restriction (D-COR-API / BI-COR11) — table of rotation
    shapes by source/target mode.
  - Structured `terminal_context` payload reference (every
    `copy_skip_reason` and `resume_failure_reason` value).
  - One-shot transparent retry on `session_not_found` (D-COR-Resume) —
    so the supervisor knows the re-spawn within the same run id is
    expected behaviour, not a daemon bug.
  - Optional live-smoke procedure (RQ-COR7 default): document the
    steps a developer would take between the `smoketest` and `second`
    accounts, simulating a rate-limit via the existing fake-rate-limit
    env-flag pattern in tests rather than burning real quota. Plan does
    NOT gate on running it.
- Update `plans/17-add-coding-backend-for-ccs/plans/17-claude-multi-account.md`
  "Issue Comment Draft" section (lines ~624–646): add a paragraph to
  the draft pointing out that the "always fresh chat" caveat is
  superseded for in-priority rotation between two `config_dir` accounts
  by this follow-up plan, and pointing at the new sub-plan path.
  Mention the api_env restriction and the transparent
  `session_not_found` retry. Single-threaded issue history — no new
  comment-draft block in this plan file.
- README.md: review the existing one-liner from parent T10; if the
  rotation language was added there, update to reflect the new default.

**Verification.**
`node scripts/sync-ai-workspace.mjs --check` clean; manual readthrough
of the updated section by the reviewer.

### T-COR6 — Verification gate

**Scope.**
Run the full quality-gates checklist before declaring done.

**Verification.**
See "Quality Gates / Verification" below; record evidence in the plan
execution log post-implementation.

## Acceptance Criteria

- A user with two `config_dir`-mode accounts and a priority array
  `["work", "alt"]` runs `start_run`, hits a `rate_limit` on `work`,
  invokes `send_followup`, and observes:
  - The child run reaches a clean terminal status with
    `terminal_context.kind === "resumed_after_rotation"`,
    `resumed_session_id`, `source_path`, `target_path`,
    `copied_bytes >= 0`, `copy_duration_ms >= 0`.
  - `metadata.claude_rotation_history[-1].resumed === true`.
  - `metadata.claude_rotation_state` is preserved on the child run.
  - The child's `requested_session_id` equals the parent's
    `observed_session_id`.
  - The fake-claude binary asserts it was invoked with
    `--resume <sid>` on argv.
- A rotation step where source OR target is `api_env` produces
  `copy_skip_reason: "api_env_in_rotation_path"` with the prior account
  still cooled down and `runtime.start()` still called.
- The same scenario but the parent terminates before producing an
  `observed_session_id` falls back to fresh-chat with
  `copy_skip_reason: "no_observed_session_id"`.
- Simulated copy failure (`EACCES` / `ENOSPC` / source disappearance /
  symlink source / path escape / unsafe session id) falls back to
  fresh-chat with the correct `copy_skip_reason` and `details` payload.
- Simulated EARLY `session_not_found` resume rejection (within
  `min(50 events, 5s)`) is intercepted at the `OrchestratorService`
  layer: the resume worker is killed, a single
  `lifecycle / session_not_found_in_run_retry` event is appended to the
  child run's `events.jsonl`, and a fresh `runtime.start()` worker takes
  over — child's final terminal record carries
  `kind: "fresh_chat_after_rotation"`, `resume_attempted: true`,
  `resume_failure_reason: "session_not_found"`; `resumed` in
  rotation history stays `true`. `markTerminal` is invoked exactly once
  for the child run id. No second `send_followup` is required.
- Simulated LATE `session_not_found` (after threshold) does NOT trigger
  the interceptor; child terminates normally with
  `kind: "resumed_after_rotation"` intact and
  `latest_error.category === "session_not_found"`.
- Simulated non-`session_not_found` resume failure terminates the child
  with the underlying error category and `kind: "resumed_after_rotation"`
  intact; `claude_rotation_state` is preserved; the user's next
  `send_followup` re-evaluates rotation.
- Two concurrent `send_followup` calls off the same parent with priority
  `[A, B, C]` (A = parent's account) bind the first to B and the second
  to C — both succeed independently. Tracker `claimed` ends as
  `{B, C}`. Variant with priority `[A, B]`: second call returns
  `INVALID_STATE` with `details.reason === "priority_exhausted_for_parent"`
  and `details.claimed === ["B"]`.
- After a successful copy, `fs.stat(target).mode & 0o777 === 0o600`
  immediately and at every observation point during the copy lifecycle
  (no mode-change race; D-COR-PathHard chmod-on-tmp).
- A daemon restart between parent terminal and `send_followup` still
  produces a successful copy + resume.
- `fs.*` spy proves the daemon-process never writes to `.claude.json`,
  `.credentials.json`, `settings.json`, or any non-`projects/` path
  under any account's tree during rotation. Target-tree byte-identity
  assertion holds for all auth/MCP-config files.
- `RunErrorCategorySchema.parse("session_not_found")` succeeds.
- `pnpm verify` passes; AI workspace projection check is clean.

## Quality Gates / Verification

- [ ] `pnpm build`
- [ ] `pnpm test` — full repo suite, including the new copy-on-rotate +
      classifier tests; expected count ~405 / 0 fail / 1 pre-existing
      skip.
- [ ] `pnpm verify` — release-readiness gate; evidence pasted into
      `plans/17-add-coding-backend-for-ccs/resolution-map.md`.
- [ ] `fs.*` spy / instrumentation: zero daemon-process writes to
      `.claude.json`, `.credentials.json`, `settings.json`, MCP config
      across any account during a full rotation lifecycle (BI-COR4).
- [ ] Target-tree byte-identity: before/after diff of every non-JSONL
      file under `<accounts/B>/` over a successful rotation step is
      empty.
- [ ] Atomic-write observability test: destination is never observed
      mid-copy; temp file removed on every failure path (BI-COR3).
- [ ] AI workspace projection check: `node scripts/sync-ai-workspace.mjs
      --check` clean.
- [ ] No new runtime dependencies (Node built-ins only — `node:fs`,
      `node:path`, `node:crypto`).
- [ ] Live local smoke test (optional, per T-COR5): not gated.

## Future Options

- **Periodic pruning of stale JSONL copies** under `<account>/projects/`.
- **MCP-server-set parity surfacing** in
  `terminal_context.kind === "resumed_after_rotation"` (R-COR2).
- **Hard cap on JSONL size before copy** (R-COR4).
- **Encoded-cwd diagnostic check** that probes Claude's actual encoding
  rule on doctor (R-COR1).
- **Reflinks (CoW) on supported filesystems**.
- **Cross-account session export tool**
  (`agent-orchestrator claude session export`).
- **CLAUDE_CONFIG_DIR-equivalent for api_env mode** (would unlock
  copy-on-rotate for api_env participants — but conflicts with parent
  plan's BI8; out of scope).

## Execution Log

(to be filled in during implementation)

### T-COR1 — Session-copy helper
- **Status:** done
- **Code:**
  - `src/claude/sessionCopy.ts` — exports `encodeProjectCwd`,
    `computeSessionJsonlPath`, `copySessionJsonlForRotation` (D-COR-PathHard
    order: regex sessionId / `isValidAccountName` checks → mkdir target
    parent (recursive, mode 0o700) → lstat source → realpath +
    `path.relative` containment on both sides → cycle handling (byte-equal
    no-op / byte-different `session_jsonl_collision`) → atomic copy
    (`copyFile` → `chmod tmp 0o600` → `rename`) with `safeRm(tmp)` on every
    failure path).
  - `src/__tests__/claudeSessionCopy.test.ts` — 12 unit tests covering
    encoder edge cases, happy-path copy + 0o600 mode + bytes/duration,
    unsafe session id, unsafe account name, source missing, symlink source
    refusal, byte-equal cycle no-op, byte-different cycle collision,
    EACCES copy_failed, no temp leak on failure, path-escape via symlinked
    encoded-cwd subdir.
- **Verification:** `pnpm build` clean. Focused tests 12/12 pass. Full
  suite 407 / 0 fail / 1 skip / 89 suites.

### T-COR-Classifier — Stream-error classifier extension
- **Status:** done
- **Code:**
  - `src/backend/common.ts` — `errorFromEvent` reads `subtype` from both
    nested-error and top-level event records onto `context.subtype`;
    `classifyErrorCategory` now structured-first
    (`subtype/code === "session_not_found"`) then stderr-source-only fallback
    `/session\s+not\s+found/i` and `/no\s+(?:such\s+)?session/i`.
  - `src/contract.ts:74` — `RunErrorCategorySchema` widened with
    `"session_not_found"` (HAT-COR3).
  - `src/processManager.ts` — new `buildTerminalErrorList`: when
    `dedupeErrors(observedErrors)` already contains a non-`process_exit`
    error and exit code is non-zero, the synthetic `process_exit` error is
    suppressed.
  - `src/__tests__/claudeSessionNotFoundClassifier.test.ts` — 7 hermetic
    tests covering subtype/code, stderr fallback, backend_event prompt-
    content negative, rate_limit subtype regression, schema parse.
- **Verification:** `node --test
  dist/__tests__/claudeSessionNotFoundClassifier.test.js` → 7/7 pass.
  Full suite (388 tests, 81 suites, 0 fail, 1 skip).

### T-COR-Race — Per-parent rotation lock + claimed-destinations set
- **Status:** done (Test 6 fake-clock variant deferred with TODO).
- **Code:**
  - `src/orchestratorService.ts` — `rotationTrackers: Map<string, { lock; claimed; reconstructed }>` field, `reconstructClaimedDestinations(parentRunId)` (filters by `RunMeta.parent_run_id` since `ClaudeRotationState` carries no `parent_run_id` — design deviation noted), `evaluateRotation` returns a `releaseLock` callback now, `sendFollowup` calls `releaseLock()` in a finally after cooldown write + createRun + updateMeta + tracker.claimed.add. Priority-exhausted error split: `details.reason === "priority_exhausted_for_parent"` for the new D-COR-Lock path; legacy "all cooled-down" message preserved for the today's path.
  - `src/__tests__/claudeRotationRace.test.ts` — 8 tests (Test 6 skipped).
- **Verification:** Full suite 415 / 0 fail / 2 skip. Race tests 7/7 pass.

### T-COR2 — Rotation flow integration
- **Status:** done (paired with T-COR-Resume-Layer Step 2).
- **Code:**
  - `src/orchestratorService.ts` — `sendFollowup` rotation branch now: (a) reads `priorMode`/`newMode` from registry, (b) api_env-source-or-target gate → `copy_skip_reason: "api_env_in_rotation_path"`, (c) `observedSessionId` gate → `copy_skip_reason: "no_observed_session_id"`, (d) calls `copySessionJsonlForRotation(...)` and on `{ ok: false, reason }` falls through to fresh-chat with the structured reason+details, (e) on `{ ok: true }` builds `terminal_context.kind = "resumed_after_rotation"` with payload (resumed_session_id, source_path, target_path, copied_bytes, copy_duration_ms, optional collision_resolution) and chooses `runtime.resume(observedSessionId)`. `requested_session_id` is set on the rotated child only when resume is chosen. `applyRotationMetadata(base, rotation, parentRunId, resumed)` threads `resumed` into the appended history entry.
  - `src/backend/runtime.ts` — new `WorkerRuntime.buildStartInvocation(input)` returns a pre-baked start-shape WorkerInvocation (binary resolved, accountSpawn merged, no interceptor). Used by orchestrator to construct the retry invocation.
  - `src/backend/cursor/runtime.ts` — stub returning `SPAWN_FAILED` (cursor isn't WorkerInvocation-driven).
- **Verification:** Full suite 415 / 0 fail / 2 skip.

### T-COR-Resume-Layer — Runtime interceptor contract + OrchestratorService integration
- **Status:** Step 1 (`processManager.ts` interceptor mechanics) done. Step 2
  (OrchestratorService integration) lands as part of T-COR2.
- **Code (Step 1):**
  - `src/backend/WorkerBackend.ts` — `EarlyEventInterceptor` type and
    `WorkerInvocation.earlyEventInterceptor?` field (already in place).
  - `src/backend/runtime.ts` — `RuntimeStartInput.earlyEventInterceptor?`
    threaded into `WorkerInvocation` (already in place).
  - `src/processManager.ts` — refactor: `start()` is a thin wrapper around
    new private `executeAttempt()`; on `retry_with_start` the close path
    resolves with `{ kind: 'retry', retryInvocation, killedPid, durationMs,
    observedEvents }`, then `start()` appends the structured
    `lifecycle / session_not_found_in_run_retry` event and re-enters
    `executeAttempt` once with `earlyEventInterceptor` stripped from the
    retry invocation. `appendEventBuffered` helper buffers stream events
    while interceptor is engaged-and-not-disengaged; on retry the buffer is
    dropped, on disengage the buffer is flushed in arrival order.
    `handleJsonLine` runs the classifier BEFORE meta updates / sink calls /
    appendEvent so a `retry_with_start` short-circuits the line entirely
    (no `recordObservedError` → `cancel('failed')` path). `cancel` and
    `lastActivityMs` reach the active attempt via a small mutable
    `SharedManagedHandle`. `ManagedRun.child` continues to point at the
    first attempt's child (no caller reads it; verified by grep).
  - `src/__tests__/claudeResumeInterceptor.test.ts` — 7 hermetic tests
    covering: early `session_not_found` interception (kill + lifecycle
    marker + retry succeeds), event-count threshold expiry, time-based
    threshold expiry, single-shot enforcement (retry worker also fails),
    `continue` on non-matching error, backward compatibility (no
    interceptor = byte-identical behaviour), cancelled-attempt's events
    not appended.
- **Verification:** `pnpm build` clean. `node --test
  dist/__tests__/claudeResumeInterceptor.test.js` → 7/7 pass. Full suite
  395 tests, 82 suites, 0 fail, 1 skip.

### T-COR3 — Rotation history `resumed` flag
- **Status:** done.
- **Code:**
  - `src/claude/accountBinding.ts` — `ClaudeRotationHistoryEntry.resumed?: boolean` field; `readRotationHistory` now propagates the field on round-trip (so prior entries' resumed flag survives subsequent rotations).
  - `src/orchestratorService.ts:applyRotationMetadata` — new mandatory `resumed` parameter, threaded into the appended entry.
  - `src/__tests__/claudeAccountValidation.test.ts` — truncation regression mixes `resumed: true / false / undefined` across the 100-append loop.
- **Verification:** Existing truncation tests stay green; race tests verify resumed=false on api_env path.

### T-COR4 — Hermetic tests
- **Status:** done.
- **Code:**
  - Unit-level: `src/__tests__/claudeSessionCopy.test.ts` (12 tests).
  - Process-manager-level (interceptor cases 11/11b/11c): `src/__tests__/claudeResumeInterceptor.test.ts` (7 tests).
  - Race / concurrency cases: `src/__tests__/claudeRotationRace.test.ts` (8 tests, 1 skipped TODO).
  - Classifier: `src/__tests__/claudeSessionNotFoundClassifier.test.ts` (7 tests).
  - End-to-end (cases 1, 2, 3, 4, 13, 22): added 4 new tests under T-COR4 describe block in `src/__tests__/claudeRotation.test.ts`. Fake-claude binary extended to be `CLAUDE_CONFIG_DIR`-aware: writes a session JSONL to the encoded-cwd subdir on every spawn, asserts the JSONL exists at the new account's tree on `--resume`. Helpers `registerConfigDirAccount` and `registerApiEnvAccount` for fixture composability.
- **Verification:** Full suite 419 / 0 fail / 2 skip / 91 suites.

### T-COR5 — Docs
- **Status:** done.
- **Code:**
  - `docs/development/claude-multi-account.md` — Rotation behaviour rewritten: copy-on-rotate is the default for two `config_dir` accounts; structured `terminal_context` payload reference (table of every `copy_skip_reason` value); transparent in-run retry on `session_not_found` (single-shot, threshold-bounded); rotation shape table by source/target mode; rotation history `resumed` flag.
  - `plans/17-add-coding-backend-for-ccs/plans/17-claude-multi-account.md` Issue Comment Draft — caveat updated to point at the copy-on-rotate sub-plan and explain the corrected understanding (no opaque session DB; JSONL is plain file; resume works cross-account given the JSONL is reachable).
  - README.md — already concise (points at `claude-multi-account.md`); no copy-on-rotate-specific update needed.
- **Verification:** Pending `node scripts/sync-ai-workspace.mjs --check` (T-COR6).

### T-COR6 — Verification gate
- **Status:** done (gated quality checks; `pnpm verify` deferred per OHD-IMPL-1 — pre-existing audit failure on this branch).
- **Evidence:**
  - `pnpm build` clean (no TS errors).
  - `pnpm test` — 428 tests / 426 pass / 0 fail / 2 skip / 91 suites.
  - `node scripts/sync-ai-workspace.mjs --check` — clean.
  - `pnpm verify` — NOT run; OHD-IMPL-1 (pre-existing audit failure
    on this branch deferred per parent plan).

### Reviewer pass — three blocking findings + e2e gaps + 1 robustness fix
- **Status:** done.
- **Code:**
  - `src/processManager.ts` — Fix #1: when the interceptor was engaged but
    the worker closed cleanly within the threshold (no retry, no threshold
    expiry), the close handler now flushes `eventBuffer` to
    `store.appendEvent` in arrival order BEFORE finalizeRun runs, so a
    quick clean resume's `started`, assistant, and `result_event`
    lifecycle entries land in `events.jsonl`. Robustness: the
    interceptor's kill path now arms a 5s SIGKILL fallback (mirrors the
    `cancel` path) so a worker that ignores SIGTERM cannot hang the retry.
    Also extends `AttemptOutcome.retry` and `retryDetails` to carry the
    interceptor's `onRetryFired` callback through to `start()`'s retry
    loop.
  - `src/backend/WorkerBackend.ts` — `EarlyEventInterceptor.onRetryFired?:
    () => Promise<void>` field added.
  - `src/orchestratorService.ts` — Fix #2a: `failPreSpawn` now takes
    `rotationTerminalContext` and, when set, merges it into the failure
    `terminal.context` so the rotation `kind` survives `markTerminal`
    overwriting. When unset, `failPreSpawn` reads `current.terminal_context`
    off the run's meta and merges it as a fallback. Both
    `startManagedRun` callsites of `failPreSpawn` pass through the
    rotation context. Fix #2b: the `earlyEventInterceptor` constructed for
    rotation-resume runs now carries an `onRetryFired` async callback
    that updates the run's meta with the post-retry downgrade
    (`kind: "fresh_chat_after_rotation"`, `resume_attempted: true`,
    `resume_failure_reason: "session_not_found"`). `ProcessManager.start`'s
    retry loop awaits this hook AFTER the lifecycle marker append and
    BEFORE the retry attempt's spawn, so a reader between
    `markTerminal` and the post-completion re-merge cannot observe stale
    `kind: "resumed_after_rotation"`.
  - `src/claude/sessionCopy.ts` — Fix #3: containment now anchors at
    `realpath(<accountsRoot>/<account>/)` (the account root) and requires
    the relative path starts with `projects/` + sep. The pre-fix
    anchoring at `realpath(<account>/projects/)` allowed the
    `<account>/projects` symlink-replacement attack because both root and
    candidate would resolve to the symlink target.
  - `src/__tests__/claudeResumeInterceptor.test.ts` — 2 new tests:
    "Reviewer fix #1 — buffered events flushed on clean close" and
    "Reviewer fix #2b — onRetryFired hook invoked between marker and
    retry spawn" (verifies the lifecycle marker is on disk at hook-fire
    time AND the retry's started event is not yet there).
  - `src/__tests__/claudeSessionCopy.test.ts` — 2 new tests for the
    projects-symlink and source-projects-symlink attack vectors.
  - `src/__tests__/claudeRotation.test.ts` — 5 new e2e tests:
    A→B→A byte-equal cycle (collision_resolution: "noop"), A→B
    byte-different cycle (`session_jsonl_collision`), auth-files byte-
    identity assertion, pre-spawn failure preserves rotation `kind`,
    early session_not_found through `sendFollowup` (drives interceptor
    + retry end-to-end via a `FORCE_SESSION_NOT_FOUND_EARLY` prompt
    token in the fake-claude resume path).
- **Verification:** `pnpm build` clean. `pnpm test` — 428 / 426 pass / 0
  fail / 2 skip. `node scripts/sync-ai-workspace.mjs --check` clean.

### Residual risks
- The interceptor's forced-kill SIGKILL fallback is a 5s timeout (matching
  the `cancel` path). On a worker that hangs and ignores both SIGTERM and
  SIGKILL (uninterruptible state), the retry would still stall. This is the
  same risk surface as the existing `cancel` path; documented as parity
  rather than a new risk.
- E2e `ENOSPC` and helper-internal `ENOENT-mid-copy` are covered at the
  helper level in `claudeSessionCopy.test.ts` but not e2e through
  `sendFollowup` — driving them e2e requires global stubs of `fs.copyFile`
  that would couple the test to internals. The state-diagram outcomes are
  still covered through other `copy_skip_reason` paths.
