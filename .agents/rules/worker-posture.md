---
description: "Worker posture: trusted is the default; supervisor stays curated; isolation is profile opt-in"
paths:
  - "src/backend/**/*.ts"
  - "src/orchestratorService.ts"
  - "src/contract.ts"
  - "src/harness/capabilities.ts"
  - "src/mcpTools.ts"
globs:
  - "src/backend/**/*.ts"
  - "src/orchestratorService.ts"
  - "src/contract.ts"
  - "src/harness/capabilities.ts"
  - "src/mcpTools.ts"
---

# Worker Posture

Issue #58 introduces a `worker_posture: 'trusted' | 'restricted'` field on
the `WorkerProfile`, the direct-mode `start_run` / `send_followup` inputs,
and the persisted `RunModelSettings`. Defaults to `'trusted'`.

- Workers default to `trusted`: backend-native parity with a manual run from
  the project worktree. Each backend translates `trusted` to its own
  surface — Claude broadens `--setting-sources` to `user,project,local` and
  adds `enableAllProjectMcpServers`; Codex drops `--ignore-user-config` and
  uses resume-safe `-c` overrides; Cursor passes `local.settingSources:
  ['all']` to the SDK.
- The Claude **supervisor** envelope (`buildClaudeSpawnArgs`) is always
  restricted. It must not read `worker_posture` or branch on it.
- `restricted` posture is the profile opt-in for the pre-#58 closed-by-default
  envelope. New code paths that change worker behavior should ask "what does
  this look like under restricted?" before changing the default.
- Profile mode rejects `profile + worker_posture` (and direct-mode
  `worker_posture` on profile-mode chains in `send_followup`) the same way
  `codex_network` is rejected today — to keep the profile manifest
  authoritative for the chain.
- The resolved posture is persisted on `RunModelSettings.worker_posture`.
  Legacy `null` is tolerated on read and normalized to a concrete posture on
  child-record write (same pattern as `codex_network: null → 'isolated'`).
- Every worker spawn emits one `{ type: 'lifecycle', payload: { state:
  'worker_posture', backend, worker_posture, ... } }` event so operators
  can see the chosen posture in `get_run_events`. CLI backends emit via
  `WorkerInvocation.initialEvents`; Cursor emits via
  `store.appendEvent()` after `Agent.create`/`Agent.resume` succeeds and
  before the first SDK stream message.
