# Plan Index

Branch: `42-project-doesnt-work-on-windows`
Updated: 2026-05-06

## Sub-Plans

| Plan | Scope | Status | File |
|---|---|---|---|
| Fix Claude launcher monitor pin on Windows | Make `agent-orchestrator claude` start successfully when installed under a Windows path that contains backslashes, by making `resolveMonitorPin` platform-aware (forward-slash normalization plus `path.win32`/`path.posix` `isAbsolute` selection on `win32`). | implemented (T1–T4, T6, T7); T5 manual Windows smoke pending operator | `plans/42-project-doesnt-work-on-windows/plans/42-claude-launcher-windows-monitor-pin.md` |
| Make justfile recipes run natively on Windows | Rewrite the `justfile` so every recipe runs under PowerShell Desktop without Git Bash. Pin `windows-shell` to PowerShell Desktop; **keep** `set positional-arguments` globally (load-bearing for `[script("node")]` argv forwarding per T0); convert all 13 parameter-taking recipes to `[script("node")]` so `just` invokes `node <tempfile> <recipe-args>` directly without a shell tokenizer in the path (raises `just` floor to `>= 1.44`, the `[script]` stabilization version); each recipe body is a two-line `pathToFileURL(path.resolve(...))` import that loads a focused helper under `scripts/just/` (`cli.mjs` for 8 recipes, `passthrough.mjs` for 3, `local-cli.mjs` for 2); move POSIX-only logic in the 3 no-param Class 3 recipes (`agent-orchestrator-local-clean`, `ai-files`, `agent-orchestrator-local-home`) into focused Node helpers; drop the parse-time backtick and add no replacement parse-time path variable (path resolution moves into the script body, away from `just`-substituted JS string literals). The Git Bash requirement for `agent-orchestrator claude` itself is unchanged. No new dev deps. No `src/` changes. | ready-for-implementation | `plans/42-project-doesnt-work-on-windows/plans/42-justfile-windows-native.md` |
