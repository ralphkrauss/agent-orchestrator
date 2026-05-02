# Plan Index

Branch: `16-add-coding-backend-for-cursor-sdk`
Updated: 2026-05-02 (revised: finalize synthesis for SDK exit code, missing-SDK parity with missing-binary, smoke uses temp repo copy not packed tarball, stale ManagedRun references purged, RQ1 pinned to 1.0.12)

## Sub-Plans

| Plan | Scope | Status | File |
|---|---|---|---|
| Cursor Agents SDK backend (SDK-first) | Add a third worker backend that uses the `@cursor/sdk` TypeScript SDK in-process (local runtime). Introduces a `WorkerRuntime` + `RuntimeRunHandle` abstraction (the existing `ManagedRun` inside `processManager.ts` keeps its name as a `CliRuntime` internal) so SDK and CLI backends share the orchestrator. CLI fallback and cloud runtime captured as Future Options. | planning | plans/16-cursor-agent-backend.md |
