# Review: Round 2 Fixes

Date: 2026-05-02
Scope: uncommitted changes for the four Round 2 PR review fixes.

## Findings

### 1. Medium: exit-0 failed runs now lose parsed backend error diagnostics

- **File:** `src/processManager.ts:233`
- **Status:** resolved in follow-up review

The change clears terminal `errors` for every `exitCode === 0`, but `exitCode === 0` is not always a successful worker result. `finalizeFromObserved()` still marks the run failed when no backend result event was emitted. In that path, parsed backend errors used to be carried into the failed result and used as the actionable summary; now the failed result only gets the generic `worker result event missing` validation error.

This regresses diagnostics for a backend that emits a structured error event and exits 0 without a result event. The new tests cover successful result events and nonzero failures, but not this exit-0/no-result failure.

Recommended fix:

```ts
const errors = terminalOverride
  ? [{ message: terminalOverride === 'timed_out' ? 'execution timeout exceeded' : 'cancelled by user' }]
  : exitCode === 0 && resultEvent
    ? []
    : [
        ...(exitCode === 0 ? [] : [{ message: 'worker process exited unsuccessfully', context: { exit_code: exitCode, signal } }]),
        ...dedupeErrors(exitCode === 0 ? parsedErrors : [...parsedErrors, ...stderrErrors]),
      ];
```

Add a regression test where a worker emits a structured backend error, emits no result event, exits 0, and the final failed result includes both the parsed backend error and `worker result event missing`.

Follow-up review: fixed. `src/processManager.ts` now clears parsed errors only for `exitCode === 0 && resultEvent`; exit-zero/no-result failures preserve parsed backend errors while omitting the generic process-exit error. `src/__tests__/processManager.test.ts` includes the requested regression.

## Notes

- The follow-up metadata assertions now correctly assert `getRunStatus()` success before reading metadata.
- Claude effort validation now rejects unknown values in the shared helper while preserving exact direct model id handling.
- The OpenCode `external_directory` change keeps manifest access exact and adds only the out-of-workspace `orchestrate-*/SKILL.md` pattern.
- `git diff --check` passed.
- Follow-up verification passed: `pnpm build` and `node --test dist/__tests__/processManager.test.js`.
