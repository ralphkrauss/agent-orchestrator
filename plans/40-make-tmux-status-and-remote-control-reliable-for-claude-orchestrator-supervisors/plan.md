# Plan Index

Branch: `40-make-tmux-status-and-remote-control-reliable-for-claude-orchestrator-supervisors`
Updated: 2026-05-06 (revision 5 — human Open-Human-Decisions answers applied; H1, H2, H4, H6-method resolved)

## Sub-Plans

| Plan | Scope | Status | File |
|---|---|---|---|
| Orchestrator Status Hooks | Daemon-owned orchestrator identity + 5-state aggregate status, supervisor-to-daemon turn signaling via harness-generated Claude Code hooks (pinned CLI; nested `hooks.<EventName>` shape verified against Claude 2.1.129), user-level `agent-orchestrator` hook interface (`~/.config/agent-orchestrator/hooks.json` v1, **Claude-parity shell-string schema** `{type, command, env?, timeout_ms?}`, daemon-side `shell:true`), worker subprocess isolation (multiplexer env stripped + `disableAllHooks: true` for Claude workers, no `CLAUDE_CONFIG_DIR` redirect by default), launcher flags `--remote-control` and `--orchestrator-label` confirmed, supervisor status read via the new `agent-orchestrator supervisor status` CLI subcommand (no public MCP tool in v1). Tmux remains a documented user-hook example, not built-in product behavior. | planning (rev 5) | `plans/40-make-tmux-status-and-remote-control-reliable-for-claude-orchestrator-supervisors/plans/40-orchestrator-status-hooks.md` |
