# Plan Index

Branch: `42-project-doesnt-work-on-windows`
Updated: 2026-05-06

## Sub-Plans

| Plan | Scope | Status | File |
|---|---|---|---|
| Fix Claude launcher monitor pin on Windows | Make `agent-orchestrator claude` start successfully when installed under a Windows path that contains backslashes, by making `resolveMonitorPin` platform-aware (forward-slash normalization plus `path.win32`/`path.posix` `isAbsolute` selection on `win32`). | implemented (T1–T4, T6, T7); T5 manual Windows smoke pending operator | `plans/42-project-doesnt-work-on-windows/plans/42-claude-launcher-windows-monitor-pin.md` |
