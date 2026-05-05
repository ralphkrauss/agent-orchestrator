# Codex Worker Network Egress Under Daemon-Managed Sandbox

Branch: `31-codex-worker-bash-sandbox-blocks-outbound-http-eg-apigithubcom-breaking-gh-api-in-workflows`
Plan Slug: `31-codex-network-egress`
Parent Issue: #31
Created: 2026-05-05
Status: implemented (2026-05-05; T1–T13 complete; T6 manual/live smoke still required pre-merge per repo policy)

## Context

A codex-backed worker run cannot reach the public internet (e.g.
`gh api repos/.../pulls/.../reviews` against `api.github.com`) when
dispatched through the orchestrator daemon. The user observed this while
running `orchestrate-resolve-pr-comments`: the `pr-comment-reviewer`
profile (codex / gpt-5.5 / xhigh, `service_tier: "normal"`) failed to
fetch PR review threads, so its review fell back to a local-only
attestation.

### What the code actually does today

The chain that produces `--ignore-user-config` in the codex argv is:

1. `src/orchestratorService.ts:1173-1191` (`modelSettingsForBackend`)
   maps the codex backend's user-supplied `service_tier` to the
   internal `RunModelSettings`:
   - `service_tier === 'normal'` ⇒ `service_tier: null, mode: 'normal'`
   - any other tier ⇒ `service_tier: <tier>, mode: null`
   - `service_tier` unset ⇒ `mode: null`
2. `src/backend/codex.ts:144-146` (`userConfigArgs`) emits
   `['--ignore-user-config']` **iff `mode === 'normal'`**, otherwise
   nothing.
3. `src/backend/codex.ts:8-34` (`start` and `resume`) splice
   `userConfigArgs(...)` into `codex exec` argv.

Per the codex CLI help (verified by the reviewer on codex-cli 0.128.0),
`--ignore-user-config` "**skips `$CODEX_HOME/config.toml`**" — so the
user's network policy lives there, and only the `service_tier: 'normal'`
path strips it. Profiles with `service_tier` set to anything else (or
unset) currently honor `~/.codex/config.toml` and inherit whatever
network allowlist the user configured.

That asymmetry is load-bearing for OD1 below.

### Why claude does not hit this

`src/backend/claude.ts:8-14` does not pass any equivalent
"ignore-user-config" flag. Claude has its own permission/network model
independent of `~/.codex/`.

### Sources read

- Issue #31 (this branch).
- `AGENTS.md`, `CLAUDE.md`, `.agents/rules/node-typescript.md`,
  `.agents/rules/mcp-tool-configs.md`,
  `.agents/rules/ai-workspace-projections.md`.
- `src/backend/codex.ts`, `src/backend/claude.ts`, `src/backend/common.ts`.
- `src/orchestratorService.ts`
  (`modelSettingsForBackend`, `workerProfileFromUpsert`,
  `formatValidProfile`).
- `src/contract.ts` (`RunModelSettingsSchema`, `StartRunInputSchema`,
  `UpsertWorkerProfileInputSchema`, `SendFollowupInputSchema`).
- `src/mcpTools.ts` (upsert/list/start MCP tool schemas at lines 32, 98,
  250).
- `src/harness/capabilities.ts`
  (`WorkerProfileSchema`, `validateCodexProfile`, capability table).
- `src/runStore.ts:165-189` (run-meta persistence; `model_settings` is
  stored verbatim).
- `src/observability.ts:374-378` (run aggregation keyed on
  `reasoning_effort:service_tier:mode`; `uniqueSettings` deduplication).
- `src/contract.ts:543-544` — `ObservabilityRunSettingsSchema =
  RunModelSettingsSchema` (so any field added to
  `RunModelSettingsSchema` is automatically reflected in observability
  and dedup paths).
- `src/opencode/config.ts:160-255` — supervisor system-prompt formatters:
  profile-field listing (`:174`), `formatProfiles` (`:229-246`),
  `formatCatalog` (`:248-255`).
- `src/claude/config.ts:197-235` — same supervisor system-prompt
  formatters for the Claude harness: `formatProfiles` (`:197-214`),
  `formatCatalog` (`:228-235`).
- `src/__tests__/backendInvocation.test.ts` (asserts current argv shape).
- `src/__tests__/integration/orchestrator.test.ts` (uses
  `service_tier: 'normal'` end-to-end).
- `README.md` (profile manifest documentation, MCP tool tables).
- `.agents/skills/orchestrate-resolve-pr-comments/SKILL.md`,
  `.claude/skills/orchestrate-resolve-pr-comments/SKILL.md`.
- `docs/development/cursor-backend.md`, `docs/development/auth-setup.md`,
  `docs/development/mcp-tooling.md` (no codex backend doc exists yet).
- Prior plans `plans/27-.../plans/27-daemon-auth-setup.md` and
  `plans/11-.../plans/11-opencode-orchestration-harness.md`
  (precedent for additive contract changes and conservative defaults).

### Reviewer round 1 — answers folded in

- **RQ1 → answered.** Defer per-domain allowlist; ship coarse modes only.
  `user-config` remains the escape hatch for advanced users.
- **RQ2 → answered.** Confirmed against codex-cli 0.128.0:
  `-c sandbox_workspace_write.network_access=true` is supported, and
  `--ignore-user-config` skips `$CODEX_HOME/config.toml`. T6 still runs a
  smoke for the literal flag against the version under release.
- **RQ3 → answered.** Confirmed: the user's `pr-comment-reviewer`
  profile uses `service_tier: 'normal'`. Trigger model is correct.
- **RQ4 → answered.** Field name is `codex_network` (explicit,
  codex-only). Revisit `codex_sandbox` later if scope grows.
- **RQ5 → answered.** Persist effective `codex_network` on
  `run_summary.model_settings`; `runStore.ts:174` already stores
  `model_settings`, `observability.ts:378` aggregates them.
- **RQ6 → answered.** Document pre-fetch as the recommended default in
  `orchestrate-resolve-pr-comments`, *and* list claude-profile and codex
  `user-config`/`workspace` modes as alternatives. Skill stays
  backend-agnostic per existing skill rule.

### Reviewer round 1 — blocking findings folded in

- **F1**: The "default unchanged" claim from the prior draft was wrong
  for codex profiles **without** `service_tier: 'normal'`. Today those
  profiles honor `~/.codex/config.toml`; defaulting an absent
  `codex_network` to `'isolated'` would silently start ignoring the
  user's codex config for all of them. The default-semantics question is
  promoted to **Open Human Decision #1** with two options and explicit
  consequences. The plan does **not** pre-decide.
- **F2**: A `start_run.codex_network` runtime override is a public MCP
  contract / permission-surface change. `contract.ts:358` currently
  rejects mixing `profile` with direct settings. This is promoted to
  **Open Human Decision #2** with three options.
- **F3**: Round-trip surfaces beyond `WorkerProfileSchema` are now
  explicit implementation tasks: `UpsertWorkerProfileInputSchema`,
  `mcpTools.ts` upsert/list schemas, `workerProfileFromUpsert`,
  `formatValidProfile`, README tool tables/docs, and tests for each.

### Reviewer round 1 — non-blocking suggestions folded in

- **S1**: T6 tightened to a real local `codex exec` smoke for
  `codex_network: 'workspace'` if feasible, and the plan explicitly
  decides whether to emit `--sandbox workspace-write` alongside the
  network override (see C3 note).
- **S2**: Stop calling `--ignore-user-config` "config isolation"
  throughout — the precise effect per `codex exec --help` is "skips
  `$CODEX_HOME/config.toml`". Wording corrected in C1, C3, C7.
- **S3**: New T10 covers `send_followup` inheritance: if the original
  run's `model_settings.codex_network` was set, follow-ups must inherit
  it intentionally (not silently drop).

### Reviewer round 2 — blocking finding folded in

- **B1**: `codex_network` must also be plumbed through the supervisor
  system-prompt formatters or it is invisible to a supervisor at
  launch (before any `list_worker_profiles` MCP call). The supervisor
  system prompts are assembled in `src/opencode/config.ts` and
  `src/claude/config.ts`; they enumerate profile fields and backend
  capability metadata into the prompt text. Adding the field anywhere
  else without updating these formatters means the supervisor cannot
  reason about `codex_network` until it explicitly calls the MCP tool.
  Promoted to a dedicated task (T13 below) covering all five touch
  points (`opencode/config.ts` `:174`, `:238`, `:248`;
  `claude/config.ts` `:204`, `:228`) plus harness tests so the
  system-prompt mirror stays in sync.

### Reviewer round 2 — non-blocking polish folded in

- **P1 — T6 is manual/live, not part of `pnpm verify`.** The T6 smoke
  is recorded in the Execution Log and run by the implementer against a
  local codex CLI before merge; it is **not** added to `pnpm verify` or
  CI. Use `gh api /zen` (the documented zen endpoint, no host prefix
  — `gh api` parses bare paths via the configured GitHub host).
