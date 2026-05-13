---
pr: 61
url: https://github.com/ralphkrauss/agent-orchestrator/pull/61
branch: 56-make-system-prompt-configurable
base: main
head_commit: 87ee632d168af7d312ad2cc38ea83f77cb9b4e40
created: 2026-05-12
generated_by: Claude resolve-pr-comments triage (batched, resolution-map only; interactive one-comment loop overridden)
ai_reply_prefix: "**[AI Agent]:**"
correlation_marker_pattern: "<!-- agent-orchestrator:pr61:<tag> -->"
scope: "Resolution map only. No implementation, no commits, no pushes, no GitHub replies, no thread resolution."
---

# PR #61 Resolution Map

Branch: `56-make-system-prompt-configurable`
Base: `main`
Head commit: `87ee632 feat(56): configurable supervisor system prompt (append-only)`
Approved plan: `plans/56-make-system-prompt-configurable/plans/56-configurable-supervisor-system-prompt.md`

## Fetch Results

Collected via `gh` (auth via `GH_TOKEN`) against `ralphkrauss/agent-orchestrator`:

- `gh pr view 61 --json reviews` → reviews: **0**
- `gh api repos/ralphkrauss/agent-orchestrator/pulls/61/comments` (inline review comments): **0**
- `gh api repos/ralphkrauss/agent-orchestrator/pulls/61/reviews` (reviews, paginated): **0**
- `gh api repos/ralphkrauss/agent-orchestrator/issues/61/comments` (conversation comments): **1**
- GraphQL `reviewThreads(first:100)`: `nodes: []` → **0** threads to filter as resolved/unresolved

## Counts

- Total comments fetched: 1
- Filtered as bot informational summary: 1 (CodeRabbit walkthrough; "No actionable comments were generated in the recent review. 🎉")
- Embedded informational items surfaced for explicit triage: 2 (one pre-merge check warning + one LanguageTool grammar batch on plan docs)
- Actionable comments triaged: 2
- To fix: 0 | To decline: 2 | To defer: 0 | To escalate: 0 | Human Approval Required: 0

## Filter Notes

The single fetched comment is CodeRabbit's auto-generated walkthrough/summary
comment (id `4431211822`, author `coderabbitai[bot]`). Its top line explicitly
states:

> No actionable comments were generated in the recent review. 🎉

The body's `Additional comments (9)` section is praise-only ("Clear, actionable
passthrough rejection message", "Docs section is thorough and
implementation-aligned", "Resolver contract is clean and testable",
"Parser precedence and escape-hatch behavior look solid", etc.) and is not
actionable feedback. The walkthrough itself is therefore filtered as
informational bot noise per the `resolve-pr-comments` filter rules.

Two embedded blocks inside the same auto-summary comment could plausibly be
construed as feedback and are surfaced below as `C1` and `C2`:

- `C1` — Pre-merge check warning: **Docstring Coverage** (12.90% vs 80%
  threshold). Same generic CodeRabbit threshold check encountered on PR #50;
  see `plans/33-root-command-should-give-you-the-help/resolution-map.md` for
  the established precedent.
- `C2` — LanguageTool grammar batch: three "Use a hyphen to join words"
  suggestions targeting "Worker run prompts" / "worker run prompts" in plan
  documents.

No prior AI replies with `<!-- agent-orchestrator:pr61:* -->` correlation
markers exist on this PR (issue-comments list has only the CodeRabbit
auto-summary; review-comments and reviews lists are empty).

CI status on this branch is reported as 4 pre-merge checks passing
(Description, Title, Linked Issues, Out-of-scope) and 1 warning (the
Docstring Coverage threshold). No required check is failing. The CodeRabbit
auto-summary also notes one timed-out external check (`GitHub Check: Windows
Smoke on Node 24`); that is an infra timeout, not an item of review feedback,
so it is not triaged.

## Reviewer Questions

none.

