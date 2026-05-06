# PR #38 — Resolution Map (Triage Pass)

PR: https://github.com/ralphkrauss/agent-orchestrator/pull/38
Branch: `31-codex-worker-bash-sandbox-blocks-outbound-http-eg-apigithubcom-breaking-gh-api-in-workflows`
Latest commit: `9125ca9` (codex_network field; default closed egress)
Locked decisions in scope: **OD1 = B** (uniform `'isolated'` default; breaking) and **OD2 = B** (direct-mode-only `start_run.codex_network` override). C12 per-run defaulted-warning event.
Triage date: 2026-05-06.

## Source inventory

| Source | URL | Notes |
|---|---|---|
| Issue comment (CodeRabbit walkthrough/summary) | https://github.com/ralphkrauss/agent-orchestrator/pull/38#issuecomment-4380831599 | Auto-generated walkthrough. Status-only; no action. |
| Review (CodeRabbit `COMMENTED`) | https://github.com/ralphkrauss/agent-orchestrator/pull/38#pullrequestreview-PRR_kwDOSRv-qs78Gwgl | Body holds 1 outside-diff comment and 1 nitpick that are not posted as inline review-thread comments. |
| Review-thread inline comments | 5 comments | Itemized below as items 1–5. |

## Triage decisions

### Item 1 — CHANGELOG.md fence missing language (MD040 nit)

- Comment ID: `3189807701`
- URL: https://github.com/ralphkrauss/agent-orchestrator/pull/38#discussion_r3189807701
- Author: `coderabbitai[bot]`
- File:line: `CHANGELOG.md:89-91`
- Comment (summarized): The fenced block holding the per-run warning copy has no language tag and trips MD040. Suggests `text`.
- Verification: **Confirmed.** `CHANGELOG.md:89` opens a ` ``` ` fence with no language; the linter warning is real.
- Decision: **fix-as-suggested**.
- Implementation:
  - File: `CHANGELOG.md`
  - At line 89 change ` ``` ` → ` ```text ` (the matching closing fence at line 91 stays ` ``` `, no change).
- Pre-drafted reply:

```text
<!-- ai-resolution-marker: PR38-cmt3189807701 -->
Triage: applied as suggested in commit `<sha>`. Tagged the warning-copy fence `text`.

(AI-assisted reply on behalf of @ralphkrauss.)
```

### Item 2 — `docs/development/codex-backend.md` fences missing languages (MD040 nit, 4 occurrences)

- Comment ID: `3189807712`
- URL: https://github.com/ralphkrauss/agent-orchestrator/pull/38#discussion_r3189807712
- Author: `coderabbitai[bot]`
- File:lines: `docs/development/codex-backend.md` lines `13`, `19`, `101`, `211`
- Comment (summarized): Four fenced code blocks have no language and trip MD040. Suggests `sh` for the codex argv shapes, `text` for the warning copy, and `ts` for the `start_run({...})` example.
- Verification: **Confirmed.** The four blocks are at:
  - `13` — codex exec argv shape (placeholders inside `[...]` make true `sh` slightly inaccurate; `text` is safest)
  - `19` — codex exec resume argv shape (same as above)
  - `101` — warning-copy block (matches CHANGELOG, use `text`)
  - `211` — `start_run({...})` example block (use `ts` for syntax highlighting parity with the rest of the codebase)
- Decision: **fix-with-alternative** (use `text` for the two argv shapes and the warning, `ts` only for the `start_run` example — `sh` would imply an executable command but the bracketed placeholders are not valid shell).
- Implementation:
  - File: `docs/development/codex-backend.md`
  - Line 13: change ` ``` ` → ` ```text `
  - Line 19: change ` ``` ` → ` ```text `
  - Line 101: change ` ``` ` → ` ```text `
  - Line 211 (note: this fence is indented 3 spaces): change `   ``` ` → `   ```ts `
- Pre-drafted reply:

```text
<!-- ai-resolution-marker: PR38-cmt3189807712 -->
Triage: applied with a small variation in commit `<sha>` — used `text` for the two argv-shape fences (13, 19) and the warning-copy fence (101) since the bracketed placeholders aren't valid shell, and `ts` for the `start_run({...})` example fence (211). Same MD040 outcome.

(AI-assisted reply on behalf of @ralphkrauss.)
```

### Item 3 — Clarify schema-side vs runtime rejection wording for `send_followup`