- **P2 — C3 wording corrected.** Dropped any phrasing that implied
  "preserves user sandbox customization" for `'workspace'` mode. Both
  `'isolated'` and `'workspace'` pass `--ignore-user-config`, so neither
  preserves user customization in `$CODEX_HOME/config.toml`. The reason
  to *not* splice `--sandbox workspace-write` is operational only:
  codex's default sandbox already allows workspace writes, so adding
  the explicit flag is unnecessary noise on the verified codex versions.
  Updated in C3 below.
- **P3 — OD3 folded under OD1 Option A as a sub-decision.** OD3 is no
  longer a top-level Open Human Decision; it lives under OD1 as
  "Option A sub-decision: emit a deprecation hint for legacy
  `service_tier: 'normal'` callers". OD3 numbering is dropped to avoid
  ambiguity. Final top-level human decisions are exactly OD1 (with one
  sub-question) and OD2.
- **P4 — OD2 Option B requires `contract.ts:358` superRefine update.**
  Even Option B (direct-mode-only override) needs to add `codex_network`
  to the existing profile-mode rejection list in `StartRunInputSchema`'s
  `superRefine`, so that `profile + codex_network` is rejected
  schema-side, matching how `model`/`reasoning_effort`/`service_tier`
  are rejected. T9 is updated to be explicit about this; the plan no
  longer implies any OD2 option ships without a `contract.ts:358` edit.
- **P5 — Inverse-bug regression test.** A regression case for
  `codex_network: 'user-config'` together with `service_tier: 'normal'`
  is added to T2 / T9 acceptance: the resulting argv must **not**
  contain `--ignore-user-config`. This is the inverse of the original
  bug and the most important regression to pin: it proves the
  decoupling actually decoupled.
- **P6 — Observability consistency.** `RunModelSettingsSchema` is the
  single source for `ObservabilityRunSettingsSchema`
  (`contract.ts:543-544`), so adding `codex_network` there flows
  through to observability automatically. T5 is tightened to also
  include `codex_network` in `uniqueSettings`
  (`src/observability.ts:374`) and to add a snapshot-dedupe test where
  two otherwise-identical runs differ only by `codex_network` and
  appear as two distinct entries.

### What the issue lists as possible directions

1. Pre-fetch external data in the supervisor; pass to the worker via
   prompt/file. (No sandbox change.)
2. Allow profiles to opt out of `--ignore-user-config`. (Loses
   determinism.)
3. Surface a network allowlist override (e.g. via codex `-c
   sandbox_workspace_write.network_access=true` or per-domain
   allowances).
4. Document the limitation; tell users to switch network-dependent
   reviewers to a claude profile or pre-fetch.

The plan combines (1)+(3)+(4); direction (2) is contained inside the
richer `codex_network` knob. The plan does **not** flip default network
egress — that requires explicit approval on OD1.

## Confirmed Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| C1 | Decouple "ignore `$CODEX_HOME/config.toml`" from `service_tier` | Stop deriving the codex backend's "skip user config" behavior solely from `service_tier === 'normal'`. The codex backend will pass `--ignore-user-config` based on an **explicit `codex_network` knob** (see C2), not as a side effect of `service_tier`. The internal `mode: 'normal'` value is retained on `RunModelSettings` for back-compat with stored runs and observability aggregation, but it is **derived from the resolved `codex_network`** rather than from `service_tier`. The exact resolution rule for "no `codex_network` field set on the profile or run" is gated on **OD1** and explicitly *not* decided in this plan. | The current coupling is a security/UX foot-gun: a user changing tiers cannot predict whether their codex config (and therefore network policy) is honored. Decoupling is a prerequisite for any per-profile fix. Per `codex exec --help` on codex-cli 0.128.0, `--ignore-user-config` *specifically* "skips `$CODEX_HOME/config.toml`" — wording in this plan reflects that. | (a) Leave the coupling and only document it — foot-gun stays; users still surprised. (b) Drop `--ignore-user-config` entirely — loses the deterministic posture some profiles rely on; flagged as HA1. |
| C2 | Add an explicit, opt-in profile field for codex sandbox posture | Extend `WorkerProfileSchema` (`src/harness/capabilities.ts`) with a new optional, **codex-only** field `codex_network` accepting three values: `'isolated'` (passes `--ignore-user-config`; codex skips `$CODEX_HOME/config.toml`; bash sandbox network is closed by codex defaults), `'workspace'` (passes `--ignore-user-config` *and* `-c sandbox_workspace_write.network_access=true`; codex skips user config but bash network is granted), `'user-config'` (omits `--ignore-user-config`; codex reads `$CODEX_HOME/config.toml` and honors whatever sandbox/network policy lives there). The field is rejected for non-codex backends with a clear validation error mirroring `validateCursorProfile`. **The default value when the field is absent is gated on OD1.** | The issue calls for "profile opt-out of `--ignore-user-config`" and/or a network allowlist override; both are profile-scoped concepts that fit a single explicit field. A domain-named field (`codex_network`) makes the security surface visible at the manifest level. | (a) Two separate fields (`respect_user_config: bool`, `network: 'open' \| 'closed'`) — overlapping with invalid combos. (b) A single boolean — does not express "I want network without skipping user config". (c) Per-domain allowlist now — RQ1 deferred. |
| C3 | Mapping from `codex_network` to `codex exec` argv | Replace `userConfigArgs(modelSettings)` with `sandboxArgs(modelSettings)`: `'isolated'` ⇒ `['--ignore-user-config']`; `'workspace'` ⇒ `['--ignore-user-config', '-c', 'sandbox_workspace_write.network_access=true']`; `'user-config'` ⇒ `[]`. We **do not** add `--sandbox workspace-write` to the argv. Note (per P2, reviewer round 2): both `'isolated'` and `'workspace'` already pass `--ignore-user-config`, so neither mode preserves the user's `$CODEX_HOME/config.toml` customization — that wording was incorrect in an earlier draft. The reason to omit `--sandbox workspace-write` is purely operational: codex 0.128.0's default sandbox under `--ignore-user-config` already allows workspace writes, so the explicit flag is unnecessary noise. T6 confirms a representative `gh api /zen` call succeeds end-to-end under `'workspace'` on the version under release; if a future codex version changes that default, T6 will catch it and we add the explicit `--sandbox` flag at that point. | Each value is a concrete point on the isolation/utility curve. Encoding all three through the same helper keeps the codex argv builder small and testable. The `-c sandbox_workspace_write.network_access=true` key is verified on codex-cli 0.128.0 (RQ2). | (a) Always splice `--sandbox workspace-write` — unnecessary on 0.128.0 per smoke results. (b) Build the argv inside `orchestratorService` instead of the backend — leaks codex specifics. |
| C4 | Default behavior for codex profiles **(LOCKED 2026-05-05 — OD1 = B)** | When a profile/run does **not** explicitly set `codex_network`, the effective value is `'isolated'` for **every** codex profile, regardless of `service_tier`. This is uniform, deterministic, and closes the foot-gun across the board. **Breaking change for users with `service_tier ∈ {'fast','flex',unset}` who relied on `~/.codex/config.toml` for network access** — they must opt into `codex_network: 'user-config'` (or `'workspace'`) on upgrade. Mitigation is bundled (release notes, migration doc, first-run warning per C12). HA1 closes. | Locked by human decision 2026-05-05. Uniform `'isolated'` is the long-term posture (closed-by-default); the project chose to ship it now rather than via a deprecation cycle, accepting the breaking-change cost in exchange for not carrying the legacy `service_tier`-driven foot-gun forward. | **Alternatives considered (see prior plan revision for full options)**: Option A (legacy-compatible default) — rejected as it would carry the foot-gun forward indefinitely. Default `'workspace'` — never on the table; flips network egress on by default. |
| C5 | Direct `start_run` and `send_followup` overrides **(LOCKED 2026-05-05 — OD2 = B)** | `StartRunInputSchema` and `SendFollowupInputSchema` accept `codex_network` **only when `backend` is set directly** (direct mode). Profile mode rejects the field as `INVALID_INPUT`. `StartRunInputSchema.superRefine` (`contract.ts:358`) is extended to add `codex_network` to the existing profile-mode rejection list, mirroring the carve-out for `model`/`reasoning_effort`/`service_tier`. Same treatment applies to `send_followup`. README MCP-tool tables updated. HA3 closes (Option C deferred to a future release). | Locked by human decision 2026-05-05. Smallest correct schema change beyond the rejection-list addition; preserves the existing "profile is closed; direct mode is open" contract shape. | **Alternatives considered (see prior plan revision for full options)**: Option A (defer override entirely) — rejected as it forces users to edit manifests for one-off network-aware runs. Option C (profile-mode override too) — rejected for this PR; widest IPC surface, can revisit later if direct-mode proves too clumsy. |
| C12 | First-run / per-run warning surface for the new default | When a codex worker run starts and the resolved `codex_network` came from the **C4 default** (i.e. the profile/run did not set it explicitly), the daemon emits a **non-blocking** warning into the worker's invocation log: `agent-orchestrator codex_network not set on profile <id>; defaulting to 'isolated' (no network access). Set codex_network explicitly to silence this warning. See docs/development/codex-backend.md for migration.` Warning is per-run, never an error, never blocks the run. The warning is **not** placed in the supervisor system prompt (which would be intrusive and load on every supervisor launch); it is in the worker's daemon-side log so users see it at the moment of impact. | OD1 = B is breaking; users who upgrade without reading release notes will hit "gh api fails" failures. A run-time warning surfaces at the moment of impact, in the daemon log alongside the failing tool calls, so users can correlate. Non-blocking + per-run keeps the noise narrowly targeted (only profiles that did not migrate, only when actually used). | (a) Supervisor-prompt warning — too noisy; loads on every supervisor launch regardless of which profiles run. (b) Profile-load warning — fires once per daemon startup; users running an unrelated profile see it. (c) No warning — leaves users to discover the breaking change via failing CI. (d) Hard error — rejected; OD1 explicitly says default is `'isolated'`, not "reject unless set". |
| C6 | Pre-fetch pattern documented as the recommended default in `orchestrate-resolve-pr-comments` | Update `.agents/skills/orchestrate-resolve-pr-comments/SKILL.md` (regenerate `.claude/skills/...` via `node scripts/sync-ai-workspace.mjs`) to document a pre-fetch step (supervisor runs `gh api ...` and writes JSON to a temp file under run cwd, then passes the path to the reviewer). The skill also lists the three alternatives — switch to a claude profile, set `codex_network: 'workspace'` on a review-only profile, or set `codex_network: 'user-config'` for advanced users — and stays backend-agnostic per the existing skill rule. | RQ6: pre-fetch is the safest default and works regardless of backend; the alternatives are valid but introduce a wider sandbox surface or rely on user codex config. The user is expected to choose. | (a) Recommend `'workspace'` as the default for the reviewer profile — silently widens network egress; HA1. (b) Recommend claude-only — dismisses the user's stated codex/gpt-5.5/xhigh combination. |
| C7 | Documentation deliverable | New `docs/development/codex-backend.md` covering: codex argv assembled by the daemon; `codex_network` profile field with each value's argv, **precise** description (use the `codex exec --help` wording: `--ignore-user-config` "skips `$CODEX_HOME/config.toml`"), security implications, and recommended use; the `start_run`/`send_followup` override per OD2; the relationship to `~/.codex/config.toml`; and an explicit "default codex network egress is closed; you must opt in" callout (or, if OD1 picks Option A, "default mirrors today's `service_tier`-driven behavior"). README's profile section gains a one-paragraph link in the same place where it documents `backend: codex`. README MCP-tool tables for `upsert_worker_profile` / `list_worker_profiles` / `start_run` / `send_followup` updated to advertise `codex_network`. | Documentation is required regardless of code changes (issue direction 4) and the wording must match codex's own help text to avoid drift. | Docs-only without code changes — leaves the foot-gun in place. |
| C8 | Tests | Argv tests for each `codex_network` value (including the "old-style `mode: 'normal'`" regression case); profile-validation tests (codex-only acceptance, claude/cursor rejection); MCP round-trip tests for upsert/list (creation, listing, validation, observe-after-restart); integration tests for run-time precedence per OD2; capability-catalog test for the new field; observability test asserting `codex_network` aggregates correctly through the existing `mode` aggregation key (RQ5); follow-up inheritance test (S3). All tests reference issue #31 in their description so future regressions are loud. | Covers schema, wire, contract, observability, and skill-affecting surfaces. The "old-style `mode: 'normal'`" regression case prevents the inverse foot-gun (a future change silently drops `--ignore-user-config` from the legacy path). | Unit-only or end-to-end-only — neither catches the orchestrator-to-backend wiring on its own. |
| C9 | Out-of-scope guardrails | This plan does **not**: (i) flip the default codex network posture (OD1 owns that); (ii) introduce a per-domain allowlist (deferred to RQ1/HA2); (iii) auto-restart the daemon; (iv) change claude or cursor backends; (v) change the meaning of `service_tier` beyond decoupling it from `--ignore-user-config`; (vi) introduce a new dependency; (vii) modify any non-codex MCP/contract surface beyond the additive `codex_network` field on `WorkerProfile`, `RunModelSettings`, `UpsertWorkerProfileInput`, `StartRunInput` (per OD2), and `SendFollowupInput` (per OD2); (viii) repair any user profile manifest on disk. | Keeps scope tight; respects `node-typescript.md` ("ask before installing packages") and `AGENTS.md` ("ask before changing release, secret, hook, or external-service behavior"). | Bundling any of the above — blast-radius creep. |