Both triaged items are generic, repo-pattern-aligned declines with clear
precedent (PR #50). The triage did not turn up uncertainty that requires
pr-comment-reviewer adjudication before proceeding.

## Open Human Decisions

none.

Neither `C1` nor `C2` proposes a behavior change, public-contract change,
workflow change, permission/tool-surface change, security-boundary change,
release/publish change, dependency-policy change, or capability removal. The
PR's approved scope (append-only customization slot, three resolution
surfaces, 64 KB cap, etc.) is not affected by either item, so no human
approval gate is triggered.

---

## Comment C1 | Decline | Low

- **Comment Type:** conversation (embedded pre-merge check warning inside the CodeRabbit auto-summary comment)
- **File:** N/A (repo-wide bot threshold, not tied to a specific path/line)
- **Comment ID:** `4431211822` (parent CodeRabbit summary)
- **Review ID:** N/A
- **Thread Node ID:** N/A (not posted as a review thread)
- **Author:** `coderabbitai[bot]`
- **Comment (verbatim excerpt):**

  > Docstring Coverage — ⚠️ Warning — Docstring coverage is 12.90% which is
  > insufficient. The required threshold is 80.00%. Resolution: Write
  > docstrings for the functions missing them to satisfy the coverage
  > threshold.

- **Code surfaces this PR adds that the threshold would target:**
  - `src/claude/appendPrompt.ts` (new, 317 lines): exports
    `AppendSource` (type), `SUPERVISOR_APPEND_PROMPT_BYTE_CAP`,
    `SUPERVISOR_APPEND_PROMPT_DELIMITER`,
    `CONVENTION_APPEND_PROMPT_RELATIVE_PATH`, `LoadedAppendContent`
    (interface), `AppendPromptError` (discriminated type with
    `code: 'missing-file' | 'oversize' | 'read-failed'`),
    `ResolveSupervisorAppendPromptInput`,
    `ResolvedSupervisorAppendPrompt`, `resolveSupervisorAppendPrompt`,
    `ConventionPromptProbeResult`, `probeConventionAppendPromptFile`,
    `LoadAppendPromptInput`, `LoadAppendPromptResult`,
    `readAppendPromptFile`, `loadAppendPromptSource`.
  - `src/claude/launcher.ts`: new helpers
    `resolveAppendSystemPromptForEnvelope`, `formatUserSystemPromptSections`,
    expanded parser branches in `parseClaudeLauncherArgs`, expanded
    `BuiltClaudeEnvelope` fields.
  - `src/claude/config.ts`: new input field `userAppendSystemPrompt` and
    three new result fields (`userSystemPromptSource`,
    `userSystemPromptPath`, `userSystemPromptAppend`); extended
    `buildSupervisorSystemPrompt` with a non-empty-text delimiter branch.
  - `src/claude/passthrough.ts`: specialized rejection branch for
    `--append-system-prompt` / `--append-system-prompt-file` after `--`.
