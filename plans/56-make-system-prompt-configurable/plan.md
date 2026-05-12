# Plan Index

Branch: `56-make-system-prompt-configurable`
Updated: 2026-05-12

## Sub-Plans

| Plan | Scope | Status | File |
|---|---|---|---|
| Configurable Claude supervisor system prompt (append-only) | Allow users to add their own text to the Claude supervisor system prompt without touching the harness-owned isolation contract. Exposes a CLI flag pair (`--append-system-prompt` / `--append-system-prompt-file`) on `agent-orchestrator claude`, env-var fallbacks (`AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT` / `..._FILE`), and an auto-loaded convention file at `<targetCwd>/.agents/orchestrator/system-prompt.md`. A discriminated `AppendSource` (`cli-inline` \| `cli-file` \| `env-inline` \| `env-file` \| `convention-file` \| `none`) drives precedence: CLI wins over env, env over convention, with a single-line stderr notice when a present convention file is suppressed by a higher-precedence source. `--no-append-system-prompt` is an explicit escape hatch that forces `none` and suppresses all sources. The resolved user text is concatenated after the existing harness prompt into the single envelope `system-prompt.md`; spawn args stay exactly `--append-system-prompt-file <envelope-file>` (no new Claude flag surface, no second instance). `--print-config` always emits `# user system prompt source` (with the `none` sentinel) and the `# user system prompt (append)` section when non-empty. Worker run prompts and full-prompt replacement are explicitly out of scope. | planning | [plans/56-configurable-supervisor-system-prompt.md](plans/56-configurable-supervisor-system-prompt.md) |
