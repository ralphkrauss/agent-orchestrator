# Plan Index

Branch: `27-add-first-class-daemon-auth-setup-for-cursor-api-keys`
Updated: 2026-05-04

## Sub-Plans

| Plan | Scope | Status | File |
|---|---|---|---|
| Daemon auth setup for provider credentials (Cursor first) | Add a generic `agent-orchestrator auth` command surface, a user-level secrets file at `~/.config/agent-orchestrator/secrets.env`, and have the daemon load it on startup with env-var precedence. Wire Cursor end-to-end; `claude`/`codex` reserved as stubs in the provider table. Update `doctor` to identify the auth source in human output without exposing the secret. | complete | plans/27-daemon-auth-setup.md |