- **Independent Assessment:**
  - This is a generic CodeRabbit pre-merge threshold (12.90% < 80.00%)
    applied uniformly across the repo, not a verified review of this PR's
    correctness or contract. The CodeRabbit comment that contains the
    warning explicitly declares "No actionable comments were generated in
    the recent review. 🎉", which confirms the bot does not classify it as
    actionable feedback.
  - Repository convention does not use JSDoc tag-based docstrings: across
    `src/`, `@param` / `@returns` / `@throws` tags occur **zero** times.
    Existing `/**` block-comment openings are plain prose intros, not
    formal docstrings. Forcing 80%+ JSDoc tag coverage on the new files
    would diverge from the repo's established TypeScript style.
  - Neither `AGENTS.md`, `.cursor/rules/node-typescript.mdc`, nor the
    approved plan
    (`plans/56-make-system-prompt-configurable/plans/56-configurable-supervisor-system-prompt.md`)
    requires docstrings. The plan explicitly enumerates the public type
    contract (Decision 12) and the typed error contract (Tests T1–T8)
    instead.
  - The new public surface is already self-documenting and test-covered:
    - `AppendSource`, `LoadedAppendContent`,
      `ResolveSupervisorAppendPromptInput`,
      `ResolvedSupervisorAppendPrompt`, `ConventionPromptProbeResult`,
      `LoadAppendPromptInput`, `LoadAppendPromptResult`, and the
      discriminated `AppendPromptError` (`missing-file` / `oversize` /
      `read-failed` variants) are named types whose shape is the
      documentation; all are exercised by the 1,105-line suite in
      `src/__tests__/claudeAppendPrompt.test.ts`.
    - `resolveSupervisorAppendPrompt`, `probeConventionAppendPromptFile`,
      `readAppendPromptFile`, `loadAppendPromptSource`,
      `resolveAppendSystemPromptForEnvelope`, and
      `formatUserSystemPromptSections` each have named parameters and
      typed return values; the test suite covers precedence,
      BOM/CRLF/trim semantics, the 64 KB byte cap boundary (`65536`
      bytes accepted, `65537` bytes rejected — asserted at
      `src/__tests__/claudeAppendPrompt.test.ts:359-360` and the
      end-to-end launcher error message `/65536-byte cap/` +
      `/65537 bytes/` at `:836-837`), `lstat`-guarded convention
      probing, typed error contracts, single-channel stderr routing,
      and `--print-config` output across every `AppendSource` value.
  - PR-level CI is reported as `OPEN` with 4 pre-merge checks green and
    only the docstring threshold flagged as a warning (not failing).
- **Decision:** Decline.
- **Rationale:** Generic bot threshold not aligned with repo TypeScript
  conventions, not requested by the approved plan, not blocking CI, and the
  affected new surface is already covered by a 1,105-line test suite
  asserting both happy paths and typed error contracts. Adding JSDoc here
  purely to satisfy a global CodeRabbit threshold would be scope creep on a
  focused PR and would invite unrelated stylistic churn. The same decline
  was applied on PR #50 (`plans/33-root-command-should-give-you-the-help/resolution-map.md`)
  for the same threshold; staying consistent with that precedent.
- **Approach:** No code change.
- **Files To Change:** none.
- **Reply Draft:**

  > **[AI Agent]:** Acknowledged, but declining this pre-merge warning.
  > It's a generic CodeRabbit threshold (12.90% vs. 80.00%) not tied to a
  > specific correctness issue — the same review explicitly notes "No
  > actionable comments were generated in the recent review. 🎉". The repo
  > does not use JSDoc tag-based docstrings (zero `@param` / `@returns` /
  > `@throws` across `src/`), and neither `AGENTS.md` nor the approved
  > plan
  > (`plans/56-make-system-prompt-configurable/plans/56-configurable-supervisor-system-prompt.md`)
  > requires them. The new public surface is already self-documenting via
  > named types (`AppendSource`, `LoadedAppendContent`,
  > `ResolveSupervisorAppendPromptInput`,
  > `ResolvedSupervisorAppendPrompt`, the discriminated `AppendPromptError`
  > with `missing-file` / `oversize` / `read-failed` variants,
  > `ConventionPromptProbeResult`, `LoadAppendPromptInput`,
  > `LoadAppendPromptResult`) and covered by
  > `src/__tests__/claudeAppendPrompt.test.ts` (1,105 lines) asserting
  > precedence, BOM/CRLF/trim semantics, the 64 KB byte cap boundary
  > (`65536` accepted, `65537` rejected — see
  > `src/__tests__/claudeAppendPrompt.test.ts:359-360` and the launcher
  > error-message assertions at `:836-837`), lstat-guarded convention
  > probing, typed error contracts, single-channel stderr routing, and
  > `--print-config` across every `AppendSource`. Same decline precedent
  > as PR #50. Happy to revisit if we ever adopt a repo-wide JSDoc policy.
  > <!-- agent-orchestrator:pr61:c1 -->

## Comment C2 | Decline | Trivial

