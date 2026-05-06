# Plan Index

Branch: `17-add-coding-backend-for-ccs`
Updated: 2026-05-06 (added follow-up sub-plan for cross-account session
resume via copy-on-rotate; supersedes the parent plan's "rotation always
calls runtime.start()" rule for in-priority rotations only — see
`17-copy-on-rotate-resume.md` HAT-COR2 for the citation back to the
upstream `shared-manager.js:412/:1048` evidence that overturned the
previous "fundamental upstream limitation" finding)

## Sub-Plans

| Plan | Scope | Status | File |
|---|---|---|---|
| Native Claude multi-account support with rotation on rate limit | Add a daemon-owned account registry plus `agent-orchestrator auth login claude --account <name>` (config_dir mode, interactive `claude /login`) and `auth set claude --account <name> ...` (api_env mode) so the orchestrator can launch `claude` worker runs against any of several accounts. Add `claude_account` / `claude_account_priority` / `claude_cooldown_seconds` fields to worker profiles and `start_run`. Detect terminal `rate_limit`/`quota` errors, mark the active account cooled-down, and on `send_followup` rotate to the next healthy account, producing a fresh chat (`terminal_context.kind === "fresh_chat_after_rotation"`). `BackendSchema` is unchanged. **Note (2026-05-06):** the "always fresh chat" caveat is superseded for in-priority rotations by `17-copy-on-rotate-resume.md`; fresh-chat remains the documented fallback shape. | implementation (uncommitted on this branch as of 2026-05-06) | plans/17-claude-multi-account.md |
| Cross-account session resume via copy-on-rotate | Make rotation between healthy `config_dir`-mode accounts produce a true continuation of the parent chat by copying the parent run's session JSONL from `<run_store>/claude/accounts/<old>/projects/<encoded-cwd>/<sid>.jsonl` to the analogous path under the new account, then invoking `claude --resume <sid>` under the new account. Plain file ops, atomic via `copyFile → chmod(tmp, 0o600) → rename`, fully portable (symlinks rejected for Windows compatibility). Rotations involving `api_env` accounts (source or target) skip the copy and fall back to today's fresh-chat shape — the `api_env` injection model has no `CLAUDE_CONFIG_DIR` for the copied JSONL to live under. Falls back to `terminal_context.kind === "fresh_chat_after_rotation"` with a structured `copy_skip_reason` on any source-missing, copy, or non-`session_not_found` resume failure. One transparent in-run retry on classifier-detected `session_not_found` via an additive `RuntimeStartInput.earlyEventInterceptor` contract on `processManager.ts`. Same-parent rotation distinctness is durable across daemon restart (D-COR-Lock reconstructs the claimed-destinations set from on-disk run-summary metadata on cache miss). Adds new `terminal_context` payload values (`"resumed_after_rotation"`, plus `copy_skip_reason` / `resume_failure_reason` / `resume_attempted` keys), an additive `metadata.claude_rotation_history[i].resumed` flag, and a single Zod enum widening on `RunErrorCategorySchema` for `"session_not_found"` (HAT-COR3). Supersedes parent plan's D8 / A3 / T8 for in-priority rotation between two `config_dir` accounts only; non-rotation `send_followup` is untouched. | planning (post-reviewer-pass-3 — three rounds of blocking findings addressed 2026-05-06; mechanics now spelled out down to `processManager.ts` event-interception contract and run-store-backed claimed-set reconstruction) | plans/17-copy-on-rotate-resume.md |

## History

The earlier sub-plan `plans/17-ccs-backend.md` (deleted) targeted a `ccs`
worker backend wrapping `claude` via
[`@kaitranntt/ccs`](https://github.com/kaitranntt/ccs). A deep-dive of
upstream `@kaitranntt/ccs@7.65.3` revealed two blockers: (1) `ccs <profile>
-p ...` triggers ccs's delegation pipeline (`ccs.js:527`,
`delegation/headless-executor.js:218`, `delegation/result-formatter.js:44`)
and emits a formatted summary report on stdout instead of raw Claude
stream-json — there is no `--quiet` flag (only `CCS_QUIET` for stderr); and
(2) cross-profile `claude --resume <id>` is unreachable because each
profile gets an isolated `CLAUDE_CONFIG_DIR=<ccsDir>/instances/<profile>`
(`instance-manager.js:88`, `ccs.js:938`) and `context_mode: shared` /
`context_group` only synchronise `projects/`, `session-env`,
`file-history`, `shell-snapshots`, `todos` — not the Claude session DB
(`shared-manager.js:407`, `:483`). The user approved the pivot to native
multi-account support; details live in `plans/17-claude-multi-account.md`.