- Comment ID: `3189807720`
- URL: https://github.com/ralphkrauss/agent-orchestrator/pull/38#discussion_r3189807720
- Author: `coderabbitai[bot]`
- File:line: `docs/development/codex-backend.md:60-63`
- Comment (summarized): The current paragraph implies both `start_run` and `send_followup` reject profile + `codex_network` at schema parse time, but only `start_run` does (via `StartRunInputSchema.superRefine`). `send_followup` enforces it at runtime after walking the chain to find the originating mode.
- Verification: **Confirmed.**
  - `src/contract.ts:359-375` — `StartRunInputSchema.superRefine` rejects `profile + codex_network` at parse time.
  - `src/contract.ts:403-413` — `SendFollowupInputSchema` has **no** `superRefine`; the schema cannot see the chain mode.
  - `src/orchestratorService.ts:505-515` — `send_followup` walks ancestry (`chainOriginatedFromProfileMode`) and only then returns `INVALID_INPUT`.
  - The comment is accurate; the doc paragraph is misleading.
- Decision: **fix-as-suggested**.
- Implementation:
  - File: `docs/development/codex-backend.md`
  - Lines 60–63 — replace the current sentence:
    ```markdown
    - **Direct-mode `start_run` / `send_followup`**: pass `codex_network` directly
      for one-off overrides (issue #31 OD2 = B). Profile-mode runs reject the
      argument; the schema-side `superRefine` returns `INVALID_INPUT` so a
      supervisor that mixes them sees the error early.
    ```
    with:
    ```markdown
    - **Direct-mode `start_run` / `send_followup`**: pass `codex_network` directly
      for one-off overrides (issue #31 OD2 = B). Profile-mode runs reject the
      argument and return `INVALID_INPUT`. For `start_run` the rejection fires at
      schema parse time via `StartRunInputSchema.superRefine`. For `send_followup`
      the rejection fires at runtime in the orchestrator service after walking the
      run chain to locate the originating start (a profile-mode root cannot be
      bypassed by chained direct-mode follow-ups).
    ```
- Pre-drafted reply:

```text
<!-- ai-resolution-marker: PR38-cmt3189807720 -->
Triage: confirmed and applied in commit `<sha>`. The doc now distinguishes `start_run` (schema-side `StartRunInputSchema.superRefine`) from `send_followup` (runtime walk in `chainOriginatedFromProfileMode`). Thanks for catching the overgeneralization.

(AI-assisted reply on behalf of @ralphkrauss.)
```

### Item 4 — Don't document an `experimental` capability flag that does not exist

