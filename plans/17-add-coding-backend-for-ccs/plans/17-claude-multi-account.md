# Native Claude Multi-Account Support With Rotation On Rate Limit

Branch: `17-add-coding-backend-for-ccs`
Plan Slug: `claude-multi-account`
Parent Issue: #17
Created: 2026-05-05 (pivot from earlier `17-ccs-backend.md`, deleted)
Status: planning

## Context

Issue #17 originated as "add coding backend for ccs": run Claude Code under
[`@kaitranntt/ccs`](https://github.com/kaitranntt/ccs) and wire profile
priority arrays for rotation on rate limit. The earlier plan (deleted —
see git history for `plans/17-add-coding-backend-for-ccs/plans/17-ccs-backend.md`)
spec'd a `ccs` worker backend that wraps `claude`.

A deep-dive into the upstream `@kaitranntt/ccs@7.65.3` source uncovered
two findings that make a ccs-wrapper unworkable for an orchestrator that
needs raw stream-json events and any hope of cross-account session
continuity. The user has approved a pivot to **native multi-account
support on the existing `claude` backend**.

### Deep-dive findings (rationale for the pivot)

1. **Cross-profile `claude --resume <id>` is unreachable in ccs.** Each
   account-mode profile is bound to its own
   `CLAUDE_CONFIG_DIR=<ccsDir>/instances/<profile>` (`instance-manager.js:88`,
   `ccs.js:938`). The `context_mode: shared` / `context_group` /
   `--share-context` mechanism only synchronises a small set of
   sub-directories between profiles in the same group — `projects/`,
   `session-env`, `file-history`, `shell-snapshots`, `todos`
   (`shared-manager.js:407`, `:483`). The Claude session DB used by
   `claude --resume <id>` is **not** in that synchronised set. Therefore
   `claude --resume <id>` cannot succeed from a profile other than the
   one that recorded the session id, regardless of how the user
   configures ccs sharing.

2. **`ccs <profile> -p ...` does NOT pass through Claude stream-json.**
   `-p` triggers ccs's "delegation" path (`ccs.js:527`); the delegation
   pipeline (`delegation/headless-executor.js:218`) captures Claude's
   stdout, parses it internally, and `delegation/result-formatter.js:44`
   emits a *formatted summary report* to stdout, not the raw stream-json
   line stream the orchestrator's parser depends on. There is no
   `--quiet` flag (only a `CCS_QUIET` env var that suppresses **stderr**,
   not stdout). With `-p` but no real prompt token, ccs treats
   `--output-format` as the prompt. Net: we cannot drive ccs in `-p`
   mode and have any chance of consuming the worker stream-json events
   the daemon needs.

3. **Env-coupling deny list (verified during the deep-dive).** Any
   account-binding spawn must scrub the following from the inherited
   daemon env before injecting account-specific values:
   `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
   `ANTHROPIC_MODEL`, `CLAUDE_CONFIG_DIR`, `CLAUDECODE`. Defence in depth
   adds the broader `ANTHROPIC_*` glob and provider-token globs
   `*_API_KEY`, `*_AUTH_TOKEN`, `*_ACCESS_TOKEN`, `*_SECRET_KEY`,
   `*_BEARER_TOKEN`, `*_SESSION_TOKEN`. This list is captured as
   D12 / OHD1 / HAT1 below.

These findings are not saved as a separate research file — they live
here and in the issue-#17 comment that announces the pivot.

### What the new direction is

Drop ccs entirely. The daemon owns a small registry of named "claude
accounts". Each account is one of:

- `config_dir` mode — a daemon-owned `CLAUDE_CONFIG_DIR=<run_store>/claude/accounts/<name>/`
  that holds a Claude Pro/Max plan login (or any auth state Claude Code
  manages for itself);
- `api_env` mode — an `ANTHROPIC_API_KEY` (or another supported
  Anthropic-side env var set) stored via the existing
  `src/auth/userSecrets.ts` mechanism.

Worker profiles and direct-mode `start_run` calls gain an optional
`claude_account` plus an optional `claude_account_priority` /
`claude_accounts` array. Rotation triggers on terminal
`latest_error.category ∈ {rate_limit, quota}` exactly as the previous
plan specified, but across daemon-owned accounts in our registry —
nothing about ccs is involved.

**Cross-account session continuity does not work.** Claude's session DB
is stored under `CLAUDE_CONFIG_DIR/projects/...` and is
account-specific. **Rotated follow-ups never attempt cross-account
`claude --resume`**; the daemon always calls `runtime.start()` for a
fresh chat under the next account (D8 / A3 / T8) and tags the run
with `terminal_context.kind === "fresh_chat_after_rotation"` so the
supervisor sees the context loss.

### Sources read

- `AGENTS.md`, `CLAUDE.md`, `.agents/rules/node-typescript.md`,
  `.agents/rules/ai-workspace-projections.md`
- GitHub issue #17 body + 2026-05-05 owner comment on rate-limit
  detection
- `src/contract.ts` (`BackendSchema`, `RunErrorCategorySchema`,
  `RunLatestErrorSchema`, `RunSummarySchema`, `StartRunInputSchema`,
  `WorkerProfileSchema`)
- `src/backend/{claude,common,registry,runtime}.ts`,
  `src/backend/claudeValidation.ts`
- `src/orchestratorService.ts` (run lifecycle, profile resolution,
  followup logic)
- `src/processManager.ts` (env composition at `start()`:
  `{...process.env, ...invocation.env, NO_COLOR, TERM}`)
- `src/diagnostics.ts` (binary check, auth detection)
- `src/harness/capabilities.ts` (`WorkerProfileSchema`,
  `createWorkerCapabilityCatalog`)
- `src/auth/{authCli,providers,userSecrets,prompt}.ts`,
  `src/auth/providers.ts` (the `claude` provider currently registered
  with `status: "reserved"`)
- `src/mcpTools.ts` (`start_run`, `upsert_worker_profile` schemas)
- `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md`
- `plans/16-add-coding-backend-for-cursor-sdk/plans/16-cursor-agent-backend.md`
- Upstream `@kaitranntt/ccs@7.65.3` files cited in the deep-dive
  findings above

## Goal And Scope

### Goal

Let users orchestrate Claude Code runs against any of several Pro/Max or
API-key accounts, rotate to the next healthy account when the active
one trips a rate-limit / quota signal, and surface the resulting loss
of conversation continuity honestly via `terminal_context`. Account
setup is interactive via `agent-orchestrator auth login claude --account
<name>` so the user never has to hand-edit Claude's config dir layout.

### In Scope

- **Account registry**: daemon-owned JSON store at
  `<run_store>/claude/accounts.json` with entries
  `{ name, mode: "config_dir" | "api_env", config_dir_path?, env_vars?,
  registered_at, last_error_category?, cooldown_until_ms? }`. For
  `config_dir` mode the daemon owns
  `<run_store>/claude/accounts/<name>/`. For `api_env` mode the
  per-account secret is stored via `src/auth/userSecrets.ts`.
- **Worker profile schema additions** (gated on `backend === "claude"`):
  optional `claude_account: string`, `claude_account_priority: string[]`,
  `claude_cooldown_seconds: number` (positive integer ≤ 24h, default
  900). Validation: account names match
  `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` (no leading dot/dash, no `..`,
  no `/`, no whitespace) **plus** a defensive resolved-path containment
  check (`path.resolve(accountsRoot, name)` must stay inside
  `accountsRoot`); priority entries must exist in the registry at
  `start_run` time; if both `claude_account` and a priority array are
  supplied, `claude_account` must be a member of the priority array.
  Direct `claude_account` / `claude_accounts` are rejected when
  `profile` is supplied (mirrors the existing direct-vs-profile arbiter
  in `src/contract.ts:349`). Full rules in D4.
- **Direct-mode `start_run` additions** (gated on `backend === "claude"`):
  optional `claude_account: string` + `claude_accounts: string[]` with
  the same validation as profile mode.
- **Backend extension**: extend `ClaudeBackend` (or layer a thin
  `ClaudeAccountResolver` in `OrchestratorService`) so an active account
  name resolves to a per-spawn env (`CLAUDE_CONFIG_DIR=<path>` for
  `config_dir` mode, `ANTHROPIC_*` injection for `api_env` mode). The
  spawn still goes through the existing `CliRuntime` → `processManager`
  pipeline; `parseEvent`, `finalizeResult`, and the stream-json schema
  are unchanged. **`BackendSchema` is unchanged** — no new enum value.
- **Rate-limit detection + cooldown**: reuse `classifyBackendError`. On
  terminal `latest_error.category ∈ {rate_limit, quota}` mark the active
  account cooled-down for the configured TTL (default 15 min, overridden
  by `claude_cooldown_seconds`), persisted in the registry.
- **Rotation on `send_followup`**: when the parent run ended
  rotation-eligible and supplied a priority array, pick the next healthy
  account. Always start a fresh chat under the new account (no
  cross-account `--resume`). Record the rotation step on
  `metadata.claude_rotation_history` (cap at 32 entries) and set
  `terminal_context.kind === "fresh_chat_after_rotation"` with the prior
  account, the new account, and the parent run id. No silent
  auto-respawn.
- **Auth integration** — extend `agent-orchestrator auth` (added in PR
  #28 for cursor) with a `claude` provider:
  - `agent-orchestrator auth login claude --account <name>` — registers a
    new `config_dir` account (creating
    `<run_store>/claude/accounts/<name>/`), then runs
    `CLAUDE_CONFIG_DIR=<that-path> claude /login` interactively in the
    user's TTY so the user can complete OAuth. On success the registry
    entry is marked ready.
  - `agent-orchestrator auth set claude --account <name>` — registers
    an `api_env` account; secret input is via interactive hidden
    prompt (default), `--from-env VAR`, or `--from-stdin`. **No
    value-bearing argv flag is accepted** (mirrors the cursor
    provider precedent in `src/auth/authCli.ts:79`); secrets in argv
    leak into shell history and process listings. Persisted via
    `userSecrets.ts` under the slug-and-hash key from D11.
  - `agent-orchestrator auth list claude [--json]` — lists registered
    accounts with mode and status.
  - `agent-orchestrator auth remove claude --account <name>
    [--delete-config-dir]` — removes the registry entry; for
    `config_dir` mode also deletes `<run_store>/claude/accounts/<name>/`
    only when `--delete-config-dir` is passed (HAT3).
- **Env scrubbing** — implemented as a **runtime-threaded
  `WorkerInvocation.envPolicy`** (D12) that `ProcessManager.start()`
  honours **before** the existing `process.env` merge. The policy is
  set whenever an account is bound to the spawn (D13's
  `RuntimeStartInput.accountSpawn`), regardless of whether the run
  uses rotation or a single account. Unbound `backend: "claude"` runs
  inherit env exactly as today (default policy = no scrub),
  preserving behaviour for current users. The deny list is the
  verified set in D12; tested by an env-snapshot assertion. (HAT1)
- **Diagnostics** — `claude` diagnostic surfaces account info via the
  existing `BackendDiagnostic.checks[]` and `hints[]` arrays only (D14
  — no new schema field). One `checks[]` entry per registered
  account (capped at 16 in human output, full list via `auth list
  claude --json`); one aggregate `hints[]` line when zero accounts
  are registered. The existing binary / version / auth checks are
  unchanged. No reading of `~/.ccs/`.
- **Capability catalog** — update the existing `claude` entry in
  `createWorkerCapabilityCatalog` (`src/harness/capabilities.ts`) so the
  three new optional fields and their validation are advertised. No
  new backend.
- **MCP tool surface** — update `start_run` and `upsert_worker_profile`
  schema descriptions to mention the new `claude_account*` fields.
  Backend enum unchanged.
- **Tests** — hermetic, reuse the existing fake-`claude` test pattern.
- **Docs** — new `docs/development/claude-multi-account.md`; README
  one-liner; updates to PR #28's auth docs to cover the new `claude`
  provider commands; touch `docs/development/mcp-tooling.md` only if a
  cross-link is needed.

### Out Of Scope

- Any ccs integration. The previous `17-ccs-backend.md` plan and its
  `BackendSchema` widening are explicitly retracted.
- Cross-account session continuity / resume. Claude's session DB is per
  `CLAUDE_CONFIG_DIR`; rotation always produces a fresh chat (BI3).
- A new top-level backend value. The schema enum stays
  `['codex', 'claude', 'cursor']` (BI1).
- A new MCP tool for rotation. Rotation is driven exclusively via
  `send_followup` (BI4 / single rotation surface, same as the deleted
  ccs plan).
- Mid-run pre-emptive rotation. Captured as Future Options.
- Automating Claude's `/login` flow. The daemon never automates
  `claude /login`; the user always types it interactively in their own
  TTY (BI7).
- Reading or writing user-owned `CLAUDE_CONFIG_DIR` paths outside
  `<run_store>/claude/accounts/`. Pre-existing user homes
  (`~/.claude`, `~/.config/claude-code`) are not touched (BI6).
- Migrating users from a hypothetical earlier ccs profile manifest
  (there is no such manifest in production yet).

## Confirmed Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Pivot away from ccs | Drop the entire ccs-wrapper backend approach. No `ccs` enum value, no `src/backend/ccs.ts`, no ccs-specific schema fields. | Deep-dive findings show (a) `ccs <profile> -p` reformats stdout away from the stream-json contract the orchestrator depends on, and (b) cross-profile `claude --resume` is unreachable inside ccs even with `context_mode: shared`. Both are blocking; one is enough. | Continuing with ccs as a fallback worker — adds maintenance for a path that cannot satisfy the original goal. |
| 2 | Backend extension instead of new backend | Keep `BackendSchema = ['codex','claude','cursor']` unchanged. Multi-account support layers onto the existing `claude` backend via per-spawn env composition. | The `ClaudeBackend.parseEvent` and stream-json pipeline are correct — only the spawn env needs to vary by account. Adding a backend would force every consumer (CLI, MCP, capabilities, docs) to learn a parallel name. | A new `claude-multi-account` backend — duplicates code; surface change with no semantic benefit. |
| 3 | Account registry shape (D-AccountRegistryShape) | Daemon-owned JSON at `<run_store>/claude/accounts.json`, schema `{ version: 1, accounts: [...] }`. Each account entry: `{ name, mode: "config_dir" \| "api_env", config_dir_path?: string, secret_key?: string, registered_at: ISO8601, last_error_category?, cooldown_until_ms? }`. **The registry stores only references** — `config_dir_path` is a path under `<run_store>/claude/accounts/`, `secret_key` is the `userSecrets` key name produced by D11's slug-and-hash transform — **never raw secret values**. Atomic write through the same per-file lock pattern as worker profiles (`profileUpdateLocks` in `OrchestratorService`); corruption recovery resets to `{ version: 1, accounts: [] }` and logs a warning. Schema-version mismatch is reported as `INVALID_STATE` rather than silently overwritten. | Mirrors how the daemon already owns small per-host state. No new database. Storing only references makes the file safe to log, copy, and inspect. | (a) Embedding in `worker-profiles.json` — couples two unrelated registries. (b) SQLite — overkill. (c) In-memory only — lost on daemon restart, exactly when cooldown matters. (d) Storing raw secret values — duplicates `userSecrets.ts` and makes the file dangerous to log. |
| 4 | Profile / direct fields (gated on `backend === "claude"`) | `WorkerProfileSchema` gains optional `claude_account`, `claude_account_priority`, `claude_cooldown_seconds`. `StartRunInputSchema` gains optional `claude_account`, `claude_accounts`. **Validation rules** (Zod refinements at the contract boundary): (i) names match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` — must start with an alphanumeric, max 64 chars, no leading dot/dash, no embedded `/` or whitespace. **Plus a defensive resolved-path containment check**: at every call site that builds a path from a name (`path.resolve(accountsRoot, name)`), the resolved string must start with `accountsRoot + path.sep` and the name must not equal `..`, `.`, or contain `..` segments. Names failing either check are rejected with `INVALID_INPUT` (treated as a security-class error, not a typo). (ii) priority arrays non-empty + unique; (iii) when both `claude_account` and a priority array are supplied, `claude_account` must be in the priority array; (iv) every priority entry must exist in the account registry at `start_run` / `send_followup` time (looked up against the live registry — `INVALID_INPUT` otherwise); (v) all new fields rejected on non-`claude` backends with `INVALID_INPUT`; (vi) `claude_account` / `claude_accounts` direct-mode fields are rejected when `profile` is supplied (mirrors the existing direct-vs-profile arbiter in `src/contract.ts:349`); (vii) `claude_cooldown_seconds` is a positive integer ≤ `24*60*60` (24 hours); the daemon-side default is 900 (15 min). | The `^[A-Za-z0-9]` anchor and the ban on `.`/`..`/leading-dot prevents path-aliasing escapes since names build `<run_store>/claude/accounts/<name>/`. The resolved-path containment check is defence in depth in case the regex is later loosened. Registry-backed name validation prevents typos becoming silent rotation. | (a) The looser `/^[A-Za-z0-9_.-]{1,64}$/` from earlier drafts — allows `.`, `..`, leading dot/dash; path-traversal risk. (b) Free-form names — argv injection / typo risk. (c) Top-level `claude:` block on the manifest — premature. |
| 5 | Rate-limit detection mechanism | Post-terminal classification only. `classifyBackendError` (`src/backend/common.ts:173`) already maps Anthropic / stream-json `rate_limit_error` and quota errors to `RunErrorCategory ∈ {rate_limit, quota}`. The daemon flags the active account cooled-down for the configured TTL once the run reaches terminal status. Mid-stream pre-emption is **not** in v1. | Reuses the existing classifier and the existing `latest_error` field (`src/contract.ts:263`); matches the precedent set by the deleted ccs plan and by cursor's runtime; avoids killing healthy runs that recover. | (a) Mid-stream pre-emption — speculative, risks killing recoverable runs; captured as Future Options. (b) Polling Anthropic for token-bucket state — out of scope. |
| 6 | Cooldown bookkeeping | Cooldown lives directly on the registry entry (`cooldown_until_ms`, `last_error_category`). TTL is the per-profile `claude_cooldown_seconds` override if present, otherwise the **15-minute default**. Overrides are honoured at face value (no `min(override, default)` cap). | One TTL per account, persisted alongside the account entry, is enough for v1; co-locating with the registry avoids a second JSON file. | Per-error-category TTLs — deferred. Exponential backoff — deferred. |
| 7 | Rotation entry point | Exactly one rotation surface: `send_followup`. When the parent run ended rotation-eligible (terminal `latest_error.category ∈ {rate_limit, quota}`) **and** the parent's `metadata.claude_rotation_state` (D9) indicates rotation was enabled, the daemon picks the next healthy account from the persisted priority array and spawns a follow-up via `runtime.start()` (D8 — never `resume()`) bound to that account. A new `start_run` with a priority array also picks the first non-cooled-down account at start time. The daemon does **not** silently auto-respawn while the supervisor is unaware, and there is **no** new MCP tool for rotation. | Keeps the supervisor in control of when retry happens; matches the existing model where `send_followup` is the way to extend a chat. Reading rotation context off the parent run (D9) means the decision is stable across daemon restarts and profile-file edits. | Auto-respawn — surprises the supervisor. A new `rotate_run` MCP tool — public-contract widening for no behavioral gain. |
| 8 | Cross-account rotation always uses fresh `start()` (D-RotationStartShape — closes findings #8, #9) | For any rotated follow-up the daemon ALWAYS calls `runtime.start()` with the next account — NEVER `runtime.resume()`. This holds regardless of whether the parent run produced an `observed_session_id` (so it works even when the parent failed before any session id was seen, e.g. a rate-limit on the very first request). `runtime.resume()` is reserved exclusively for non-rotation follow-ups within the **same** account. Rotation runs always carry `terminal_context.kind === "fresh_chat_after_rotation"` with `{ parent_run_id, prior_account, new_account, parent_error_category }`. Rotation history is recorded on `metadata.claude_rotation_history` (capped at 32 entries; the 33rd write drops the oldest and emits a marker `{ truncated_count: 1 }`). The daemon does NOT attempt a "best-effort resume for telemetry" — that previous wording is retracted. | Claude's session DB is per `CLAUDE_CONFIG_DIR` (deep-dive finding 1); a cross-account `--resume` either fails or hallucinates a continuation. Always-fresh removes the corner case where rotation needs a session id the parent never produced. | (a) Best-effort cross-account resume for telemetry — risks hallucinated continuation; rejected. (b) Skip rotation when the parent has no `observed_session_id` — fights the issue's "rate-limit on first request" case. (c) Refuse to rotate when not shareable — fights the issue's stated goal. |
| 9 | Rotation state persistence on the parent run (D-RotationStatePersistence — closes finding #7) | At `start_run` time, when a `claude_account_priority` / `claude_accounts` array is supplied (in either profile or direct mode), the daemon **freezes** the rotation context onto the parent run as `RunSummary.metadata.claude_rotation_state = { accounts: string[], cooldown_seconds: number, source: "profile" \| "direct", frozen_at: ISO8601 }`. Subsequent `send_followup` reads `claude_rotation_state` from the parent run summary plus the live cooldown registry to make the next decision; it does NOT re-resolve the priority array from the profile manifest (which may have changed). `claude_rotation_state` is absent when no priority array was supplied — and rotation does not fire (BI2). | Daemon restarts, profile-file edits, and the no-`observed_session_id` rotation path (D8) all need the rotation context to live on the run record itself. Freezing at `start_run` time gives `send_followup` a stable contract no matter what happened to the manifest in between. | (a) Re-read the profile manifest on every `send_followup` — silent behaviour change when the user edits the manifest mid-flight. (b) Reconstruct from history — fragile and lossy (and impossible for direct-mode runs that did not come from a profile). (c) Putting it in a separate registry — duplicates state. |
| 10 | Auth surface for new accounts | Extend `agent-orchestrator auth` with a `claude` sub-surface: `auth login claude --account <name> [--refresh]` (interactive `claude /login` under a daemon-owned `CLAUDE_CONFIG_DIR`; **idempotency per D20**: refuses if `<name>` already exists unless `--refresh` is supplied, in which case `/login` re-launches against the existing dir to refresh the session); `auth set claude --account <name>` with secret input via **interactive prompt (default), `--from-env VAR`, or `--from-stdin`** — value-bearing argv flags such as `--api-key sk-...` are **NOT supported** (D-AuthCli, finding #6, mirrors the cursor provider precedent in `src/auth/authCli.ts:79`). v1 stores **exactly one** env var per `api_env` account: `ANTHROPIC_API_KEY` (D21); structured Anthropic env maps and arbitrary env maps are deferred to Future Options. `auth list claude [--json]`; `auth remove claude --account <name> [--delete-config-dir]`. The claude provider's `status` in `src/auth/providers.ts:73` flips from `"reserved"` to `"wired"` (gated on rollout). The daemon **never** automates `/login`; it spawns `claude /login` in the user's TTY and waits. Cooldown status is **not** echoed in direct-`start_run` metadata; it is surfaced via `auth list claude` and the diagnostic `checks[]` only (RQ4 resolution). | The user explicitly approved auth-as-in-scope; the existing `auth` CLI is the natural surface. Refusing value-bearing argv flags keeps secrets out of shell history, process listings, and CI logs — same posture as cursor. Interactive `/login` keeps OAuth flows on the user's side, never in daemon code. The `--refresh` opt-in keeps idempotency explicit. | (a) Allowing `--api-key sk-...` — leaks secrets into shell history / process listings; rejected for safety reasons. (b) A new top-level command (`agent-orchestrator claude account …`) — duplicates `auth` plumbing. (c) Embedding in MCP tools — auth flows do not belong in supervisor RPCs. (d) Echoing cooldown status in run metadata — direct-mode users asked explicitly for the named account; surfacing via `auth list` keeps the run-summary surface clean. (e) Always-relaunch idempotency — surprising; rejected by D20. (f) Supporting structured Anthropic env maps in v1 — widens the input surface; deferred per D21. |
| 11 | Auth secret storage for `api_env` mode (D-AccountSecretKey) | Reuse `src/auth/userSecrets.ts`. Per-account secrets are stored under a deterministic slugged key. **Slug transform**: `slug(name) = replaceAll(name, /[^A-Za-z0-9_]/g, "_")`; **disambiguation suffix**: `suffix = base32(sha256(name)).slice(0, 8).toUpperCase()`; **final secret-key** = `ANTHROPIC_API_KEY__<slug>__<suffix>`. The 8-char hash suffix prevents collisions when two distinct names slug to the same value (e.g. `alt-key` vs `alt_key` both slug to `alt_key`). The result always satisfies `isValidKey = /^[A-Za-z_][A-Za-z0-9_]*$/` (`src/auth/userSecrets.ts:305`). The registry entry stores only **the secret-key reference** (`secret_key: "ANTHROPIC_API_KEY__alt_key__7K3F2QXA"`), never the raw secret value. **No fallback chain** for account-bound runs: a registered `api_env` account whose secret-key is missing or empty causes `start_run` / `send_followup` to fail with `OrchestratorErrorCode = "INVALID_STATE"` (details: `{ reason: "missing_account_secret", account, secret_key }`). The fallback to user-level `ANTHROPIC_API_KEY` and daemon env applies **only to unbound `backend: "claude"` runs** (no `claude_account` field) — that path is unchanged from today. | No new secret store; the slug-and-hash transform makes name → key 1-to-1; storing only the key reference keeps the registry safe to log. The strict no-fallback rule for bound runs is the security invariant: a named account must use exactly its own credential, never silently borrow a different one. | (a) `ANTHROPIC_API_KEY__<account_name>` direct interpolation — fails `isValidKey` for names containing `.` or `-` (verified). (b) Storing the raw secret in the registry — fights `userSecrets.ts`. (c) "Account-bound key → user-level → daemon env" fallback chain — would silently use the wrong credential when an account is misconfigured; rejected for safety reasons (finding #4). |
| 12 | Env scrubbing via runtime-threaded policy (D-EnvScrub / HAT1; deny list locked by D19) | The deny list itself: explicit keys `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `CLAUDE_CONFIG_DIR`, `CLAUDECODE`; plus the broader globs `ANTHROPIC_*`, `*_API_KEY`, `*_AUTH_TOKEN`, `*_ACCESS_TOKEN`, `*_SECRET_KEY`, `*_BEARER_TOKEN`, `*_SESSION_TOKEN`. **Implementation shape (closes finding #2):** introduce `WorkerInvocation.envPolicy?: { scrub: string[]; scrubGlobs?: string[] } \| "default"` and have `ProcessManager.start()` apply it BEFORE the existing `{ ...process.env, ...invocation.env, NO_COLOR, TERM }` merge, i.e. compute `inherited = process.env` minus matching keys/globs, then merge `inherited → invocation.env → { NO_COLOR, TERM }`. **Default policy is `"default"` (no scrub) — preserves current behaviour for unbound runs and for non-`claude` backends.** Account-bound `claude` runs set the policy to the deny list above. The policy is threaded from `OrchestratorService` through `RuntimeStartInput.accountSpawn.envPolicy` (D-RuntimeAccountSpawn / D12 below) so `CliRuntime` populates `WorkerInvocation.envPolicy` for `ProcessManager` to honour. | The deep-dive findings show that any inherited `ANTHROPIC_*` / `CLAUDE_*` value will silently override account-specific env; mishandling this is the single largest auth-surface risk in the slice. The runtime-threaded shape avoids the architectural mistake of trying to inject env at the `OrchestratorService` layer (it never sees `WorkerInvocation`). | (a) Deny only the explicit six keys — leaks vendor-specific keys we don't know about. (b) Scrub everything matching `*_KEY` — overscans, breaks unrelated tooling. (c) Hard-coding scrub inside `ProcessManager` for all `claude` runs — breaks single-account / unbound runs that today rely on inherited env. (d) Trying to set env at the `OrchestratorService.startManagedRun` layer — `OrchestratorService` does not own the spawn pipeline; `CliRuntime` calls `processManager.start()` directly. |
| 13 | Runtime-threaded account spawn (D-RuntimeAccountSpawn — closes finding #3 / RQ1) | Extend `RuntimeStartInput` (the input to `WorkerRuntime.start()` / `.resume()` in `src/backend/runtime.ts`) with an optional `accountSpawn?: { env: Record<string, string>; envPolicy: { scrub: string[]; scrubGlobs?: string[] } }`. `OrchestratorService` resolves the active account → constructs `accountSpawn` (account-specific env + the D12/D19 deny list) → passes it to the runtime. `CliRuntime` merges `accountSpawn.env` into `WorkerInvocation.env` and sets `WorkerInvocation.envPolicy` from `accountSpawn.envPolicy` before calling `processManager.start()`. **`accountSpawn` is undefined for non-`claude` backends and for unbound `claude` runs**, leaving today's behaviour untouched. | `OrchestratorService` does not own the spawn pipeline (`CliRuntime` calls `processManager.start()` directly), so account env cannot live at the service layer alone. Threading through `RuntimeStartInput` puts the binding at the only place every `claude` spawn flows through, while keeping `ClaudeBackend.parseEvent` and the stream-json schema unchanged. | (a) Inject env in `OrchestratorService.startManagedRun` — does not work; `OrchestratorService` never sees `WorkerInvocation`. (b) Subclass `ClaudeBackend` for the multi-account path — couples spawn-time policy to backend identity. (c) Hard-code scrub in `ProcessManager` for all `claude` runs — breaks unbound runs. |
| 14 | Diagnostics (closes finding #10 / RQ3) | Render account info **only via the existing `BackendDiagnostic.checks[]` and `hints[]` arrays** — no new schema field on `BackendDiagnosticSchema`. Each registered account contributes one `checks[]` entry of shape `{ name: "claude account: <name> (<mode>)", ok: status === "ready", message: "<status>[, cooled until <iso>][, last_error: <category>]" }`. When **more than 16 accounts** are registered, only the first 16 are emitted as `checks[]` entries and a single aggregate `hints[]` line `"and N more registered claude accounts; run \`agent-orchestrator auth list claude --json\` for the full list"` is appended. `auth list claude --json` always returns every account (no cap). When **zero** accounts are registered the `claude` diagnostic adds a hint pointing at `agent-orchestrator auth login claude --account <name>`. `incomplete` status covers the case where the registry entry exists but the daemon-owned `CLAUDE_CONFIG_DIR` is missing or the api_env secret is absent. **No reading of `~/.ccs/`.** | Reuses the existing diagnostic surface end-to-end; no public-contract widening; the 16-entry cap keeps `claude doctor` output readable for users with many accounts while preserving full data through the JSON path. | (a) Adding a top-level `BackendDiagnostic.accounts` field — public-contract widening; rejected (would have required OHD4). (b) Always emitting every account into `checks[]` — unbounded growth in human output. (c) Inventing a `ClaudeAccountDiagnostic` schema — unnecessary contract change. |
| 15 | Capability catalog | Update the existing `claude` entry in `createWorkerCapabilityCatalog` so it advertises the three new optional fields with constraints, and so `inspectWorkerProfiles` rejects manifests that reference an unknown account at validation time. | Reuses the existing capability surface and profile validation pipeline. | Treating accounts as a separate axis on the catalog — drift risk vs. profile validation. |
| 16 | Public contract additivity | All new fields are additive: `BackendSchema` unchanged; `WorkerProfileSchema` and `StartRunInputSchema` gain the three / two optional fields; `OrchestratorErrorCodeSchema` gains **no** new code (`INVALID_INPUT` covers misconfigured priorities; `INVALID_STATE` covers all-cooled-down and missing-account-secret with structured `details`); `RunSummarySchema.metadata` carries `claude_account_used`, `claude_rotation_history`, and `claude_rotation_state` (D9); `RunSummarySchema.terminal_context` carries `kind === "fresh_chat_after_rotation"` for rotated runs (D8). `BackendDiagnostic.checks[]` and `hints[]` carry per-account info — **no new field on `BackendDiagnosticSchema`** (D14). `WorkerInvocation.envPolicy` is the only spawn-pipeline addition (D12), with a `"default"` (no-scrub) value preserving today's behaviour. | Same additivity discipline used for cursor (cursor-plan D10) and the deleted ccs-plan D11. | A new top-level `claude_state` field on `RunSummary` — premature. A new `accounts` field on `BackendDiagnosticSchema` — would have required OHD4; rejected by D14. |
| 17 | Tests | Mirror the cursor / claude test pattern. A fake `claude` test binary already exists; extend it to support `--rate-limit`, `--quota`, and a `/login` mock that prints `Login complete` after a configurable delay. Hermetic CI; no test reads the real `~/.claude/` or hits Anthropic. Coverage list in T9-Tests-Hermetic. | Hermetic CI; matches the existing pattern. | Hitting real Claude / Anthropic — non-hermetic. |
| 18 | Docs | New `docs/development/claude-multi-account.md` covering the account model, registering accounts via `auth login claude --account …` / `auth set claude …`, profile manifest examples (single account; priority array), rotation behaviour and the fresh-chat caveat, the env-scrub deny list, the `--refresh` flag for re-running `auth login`, and troubleshooting. README gains a one-liner. PR #28 auth docs are updated to cover the new `claude` provider commands. | Public CLI surface widens (HAT2); users need to know what is and is not in scope. | Docs-only without README — miss the contract change. |
| 19 | Env scrub deny list adopted (was OHD1 — human-approved 2026-05-05) | The deny list shipped with v1 is **exactly** the deep-dive list locked in D12: must-scrub explicit keys `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `CLAUDE_CONFIG_DIR`, `CLAUDECODE`; should-also-scrub globs `ANTHROPIC_*`, `*_API_KEY`, `*_AUTH_TOKEN`, `*_ACCESS_TOKEN`, `*_SECRET_KEY`, `*_BEARER_TOKEN`, `*_SESSION_TOKEN`. The list is **not** configurable via worker profile fields in v1 (no `claude_env_scrub` knob). Any later change to add, remove, or expose this list still requires HAT1 approval. | Maximum default safety with zero public knobs to mis-set. The verified deep-dive list covers every Anthropic / Claude Code env override path observed in upstream code; the broader globs catch vendor-token shapes used by adjacent tooling. | (a) Restrict to the explicit six keys only — leaks vendor-specific keys we do not know about. (b) Make the list a configurable manifest field — adds a public knob most users will never need; saved for a Future Option behind HAT1. |
| 20 | `auth login claude` idempotency adopted (was OHD2 — human-approved 2026-05-05) | When `agent-orchestrator auth login claude --account <name>` is invoked for a name that already exists in the registry, the command **refuses** with a clear error pointing at `--refresh`. The user must pass `--refresh` (long form; no shortened alias in v1) to re-launch `claude /login` against the existing daemon-owned `CLAUDE_CONFIG_DIR`; this preserves the directory and any prior session DB while letting the user reauthenticate. Always-relaunch and prompt-to-confirm options are explicitly retracted. | Predictable behaviour with no implicit credential refresh; matches the user's "explicit, no surprises" preference. The `--refresh` opt-in keeps the success path one keystroke away while preventing accidental re-OAuth. | (a) Always relaunch — surprises the user; risks re-prompting on every script run. (b) Prompt for confirmation — adds an interactive step in non-TTY contexts. |
| 21 | `api_env` mode breadth adopted (was OHD3 — human-approved 2026-05-05) | v1 supports **exactly one** environment variable per `api_env` account: `ANTHROPIC_API_KEY`. The registry's `secret_key` field references that single value via the slug-and-hash transform from D11. Structured Anthropic env maps (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, …) and arbitrary env-var maps are moved to Future Options. | Smallest auth-CLI input surface; smallest abuse surface; covers the common case (separate API keys for separate accounts). Bedrock / proxy users have a clear migration path via the future structured-map work. | (a) Structured Anthropic env map per account — widens the auth-CLI input surface and `userSecrets.ts` slug interactions; deferred. (b) Arbitrary env map per account — biggest abuse surface; deferred. |

## Assumptions

- **A1.** The `claude` binary on PATH respects `CLAUDE_CONFIG_DIR` as an
  override for the per-user state directory. This is a documented Claude
  Code feature and is what ccs relies on (verified during the
  deep-dive). If a future Claude Code release changes this, the
  registry's `config_dir` mode breaks; we capture the dependency in
  diagnostics so a regression surfaces.
- **A2.** Anthropic's stream-json `rate_limit_error` events are correctly
  classified as `RunErrorCategory.rate_limit` by the existing
  `classifyBackendError` (`src/backend/common.ts:173`). A test in
  `src/__tests__/processManager.test.ts:405` already covers the
  `rate_limit_error` shape; quota errors are covered by
  `backendErrorClassification.test.ts`.
- **A3.** Cross-account `claude --resume <id>` is **never attempted**
  by the daemon. The deep-dive (finding 1 in Context) shows Claude's
  session DB is per `CLAUDE_CONFIG_DIR`; an attempt with a foreign
  session id would either fail or, worse, hallucinate a continuation.
  Rotated follow-ups always invoke the runtime's `start()` path with
  the next account (D8). `resume()` is reserved for non-rotation
  follow-ups within the same account.
- **A4.** `claude /login` is the documented OAuth flow command and is
  safe to spawn interactively in a TTY with `CLAUDE_CONFIG_DIR` set.
  Verified by reading PR #28's interactive-spawn pattern for cursor.
- **A5.** Account names match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`
  (D4) and additionally pass the resolved-path containment check
  before any filesystem operation. Names are used as filesystem path
  segments and JSON keys, never as argv tokens.
- **A6.** `RunSummary.metadata` is allowed to carry orchestrator-owned
  structured fields (`claude_account_used`, `claude_rotation_history`,
  `claude_rotation_state`); the schema is `metadata:
  z.record(z.unknown())`, so this is additive.
- **A7.** `src/auth/userSecrets.ts` `isValidKey` is
  `/^[A-Za-z_][A-Za-z0-9_]*$/` (verified). Account names containing
  `.` or `-` therefore cannot map directly to env-style keys; D10
  defines the deterministic slug-and-hash transform that produces a
  valid `userSecrets` key.

## Behavior Invariants

- **BI1.** `BackendSchema` stays a closed enum
  `['codex','claude','cursor']`. No new enum value is added in this
  slice; the multi-account feature layers onto the existing `claude`
  backend.
- **BI2.** Rotation is **opt-in**: a `start_run` / profile manifest
  entry without a priority array behaves like the current `claude`
  backend — terminal errors are durable, no rotation happens,
  diagnostics for that profile are unchanged. Single-account runs are
  unaffected.
- **BI3.** Cross-account `claude --resume` is **never trusted**.
  Rotation always produces a fresh chat with
  `terminal_context.kind === "fresh_chat_after_rotation"`, regardless
  of whether the underlying resume call returned 0.
- **BI4.** Rotation has exactly one entry point: `send_followup`. No
  silent auto-respawn; no new MCP rotation tool.
- **BI5.** The cooldown store is **never** consulted to deny a request
  that did not opt into rotation: a direct `start_run` for a single
  account proceeds even if that account is currently cooled-down (the
  user is explicitly asking for that account).
- **BI6.** The daemon never reads or writes any user-owned
  `CLAUDE_CONFIG_DIR` outside `<run_store>/claude/accounts/`. In
  particular, `~/.claude/`, `~/.config/claude-code/`, and any
  user-supplied `CLAUDE_CONFIG_DIR` env value are never touched by
  daemon code (spawned `claude` child processes will of course manage
  whatever directory they are pointed at — that is upstream
  behaviour).
- **BI7.** `auth login claude --account <name>` is **interactive**.
  The daemon spawns `claude /login` with stdio bound to the user's
  TTY and waits; it does not screen-scrape, type credentials, or
  capture the token. The daemon's only role is to set
  `CLAUDE_CONFIG_DIR` for the spawned process and detect successful
  completion afterwards (presence of the auth-token file the spawned
  Claude wrote).
- **BI8.** Env scrubbing (D12 deny list, applied via
  `WorkerInvocation.envPolicy`) fires **whenever an account is bound
  to the spawn** — i.e. for every account-bound run, regardless of
  whether the run also opts into rotation. A single-account
  `start_run` with `claude_account: "work"` and no priority array
  still scrubs. **Unbound `backend: "claude"` runs (no
  `claude_account` field) inherit env exactly as today** (default
  policy = no scrub), preserving behaviour for existing users. This
  rule is also enforced for non-`claude` backends, where
  `accountSpawn` is always undefined.
- **BI9.** Account names referenced in worker profiles or `start_run`
  must exist in the registry **at run time**. A profile that names a
  removed account fails up-front with `INVALID_INPUT` and does not
  silently fall through to a different account.
- **BI10.** Concurrent registry writes are serialized through the same
  per-file lock pattern (`profileUpdateLocks`) used for worker
  profiles; corrupted JSON is recovered by resetting to an empty
  registry with a logged warning, never by silently accepting partial
  state.

## Human Approval Triggers

- **HAT1. Env scrub deny list (security boundary).** Adding or
  modifying the deny list in D11. Loosening it, exposing it as a
  manifest field, or switching to "inherit unchanged" requires
  explicit user approval. The default ships as the verified deny list
  from the deep-dive.
- **HAT2. Public CLI surface widening for the `claude` auth
  provider.** Adding `auth login claude`, `auth set claude`, `auth
  list claude`, `auth remove claude` (D9). The provider's `status`
  flipping from `"reserved"` to `"wired"` in
  `src/auth/providers.ts` is part of the same trigger.
- **HAT3. Destructive removal of daemon-owned account dirs.** Allowing
  `auth remove claude --account <name> --delete-config-dir` to
  recursively delete `<run_store>/claude/accounts/<name>/`. The flag
  is required (default off); without it the registry entry is removed
  but the directory is preserved on disk so the user can recover the
  Claude session DB if they made a mistake.
- **HAT4. Mid-run pre-emptive rotation.** Out of scope for this slice;
  any later change that adds it requires a separate plan.
- **HAT5. Auto-running `claude /login`.** The daemon must not screen-
  scrape or automate `/login`; any change that adds non-interactive
  OAuth handling requires explicit approval.

## Reviewer Questions

All RQs from the previous revision were resolved by the plan reviewer in
the 2026-05-05 pass and either folded into Confirmed Decisions (D8, D9,
D12, D13, D14) or promoted to Open Human Decisions (OHD2, OHD3). None
remain open at this layer.

none

## Open Human Decisions

none — the three previously-open OHDs were resolved by the human in the
2026-05-05 approval pass. Their adoptions are recorded as Confirmed
Decisions D19, D20, and D21:

- **OHD1 → D19.** Env scrub deny list = the verified deep-dive list
  (explicit six keys + the broader globs). Tied to HAT1 for any
  future change.
- **OHD2 → D20.** `auth login claude` idempotency = refuse if the
  account already exists unless `--refresh` is supplied.
- **OHD3 → D21.** `api_env` mode breadth = single `ANTHROPIC_API_KEY`
  per account in v1; structured Anthropic env map / arbitrary env
  map move to Future Options.

## Risks

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| R1 | Claude Code upstream changes the `CLAUDE_CONFIG_DIR` semantics or the `/login` flow. | Diagnostics call `claude --version` and surface the version; tests use a mock binary with the same env contract; we depend only on documented behaviour. The `config_dir` mode degrades to `incomplete` in diagnostics rather than crashing. | T5-Diagnostics |
| R2 | A user removes an account directory by hand (or `auth remove --delete-config-dir`) while a run is in flight bound to that account. | The spawn already failed if the dir is missing (Claude exits with a clear error). The cooldown bookkeeping does not lose information because the registry entry is removed atomically; in-flight runs report their existing terminal error path. We do not hold open file descriptors against the directory. | T2-Backend |
| R3 | Concurrent `auth login claude --account <name>` for the **same** name. | Per-name lock at the auth-CLI layer (reuse `profileUpdateLocks`-style pattern); second invocation reports a clear "in progress" message. Resolution depends on RQ5/OHD2. | T7-Auth |
| R4 | Rotation hides a real misconfiguration that classifies as `rate_limit` (e.g. a bad model id triggers a 429-shaped error). | Rotation history is durable and records `last_error_category` per step; if **all** accounts cool down within a short window, the daemon surfaces `INVALID_STATE` with `details.cooldown_summary` so the supervisor can diagnose. | Decision 6, BI8 |
| R5 | Env scrub regex is too permissive and strips a key the user actually needs (e.g. an HTTP proxy auth header). | Deny list is a fixed array of explicit keys plus targeted vendor patterns; it does not scan `*_TOKEN` (too broad). The patterns that **are** broad (`ANTHROPIC_*`) are limited to a single vendor's namespace. Tests assert that unrelated env keys (`HOME`, `PATH`, `EDITOR`, `GH_TOKEN`, …) survive. | T2-Backend, T9-Tests-Hermetic |
| R6 | The `metadata.claude_rotation_history` field grows unbounded across long chains of follow-ups. | Cap at 32 entries; older entries are dropped with a marker entry `{ truncated_count }`. Same shape as BI8 in the deleted ccs plan. | BI semantics |
| R7 | Deleting `<run_store>/claude/accounts/<name>/` strands the account's session DB. | `--delete-config-dir` is opt-in; default behaviour preserves the directory so the user can re-register the account and recover the prior session DB. | HAT3, Decision 9 |
| R8 | The interactive `claude /login` spawn cannot inherit the user's TTY (e.g. invoked from a non-interactive shell). | `auth login claude` checks `process.stdin.isTTY` up front; non-interactive callers get a clear error pointing them at `auth set claude --from-env` / `--from-stdin` for `api_env` mode. | T7-Auth, BI7 |
| R9 | `auth list claude` and the `BackendDiagnostic.checks[]` account entries drift from the on-disk registry between calls. | Both surfaces read the registry through the same `loadAccountRegistry` helper; tests assert that a write is visible to the next read. | T6-Service-Registry, T7-Auth |
| R10 | A future schema migration on `accounts.json` breaks running daemons. | Schema carries a top-level `version: 1` field; unknown versions are rejected with `INVALID_STATE` and a clear remediation hint rather than silently overwritten. Same pattern as the worker profile manifest. | T6-Service |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T1-Contract | Widen `WorkerProfileSchema` and `StartRunInputSchema` with the new optional `claude_account*` fields and D4 validation rules (Zod refinements + the resolved-path containment check helper). Add `WorkerInvocation.envPolicy?: { scrub: string[]; scrubGlobs?: string[] } \| "default"` to the `WorkerInvocation` type. Reject the new fields on non-`claude` backends with `INVALID_INPUT`. Update `mcpTools.ts` `start_run` and `upsert_worker_profile` schema descriptions. **`BackendSchema` is unchanged.** | none | pending | `pnpm build`; `pnpm test` covers (a) accept/reject samples for the regex including `..`, `./x`, leading-`.`, embedded `/`, whitespace, unicode; (b) the resolved-path containment check rejects names that escape `accountsRoot`; (c) empty / duplicate priority arrays rejected; (d) `claude_account` not in `claude_accounts` rejected; (e) fields rejected on non-`claude` backends; (f) priority entries that do not exist in the registry rejected at `start_run` time; (g) **direct `claude_account` / `claude_accounts` rejected when `profile` is supplied** (mirrors `src/contract.ts:349`); (h) `claude_cooldown_seconds` upper-bound (24h) and positive-int validation. |
| T2-Backend | (a) In `ProcessManager.start()` (`src/processManager.ts:42`) honour `WorkerInvocation.envPolicy`: when the policy is non-`"default"`, scrub matching keys/globs from `process.env` BEFORE merging `invocation.env` and the existing `NO_COLOR`/`TERM` overrides. Default policy is `"default"` (no scrub) — preserves today's behaviour for non-`claude` and unbound-`claude` runs. (b) Extend `RuntimeStartInput` (`src/backend/runtime.ts`) with optional `accountSpawn?: { env, envPolicy }` (D13). (c) In `CliRuntime.spawn()` (or equivalent) merge `accountSpawn.env` into `WorkerInvocation.env` and set `WorkerInvocation.envPolicy = accountSpawn.envPolicy` before calling `processManager.start()`. (d) Surface `claude_account_used` on `RunSummary.metadata`. The argv shape produced by `ClaudeBackend` is unchanged. | T1-Contract | pending | Argv unchanged from the existing `claude` backend; env-snapshot tests in `src/__tests__/processManager.test.ts` style assert that (i) with `envPolicy: "default"` today's behaviour is byte-identical, (ii) with the deny-list policy no deny-listed key from `process.env` survives, (iii) account-specific env (`CLAUDE_CONFIG_DIR=<path>` or `ANTHROPIC_API_KEY=<value>`) is set exactly, (iv) unrelated env (`PATH`, `HOME`, `GH_TOKEN`, `EDITOR`, `LANG`, …) is preserved. Mock-binary integration test exercises a full lifecycle with one `config_dir` account and one `api_env` account. |
| T3-Diagnostics | Extend the `claude` diagnostic per D14: render account info **only via `BackendDiagnostic.checks[]` and `hints[]`** (no new schema field). Cap `checks[]` at 16 account entries with an aggregate "and N more" `hints[]` line when the registry has more; emit a "no accounts registered" hint when empty. **No reading of `~/.ccs/`.** | T6-Service-Registry | pending | `pnpm test` covers no-accounts, one-ready-account, one-cooled-down account, one-incomplete account, and the 17-account boundary (16 in `checks`, 1 named in the aggregate hint). `formatBackendStatus` renders the new entries human-readably. |
| T4-CapabilityCatalog | Update the `claude` entry in `createWorkerCapabilityCatalog` to advertise the three new optional fields and to make `inspectWorkerProfiles` reject manifests referencing unknown accounts. | T1-Contract, T6-Service | pending | Catalog snapshot test updated; profile-validation tests cover both the "unknown account" rejection path and the happy path. |
| T5-Service-Resolution | Extend `OrchestratorService.startRun` and `sendFollowup` to (a) parse the new fields, (b) resolve the active account against the registry (skipping cooled-down entries when a priority array is in play), (c) construct `RuntimeStartInput.accountSpawn` (D13) with the account-specific env and the D12 deny-list policy, (d) freeze `metadata.claude_rotation_state` on `start_run` (D9). For `api_env` accounts with no stored secret return `INVALID_STATE` (`reason: "missing_account_secret"`, D11) — **no fallback to ambient env**. | T1-Contract, T6-Service-Registry | pending | Unit tests cover empty-priority, single-entry, all-cooled-down (returns `INVALID_STATE` with structured `details.cooldown_summary`), successful selection, the missing-account-secret error, and `claude_rotation_state` frozen at `start_run` time (verified by reading the parent `RunSummary` after the call). |
| T6-Service-Registry | Implement the account-registry CRUD layer at `<run_store>/claude/accounts.json` per D3: `version: 1`, atomic-write with the existing per-file lock pattern, corruption recovery (reset to empty + log), schema-version mismatch error (`INVALID_STATE`). **The registry stores only references** (`config_dir_path`, `secret_key`) — never raw secrets. Expose helpers `loadAccountRegistry()`, `withAccountRegistryLock()`, `markAccountCooledDown()`, `clearExpiredCooldowns()`, `resolveAccountSpawn(account)` (returns `{ env, envPolicy }` for D13). | none | pending | Unit tests cover create/read/update/delete, atomic concurrent writes via the lock, corrupt-JSON recovery, schema-version mismatch error, cooldown TTL expiry semantics, and the resolved-path containment check rejecting names that escape `accountsRoot`. Test that the on-disk JSON never contains a raw secret value (only `secret_key` references). |
| T7-Auth | Add the `claude` provider commands to `src/auth/authCli.ts`: `auth login claude --account <name>` (interactive `claude /login` under daemon-owned `CLAUDE_CONFIG_DIR`), `auth set claude --account <name> [--from-env VAR \| --from-stdin]` (default = interactive prompt; **no `--api-key` value flag**, mirrors the cursor precedent in `src/auth/authCli.ts:79` per D10), `auth list claude [--json]`, `auth remove claude --account <name> [--delete-config-dir]`. Flip the claude provider's `status` from `"reserved"` to `"wired"` in `src/auth/providers.ts:73`. Use `userSecrets.ts` for `api_env` mode under the slug-and-hash key from D11; secret-key reference is the only thing stored in the registry. Idempotency policy per OHD2 (default = refuse unless `--refresh`). | T6-Service-Registry | pending | E2E test with a fake `claude` binary that mocks `/login` and writes a sentinel file under the supplied `CLAUDE_CONFIG_DIR`; tests for the three input paths (interactive prompt, `--from-env VAR`, `--from-stdin`); test asserting **no value-bearing argv flag** is accepted (`--api-key sk-…` errors out); test for non-interactive caller of `auth login` getting a clear error (BI7); test for the slug-and-hash round-trip (`alt-key` and `alt_key` produce distinct secret keys); test for `auth remove --account <name>` without `--delete-config-dir` leaving the directory on disk (HAT3). |
| T8-Service-Rotation | On `send_followup` against a parent run whose `metadata.claude_rotation_state` (D9) indicates rotation was enabled and that ended with `latest_error.category ∈ {rate_limit, quota}`, pick the next healthy account from the persisted priority array (live cooldown registry), **always** invoke `runtime.start()` (D8 — never `resume()`, even when no `observed_session_id` was produced), set `terminal_context.kind === "fresh_chat_after_rotation"` with `{ parent_run_id, prior_account, new_account, parent_error_category }`, append to `metadata.claude_rotation_history`, cap at 32 entries (drop oldest with `{ truncated_count }` marker). Mark the prior account cooled-down per D5 / D6. | T2-Backend, T6-Service-Registry | pending | Integration test: parent hits `rate_limit` → followup rotates → fresh chat under new account; `terminal_context` and rotation history are set. **Test the no-session-id path**: parent fails before any `observed_session_id` is recorded → followup still rotates and starts a fresh chat. **Test daemon-restart-during-cooldown**: parent ends rotation-eligible, daemon restarts, `claude_rotation_state` is read off the parent run, `send_followup` rotates correctly. All-cooled-down → `INVALID_STATE` with structured details. Rotation history truncation at 33+ entries. |
| T9-Tests-Hermetic | Extend the existing fake `claude` test binary with `--rate-limit`, `--quota`, and a `/login` mock that prints `Login complete` and writes a sentinel file under the supplied `CLAUDE_CONFIG_DIR`. All new tests use the fake binary; no test reads real `~/.claude/` or contacts Anthropic. | T2-Backend | pending | Coverage explicitly includes: (1) account-name regex accepts/rejects (including `..`, `./x`, leading-`.`, embedded `/`, whitespace) and resolved-path containment; (2) `WorkerInvocation.envPolicy` honoured by `ProcessManager` (deny list keys removed; unrelated keys preserved); (3) registry CRUD + atomic concurrent writes; (4) profile validation rejecting unknown account names; (5) **direct `claude_account` rejected when `profile` is supplied** (mirrors `src/contract.ts` arbiter); (6) **`api_env` account with no stored secret produces `INVALID_STATE` (`reason: "missing_account_secret"`) — no fallback to ambient env**; (7) slug-and-hash secret-key round-trip (`alt-key` vs `alt_key` distinct); (8) rate_limit → cooldown → rotation → fresh chat; (9) **rotation when parent has no `observed_session_id`** still starts fresh in next account; (10) **daemon-restart-during-cooldown**: state reconstructed from parent's `claude_rotation_state`; (11) all-cooled-down → `INVALID_STATE` with `details.cooldown_summary`; (12) cooldown corruption recovery (truncated/invalid JSON resets to empty); (13) rotation history truncation at 33+ entries; (14) `auth login claude` end-to-end with the fake binary; (15) `auth set claude --from-env`/`--from-stdin` paths; (16) `auth set claude --api-key sk-…` rejected with a clear error; (17) diagnostics `checks[]` cap at 16 entries with aggregate hint; (18) `auth list claude --json` returns all entries (no cap). |
| T10-Docs | New `docs/development/claude-multi-account.md` covering account model, `auth login` / `auth set` walkthroughs, profile manifest examples (single account; priority array), rotation behaviour and the fresh-chat caveat, env-scrub deny list, and troubleshooting. README one-liner. PR #28's auth docs updated. | T1-T9 | pending | Docs cover the eight points in In Scope / Decision 16; pinned snippets for `auth login` / `auth set` / `auth list` / `auth remove`. |
| T11-Verify | `pnpm verify`; capture evidence in `plans/17-add-coding-backend-for-ccs/resolution-map.md`. **Live local smoke test**: run `auth login claude --account smoke` against a real Claude install, register a second account via `auth set claude --account smoke-api --from-env ANTHROPIC_API_KEY` (no value-bearing flag), build a worker profile that uses both, **simulate a rate-limit using the fake-claude binary's `--rate-limit` mode** (do NOT wait for a real rate-limit; burning quota requires explicit human approval), and confirm rotation produces a fresh chat with `terminal_context.kind === "fresh_chat_after_rotation"`. | T1-T10 | pending | `pnpm verify` exits 0; evidence pasted into the resolution map. Live smoke evidence (or explicit "no real Claude install available — smoke deferred" note with sign-off) recorded. |

## Acceptance Criteria

- A user can run `agent-orchestrator auth login claude --account work`,
  complete the OAuth flow interactively in their TTY, and see the
  account marked ready in `agent-orchestrator auth list claude` and in
  `agent-orchestrator doctor` output.
- A user can run `agent-orchestrator auth set claude --account alt-key
  --from-env ANTHROPIC_API_KEY` (or the interactive prompt, or
  `--from-stdin`) and see the account marked ready, with the secret
  stored via `userSecrets.ts` under the slug-and-hash key from D11 and
  **never** echoed back. **Value-bearing argv flags such as `--api-key
  sk-…` are rejected with a clear error.**
- A worker profile manifest entry with `backend: "claude"`,
  `claude_account: "work"`, `claude_account_priority: ["work",
  "alt-key", "team"]`, `model: "claude-opus-4-7"` resolves on
  `start_run`. The first run uses `work`, succeeds end-to-end, produces
  stream-json events identical to a current `claude` run, and the
  parent `RunSummary.metadata.claude_rotation_state` is frozen with
  the priority array (D9).
- When a run terminates with `latest_error.category ∈ {rate_limit,
  quota}` the next `send_followup` against that run rotates to the
  next healthy account via `runtime.start()` (D8 — never `resume()`,
  even when no `observed_session_id` exists), **always** produces a
  fresh chat (BI3), sets `terminal_context.kind ===
  "fresh_chat_after_rotation"`, and appends to
  `metadata.claude_rotation_history`.
- After a daemon restart, `send_followup` against a parent run with
  `claude_rotation_state` frozen on it still rotates correctly
  (regression test: D9 / T8).
- A direct `start_run` with `backend: "claude"`, `claude_account:
  "work"`, no priority array works exactly like the current `claude`
  backend with one account; cooldown is **not** consulted (BI5);
  terminal `rate_limit` is durable, no rotation happens.
- A `start_run` with `profile: "<alias>"` AND a direct
  `claude_account` / `claude_accounts` is rejected with
  `INVALID_INPUT` (mirrors `src/contract.ts:349`).
- A registered `api_env` account whose `userSecrets` key is missing
  produces `INVALID_STATE` (`reason: "missing_account_secret"`); the
  daemon does **not** silently fall back to the ambient
  `ANTHROPIC_API_KEY` (D11 / finding #4).
- All accounts in the priority array being cooled down produces
  `OrchestratorErrorCode = "INVALID_STATE"` with
  `details.cooldown_summary` and per-account `details.cooldown_until_ms`.
- `claude` diagnostic surfaces account info **only via `checks[]` and
  `hints[]`** (D14): one `checks[]` entry per registered account,
  capped at 16 with an aggregate hint at 17+; `auth list claude
  --json` always returns the full list. **`BackendDiagnosticSchema`
  itself is unchanged** (no new top-level field).
- The daemon process never reads or writes user-owned
  `CLAUDE_CONFIG_DIR` paths outside `<run_store>/claude/accounts/`
  (BI6) — verified by `fs.*` spy on the daemon process.
- Spawned `claude` env from an account-bound run never contains any
  deny-listed key inherited from the daemon (BI8 / HAT1 / D12) —
  verified by env-snapshot test in `src/__tests__/processManager.test.ts`
  style. Unbound `claude` runs see today's env unchanged
  (`envPolicy: "default"` regression test).
- `pnpm verify` passes; AI workspace projection check is clean
  (`node scripts/sync-ai-workspace.mjs --check`).

## Quality Gates / Verification

- [ ] `pnpm build`
- [ ] `pnpm test` — full repo suite, including the new account / auth /
      rotation tests
- [ ] `pnpm verify` — release-readiness gate, evidence pasted into
      `plans/17-add-coding-backend-for-ccs/resolution-map.md`
- [ ] Live local smoke test: real `auth login claude --account smoke`
      → real worker run → simulated rate limit → rotation produces
      fresh chat with `terminal_context.kind ===
      "fresh_chat_after_rotation"`
- [ ] `fs.*` spy / instrumentation: zero **daemon-process** reads or
      writes outside `<run_store>/claude/accounts/` and the registry
      JSON during a full lifecycle (BI6)
- [ ] Env scrubbing test: spawned `claude` env never contains
      `ANTHROPIC_*` / `CLAUDE_CONFIG_DIR` / `CLAUDECODE` /
      vendor-token-shaped keys inherited from the daemon (BI8 / HAT1)
- [ ] AI workspace projection check: `node scripts/sync-ai-workspace.mjs
      --check` clean
- [ ] Capability catalog snapshot updated (T4)
- [ ] No new runtime dependencies (no YAML parser; no new SDK; no new
      crypto library) — repo policy from
      `.agents/rules/node-typescript.md`

## Future Options

- **Mid-run pre-emptive rotation.** Watch stream-json for early
  `rate_limit_error` events and cancel + rotate before terminal.
  Captured under HAT4.
- **`api_env` proxy / Bedrock support.** Storing a multi-var env map
  per `api_env` account so users can wire `ANTHROPIC_BASE_URL` +
  `ANTHROPIC_AUTH_TOKEN` for proxy / Bedrock setups. Deferred per
  D21; reviving this widens the auth-CLI input surface and the
  registry schema.
- **Arbitrary env-var map per `api_env` account.** Largest abuse
  surface; deferred per D21.
- **Per-error-category cooldowns.** Different TTLs for `rate_limit`
  vs `quota` and exponential backoff for repeat offences.
- **Cross-account session export.** A daemon-side mechanism to copy a
  Claude session DB row from one account's `CLAUDE_CONFIG_DIR` to
  another before rotation. Risky; would need a deep-dive of Claude
  Code's session DB schema and would likely require explicit user
  approval (HAT-class).
- **Rotation telemetry / observability.** Surface
  `claude_rotation_history` in the observability snapshot so users
  can chart how often they hit rate limits per account.
- **`agent-orchestrator auth refresh claude --account <name>`.** A
  dedicated subcommand for token refresh. v1 ships the `--refresh`
  flag on `auth login claude` instead (D20); this option captures a
  potential cleanup if `--refresh` proves awkward.
- **Configurable env-scrub deny list.** A worker-profile field
  `claude_env_scrub: string[]` that lets a user add or remove keys
  from the v1 deny list (D19). Deferred; any later change still goes
  through HAT1.

## Execution Log

### T1-Contract: Widen schemas
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T2-Backend: Account-bound spawn
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T3-Diagnostics
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T4-CapabilityCatalog
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T5-Service-Resolution
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T6-Service-Registry
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T7-Auth
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T8-Service-Rotation
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T9-Tests-Hermetic
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T10-Docs
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T11-Verify
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

## Issue Comment Draft (for posting on issue #17)

> Note: this comment is to be posted **manually** on issue #17 after
> this plan is committed; the planning workflow does not post on the
> user's behalf. Update the wording at post time if any of the
> Decisions / OHDs change before merge.

```markdown
## Pivot: scrap the ccs wrapper, build native multi-account support

The original direction was a `ccs` worker backend wrapping `claude` via [`@kaitranntt/ccs`](https://github.com/kaitranntt/ccs). A deep-dive of upstream `@kaitranntt/ccs@7.65.3` turned up two blockers:

1. **`ccs <profile> -p ...` does not pass through Claude stream-json.** `-p` triggers ccs's delegation pipeline (`ccs.js:527`); `delegation/headless-executor.js:218` captures Claude's stdout and `delegation/result-formatter.js:44` emits a formatted summary report instead of the raw stream-json line stream the orchestrator needs. There is no `--quiet` flag (only `CCS_QUIET` for stderr).
2. **Cross-profile `claude --resume <id>` is unreachable inside ccs.** Each account profile is bound to its own `CLAUDE_CONFIG_DIR=<ccsDir>/instances/<profile>` (`instance-manager.js:88`, `ccs.js:938`); `context_mode: shared` / `context_group` only synchronise `projects/`, `session-env`, `file-history`, `shell-snapshots`, `todos` (`shared-manager.js:407`, `:483`) — not the Claude session DB.

**New direction (approved):** drop ccs and build native multi-account support on the existing `claude` backend. The daemon owns a registry at `<run_store>/claude/accounts.json`; each account is `config_dir` mode (daemon-owned `CLAUDE_CONFIG_DIR`) or `api_env` mode (single `ANTHROPIC_API_KEY` per account in v1, stored via `userSecrets.ts`; structured Anthropic env maps and arbitrary env maps are Future Options). Worker profiles and `start_run` gain optional `claude_account` / `claude_account_priority` / `claude_cooldown_seconds`. `BackendSchema` stays `['codex','claude','cursor']`.

**Security posture:** account names match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` with a defensive resolved-path containment check (no `..` / path-traversal); env scrubbing is implemented as a runtime-threaded `WorkerInvocation.envPolicy` honoured by `ProcessManager` (no rewrite of the spawn pipeline; unbound runs unchanged) using the verified deep-dive deny list (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `CLAUDE_CONFIG_DIR`, `CLAUDECODE` plus `ANTHROPIC_*` and provider-token globs); auth always uses interactive prompt / `--from-env` / `--from-stdin` — never value-bearing argv flags (mirrors the cursor provider precedent in PR #28). `auth login claude --account <name>` is idempotent: it refuses if the account already exists unless `--refresh` is passed. A registered `api_env` account whose secret is missing fails with `INVALID_STATE` rather than silently falling back to the ambient `ANTHROPIC_API_KEY`.

**Caveat carried over:** Claude's session DB is per `CLAUDE_CONFIG_DIR`, so rotated follow-ups always call fresh `runtime.start()` — never `runtime.resume()`. Rotation runs carry `terminal_context.kind === "fresh_chat_after_rotation"` so the supervisor sees the context loss explicitly.

Plan: `plans/17-add-coding-backend-for-ccs/plans/17-claude-multi-account.md`.
```