## Assumptions

| # | Assumption | Why it's load-bearing | How we'll find out it's wrong |
|---|---|---|---|
| A1 | Codex CLI 0.128.0 (and the next minor) accept `-c sandbox_workspace_write.network_access=true` and the `--ignore-user-config` semantics described in C1. | The entire `'workspace'` branch of C3, and the C1 wording, depend on this. | Confirmed by the reviewer for 0.128.0 (RQ2). T6 smokes the literal flag at release time. |
| A2 | The `pr-comment-reviewer` profile that triggered the failure has `service_tier: 'normal'`. | Validates the trigger chain (mode='normal' → --ignore-user-config). | Confirmed by the reviewer (RQ3). |
| A3 | The supervisor process can call `gh api ...` itself (bash and credentials available) so C6's pre-fetch step is implementable in the skill. | Pre-fetch is the recommended default. | Quick check of `src/opencode/launcher.ts` and `src/claude/launcher.ts` allow-lists during T8. If supervisor cannot run `gh`, the skill change still ships but the "alternative: claude profile" path becomes the recommended one. |
| A4 | `runStore.ts:174` and `observability.ts:378` continue to round-trip `model_settings` opaquely (no exhaustive enum check on the field set). | RQ5 says yes — persist `codex_network` here. | Verified by reading those lines: `RunMeta.model_settings` is stored verbatim; the aggregation key just concatenates `reasoning_effort:service_tier:mode`. Adding `codex_network` to the aggregation key (T5) is a compatible additive change. |

## Reviewer Questions

`none` — all six prior reviewer questions answered in round 1. Any new
questions raised by reviewer round 2 will be appended here in subsequent
revisions.

## Open Human Decisions

`none` — both decisions locked 2026-05-05 (see C4, C5, C12). The
original option enumerations are preserved below as **Alternatives
Considered** for posterity; they are no longer live decisions.

## Alternatives Considered (historical)

The two original Open Human Decisions and their option matrices are
retained below for posterity. The locked outcomes are recorded in
**Confirmed Decisions** above (C4, C5, C12).

### OD1 (locked = B) — Default semantics for codex profiles that do **not** set `codex_network`

**Why this needs a human decision.** Today, only profiles with
`service_tier: 'normal'` trigger `--ignore-user-config`. Profiles with
`fast`, `flex`, or no `service_tier` honor `~/.codex/config.toml` —
including any user-configured network allowlist. When `codex_network`
is added as the new explicit driver, the value resolved when the field
is absent decides whether existing users see a behavior change.

**Option A (recommended) — legacy-compatible default per existing
`mode`/`service_tier` mapping.**

- **Behavior.** When the profile's `codex_network` is absent and the
  resolved `mode` would be `'normal'` (i.e. user set
  `service_tier: 'normal'`), the effective value is `'isolated'`. When
  `mode` would be anything else, the effective value is `'user-config'`.
  The new `codex_network` field, when set, always wins over the
  `mode`-derived value.
- **Pros.** No user-visible behavior change on upgrade. Every existing
  manifest produces the same argv as today. Migration is opt-in.
- **Cons.** Per-profile security posture continues to be encoded
  through `service_tier`, which is unrelated to network. The foot-gun
  is documented (C7) but not removed for legacy callers — it survives
  for any manifest that does not yet set `codex_network`.
- **Default codex network egress posture: not changed.** Closed for
  `service_tier: 'normal'`; open (subject to `~/.codex/config.toml`)
  for everything else, exactly as today.

**Option B — default all codex profiles to `'isolated'`.**

- **Behavior.** When the profile's `codex_network` is absent, the
  effective value is `'isolated'` regardless of `service_tier`.
  Profiles that previously honored `~/.codex/config.toml` (anything
  with `service_tier ∉ {'normal'}`) now skip it and use codex's default
  (closed network) sandbox.
- **Pros.** Uniform, deterministic default. Closes the foot-gun
  uniformly: nobody is "implicitly trusting their codex config" by
  accident. Simpler mental model.
- **Cons.** **User-visible behavior change.** Any existing user whose
  codex config grants network access via `~/.codex/config.toml` (the
  most common workaround for the issue today) will lose that access on
  upgrade unless they migrate to `codex_network: 'user-config'` or
  `'workspace'`. Requires migration steps in release notes and likely a
  CHANGELOG note flagged as **breaking**.
- **Default codex network egress posture: tightened.** Closed for all
  profiles unless they explicitly opt into `'workspace'` or
  `'user-config'`.

**Recommendation.** **Option A** for this PR. It satisfies the issue's
primary fix (decoupling, explicit field, documented opt-in) without a
breaking-change to manifest semantics, and leaves Option B available as
a follow-up release with a deprecation cycle. Option B is the right
long-term posture if the project wants closed-by-default uniformly, but
should ship behind a deprecation window, not in this PR.