- Comment ID: `3189807723`
- URL: https://github.com/ralphkrauss/agent-orchestrator/pull/38#discussion_r3189807723
- Author: `coderabbitai[bot]`
- File:line: `docs/development/codex-backend.md:225-227`
- Comment (summarized): The T6 manual-smoke runbook tells the reader to `mark 'workspace' as experimental: true in the codex capability advertised by createWorkerCapabilityCatalog`, but `WorkerBackendCapability` in `src/harness/capabilities.ts` has no `experimental` field. The recommended fallback is unimplementable as written.
- Verification: **Confirmed.** `src/harness/capabilities.ts:5-20` — `WorkerBackendCapability` exposes only `backend`, `display_name`, `available`, `availability_status`, `supports_start`, `supports_resume`, `requires_model`, `settings.{reasoning_efforts, service_tiers, variants, network_modes}`, `notes`. No `experimental` field exists on the type, on `network_modes` entries, or anywhere in `createWorkerCapabilityCatalog`.
- Decision: **fix-as-suggested** — rewrite the unimplementable runbook step so it names only the two routine paths after a T6 failure: (a) fix the workspace-write argv in `src/backend/codex.ts` so the smoke passes against the version under release, or (b) escalate to the maintainer for explicit human approval before making any capability or contract-shape mitigation.
- Implementation:
  - File: `docs/development/codex-backend.md`, lines 225–227.
  - Action: replace the existing step 5 in the T6 manual smoke procedure with the runbook text below. (To see the current text being replaced, read the file at the cited lines; the prior step is intentionally not quoted here so the resolution map's guidance stays positive about the two allowed paths.)
  - Replacement runbook text:
    ```markdown
    5. If the smoke fails on the version under release, the only two routine
       paths are:
       1. Diagnose and fix the workspace-write argv assembly in
          `src/backend/codex.ts` so the smoke passes against the version under
          release; or
       2. Escalate to the maintainer for explicit human approval before
          making any capability or contract-shape mitigation.
    ```
- Pre-drafted reply:

```text
<!-- ai-resolution-marker: PR38-cmt3189807723 -->
Triage: good catch — the original runbook step pointed at a capability shape that `WorkerBackendCapability` does not actually expose. Doc updated in commit `<sha>`. Step 5 of the T6 manual smoke procedure now names only the two routine paths after a T6 failure: (a) fix the workspace-write argv in `src/backend/codex.ts` so the smoke passes against the version under release, or (b) escalate to the maintainer for explicit human approval before making any capability or contract-shape mitigation.

(AI-assisted reply on behalf of @ralphkrauss.)
```

### Item 5 — Use `$CODEX_HOME/config.toml` in capability note

- Comment ID: `3189807729`
- URL: https://github.com/ralphkrauss/agent-orchestrator/pull/38#discussion_r3189807729
- Author: `coderabbitai[bot]`
- File:line: `src/harness/capabilities.ts:88-89` (sweep extends to `src/mcpTools.ts:40`, `src/mcpTools.ts:110`, and `docs/development/codex-backend.md:89`)
- Comment (summarized): The capability note hardcodes `~/.codex/config.toml`, but the codex CLI's actual key is `$CODEX_HOME/config.toml`. The catalog text is inaccurate for users who set `CODEX_HOME`.
- Verification: **Confirmed and broader than originally scoped.** `docs/development/codex-backend.md:36, 41, 42, 43, 198` consistently use `$CODEX_HOME/config.toml`, citing `codex exec --help` ("skips `$CODEX_HOME/config.toml`"). Reviewer flagged that the same drift exists in three additional sites that all describe the documented codex CLI behavior:
  - `src/harness/capabilities.ts:88` — capability `notes` string (catalog).
  - `src/mcpTools.ts:40` — `start_run.codex_network` description string.
  - `src/mcpTools.ts:110` — `upsert_worker_profile.codex_network` description string.
  - `docs/development/codex-backend.md:89` — `legacy-network-trust` profile snippet description (`Honors ~/.codex/config.toml for network policy`).
  General migration prose (e.g. "users can edit `~/.codex/config.toml`") is intentionally left unchanged — those sites describe the user-default path, not the documented codex CLI key.
- Decision: **fix-as-suggested**, with the sweep expanded per reviewer Q3.
- Implementation:
  - File: `src/harness/capabilities.ts`, line 88 — replace the note string:
    ```ts
    'codex_network controls network egress: isolated (default; --ignore-user-config, no network), workspace (network on, codex skips ~/.codex/config.toml), user-config (codex reads ~/.codex/config.toml verbatim).',
    ```
    with:
    ```ts
    'codex_network controls network egress: isolated (default; --ignore-user-config, no network), workspace (network on, codex skips $CODEX_HOME/config.toml), user-config (codex reads $CODEX_HOME/config.toml verbatim).',
    ```
  - File: `src/mcpTools.ts`, line 40 — in the `start_run.codex_network` description, replace both `~/.codex/config.toml` literals with `$CODEX_HOME/config.toml`:
    ```ts
    description: 'Codex-only network egress posture. isolated (default): --ignore-user-config; codex skips ~/.codex/config.toml; no network. workspace: --ignore-user-config plus -c sandbox_workspace_write.network_access=true; network on. user-config: codex reads ~/.codex/config.toml verbatim. Direct mode only; profile mode rejects this field.',
    ```
    becomes:
    ```ts
    description: 'Codex-only network egress posture. isolated (default): --ignore-user-config; codex skips $CODEX_HOME/config.toml; no network. workspace: --ignore-user-config plus -c sandbox_workspace_write.network_access=true; network on. user-config: codex reads $CODEX_HOME/config.toml verbatim. Direct mode only; profile mode rejects this field.',
    ```
  - File: `src/mcpTools.ts`, line 110 — in the `upsert_worker_profile.codex_network` description, replace both `~/.codex/config.toml` literals with `$CODEX_HOME/config.toml`:
    ```ts
    description: 'Codex-only profile field. Controls codex network egress: isolated (default; --ignore-user-config; no network), workspace (network on; codex skips ~/.codex/config.toml), user-config (codex reads ~/.codex/config.toml verbatim). When omitted, codex profiles default to isolated (issue #31, BREAKING).',
    ```
    becomes:
    ```ts
    description: 'Codex-only profile field. Controls codex network egress: isolated (default; --ignore-user-config; no network), workspace (network on; codex skips $CODEX_HOME/config.toml), user-config (codex reads $CODEX_HOME/config.toml verbatim). When omitted, codex profiles default to isolated (issue #31, BREAKING).',
    ```
  - File: `docs/development/codex-backend.md`, line 89 — in the `legacy-network-trust` profile snippet, replace `Honors ~/.codex/config.toml for network policy` with `Honors $CODEX_HOME/config.toml for network policy`.
- Implementer note: when staging these edits, grep the diff once for any other `~/.codex/config.toml` literal that describes the documented codex CLI behavior (not user-default-path prose) and only those sites should be touched. Do not sweep general migration prose.
- Pre-drafted reply:

```text
<!-- ai-resolution-marker: PR38-cmt3189807729 -->
Triage: confirmed — the operative key is `$CODEX_HOME/config.toml`. Updated in commit `<sha>` across the four sites that describe the documented codex CLI behavior: `src/harness/capabilities.ts:88` (catalog note), `src/mcpTools.ts:40` (`start_run.codex_network` description), `src/mcpTools.ts:110` (`upsert_worker_profile.codex_network` description), and the `legacy-network-trust` snippet in `docs/development/codex-backend.md:89`. General "users can edit `~/.codex/config.toml`" migration prose is intentionally unchanged.

(AI-assisted reply on behalf of @ralphkrauss.)
```

### Item 6 — Reject non-Codex `codex_network` combinations at the schema boundary (outside-diff suggestion)

- Source: review body (CodeRabbit `COMMENTED` review, "Outside diff range comments" block)
- URL: https://github.com/ralphkrauss/agent-orchestrator/pull/38#pullrequestreview-PRR_kwDOSRv-qs78Gwgl
- Author: `coderabbitai[bot]`
- File:lines: `src/contract.ts:346-375` (`StartRunInputSchema`) and `src/contract.ts:386-399` (`UpsertWorkerProfileInputSchema`)
- Comment (summarized): Both schemas accept `codex_network` even when `backend` is `claude` or `cursor`, so callers get parse-ok / runtime-fail. Add `superRefine` blocks that reject `codex_network && backend !== 'codex'` at parse time. Suggests adding a `codex_network` clause to the existing `StartRunInputSchema.superRefine` and converting `UpsertWorkerProfileInputSchema` to a `superRefine` chain with the same check.
- Verification: **Partially valid.**
  - The behavior CodeRabbit describes (parse accepts, runtime rejects) is real — `src/orchestratorService.ts:248-249` (start_run) and `src/orchestratorService.ts:517-518` (send_followup) and `src/harness/capabilities.ts:218-244` (validateBackendSpecificProfile) all reject `codex_network` on non-codex backends at runtime.
  - Tests already cover the runtime rejection: `src/__tests__/codexNetwork.test.ts:77-99` asserts that `claude` and `cursor` profiles with `codex_network` are rejected via the manifest path. The proposed change moves the check from the orchestrator/profile-validation layer to the contract schema layer, with no behavior change for valid inputs.
  - Risk: moving the check to schema parse time would change error messages and error sources for the `claude`/`cursor` `start_run` direct-mode path (currently surfaced as orchestrator `INVALID_INPUT` at `src/orchestratorService.ts:248-249`; would become a Zod `superRefine` issue surfaced earlier in the request pipeline). Existing tests asserting on those exact runtime paths would need updating.
- Decision: **defer** — defense-in-depth polish, not a behavior gap. The rejection is already enforced at runtime with clear error messages and is covered by tests. Tightening the schema is a worthwhile follow-up but not load-bearing for the OD1=B / OD2=B contract introduced by this PR.
- Implementation: not applied this round. If revisited as a follow-up:
  - `src/contract.ts:359-375` — extend the existing `StartRunInputSchema.superRefine` with:
    ```ts
    if (input.codex_network && input.backend && input.backend !== 'codex') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'codex_network is only supported when backend is codex',
        path: ['codex_network'],
      });
    }
    ```
  - `src/contract.ts:386-399` — wrap `UpsertWorkerProfileInputSchema` in a `superRefine` that rejects `input.codex_network && input.backend !== 'codex'`.
  - Update or replace orchestrator-layer regressions that assert on the runtime rejection path so they assert on the schema-layer rejection instead.
- Pre-drafted reply:

```text
<!-- ai-resolution-marker: PR38-cmt-pr38-outsidediff-contract -->
Deferred. The rejection is enforced at runtime in `orchestratorService` (`start_run` / `send_followup`) and at the profile-validation layer in `validateBackendSpecificProfile`, with regression coverage in `src/__tests__/codexNetwork.test.ts:77-99`. We are not filing a follow-up issue; if you want a defense-in-depth schema rejection later, please open one and we can address it separately.

(AI-assisted reply on behalf of @ralphkrauss.)
```

### Item 7 — Add enum assertion for `send_followup` `codex_network` (nitpick)

- Source: review body (CodeRabbit `COMMENTED` review, "Nitpick comments" block)
- URL: https://github.com/ralphkrauss/agent-orchestrator/pull/38#pullrequestreview-PRR_kwDOSRv-qs78Gwgl
- Author: `coderabbitai[bot]`
- File:line: `src/__tests__/mcpTools.test.ts:61-62`
- Comment (summarized): `start_run` (lines 30-34) and `upsert_worker_profile` (lines 50-54) both assert the exact enum `['isolated', 'workspace', 'user-config']` for `codex_network`, but `send_followup` only checks property presence. Suggests adding the same `deepStrictEqual` enum check for symmetry.
- Verification: **Confirmed.** The asymmetry is real and trivially fixable.
- Decision: **fix-as-suggested**.
- Implementation:
  - File: `src/__tests__/mcpTools.test.ts`
  - After line 62 (`assert.equal(Object.hasOwn(followup.properties, 'codex_network'), true);`), insert:
    ```ts
    assert.deepStrictEqual(
      (followup.properties.codex_network as { enum: string[] }).enum,
      ['isolated', 'workspace', 'user-config'],
    );
    ```
- Pre-drafted reply:

```text
<!-- ai-resolution-marker: PR38-cmt-pr38-nit-mcptools-enum -->
Triage: applied in commit `<sha>`. Added the matching `deepStrictEqual` enum assertion for `send_followup.codex_network` to match the `start_run` and `upsert_worker_profile` checks.

(AI-assisted reply on behalf of @ralphkrauss.)
```

## Filtered out (no action)

| Source | Reason |
|---|---|
| `4380831599` (CodeRabbit walkthrough/summary issue comment) | Auto-generated walkthrough + change tables. Status-only; no actionable suggestion. |
| Review-body LanguageTool style hint at `docs/development/codex-backend.md:63` (`that` vs `who`) | Style nit only, not surfaced as an actionable inline comment; rewording in Item 3 already touches this paragraph. |
| `📒 Files selected for processing` and `🔇 Additional comments` (LGTM) sections of the review | Status / praise; no action. |

## Counts

- Total fetched comments: 8 (1 issue comment, 5 review-thread inline comments, 1 review with 2 in-body items).
- Actionable: 7 (Items 1–7).
- Fix-as-suggested: 5 (Items 1, 3, 4, 5, 7).
- Fix-with-alternative: 1 (Item 2 — `text` instead of `sh` for two argv-shape fences).
- Declined: 0.
- Deferred: 1 (Item 6 — schema-boundary defense-in-depth).
- Follow-up issue candidates: 0 (Item 6 closed without filing; the runtime + profile-layer rejection is enforced and tested. If a defense-in-depth schema rejection is wanted later, the human can open it.).
- Human-approval-required: 0.

## CI status

All required checks on `9125ca9` are green:

| Check | Result | Duration |
|---|---|---|
| Build, Test, and Pack on Node 22 | pass | 58s |
| Build, Test, and Pack on Node 24 | pass | 1m5s |
| CodeRabbit | pass (review completed) | — |

No CI gating blocker for follow-up commits.

## Reviewer Questions

none — all four round-1 questions answered by the resolution-map reviewer; Items 2, 4, 5, 6 updated in place per those answers (see "Round 2 changes" below).

## Open Human Decisions

> Only true product / scope / behavior / contract decisions reserved for the human after reviewer review.

none.

## Boundaries respected

- No code edits, no commits, no pushes, no GitHub replies posted.
- Profiles manifest at `/home/ubuntu/.config/agent-orchestrator/profiles.json` not modified.
- No plan or source files modified outside this resolution map; working tree is otherwise clean.

## Round 2 changes (reviewer-driven)

Applied per resolution-map reviewer round 1 answers (2026-05-06):

- **Item 4** — Decision, replacement runbook step, and pre-drafted reply rewritten. The original step depended on a capability shape that `WorkerBackendCapability` does not expose, so the runbook is now positively framed around the two routine paths after a T6 failure: (1) fix the workspace-write argv in `src/backend/codex.ts`; (2) escalate to the maintainer for explicit human approval before any capability or contract-shape mitigation. Reply mirrors that wording. Round 3 follow-up: scrubbed the Decision/Implementation/Reply blocks of the proscribed phrases that the round-2 wording still surfaced (per round-2 reviewer answer).
- **Item 5** — sweep expanded from a single site to four. Implementation now covers `src/harness/capabilities.ts:88`, `src/mcpTools.ts:40` (`start_run.codex_network` description), `src/mcpTools.ts:110` (`upsert_worker_profile.codex_network` description), and `docs/development/codex-backend.md:89` (`legacy-network-trust` snippet). Implementer note clarifies that general "users can edit `~/.codex/config.toml`" migration prose is intentionally out of scope. Reply lists the four updated sites.
- **Item 6** — pre-drafted reply rewritten to match the reviewer's required wording. Removed "Tracking as a follow-up" and "happy to file an issue if you want it on the backlog." Reply now states the deferral, cites the existing runtime + profile-layer enforcement and `src/__tests__/codexNetwork.test.ts:77-99` coverage, and explicitly says no follow-up issue will be filed.
- **Counts** — follow-up-issue note tightened: Item 6 explicitly closed without a tracking artifact.
- **Reviewer Questions** — collapsed to `none` (all four round-1 questions answered).
- **Open Human Decisions** — remains `none`.

No changes to Items 1, 2, 3, or 7; verification, decision, and reply text for those are unchanged from round 1.

## Status

The map is **ready for the implementer**. No remaining blockers, no open reviewer questions, no open human decisions. CI on `9125ca9` is green; the seven actionable changes can be implemented as a single follow-up commit.

## Round 2 (after b23c6ba)

Triage date: 2026-05-06.
Latest commit at triage time: `b23c6ba` (Round 1 fixes + ip-address audit override).

CodeRabbit ran a fresh review against `b23c6ba` and posted two new inline comments — both on this resolution-map document itself (`plans/31-codex-worker-bash-sandbox-blocks-outbound-http-eg-apigithubcom-breaking-gh-api-in-workflows/resolution-map.md`). All Round 1 threads (Items 1–5) are now `isResolved: true` per GraphQL `reviewThreads`; CodeRabbit's auto-`<review_comment_addressed>` ack closed each one. The deferred Item 6 and the fixed Item 7 had their AI replies posted as issue/conversation comments; no human follow-up has appeared in either thread, so they remain filtered per the task's marker rule.

### Source inventory (Round 2)

| Source | URL | Notes |
|---|---|---|
| New inline review-thread comment | https://github.com/ralphkrauss/agent-orchestrator/pull/38#discussion_r3193852165 | New, unresolved. MD040 on resolution-map.md fenced blocks. |
| New inline review-thread comment | https://github.com/ralphkrauss/agent-orchestrator/pull/38#discussion_r3193852168 | New, unresolved. MD038 on resolution-map.md line 58. |

### Item 8 — Add language identifiers to resolution-map.md fenced blocks (MD040)

- Comment ID: `3193852165`
- URL: https://github.com/ralphkrauss/agent-orchestrator/pull/38#discussion_r3193852165
- Author: `coderabbitai[bot]`
- File:lines: `plans/31-codex-worker-bash-sandbox-blocks-outbound-http-eg-apigithubcom-breaking-gh-api-in-workflows/resolution-map.md` — **16 unlabeled opening fences** at lines `33, 61, 84, 91, 102, 122, 133, 156, 160, 164, 168, 172, 176, 183, 217, 244`. (The comment cites closing-fence-line ranges 33-38, 61-66, 84-89, 91-99, 102-107, 122-130, 133-138, 156-162, 164-170, 172-178, 183-188, 217-222, 244-249, plus three indented fence pairs CodeRabbit's range collapsing combined into the 156–178 group.)
- Comment (summarized): Multiple unlabeled fenced code blocks throughout the resolution-map trip MD040. Tag each opening fence with an explicit language consistently (`text`, `markdown`, `ts`, etc.).
- Verification: **Confirmed — count is 16, not 13.** A scan that allows leading indentation (`awk '/^[[:space:]]*```/'`) reports unlabeled opening fences at exactly the 16 lines listed. The reviewer's three-language classification was spot-checked against the file:
  - `text` — pre-drafted reply blocks (plain prose with the hidden ai-resolution-marker comment plus the reply body): lines `33, 61, 102, 133, 183, 217, 244` (7 fences, one per Item 1–7 reply).
  - `markdown` — nested markdown samples being shown as quoted prose (bulleted list, bold, inline code, numbered list): lines `84, 91, 122` (Item 3 "current sentence" / "with:" pair at 84/91, Item 4 replacement runbook step at 122).
  - `ts` — TypeScript snippets (string literals or object property values from `src/harness/capabilities.ts` and `src/mcpTools.ts` quoted in Item 5's implementation block): lines `156, 160, 164, 168, 172, 176` (6 fences; the indented `before` / `with:` pairs for the three sites).
  - The fix is mechanical and matches the language choices already used elsewhere in the repo (Items 1 and 2 used `text` and `ts` in `CHANGELOG.md:89` and `docs/development/codex-backend.md`).
- Decision: **fix-as-suggested**, with the 13→16 line-count correction and the three-language classification.
- Implementation:
  - File: `plans/31-codex-worker-bash-sandbox-blocks-outbound-http-eg-apigithubcom-breaking-gh-api-in-workflows/resolution-map.md`
  - **`text` (7 fences)** — at each of the following opening fences, replace ` ``` ` with ` ```text ` (closing fences stay unchanged):
    - Line `33` — Item 1 pre-drafted reply.
    - Line `61` — Item 2 pre-drafted reply.
    - Line `102` — Item 3 pre-drafted reply.
    - Line `133` — Item 4 pre-drafted reply.
    - Line `183` — Item 5 pre-drafted reply.
    - Line `217` — Item 6 pre-drafted reply.
    - Line `244` — Item 7 pre-drafted reply.
  - **`markdown` (3 fences)** — at each of the following opening fences, replace ` ``` ` with ` ```markdown ` (the leading 4-space indent stays; only the language tag is added). Closing fences stay unchanged:
    - Line `84` — Item 3, "current sentence" being replaced (bullet list with bold + inline code).
    - Line `91` — Item 3, replacement sentence (same shape as 84).
    - Line `122` — Item 4, replacement runbook text (numbered list with nested list and inline code).
  - **`ts` (6 fences)** — at each of the following opening fences, replace ` ``` ` with ` ```ts ` (the leading 4-space indent stays; only the language tag is added). Closing fences stay unchanged:
    - Line `156` — Item 5, `src/harness/capabilities.ts:88` `before` snippet (string literal).
    - Line `160` — Item 5, `src/harness/capabilities.ts:88` `with:` snippet (string literal).
    - Line `164` — Item 5, `src/mcpTools.ts:40` `before` snippet (object property `description: '...'`).
    - Line `168` — Item 5, `src/mcpTools.ts:40` `becomes` snippet (object property `description: '...'`).
    - Line `172` — Item 5, `src/mcpTools.ts:110` `before` snippet (object property `description: '...'`).
    - Line `176` — Item 5, `src/mcpTools.ts:110` `becomes` snippet (object property `description: '...'`).
  - Implementer notes:
    - Apply edits **in descending line order** (244 → 33) so each edit doesn't shift the line numbers of edits not yet made — none of the edits add/remove lines, but this avoids any drift if the implementer re-reads between edits.
    - **Indent preservation** — for the 9 indented fences (84, 91, 122, 156, 160, 164, 168, 172, 176) the leading 4 spaces (3 spaces for some, depending on the surrounding bullet structure; the reviewer's awk scan accepts any leading whitespace) must be kept. Only the language tag is appended directly after the three backticks; e.g. `    ``` ` → `    ```ts ` and `    ``` ` → `    ```markdown `. Read the file before each edit to lift the exact indent prefix.
    - **Round 2 reply blocks** — the new Item 8 and Item 9 pre-drafted-reply fences in this section were already opened with `` ```text ``, so they do not need re-tagging. Confirm with a post-edit re-scan (see "post-edit verification" below).
    - **Post-edit verification** — after the sweep, re-run the awk scan
      ```sh
      awk 'BEGIN{f=0} /^[[:space:]]*```/ {if(f==0){match($0,/```([a-zA-Z0-9_-]*)/,a); if(a[1]==""){print NR}; f=1} else {f=0}}' plans/31-codex-worker-bash-sandbox-blocks-outbound-http-eg-apigithubcom-breaking-gh-api-in-workflows/resolution-map.md
      ```
      It should print **0 lines** (no unlabeled opening fences anywhere in the file).
- Pre-drafted reply:

```text
<!-- ai-resolution-marker: PR38-cmt3193852165 -->
Triage: applied as suggested in commit `<sha>`. Swept all 16 unlabeled opening fences in `plans/31-codex-worker-bash-sandbox-blocks-outbound-http-eg-apigithubcom-breaking-gh-api-in-workflows/resolution-map.md` and tagged them by content type:
- `text` (reply / argv-shape blocks) — lines 33, 61, 102, 133, 183, 217, 244 (the seven Item 1–7 pre-drafted reply blocks).
- `markdown` (nested markdown samples — bullet/numbered lists with bold and inline code) — lines 84, 91, 122 (Item 3's "current sentence"/"with:" pair and Item 4's replacement runbook step).
- `ts` (TypeScript snippets — string literals / `description: '...'` property values from `src/harness/capabilities.ts` and `src/mcpTools.ts`) — lines 156, 160, 164, 168, 172, 176 (Item 5's three before/after pairs).

A post-edit re-scan reports zero remaining unlabeled fences. MD040 should be clear for this file.

(AI-assisted reply on behalf of @ralphkrauss.)
```

### Item 9 — MD038 inner padding on resolution-map.md line 58 (false positive)

- Comment ID: `3193852168`
- URL: https://github.com/ralphkrauss/agent-orchestrator/pull/38#discussion_r3193852168
- Author: `coderabbitai[bot]`
- File:line: `plans/31-codex-worker-bash-sandbox-blocks-outbound-http-eg-apigithubcom-breaking-gh-api-in-workflows/resolution-map.md:58` (two MD038 warnings on the same line)
- Comment (summarized): Line 58 has inline code spans with leading/trailing spaces; markdownlint MD038 flags them. The bot suggests trimming the inner spacing.
- Verification: **Confirmed-but-false-positive.** The two flagged code spans on line 58 are:
  - `` `   ``` ` `` — single-backtick delimiter, content `   ``` ` (3 spaces, 3 backticks, 1 space). Per CommonMark, a single space is stripped from each end after parsing, leaving `  ``` ` (2 spaces + 3 backticks) — i.e., the indented fence marker the prose is trying to display.
  - `` `   ```ts ` `` — same construction, used to display `  ```ts ` (the indented fence with a `ts` language tag).
  - The inner padding is **required** by CommonMark (a single-backtick code span cannot embed bare backticks; the spaces let the content begin/end with a backtick and survive the parse). Removing the inner spaces would either break the span (spurious `` ` `` characters leak out) or require switching to triple-backtick delimiters, which MD038 also flags. The simplest "real" fix is to rewrite the prose to not embed a triple-backtick fence inside an inline code span at all.
  - Note: this line is part of Item 2's implementation block describing how to tag fences in `docs/development/codex-backend.md`. That task is already applied in `b23c6ba`, so the prose is purely historical record. Rewriting it would muddy the planning artifact without changing any code.
- Decision: **decline** (false positive). MD038 fires on a span where the inner space is required by CommonMark to embed backticks; trimming it is incorrect. The alternative (rewrite the prose to avoid embedded triple-backticks) is invasive on a historical record and not justified by a markdownlint nit. We are not filing a follow-up issue.
- Implementation: not applied. Line 58 stays as written.
- Pre-drafted reply:

```text
<!-- ai-resolution-marker: PR38-cmt3193852168 -->
Declined. The two inline code spans on line 58 use single-backtick delimiters to embed a triple-backtick fence marker (`  ` `` `` `` and `  ` `` ``ts), and per CommonMark the leading/trailing space is required so the content can begin and end with a backtick — trimming would either break the span or force triple-backtick delimiters that MD038 also flags. Line 58 is also part of Item 2's historical implementation record (already applied in `b23c6ba`), so rewriting the prose to avoid embedded fences would muddy the planning artifact for no behavior change. Not filing a follow-up issue.

(AI-assisted reply on behalf of @ralphkrauss.)
```

### Filtered out (Round 2, no action)

| Source | Reason |
|---|---|
| Round 1 inline comments `3189807701`, `3189807712`, `3189807720`, `3189807723`, `3189807729` | Already-resolved threads (`isResolved: true`); each closed by a CodeRabbit `<review_comment_addressed>` ack after our marker reply landed in `b23c6ba`. |
| AI marker replies `3193839793`, `3193840325`, `3193840891`, `3193841404`, `3193842057` | Carry `<!-- ai-resolution-marker: PR38-cmt... -->`; threads have no human/AI follow-up. |
| CodeRabbit ack replies `3193841020`, `3193841450`, `3193841890`, `3193843152`, `3193843496` | Bot acknowledgments closing resolved threads; no actionable content. |
| Issue comment `4380831599` (CodeRabbit walkthrough/summary) | Auto-generated walkthrough; status-only. |
| Issue comment `4386073975` (Item 6 deferred reply) | Carries `<!-- ai-resolution-marker: PR38-cmt-pr38-outsidediff-contract -->`; thread has no human follow-up. |
| Issue comment `4386074410` (Item 7 fixed reply) | Carries `<!-- ai-resolution-marker: PR38-cmt-pr38-nit-mcptools-enum -->`; thread has no human follow-up. |

### Counts (Round 2)

- Total fetched comments: 20 (17 inline review-thread comments + 3 issue/conversation comments).
- Round 1 thread comments + bot acks filtered: 15 inline (5 original CodeRabbit comments now resolved + 5 AI marker replies + 5 CodeRabbit acks).
- Issue comments filtered: 3 (1 walkthrough + 2 AI marker replies on Items 6 and 7, neither has human follow-up).
- NEW actionable: 2 (Items 8 and 9).
- Fix-as-suggested: 1 (Item 8 — MD040 sweep on resolution-map fences).
- Declined: 1 (Item 9 — MD038 false positive on line 58).
- Deferred: 0.
- Follow-up issue candidates: 0 (Item 9 closed without filing; the inner padding is required by CommonMark and not a real defect).
- Human-approval-required: 0 (neither item touches OD1, OD2, C12, `codex_network`, public MCP/CLI/contract surface, release/publish, deps, or auto-merge).

### CI status (Round 2)

All required checks on `b23c6ba` are green:

| Check | Result | Duration |
|---|---|---|
| Build, Test, and Pack on Node 22 | pass | 55s |
| Build, Test, and Pack on Node 24 | pass | 58s |
| CodeRabbit | pass (review completed) | — |

No CI gating blocker for follow-up commits.

### Reviewer Questions

none — both Round 2 items are mechanical/declarative; no open questions for the resolution-map reviewer.

### Open Human Decisions

> Only true product / scope / behavior / contract decisions reserved for the human after reviewer review.

none.

### Boundaries respected (Round 2)

- No code edits, no commits, no pushes, no GitHub replies posted.
- Profiles manifest at `/home/ubuntu/.config/agent-orchestrator/profiles.json` not modified.
- Round 1 entries (Items 1–7, source inventory, original counts/CI/reviewer-questions/open-decisions blocks, and Round 2 changes notes) left intact above; this Round 2 section is appended only.
- No files modified outside this resolution map.
