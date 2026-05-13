# Implementation Follow-Up Review - 2026-05-12

## Findings

### Medium - Trusted Codex default now has an unsilenceable warning and stale public docs

The high-priority functional fix is present: `modelSettingsForBackend()` now
persists `codex_network: null` for trusted+absent Codex runs, and
`sandboxArgs()` maps that cell to the trusted default `sandbox_mode` +
`network_access` flags.

The remaining issue is the `codex_network_defaulted` warning path and docs. The
service still emits a warning for trusted+absent Codex runs and tells users to
"Set codex_network explicitly to silence this warning"
(`src/orchestratorService.ts:407-412`). Under the new mapping, there is no
explicit `codex_network` value that preserves the same argv as the trusted
default: `null` emits both `sandbox_mode="workspace-write"` and network access,
`workspace` emits only network access, and `isolated` / `user-config` emit no
sandbox flags (`src/backend/codex.ts:173-183`). So every profile that wants the
new default gets a persistent warning that cannot be silenced without changing
behavior.

The public docs still reinforce the old model in a few places:
`docs/development/codex-backend.md:70-74` says omitted `codex_network` resolves
to `'isolated'` uniformly, `docs/development/codex-backend.md:121-127` shows the
old warning text, and `docs/reference.md:151-159` still documents
`codex_network` as if `worker_posture` did not exist.

Suggested fix: either suppress `codex_network_defaulted` for
`worker_posture: 'trusted'` because the absence is now the intended default, or
introduce an explicit way to select the trusted-default cell. Then update the
Default, Per-Run Warning, and reference docs so they match the posture-aware
contract.

### Medium - `list_worker_profiles` still accepts invalid `worker_posture`

`WorkerProfileSchema` accepts `worker_posture` as any non-empty string
(`src/harness/capabilities.ts:48-52`), and the list/inspect validation path does
not check it in `validateProfile()` or the backend-specific validators
(`src/harness/capabilities.ts:237-340`). A hand-edited manifest with
`worker_posture: "trustd"` will therefore appear in `list_worker_profiles` as a
valid profile, then fail only later when `start_run` reaches
`parseProfileModelSettings()` (`src/orchestratorService.ts:2247-2253`).

That differs from `reasoning_effort`, `service_tier`, and `codex_network`, which
are surfaced as invalid profile diagnostics before the supervisor chooses a
worker. Since the supervisor is expected to use `list_worker_profiles` as the
profile health check, invalid `worker_posture` should be reported there too.

Suggested fix: add a `WORKER_POSTURE_VALUES = ['trusted', 'restricted']` check
to the harness profile validation path for all backends, and add a
`list_worker_profiles` test proving a bad posture lands in `invalid_profiles`.

## Notes

The previous implementation findings are otherwise addressed:

- Default trusted Codex direct/profile starts now have integration coverage for
  `sandbox_mode="workspace-write"`, network access, no `--ignore-user-config`,
  and persisted `codex_network: null`.
- Cursor appends `worker_posture` after `agent.send()` resolves, with a
  send-failure regression test.
- CLI retry keeps retry `initialEvents`, with a retry-path regression test for
  exactly one surviving posture event.
- Supervisor prompt/tool descriptions were updated, apart from the stale public
  reference/default docs noted above.

I did not rerun `pnpm verify`; the implementer reported it passing after the
follow-up.