**OD1 Option A sub-decision — deprecation hint** *(only relevant if OD1
= Option A; folded under OD1 per P3, reviewer round 2)*

Should profile validation emit a non-blocking hint when a profile sets
`service_tier: 'normal'` without an explicit `codex_network`,
recommending the user set `codex_network` explicitly to make the
posture stable across upgrades?

- **Sub-option Yes (recommended).** `inspectWorkerProfiles` (or
  `formatValidProfile`) emits a non-blocking hint string in the
  validated profile output. Hint string verified by tests. Helps users
  migrate to explicit `codex_network` without surprise if a future
  release adopts OD1 Option B. Hint-only; never an error; never blocks
  a run.
- **Sub-option No.** Skip the hint. Smaller surface; users have to
  read the docs to know `service_tier: 'normal'` implicitly maps to
  `'isolated'`.

**Sub-recommendation.** Yes — non-blocking hint only. Implementation
gated by this sub-decision is T11.

### OD2 (locked = B) — Runtime override surface (`start_run` / `send_followup`)

**Why this needs a human decision.** `contract.ts:358` currently
rejects mixing `profile` with direct settings, so adding a
`codex_network` runtime override expands the public MCP contract.
Permission-surface change.

**Option A — defer override; profile-only.**

- **Behavior.** `codex_network` lives only on profiles. To change it
  for a single run, edit the manifest (or define a second profile).
  `start_run.codex_network` is rejected as `INVALID_INPUT`.
- **Pros.** Smallest surface. Profile is the only place a network
  posture is declared. No new IPC argument that grants network egress.
- **Cons.** Iteration friction: a one-off "let this reviewer fetch
  PR threads once" requires editing a profile or defining a sibling
  one.

**Option B (recommended) — direct-mode override only.**

- **Behavior.** `start_run.codex_network` is accepted **only when
  `backend` is set directly** (direct mode). Profile mode rejects the
  field as `INVALID_INPUT` exactly as it does today for `model`,
  `reasoning_effort`, `service_tier`. `send_followup.codex_network`
  follows the same rule for direct-mode runs.
- **`contract.ts:358` change required (per P4, reviewer round 2).**
  Even Option B requires adding `codex_network` to the existing
  profile-mode rejection list in `StartRunInputSchema.superRefine`, so
  that `profile + codex_network` is rejected schema-side, matching how
  `model`/`reasoning_effort`/`service_tier` are handled today. This
  edit is the **minimum** schema change for any OD2 option that admits
  the field at all; only OD2 Option A avoids the edit (because the
  field is rejected wholesale, not conditionally). T9 covers this.
- **Pros.** Fits the existing "profile is closed; direct mode is open"
  contract shape. Smallest schema change beyond the rejection-list
  addition. A user who needs a one-off run can use direct mode.
- **Cons.** Profiles still cannot be temporarily overridden for a
  single run. Many users prefer profile mode for everything — they
  would have to switch invocation styles for the one-off.

**Option C — profile-mode override too (broadest surface).**

- **Behavior.** `start_run.codex_network` is accepted in both direct
  and profile modes. When in profile mode, it overrides the profile's
  resolved value for this run only; `model`/`reasoning_effort`/
  `service_tier` continue to be rejected. `send_followup.codex_network`
  follows. The `contract.ts:358` superRefine carve-out documents the
  new exception.
