# Plan Index

Branch: `58-issue-with-setting-sources`
Updated: 2026-05-12 (rev. 3 — tightened after Codex review rev. 2)

## Sub-Plans

| Plan | Scope | Status | File |
|---|---|---|---|
| Worker backend-native parity (trusted worker posture) | Introduce a `worker_posture: 'trusted' \| 'restricted'` profile field defaulting to `'trusted'`, persisted on `RunModelSettings` and inherited on `send_followup`. Under `'trusted'`: Claude `--setting-sources user,project,local` + `enableAllProjectMcpServers`; Codex drops `--ignore-user-config` and uses resume-safe `-c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true`; Cursor SDK gains `local.settingSources: ['all']` for full ambient parity. Supervisor stays curated. Spawn-time `worker_posture` telemetry (CLI via `initialEvents`; Cursor via `store.appendEvent` direct). T5/T13/#47 safety contracts preserved across both postures. (Rev. 3 after `reviews/review-plan-rev2-2026-05-12.md`; rev. 2 after `reviews/review-plan-2026-05-12.md`.) | complete | [plans/58-worker-project-mcp-access.md](plans/58-worker-project-mcp-access.md) |