- **Comment Type:** conversation (embedded LanguageTool grammar batch inside the CodeRabbit auto-summary comment)
- **File(s):**
  - `plans/56-make-system-prompt-configurable/plan.md:10`
  - `plans/56-make-system-prompt-configurable/plans/56-configurable-supervisor-system-prompt.md:31`
  - `plans/56-make-system-prompt-configurable/plans/56-configurable-supervisor-system-prompt.md:62`
- **Comment ID:** `4431211822` (parent CodeRabbit summary)
- **Review ID:** N/A
- **Thread Node ID:** N/A (not posted as a review thread)
- **Author:** `coderabbitai[bot]` (LanguageTool rule `QB_NEW_EN_HYPHEN`)
- **Comment (verbatim excerpts):**

  > `plans/56-make-system-prompt-configurable/plan.md`
  > [grammar] ~10-~10: Use a hyphen to join words.
  > Context: …(append)` section when non-empty. Worker run prompts and full-prompt replacement …
  >
  > `plans/56-make-system-prompt-configurable/plans/56-configurable-supervisor-system-prompt.md`
  > [grammar] ~31-~31: Use a hyphen to join words.
  > Context: …arness prompt. - Supervisor-only. Worker run prompts are out of scope. - Three su…
  >
  > [grammar] ~62-~62: Use a hyphen to join words.
  > Context: …s blast radius small. | Also seed worker run prompts (rejected — separate user re…

- **Independent Assessment:**
  - All three flags are the same lemma — "Worker run prompts" / "worker
    run prompts" — used as a noun phrase referring to the prompts passed
    on a per-worker `start_run` (see Decision 2 in
    `plans/56-make-system-prompt-configurable/plans/56-configurable-supervisor-system-prompt.md`).
    "Worker-run" with a hyphen would read as a compound adjective
    ("prompts that are worker-run"), which subtly drifts the meaning.
    The plan author's intent is "prompts for worker runs" (the runs that
    a worker performs), where "worker run" is itself a noun phrase used
    throughout the codebase and docs (cf. `start_run`, "worker run
    prompts", "worker run lifecycle"). LanguageTool's hyphenation rule is
    a false positive for this lemma.
  - Even if one preferred the hyphenated form, all three occurrences are
    in plan/design documents under `plans/56-make-system-prompt-configurable/`,
    which are historical project artifacts authored as decision records.
    The repo treats those plan files as a record of decisions taken, not
    as evergreen documentation that is rewritten for style.
  - Neither `AGENTS.md` nor `.cursor/rules/node-typescript.mdc` requires
    LanguageTool compliance. The repo carries an explicit learning record
    (visible in the CodeRabbit comment itself) instructing that markdown
    style false-positives should be tolerated when the original spelling
    is intentional.
  - No behavior change, no correctness impact, no test impact.
- **Decision:** Decline.
- **Rationale:** False-positive grammar suggestion on a noun-phrase used
  consistently across the repo, located in immutable plan documents.
  Touching plan docs after the plan has been executed (the implementation
  commit `87ee632` ships against this plan) is the kind of stylistic churn
  the repo's plan-archive convention deliberately avoids. There is no
  user-facing surface affected.
- **Approach:** No code change, no doc change.
- **Files To Change:** none.
- **Reply Draft:**

  > **[AI Agent]:** Declining this LanguageTool batch. "Worker run prompts"
  > is a noun phrase in this codebase — "worker run" is the noun (the
  > per-worker run; cf. `start_run`, worker run lifecycle), and "prompts"
  > is the head. Hyphenating to "Worker-run prompts" would reframe it as
  > a compound adjective ("prompts that are run by workers"), which
  > subtly shifts the meaning the plan is asserting. All three flags also
  > fall in plan documents under `plans/56-make-system-prompt-configurable/`,
  > which are decision-record artifacts the repo treats as immutable
  > history. Neither `AGENTS.md` nor `.cursor/rules/node-typescript.mdc`
  > requires LanguageTool compliance, and the repo's existing learning
  > record explicitly tolerates similar markdown-style false positives.
  > No behavior or contract change.
  > <!-- agent-orchestrator:pr61:c2 -->