- **Pros.** Maximum ergonomics for the common ask ("this one reviewer
  pass needs network"). No manifest churn.
- **Cons.** Widest IPC surface; any caller that can reach the daemon's
  IPC socket can request network egress for a run. Even though the IPC
  is local-only today, this is a permission surface and should be
  signed off explicitly. May warrant a supervisor-only gate
  (per-caller authorization), which is its own design surface.

**Recommendation.** **Option B** for this PR. It avoids a contract
exception to `contract.ts:358`, keeps the surface tightly scoped, and
still gives users a runtime override path for the cases the issue
calls out — pre-fetch first, but if pre-fetch is insufficient, a
direct-mode invocation with `codex_network: 'workspace'` is available.
Option C remains a clean follow-up if user feedback shows direct mode
is too clumsy for one-off overrides.

*OD3 was folded into OD1 as a sub-decision in reviewer round 2 (P3).
The final top-level human decisions are exactly OD1 (with one
sub-question) and OD2.*

## Risks

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| R1 | `-c sandbox_workspace_write.network_access=true` is rejected/ignored on a future codex CLI version, so `'workspace'` ships broken. | A1/RQ2 verification on 0.128.0 (done). T6 smokes the literal flag at release time. If it ever fails on a supported version, surface a `BackendDiagnostic` warning rather than a silent failure. | T2, T6 |
| R2 | A future maintainer re-couples `service_tier: 'normal'` to argv-shaping logic. | Test in `backendInvocation.test.ts` asserts that `service_tier: 'normal'` alone (no `codex_network` field) under the locked OD1 = B default produces argv that resolves through `codex_network: 'isolated'` (so `--ignore-user-config` is present, but for the *new* reason). Inverse-bug regression test (P5) pins the decoupling: `codex_network: 'user-config'` + `service_tier: 'normal'` ⇒ no `--ignore-user-config`. Both tests reference issue #31. | T1, T2, T6 |
| R3 | A user opts a profile into `'workspace'` for the reviewer use-case but the same profile also runs implementation tasks, which then get untrusted network egress. | Documentation in `docs/development/codex-backend.md` explicitly recommends a *narrow* opt-in (per-profile, ideally for read-only review profiles only). Pre-fetch (C6) is presented as the safer default. | T7 |
| R4 | Profile schema gains `codex_network`; existing JSON manifest readers in the wild (other tools, hand-written scripts) error on the unknown field. | The schema is `.strict()`, but only the orchestrator reads it. README profile sample updated. | T5, T7 |
| R5 | `'user-config'` introduces non-determinism across users. | Opt-in. Documentation explicitly states bug reports should reproduce on `'isolated'` first. | T7 |
| R6 | Skill changes (C6) regenerate `.claude/skills/...`; user has uncommitted skill edits. | Run `node scripts/sync-ai-workspace.mjs` only; surface drift via `--check`. | T8 |
| R7 | **Realized (locked):** OD1 = B ships in this PR without a deprecation cycle, breaking workflows for users who relied on `~/.codex/config.toml` network access via `service_tier ∈ {'fast','flex',unset}`. | Mitigation bundle: (a) release notes flagged `BREAKING` with the full migration table (T12); (b) `docs/development/codex-backend.md` migration section (T7); (c) per-run non-blocking warning in the worker invocation log when `codex_network` defaults (C12, T11); (d) first-run warning visible in daemon log on the next codex worker start after upgrade. Approved 2026-05-05 by the human. | C4, C12, T7, T11, T12 |
| R8 | `send_followup` on a direct-mode `'workspace'` run silently drops `codex_network` and the follow-up turns out to need network too. | T10 covers inheritance: `send_followup` reads `model_settings.codex_network` from the originating run and applies it unless the caller's argument (per OD2 = B) overrides. Test asserts inheritance. | T10 |
| R9 | Observability key collisions when the same `(reasoning_effort, service_tier, mode)` triple now spans two `codex_network` values. | T5 extends the aggregation key and `uniqueSettings` dedup to include `codex_network` (additive). | T5 |
| R10 | Users upgrade without reading release notes; their `gh api`-using codex workflows fail at first use after upgrade. | Mitigated by the same bundle as R7. The per-run warning (C12) is the most direct mitigation: it surfaces at the moment of impact, in the daemon log alongside the failing tool calls, with the migration URL. CI fixtures or workflows that depend on the legacy posture must be updated **before** consuming the upgrade — flagged in the release notes and called out as a quality gate (see Quality Gates). | C12, T7, T11, T12 |
| R11 | Existing project test fixtures or CI tests that rely on the legacy posture produce post-upgrade false negatives. | Inventory pass during T1: `src/__tests__/integration/orchestrator.test.ts:133` (uses `service_tier: 'normal'`), `src/__tests__/backendInvocation.test.ts:43` (uses `mode: 'normal'`), `src/__tests__/integration/orchestrator.test.ts:149` (asserts `mode: 'normal'`). Each must be updated to drive the new resolution path under OD1 = B and to pin both directions (`codex_network` set ⇒ argv per C3; `codex_network` unset ⇒ default `'isolated'` ⇒ `--ignore-user-config`). | T1, T2 |

## Human Approval Triggers

| # | Trigger | Status | Why |
|---|---|---|---|
| HA1 | Default-posture change (OD1 = B). | **Closed 2026-05-05 — approved.** | Default-on or default-off network egress is a security/permission surface change. Approved as part of the locked OD1 = B decision, with the mitigation bundle in C4/C12 (release notes, migration doc, per-run warning). |
| HA2 | Adding a per-domain allowlist value to `codex_network` (RQ1). | Open (out of scope this PR). | Per-domain allowlists are a richer permission model and need explicit shape sign-off. |
| HA3 | OD2 Option C (profile-mode runtime override). | **Closed 2026-05-05 — not adopted.** OD2 = B locked instead. Option C remains a future-options entry. | Widest IPC surface; was flagged for explicit sign-off. Skipped for this PR. |
| HA4 | Auto-restarting the daemon on profile change. | Open (out of scope this PR). | Flagged to prevent "while you're at it". |
| HA5 | Removing or repurposing `service_tier: 'normal'` for codex (e.g. dropping it from `ServiceTierSchema`). | Open (out of scope this PR). | Manifest-contract break for a value users likely have set. C1 keeps it accepted; any removal is a separate breaking-change call. |
| ~~HA6~~ | ~~OD1 Option A's deprecation-hint sub-decision.~~ | **Closed 2026-05-05 — N/A.** OD1 = B was chosen; the sub-decision only existed under Option A. Removed from scope. T11 is repurposed (see Implementation Tasks). | — |

## Behavior Change Summary

**OD1 = B is locked.** The default codex network egress posture is
**tightened uniformly to `'isolated'`** for every codex profile that
does not set `codex_network` explicitly. This is a **breaking change**
for a well-defined slice of users; the table below specifies exactly
who is affected and what they need to do.

| Existing codex profile | `service_tier` today | Today's argv | Tomorrow's argv (no manifest change) | User-visible change? | Required action |
|---|---|---|---|---|---|
| `pr-comment-reviewer` (the user's reproducer) | `'normal'` | includes `--ignore-user-config` | includes `--ignore-user-config` (still resolves to `'isolated'`) | No | None — same posture; pre-fetch pattern (C6) recommended for fetching PR data |
| Any codex profile | `'fast'` | no `--ignore-user-config`; honors `~/.codex/config.toml` | **includes `--ignore-user-config`** | **Yes — user codex config is no longer honored on this profile by default** | Set `codex_network: 'user-config'` to restore prior behavior, **or** `'workspace'` for codex-managed network-on, **or** `'isolated'` to keep closed |
| Any codex profile | `'flex'` | no `--ignore-user-config`; honors `~/.codex/config.toml` | **includes `--ignore-user-config`** | **Yes — same as above** | Same as above |
| Any codex profile | unset | no `--ignore-user-config`; honors `~/.codex/config.toml` | **includes `--ignore-user-config`** | **Yes — same as above** | Same as above |
| Any codex profile that explicitly sets `codex_network` | n/a | n/a | per C3 mapping | No surprise — the explicit value wins over the default | None |

### Who is affected

Concretely, any codex worker profile in
`~/.config/agent-orchestrator/profiles.json` that:

1. Has `backend: 'codex'`, **and**
2. Has `service_tier` set to `'fast'` or `'flex'`, **or** has no
   `service_tier` set, **and**
3. Relies on `~/.codex/config.toml` for network access (the most common
   shape today is
   `[sandbox_workspace_write]\nnetwork_access = true`),
4. Does not yet set `codex_network`.

These profiles will, on upgrade, start passing `--ignore-user-config`
to `codex exec`, so codex stops reading `~/.codex/config.toml`, so the
user's network allowlist is no longer applied, so bash tools inside
the worker that rely on outbound HTTP (e.g. `gh api`, `curl`, `npm
install` from a private registry) will fail.

### Migration

Three concrete options, in increasing security cost:

1. **`codex_network: 'user-config'`** — keep today's behavior verbatim
   for the affected profile. The codex CLI continues to read
   `~/.codex/config.toml`. This is the closest to a no-op migration
   and is the recommended default for users who relied on the legacy
   posture.
2. **`codex_network: 'workspace'`** — use the codex CLI's own network
   override (`-c sandbox_workspace_write.network_access=true`) without
   reading `~/.codex/config.toml`. Network is on; sandbox is
   deterministic across machines.
3. **`codex_network: 'isolated'`** (the new default) — keep network
   closed. Recommended for review-only or implementation profiles that
   do not need outbound HTTP; combine with the supervisor-side
   pre-fetch pattern (C6) for skills that need to fetch external
   data.

### How users will discover the change

Three layers, in order of likely visibility:

1. **Release notes**, called out as `BREAKING` with the migration
   table above (T12).
2. **`docs/development/codex-backend.md` migration section**, linked
   from the README's profile section (T7).
3. **First-run / per-run warning** (C12, T11): when a codex worker run
   starts and `codex_network` was not set explicitly on the profile or
   run, the daemon emits a non-blocking warning into the worker's
   invocation log naming the profile, the resolved value
   (`'isolated'`), and the migration doc URL. Per-run, never blocks.

### Default codex network egress posture

**Tightened by this PR.** Closed for all codex profiles that do not
opt in. Approved by the human on 2026-05-05 (OD1 = B). No prior
posture is preserved on upgrade.

## Scope

### In Scope

- `src/contract.ts`:
  - Add optional `codex_network` to `RunModelSettingsSchema`.
  - Add optional `codex_network` to `UpsertWorkerProfileInputSchema`.
  - Add optional `codex_network` to `StartRunInputSchema` and
    `SendFollowupInputSchema` per OD2.
- `src/harness/capabilities.ts`:
  - `WorkerProfileSchema` gains `codex_network`.
  - `validateBackendSpecificProfile` rejects `codex_network` for
    non-codex backends.
  - Codex `WorkerBackendCapability` advertises supported values
    (`network_modes: ['isolated','workspace','user-config']`) so
    `list_worker_profiles` consumers can render selectors.
- `src/orchestratorService.ts`:
  - `modelSettingsForBackend` (codex branch): resolve `codex_network`
    via OD1 (default behavior) and set `mode` accordingly.
  - `workerProfileFromUpsert`: copy `codex_network` through.
  - `formatValidProfile`: include `codex_network` in the JSON output.
  - `start_run` / `send_followup` accept the new argument per OD2.
- `src/backend/codex.ts`: `sandboxArgs` per C3; spliced into `start`
  and `resume`.
- `src/mcpTools.ts`: upsert/list/start/send-followup tool input
  schemas advertise `codex_network` (additive, optional).
- `src/runStore.ts`: defaults block for `model_settings` extended with
  `codex_network: null` so legacy run records remain readable.
- `src/observability.ts:374-378`: aggregation key and `uniqueSettings`
  dedup extended with `codex_network` (additive, ordered last for
  stable ordering). `ObservabilityRunSettingsSchema` inherits the new
  field automatically because it aliases `RunModelSettingsSchema`
  (`contract.ts:543-544`).
- Supervisor system-prompt formatters (per **B1**, T13 below):
  - `src/opencode/config.ts:174` — profile-field listing line.
  - `src/opencode/config.ts:229-246` (`formatProfiles`) — render
    `codex_network` when present.
  - `src/opencode/config.ts:248-255` (`formatCatalog`) — emit
    `network_modes=...` for backends whose capability advertises
    them (codex only in this PR).
  - `src/claude/config.ts:197-214` (`formatProfiles`) — same.
  - `src/claude/config.ts:228-235` (`formatCatalog`) — same.
- Tests:
  - `src/__tests__/backendInvocation.test.ts` — argv per value, plus
    legacy regression case for `mode: 'normal'`.
  - Profile-validation tests in `src/__tests__/`.
  - Capability-catalog test (codex has `network_modes`; claude/cursor
    do not).
  - MCP round-trip tests (upsert + list + restart).
  - Integration test for OD2 precedence (run-time arg vs profile under
    the OD2 option chosen).
  - Observability test for the new aggregation key.
  - Follow-up inheritance test (S3/T10).
  - Harness system-prompt formatter tests (per B1/T13): given a
    profile with `codex_network` set, both opencode and claude
    `formatProfiles` outputs include the field; given a catalog where
    codex advertises `network_modes`, both `formatCatalog` outputs
    include the line; absent fields render the same as today (no
    regression).
  - Inverse-bug regression test (per P5): the run with
    `codex_network: 'user-config'` and `service_tier: 'normal'`
    produces argv that does **not** contain `--ignore-user-config`.
- `docs/development/codex-backend.md` per C7; README profile-section
  paragraph and MCP-tool tables updated.
- `.agents/skills/orchestrate-resolve-pr-comments/SKILL.md` updated;
  `.claude/skills/...` regenerated via
  `node scripts/sync-ai-workspace.mjs`.
- `pnpm verify` passes.

### Out Of Scope

- Per-domain allowlist (RQ1, HA2).
- Profile-mode runtime override / OD2 Option C (HA3).
- Daemon auto-restart on profile change (HA4).
- Removing or repurposing `service_tier: 'normal'` (HA5).
- Claude/Cursor sandbox parity.
- Daemon-side reading or writing of `~/.codex/config.toml`.
- Repairing the user's `profiles.json` automatically.
- Supervisor-only IPC gate for a future profile-mode override (HA3 follow-up).

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T1 | Decouple `mode` derivation from `service_tier` in `modelSettingsForBackend` (codex branch); update legacy fixtures (R11) | none | done | Codex branch resolves `codex_network` per **C4 (OD1 = B locked)**: explicit profile/run value first, default `'isolated'` for everything else. `mode` is derived from `codex_network`, not from `service_tier` directly. Legacy test fixtures called out in R11 are updated to drive the new resolution path: `src/__tests__/integration/orchestrator.test.ts:133`, `src/__tests__/integration/orchestrator.test.ts:149`, `src/__tests__/backendInvocation.test.ts:43`. Test descriptions reference issue #31. |
| T2 | Add `codex_network` to `RunModelSettings` and the codex backend argv builder | T1 | done | `RunModelSettingsSchema` has the optional field; `src/runStore.ts:174` defaults block is extended; `src/backend/codex.ts` `sandboxArgs` returns the documented argv per C3; new tests assert each value's exact argv shape, including the literal `-c sandbox_workspace_write.network_access=true` for `'workspace'` and the explicit *absence* of `--sandbox workspace-write` (per C3). **Inverse-bug regression case (per P5):** a run with `codex_network: 'user-config'` *and* `service_tier: 'normal'` produces argv that does **not** contain `--ignore-user-config`. Test name references issue #31 explicitly. |
| T3 | Add `codex_network` to `WorkerProfileSchema`; validate codex-only; expose on capability | T2 | done | `WorkerProfileSchema` accepts `codex_network` only on codex; rejection error for claude/cursor matches `validateCursorProfile` style; codex `WorkerBackendCapability.network_modes` lists the three values; capability-catalog test passes. |
| T4 | Round-trip `codex_network` through MCP profile management | T3 | done | `UpsertWorkerProfileInputSchema` gains the optional field; `mcpTools.ts` upsert and list schemas advertise it; `workerProfileFromUpsert` copies it; `formatValidProfile` returns it; round-trip tests cover create→list→read-after-restart and validation errors for unsupported backends. |
| T5 | Persist `codex_network` on observability and run-store output | T4 | done | Effective `codex_network` lands in `run_summary.model_settings`; `observability.ts:374-378` aggregation key and `uniqueSettings` dedup both extended with `codex_network` (additive, ordered last); observability snapshot-dedup test (per P6) asserts two runs identical except for `codex_network` produce two distinct rows. `ObservabilityRunSettingsSchema` inheritance from `RunModelSettingsSchema` is preserved. |
| T6 | **Manual/live smoke:** verify codex CLI flag and run a real `codex exec` smoke for `'workspace'` (S1, P1) | T2 | documented; manual run pending | Manual step run by the implementer against a local codex CLI **before merge**. Not part of `pnpm verify`, not part of CI. Procedure: (1) ensure `codex --version` reports the version under release (≥ 0.128.0); (2) start a worker run with `codex_network: 'workspace'` (direct mode under OD2 Option B; manifest under Option A); (3) prompt it to run `gh api /zen` (no host prefix — `gh api` resolves bare paths against the configured GitHub host; using `api.github.com/zen` as a bare URL is parsed oddly by `gh api`); (4) expected exit code 0 and a returned zen sentence. Record the codex version, the exact argv assembled, the prompt, and the worker's stdout/exit in the Execution Log. If the smoke fails on the version under release, mark `'workspace'` as `experimental: true` in the codex capability advertised by `createWorkerCapabilityCatalog` and document under "Future Options". |
| T7 | Add `docs/development/codex-backend.md` (with **breaking-change migration section**) and update README/links | T2, T3, T4 | done | New doc covers C3 mapping, security implications, the C4 default `'isolated'`, the OD2 = B direct-mode override, and uses `codex exec --help` wording for `--ignore-user-config`. **Mandatory migration section** mirroring the Behavior Change Summary table: who is affected, the three migration options (`'user-config'` / `'workspace'` / `'isolated'`), and per-option example manifest snippets. README profile section gains a one-paragraph link prominently labeled `BREAKING (codex)`; README MCP-tool tables (`upsert_worker_profile`, `list_worker_profiles`, `start_run`, `send_followup`) advertise `codex_network`. Doc passes Markdown lint. |
| T8 | Update `orchestrate-resolve-pr-comments` skill (pre-fetch default + alternatives) | none | done | `.agents/skills/orchestrate-resolve-pr-comments/SKILL.md` documents the supervisor-side pre-fetch step and lists the three alternatives (claude profile, codex `'workspace'`, codex `'user-config'`); skill stays backend-agnostic. `.claude/skills/orchestrate-resolve-pr-comments/SKILL.md` regenerated via `node scripts/sync-ai-workspace.mjs`; `node scripts/sync-ai-workspace.mjs --check` reports clean. |
| T9 | Wire `start_run` / `send_followup` runtime override per **C5 (OD2 = B locked)** | T2, T3, T5 | done | `StartRunInputSchema` and `SendFollowupInputSchema` accept `codex_network`. `StartRunInputSchema.superRefine` (`contract.ts:358`) is extended to add `codex_network` to the profile-mode rejection list (so `profile + codex_network` ⇒ `INVALID_INPUT`, matching `model`/`reasoning_effort`/`service_tier`). Same treatment for `send_followup` if the originating run was a profile-mode run. Precedence in `orchestratorService` is run-time arg > profile-derived > C4 default (`'isolated'`) for direct mode only. Integration tests confirm: (a) direct-mode + `codex_network` works at each value; (b) profile-mode + `codex_network` is rejected with `INVALID_INPUT`; (c) **inverse-bug regression (P5)** — direct-mode `codex_network: 'user-config'` with `service_tier: 'normal'` produces argv that does **not** contain `--ignore-user-config`. README MCP-tool tables for `start_run` and `send_followup` updated. |
| T10 | `send_followup` inheritance test (S3/R8) | T9 | done | Without an explicit `codex_network` argument on `send_followup`, the follow-up inherits the originating run's `model_settings.codex_network`. With an explicit argument (per OD2), the follow-up uses the override. Test asserts both. |
| T11 | **(C12)** Per-run non-blocking warning when `codex_network` defaulted | T1, T2 | done | When a codex worker run starts and the resolved `codex_network` came from the C4 default (i.e. neither the profile nor the direct-mode `start_run` argument set it), the daemon emits a single non-blocking warning line into the worker's invocation log: `agent-orchestrator codex_network not set on profile <id> (or direct-mode run); defaulting to 'isolated' (no network access). Set codex_network explicitly to silence this warning. See docs/development/codex-backend.md.` Warning is per-run, never an error, never blocks the run. Test asserts: (a) the warning is emitted exactly once per run when defaulted; (b) the warning is **not** emitted when `codex_network` is set explicitly (profile or direct mode); (c) the warning copy contains the profile id (or "direct-mode run" placeholder) and the migration doc reference. |
| T12 | Final `pnpm verify` and **BREAKING** changelog/release-note section | T1–T11, T13 | done | `pnpm verify` passes. Release notes include a top-level `## BREAKING (codex)` section with: (a) the full Behavior Change Summary table; (b) the three migration options with copy-pastable manifest snippets; (c) a link to `docs/development/codex-backend.md`; (d) the per-run warning copy (so users searching for the warning text find the migration). T6 evidence (codex version, exact argv, `gh api /zen` output) included as a reproducible smoke step. Release notes flag the change in the title (e.g. `BREAKING: codex profiles now default to closed network egress`). |
| T13 | **(B1)** Supervisor system-prompt formatters mirror `codex_network` and the new default | T2, T3 | done | All five touch points updated: (a) `src/opencode/config.ts:174` — profile-fields enumeration line includes `codex_network` and notes the default `'isolated'` for codex profiles that omit it; (b) `src/opencode/config.ts:229-246` (`formatProfiles`) — emits `codex_network=<value>` when explicitly set, and emits `codex_network=isolated (default)` for codex profiles that do not set it (so the supervisor sees the **effective** posture, not just the manifest field); (c) `src/opencode/config.ts:248-255` (`formatCatalog`) — emits a `network_modes=...` line for codex (`isolated, workspace, user-config`); (d) `src/claude/config.ts:197-214` (`formatProfiles`) — same; (e) `src/claude/config.ts:228-235` (`formatCatalog`) — same. Harness tests (one for each `formatProfiles` and one for each `formatCatalog`, in both opencode and claude) pin the rendered string for: (i) explicit value rendered, (ii) **absent value rendered as `isolated (default)` for codex** (the new posture the supervisor must see), (iii) absent value rendered identically to today for non-codex backends (no regression). |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| RC1 | "When introducing a new permission/sandbox/network knob to a worker backend, default to a posture that does not change existing user-visible behavior. Surface any tightening as an Open Human Decision, not a unilateral default." | `.agents/rules/` | After T12, if reviewer agrees the pattern is generalizable. |
| RC2 | "When a user-facing profile field has been overloaded onto an unrelated internal flag (as `service_tier` was overloaded onto `--ignore-user-config`), refactor to an explicit field rather than documenting the overload." | `.agents/rules/` | After T1, if reviewer confirms the foot-gun pattern recurs. |
| RC3 | "Round-trip surfaces for a new profile field must be enumerated in the plan: schema, MCP upsert/list, formatter, observability, README tool tables, and tests for each. Do not add a profile field without the upsert path." | `.agents/rules/` | After T4, captured directly from F3. |

## Quality Gates

- [ ] `pnpm install --frozen-lockfile` passes.
- [ ] `pnpm build` passes.
- [ ] `pnpm test` passes.
- [ ] `pnpm verify` passes.
- [ ] `node scripts/sync-ai-workspace.mjs --check` reports no drift after T8.
- [ ] `src/__tests__/backendInvocation.test.ts` regression case for issue #31 is present and passes.
- [ ] **Inverse-bug regression** (P5): a run with `codex_network: 'user-config'` and `service_tier: 'normal'` produces argv without `--ignore-user-config`, and is named to reference issue #31.
- [ ] Profile-schema tests cover codex-only acceptance and claude/cursor rejection of `codex_network`.
- [ ] MCP round-trip tests cover `upsert_worker_profile` + `list_worker_profiles` for `codex_network`.
- [ ] **Supervisor formatter tests (B1)** cover both opencode and claude `formatProfiles` + `formatCatalog` with and without `codex_network` set.
- [ ] **OD2 = B `superRefine` rejection test** (`profile + codex_network` ⇒ `INVALID_INPUT`) is present and passes.
- [ ] **C12 per-run warning test** (warning emitted exactly once when `codex_network` defaulted; not emitted when set explicitly; copy contains profile id and migration doc reference) is present and passes.
- [ ] Legacy fixtures called out in R11 are updated and pin both directions: `codex_network` set ⇒ argv per C3; `codex_network` unset ⇒ default `'isolated'` ⇒ `--ignore-user-config`.
- [ ] `docs/development/codex-backend.md` uses precise codex `exec --help` wording for `--ignore-user-config` and contains the **migration section** with copy-pastable manifest snippets.
- [ ] README MCP-tool tables list `codex_network`; README profile section labels the change `BREAKING (codex)`.
- [ ] **Release notes include a top-level `## BREAKING (codex)` section** with the full migration table, the three options, and the per-run warning copy verbatim.
- [ ] **T6 manual/live smoke** recorded in the Execution Log before merge (codex version, argv, `gh api /zen` output). Not part of `pnpm verify`.

## Future Options

- Per-domain allowlist value for `codex_network` (RQ1, HA2).
- Capability advertisement of which codex CLI versions support which network keys, surfaced on `BackendDiagnostic`.
- A daemon-side warning when a profile sets `codex_network: 'workspace'` but the codex CLI version is not on the verified list.
- A small `agent-orchestrator profile lint` command flagging review-only profiles granted `'workspace'`.
- Auto-restart on profile change (HA4) once a safe in-flight-run drain story exists.
- Equivalent `claude_network` / `cursor_network` knobs once those backends grow analogous needs.
- Profile-mode `codex_network` runtime override (OD2 Option C, HA3) once a supervisor-only IPC gate is designed.

## Execution Log

### T1: Decouple `mode` derivation from `service_tier`
- **Status:** done (2026-05-05)
- **Evidence:** `src/orchestratorService.ts` `modelSettingsForBackend` (codex branch) now derives `mode` from the resolved `codex_network` (`'isolated'` ⇒ `mode: 'normal'`, otherwise `mode: null`). `service_tier='normal'` is preserved as a serialization-suppressed value (it is the codex CLI default) and no longer drives `mode`. R11 fixtures updated: `src/__tests__/integration/orchestrator.test.ts:147-161` (now asserts `mode: 'normal'`, `codex_network: 'isolated'`, and `--ignore-user-config` in the parent argv); `src/__tests__/integration/orchestrator.test.ts:230-231` (profile-mode argv now has `--ignore-user-config` per the OD1=B default); `src/__tests__/backendInvocation.test.ts:26-79` (replaced with the issue-#31 codex_network argv suite).
- **Notes:** Verified by `pnpm test` (346 tests, 0 fail). The decoupling is also pinned by the new inverse-bug regression test `src/__tests__/backendInvocation.test.ts` "issue #31 inverse-bug regression: codex_network=user-config + service_tier=normal must NOT pass --ignore-user-config".

### T2: Add `codex_network` to `RunModelSettings` and the codex backend argv builder
- **Status:** done (2026-05-05; reviewer round 3 B3 fixed)
- **Evidence:** `src/contract.ts` adds `CodexNetworkSchema` and extends `RunModelSettingsSchema` with `codex_network: CodexNetworkSchema.nullable().optional().default(null)`; `src/runStore.ts:174-178` extends the legacy default block. `src/backend/codex.ts` replaces `userConfigArgs` with `sandboxArgs` per C3: `'isolated' ⇒ ['--ignore-user-config']`, `'workspace' ⇒ ['--ignore-user-config','-c','sandbox_workspace_write.network_access=true']`, `'user-config' ⇒ []`. Argv-layer regression in `src/__tests__/backendInvocation.test.ts`. **B3 (reviewer round 3)**: orchestrator-level inverse-bug regression added in `src/__tests__/integration/orchestrator.test.ts` "issue #31 (T2 / B3): orchestrator-level inverse-bug regression — service_tier=normal + codex_network=user-config produces argv WITHOUT --ignore-user-config" — this drives `service.startRun({ backend:'codex', service_tier:'normal', codex_network:'user-config' })` end-to-end and asserts on the recorded `worker_invocation.args`, pinning the foot-gun at the orchestrator's `service_tier → mode → --ignore-user-config` chain (the original location of the bug), not just the codex backend's argv builder.
- **Notes:** A defensive fallback in `sandboxArgs` keeps legacy run records (where `codex_network` was never set) on the closed posture (`--ignore-user-config`), so replays of pre-issue-#31 records cannot accidentally open network egress. The B3 service-layer test is kept alongside the existing argv-layer test, not as a replacement.

### T3: Add `codex_network` to `WorkerProfileSchema`; validate codex-only; expose on capability
- **Status:** done (2026-05-05)
- **Evidence:** `src/harness/capabilities.ts` adds `codex_network` to `WorkerProfileSchema`, extends `WorkerBackendCapability.settings` with `network_modes: string[]`, advertises `network_modes: ['isolated','workspace','user-config']` on the codex capability and empty arrays on claude/cursor, and rejects `codex_network` on non-codex profiles via `validateBackendSpecificProfile` / `validateCursorProfile`. `validateCodexProfile` rejects unknown `codex_network` values with a clear error. Capability and validation covered by `src/__tests__/codexNetwork.test.ts` "WorkerProfileSchema accepts codex_network on a codex profile and validates the value set", "codex_network is rejected on non-codex profiles", and "capability catalog advertises codex network_modes but no others".
- **Notes:** `WorkerProfileSchema` keeps `.strict()`; the manifest schema accepts any non-empty string (forward compatibility), and the capability layer enforces the enum.

### T4: Round-trip `codex_network` through MCP profile management
- **Status:** done (2026-05-05; reviewer round 3 B4 fixed)
- **Evidence:** `src/contract.ts` `UpsertWorkerProfileInputSchema` adds `codex_network: CodexNetworkSchema.optional()`. `src/orchestratorService.ts` `workerProfileFromUpsert` copies the field through and `formatValidProfile` emits it. `src/mcpTools.ts` adds `codex_network` to `upsert_worker_profile` (and `start_run`, `send_followup`). Schema-level test in `src/__tests__/codexNetwork.test.ts` "issue #31 manifest round-trip (T4)"; MCP schema check in `src/__tests__/mcpTools.test.ts`. **B4 (reviewer round 3)**: real service-layer round-trip in `src/__tests__/integration/orchestrator.test.ts` "issue #31 (T4 / B4): real upsertWorkerProfile + listWorkerProfiles round-trip preserves codex_network across reload" — calls `service.upsertWorkerProfile({ backend:'codex', codex_network:'workspace' })`, simulates a daemon restart by constructing a fresh `OrchestratorService` over the same store/profiles file, calls `restarted.listWorkerProfiles(...)`, and asserts the profile is returned with `codex_network: 'workspace'` intact. The same test asserts that `upsertWorkerProfile` rejects `codex_network` on `backend: 'claude'` with the documented error message.
- **Notes:** `parseProfileModelSettings` now also validates the `codex_network` value when present on a profile, so a malformed manifest entry surfaces a clear daemon error instead of silently falling back.

### T5: Persist `codex_network` on observability and run-store output
- **Status:** done (2026-05-05; reviewer round 3 B2 fixed)
- **Evidence:** `src/observability.ts:374-384` extends the `uniqueSettings` aggregation key with `codex_network`. `src/runStore.ts` extends the default `model_settings` block with `codex_network: null`. `ObservabilityRunSettingsSchema` inherits the new field from `RunModelSettingsSchema` (no schema change needed). Snapshot-dedup test added in `src/__tests__/codexNetwork.test.ts` "issue #31 observability dedup (T5 / P6)": two runs identical except for `codex_network` produce two distinct settings rows. **B2 (reviewer round 3)**: codex follow-ups now normalize legacy null `codex_network` to the resolved `'isolated'` default at child-creation time so the persisted `run_summary.model_settings` reflects the *effective* posture (the plan invariant). `src/orchestratorService.ts` `sendFollowup` introduces `persistedSettings` that re-derives `codex_network: 'isolated'` and `mode: 'normal'` for codex children when the inherited value is null. Two regression tests in `src/__tests__/integration/orchestrator.test.ts`: "issue #31 (T5 / B2): legacy parent with codex_network=null produces a child whose persisted codex_network is the resolved isolated default" (positive case via a synthesized legacy parent record), and "issue #31 (T5 / B2): non-codex follow-ups must keep codex_network as null (never carry the field)" (negative case so the codex-only normalization does not leak into claude/cursor child records).
- **Notes:** Existing observability tests updated (`src/__tests__/observability.test.ts`, `src/__tests__/observabilityFormat.test.ts`, `src/__tests__/contract.test.ts`, `src/__tests__/runStore.test.ts`) to include `codex_network: null` in expected `model_settings` shapes for back-compat round-trips.

### T6: Verify codex CLI flag and run a real `codex exec` smoke for `'workspace'`
- **Status:** documented (2026-05-05); manual run pending before merge
- **Evidence:** Procedure recorded in `docs/development/codex-backend.md` "Manual Smoke Procedure (T6)". The doc captures the codex version requirement (`>= 0.128.0`), the exact `start_run` parameters, the expected zen response, and the literal argv that must contain both `--ignore-user-config` and `-c sandbox_workspace_write.network_access=true`. `CHANGELOG.md` references the same procedure as a reproducible smoke step.
- **Notes:** Per P1 (reviewer round 2), this is **not** added to `pnpm verify` or CI: the codex CLI is not available in CI and the `gh api /zen` smoke needs the human's `gh auth` state. The manual run must be recorded in the Execution Log as a final pre-merge step (codex version, exact argv, `gh api /zen` output).

### T7: Add `docs/development/codex-backend.md` and update README/links
- **Status:** done (2026-05-05)
- **Evidence:** New `docs/development/codex-backend.md` covers argv shape, the three `codex_network` values, the OD1=B default, the OD2=B direct-mode override, the per-run warning copy, the breaking-change migration table with copy-pastable manifest snippets, recommended patterns, and the manual smoke procedure (T6). README MCP tool tables updated for `start_run` (lines ~626), `send_followup` (line ~636), and `upsert_worker_profile` (line ~625) to advertise the new optional `codex_network` argument. README profile section labels the change `BREAKING (codex)` and links to the new doc. README `service_tier` paragraph rewritten to point at `codex_network`.
- **Notes:** Doc uses the `codex exec --help` wording verbatim ("skips `$CODEX_HOME/config.toml`") to avoid drift with future codex CLI releases.

### T8: Update `orchestrate-resolve-pr-comments` skill
- **Status:** done (2026-05-05)
- **Evidence:** `.agents/skills/orchestrate-resolve-pr-comments/SKILL.md` gains a "Network Egress For Codex Reviewers" section that documents the supervisor pre-fetch pattern as the recommended default and lists three alternatives (claude profile, codex `'workspace'`, codex `'user-config'`). Skill stays backend-agnostic: it does not pre-decide which option applies. `.claude/skills/orchestrate-resolve-pr-comments/SKILL.md` regenerated via `node scripts/sync-ai-workspace.mjs`; `node scripts/sync-ai-workspace.mjs --check` reports clean.
- **Notes:** Per the existing skill rule, the section avoids hard-coding model/provider settings.

### T9: Wire `start_run` / `send_followup` runtime override per OD2
- **Status:** done (2026-05-05; reviewer round 3 B1 fixed)
- **Evidence:** `src/contract.ts` `StartRunInputSchema` adds `codex_network`; the existing `superRefine` is extended to add `codex_network` to the profile-mode rejection list (matches `model`/`reasoning_effort`/`service_tier`). `src/contract.ts` `SendFollowupInputSchema` adds `codex_network`. `src/orchestratorService.ts` `resolveStartRunTarget` rejects `codex_network` on non-codex direct-mode runs and threads the value through; `sendFollowup` rejects `codex_network` when the originating chain is profile-mode (OD2=B), and inherits parent `codex_network` when the follow-up does not set it explicitly. New end-to-end tests in `src/__tests__/integration/orchestrator.test.ts` cover (a) direct-mode `codex_network=workspace` flowing into argv; (b) profile-mode `start_run + codex_network` rejected as `INVALID_INPUT`; (c) non-codex direct-mode `codex_network` rejected; (d) profile-mode `send_followup + codex_network` rejected. Schema-level tests in `src/__tests__/codexNetwork.test.ts` confirm the schema-side superRefine. **B1 (reviewer round 3)**: chained-followup bypass closed. `src/orchestratorService.ts` adds a `chainOriginatedFromProfileMode(parent.meta)` helper that walks `parent_run_id` back to the chain root (bounded by `maxDepth=1000` and a `seen` set to break cycles) and consults the *root* run's `metadata.worker_profile` flag. `sendFollowup` now uses that helper instead of inspecting only the immediate parent. Regression test "issue #31 (T9 / B1): chained send_followup of a profile-mode run still rejects codex_network on the second hop" exercises `start_run(profile) → send_followup(no override) → send_followup(codex_network: 'workspace')` and asserts the second hop is rejected with the same `INVALID_INPUT` / message as the immediate-parent rejection.
- **Notes:** README MCP-tool tables for `start_run` and `send_followup` updated with the new optional argument (T7). The ancestry walk uses `runStore.loadMeta`, which is already O(1) on disk, so chains of typical depth (<10) add a single-digit-millisecond cost on `send_followup`; `maxDepth=1000` is far above any realistic chain length and a corrupt-cycle short-circuit prevents pathological inputs from looping forever.

### T10: `send_followup` inheritance test
- **Status:** done (2026-05-05)
- **Evidence:** `src/__tests__/integration/orchestrator.test.ts` "issue #31 (T10 / S3 / R8): send_followup inherits codex_network from the parent and accepts an explicit override" asserts that (a) without an explicit `codex_network` argument, the follow-up's `model_settings.codex_network` and resulting argv match the parent (`'workspace'` ⇒ `--ignore-user-config -c sandbox_workspace_write.network_access=true`); (b) with an explicit override (`'isolated'`), the follow-up uses the override (`--ignore-user-config` only).
- **Notes:** Implementation in `src/orchestratorService.ts` `sendFollowup` introduces `patchCodexNetwork` so a one-off `codex_network` override does not reset inherited `reasoning_effort` / `service_tier`.

### T11: Per-run non-blocking warning when `codex_network` defaulted (C12)
- **Status:** done (2026-05-05)
- **Evidence:** `src/orchestratorService.ts` `maybeEmitCodexNetworkDefaultWarning` emits a single non-blocking lifecycle event (`type: 'lifecycle'`, `payload.state: 'codex_network_defaulted'`) into the run's event log when a codex run resolves `codex_network` from the C4 default. Tests in `src/__tests__/integration/orchestrator.test.ts` cover (a) exactly one warning fires when `codex_network` is defaulted; (b) no warning fires when `codex_network` is set explicitly; (c) profile-mode warning names the profile id; (d) the warning never blocks the run (the run still completes).
- **Notes:** The warning lives in the run event log, not in the supervisor system prompt — alternative (a) under C12 was rejected as too noisy. The full warning text is on the lifecycle event payload and is returned by `get_run_events`; `get_run_progress` only surfaces the compact lifecycle marker `codex_network_defaulted`. User-facing docs (`docs/development/codex-backend.md`, `CHANGELOG.md`) make the same distinction.

### T12: Final `pnpm verify` and changelog/release-note draft
- **Status:** done (2026-05-05)
- **Evidence:** `pnpm verify` passes: build + 345 tests + 1 skipped + 0 fail, publish-ready check OK, `pnpm audit --prod` reports "No known vulnerabilities found", `npm pack --dry-run` succeeds (323.8 kB tarball, 1.7 MB unpacked, 236 files). New `CHANGELOG.md` includes a top-level `## Unreleased — BREAKING: codex profiles now default to closed network egress` section with: the full Behavior Change Summary table; the three migration options with copy-pastable manifest snippets; a link to `docs/development/codex-backend.md`; the per-run warning copy verbatim. Internal-changes section enumerates schema, capability, observability, and supervisor-formatter additions.
- **Notes:** T6 manual smoke remains an explicit pre-merge step recorded in this Execution Log; not part of `pnpm verify` or CI.

### T13: Supervisor system-prompt formatters mirror `codex_network` (B1)
- **Status:** done (2026-05-05)
- **Evidence:** `src/opencode/config.ts` and `src/claude/config.ts` `formatProfiles` add a `codexNetworkLine` helper that emits `codex_network=<value>` when set on a codex profile and `codex_network=isolated (default)` when absent on a codex profile (so supervisors see the *effective* posture); non-codex profiles get no line. `formatCatalog` in both files emits `network_modes=<list>` only for backends whose capability advertises them (codex). The opencode profile-fields enumeration line (`:174` area) is updated to mention `codex_network`. New harness tests in `src/__tests__/codexNetwork.test.ts` "issue #31 supervisor system-prompt formatters (B1 / T13)" pin both opencode and claude `formatProfiles` + `formatCatalog` for: (i) explicit value rendered, (ii) absent value rendered as `isolated (default)` for codex, (iii) absent value rendered identically to today for non-codex backends (no regression).
- **Notes:** Existing harness tests (`opencodeHarness`, `claudeHarness`) continue to pass without changes — the new `codex_network` line is appended to the existing settings string.
