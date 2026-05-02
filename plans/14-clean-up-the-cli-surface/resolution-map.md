# PR #18 Resolution Map

Branch: `14-clean-up-the-cli-surface`
Created: 2026-05-02
Total comments: 1 | To fix: 1 | To defer: 0 | To decline: 0 | To escalate: 0

## Comment 1 | to-fix | minor

- **Comment Type:** review-inline
- **File:** `src/daemon/daemonCli.ts:261`
- **Comment ID:** `3177004406`
- **Review Comment Node ID:** `PRRC_kwDOSRv-qs69XT12`
- **Review ID:** `4215335320`
- **Thread Node ID:** `PRRT_kwDOSRv-qs5_IlKG`
- **Author:** `coderabbitai[bot]`
- **URL:** https://github.com/ralphkrauss/agent-orchestrator/pull/18#discussion_r3177004406
- **Comment:** CodeRabbit flagged the prune validation error because it prints only `agent-orchestrator prune --older-than-days <days> [--dry-run]`, even though the same `runDaemonCli()` implementation is used by the standalone `agent-orchestrator-daemon` bin. Standalone users who omit `--older-than-days` get a mismatched usage hint. The suggested intent is to print both the main CLI and standalone daemon CLI forms.
- **Independent Assessment:** Valid. `src/daemon/daemonCli.ts` exports `runDaemonCli(argv)` and `src/daemonCli.ts` invokes that same runner for the `agent-orchestrator-daemon` bin, so the current single-command error text is misleading for standalone daemon users. The reviewer's high-level fix is correct. Do not apply the committable suggestion verbatim: the suggestion block is incomplete and contains adjacent string literals without a `+`, which would not compile.
- **Decision:** alternative-fix
- **Approach:** Update the missing-`--older-than-days` branch in `prune(argv)` to print a two-line usage hint that includes both supported command forms:
  - `Usage: agent-orchestrator prune --older-than-days <days> [--dry-run]`
  - `   or: agent-orchestrator-daemon prune --older-than-days <days> [--dry-run]`

  Keep the exit behavior unchanged (`process.exit(1)`). Prefer a small helper such as `pruneUsage()` if that keeps the string readable, but avoid broader help text changes outside the prune validation error. Add focused tests that invoke both built entrypoints without `--older-than-days` and assert stderr includes the relevant command forms.
- **Files To Change:** `src/daemon/daemonCli.ts`, `src/__tests__/daemonCli.test.ts`
- **Suggested Verification:**
  - `pnpm build`
  - `node --test dist/__tests__/daemonCli.test.js`
  - `pnpm test` if the implementation touches shared daemon CLI behavior beyond the usage string
- **Reply Draft:**
  > **[AI Agent]:** Fixed. The prune validation error now shows both `agent-orchestrator prune` and `agent-orchestrator-daemon prune`, and daemon CLI tests cover the missing-argument usage path. <!-- agent-orchestrator:pr18:c1 -->

## Skipped Comments

- Skipped CodeRabbit review-body summary `4215335320` except for its single inline actionable comment above. The rest was review metadata, positive observations, LanguageTool style noise, and collapsed informational comments.
- Skipped conversation comment `4364385428` because it explicitly says no actionable comments were generated in the recent review and contains bot walkthrough/pre-merge-check metadata only.

## Implementation Plan

| Step | Action | Files |
|---|---|---|
| 1 | Add a dual-command prune usage string for missing `--older-than-days`. | `src/daemon/daemonCli.ts` |
| 2 | Add daemon CLI tests for missing prune age through `dist/cli.js prune` and `dist/daemonCli.js prune`. Assert non-zero exit and the expected usage text. | `src/__tests__/daemonCli.test.ts` |
| 3 | Build and run the focused daemon CLI test. Broaden to `pnpm test` only if implementation changes more than the usage branch. | n/a |

## Implementation Evidence

Status: implemented 2026-05-02.

- `src/daemon/daemonCli.ts`: added a dual-command `pruneUsage()` hint for the missing `--older-than-days` validation branch while preserving `process.exit(1)`.
- `src/__tests__/daemonCli.test.ts`: added regression coverage for `dist/cli.js prune` and `dist/daemonCli.js prune` without `--older-than-days`, asserting non-zero exit and both command forms in stderr.

Verification:

- `pnpm build` passed.
- `node --test dist/__tests__/daemonCli.test.js` passed: 7 tests, 0 failures.

`pnpm test` was not run because the implementation stayed within the prune usage validation branch covered by the focused daemon CLI test.

## Reply And Resolution Policy

- Do not post the reply until the fix is committed and pushed.
- After the fix is pushed and checks pass, post the drafted reply on the inline comment and resolve thread `PRRT_kwDOSRv-qs5_IlKG`.
