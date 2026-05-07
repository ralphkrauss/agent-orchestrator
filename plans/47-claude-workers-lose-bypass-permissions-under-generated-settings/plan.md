# Plan Index

Branch: `47-claude-workers-lose-bypass-permissions-under-generated-settings`
Updated: 2026-05-07

## Sub-Plans

| Plan | Scope | Status | File |
|---|---|---|---|
| Claude worker bypass-permissions fix | Restore non-interactive worker permission posture by adding `permissions.defaultMode: "bypassPermissions"` + `skipDangerousModePermissionPrompt: true` to the per-run worker settings body and passing `--permission-mode bypassPermissions` alongside the existing `--settings` / `--setting-sources user` flags. | complete | [plans/47-claude-worker-bypass-permissions.md](plans/47-claude-worker-bypass-permissions.md) |
