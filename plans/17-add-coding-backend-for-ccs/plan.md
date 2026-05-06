# Plan Index

Branch: `17-add-coding-backend-for-ccs`
Updated: 2026-05-05 (pivot: dropped ccs-wrapper plan; replaced with native
multi-account support on the existing `claude` backend after deep-dive of
upstream `@kaitranntt/ccs@7.65.3` showed `-p` reformats stdout away from
stream-json and cross-profile `--resume` is unreachable)

## Sub-Plans

| Plan | Scope | Status | File |
|---|---|---|---|
| Native Claude multi-account support with rotation on rate limit | Add a daemon-owned account registry plus `agent-orchestrator auth login claude --account <name>` (config_dir mode, interactive `claude /login`) and `auth set claude --account <name> ...` (api_env mode) so the orchestrator can launch `claude` worker runs against any of several accounts. Add `claude_account` / `claude_account_priority` / `claude_cooldown_seconds` fields to worker profiles and `start_run`. Detect terminal `rate_limit`/`quota` errors, mark the active account cooled-down, and on `send_followup` rotate to the next healthy account — always producing a fresh chat (`terminal_context.kind === "fresh_chat_after_rotation"`) because Claude's session DB is per `CLAUDE_CONFIG_DIR`. `BackendSchema` is unchanged. | planning | plans/17-claude-multi-account.md |

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
