# Plan Review Rev. 2: Worker Backend-Native Parity

Date: 2026-05-12
Reviewer: Codex
Scope:
- `plans/58-issue-with-setting-sources/plan.md`
- `plans/58-issue-with-setting-sources/plans/58-worker-project-mcp-access.md`

## Findings

### High: Codex trusted mapping uses a flag that `codex exec resume` does not support

Decision 6 and T-Codex-1 specify `--sandbox workspace-write` for trusted Codex
workers (`58-worker-project-mcp-access.md:114`, `156-157`, `231`). That works
for `codex exec`, but local `codex-cli 0.130.0` shows `codex exec resume
--help` does not accept `--sandbox` or `--cd`; it accepts `-c/--config`,
`--ignore-user-config`, and related resume flags.

Current `src/backend/codex.ts` shares `sandboxArgs()` between `start()` and
`resume()` (`src/backend/codex.ts:8-33`, `144-160`). If T-Codex-1 implements
`--sandbox workspace-write` in that shared helper, Codex follow-ups will spawn
with an invalid argv.

Recommendation: use config overrides that both start and resume accept, e.g.
`-c sandbox_mode="workspace-write"` plus
`-c sandbox_workspace_write.network_access=true`, or split start/resume argv
generation explicitly and test both paths with the local help surface.

### High: `worker_posture` persistence and follow-up inheritance are underspecified

The plan adds `worker_posture` to profiles and direct-mode schemas
(`58-worker-project-mcp-access.md:109-110`, `144-147`, `224-225`), but it does
not explicitly say where the resolved posture is persisted on the run record or
how `send_followup` inherits it. Today the runtime-visible settings are carried
through `RunModelSettings` (`src/contract.ts:253-265`), and follow-ups inherit
`parent.meta.model_settings` unless the follow-up overrides model settings
(`src/orchestratorService.ts:794-808`).

Without an explicit persistence rule, a restricted parent run can silently
produce a trusted child on follow-up, or direct-mode `send_followup` can become
ambiguous. The same ambiguity exists for profile-mode starts if a caller passes
both `profile` and a direct `worker_posture` field; the current schema already
forbids profile mode from mixing direct settings such as `codex_network`
(`src/contract.ts:361-390`), and the new field needs the same kind of rule.

Recommendation: add a decision and tasks for:

- Persisting the resolved posture, probably on `RunModelSettingsSchema` or an
  equally durable run-meta field.
- Inheriting the parent posture on `send_followup` unless a valid direct-mode
  override is supplied.
- Rejecting `profile + worker_posture` on `start_run`, or clearly defining
  precedence if you want that override.
- Adding tests for profile start, direct start, profile-mode follow-up, direct
  follow-up override, and legacy records with no posture.

### Medium: Existing explicit `codex_network: "workspace"` profiles still suppress user config

Decision 9 says explicit `codex_network` values keep winning in either posture
(`58-worker-project-mcp-access.md:117`), while the trusted default only changes
when `codex_network` is absent (`58-worker-project-mcp-access.md:154-159`,
`231`). In current code, `codex_network: "workspace"` means
`--ignore-user-config -c sandbox_workspace_write.network_access=true`
(`src/backend/codex.ts:144-155`).

That means any existing Codex profile that explicitly set `"workspace"` to get
network access will remain unable to load user config and may still miss user
MCP config after this plan lands. That is a surprising result for an issue whose
new contract is "trusted workers get backend-native user/project config and
network access."

Recommendation: either separate Codex config-source posture from network
posture, or redefine the trusted interpretation of explicit
`codex_network: "workspace"` so it enables workspace network without
`--ignore-user-config`.
If explicit values must preserve old behavior, call that out as a migration risk
and add a test proving the warning/docs explain it.

### Medium: Cursor `['project', 'user']` is not full Cursor setting-source parity

The plan's product framing says trusted workers get normal project/user config,
project MCP, and "subagents / plugins discovery where applicable"
(`58-worker-project-mcp-access.md:29-34`). But Decision 7 only passes
`local.settingSources: ['project', 'user']` for Cursor
(`58-worker-project-mcp-access.md:115`, `160-165`, `233`).

The prior documentation verification recorded that Cursor SDK
`local.settingSources` also supports `team`, `mdm`, `plugins`, and `all`
(`review-plan-2026-05-12.md:197-203`). If a manual Cursor run loads plugins,
team, or MDM-managed settings, `['project', 'user']` is not full backend-native
parity.

Recommendation: use `local.settingSources: ['all']` for trusted Cursor workers,
or explicitly narrow the product claim and risk table to "project + user only"
and explain why team/MDM/plugins are intentionally excluded.

### Medium: Cursor telemetry is not covered by the `WorkerInvocation.initialEvents` design

The plan states that `WorkerInvocation.initialEvents` and `ProcessManager`
spawn-time flushing cover backend telemetry
(`58-worker-project-mcp-access.md` lines 166-170 and 226-235). That applies to
CLI backends, but Cursor does not produce a `WorkerInvocation` and does not go
through `ProcessManager.start()`.
`CursorSdkRuntime.spawn()` returns its own runtime handle
(`src/backend/cursor/runtime.ts:68-74`, `94-208`), and Cursor lifecycle events
are appended in `drainAndFinalize()` (`src/backend/cursor/runtime.ts:277-291`).

T-Cursor-2 currently says the test should assert that the adapter receives
`settingSources` (`58-worker-project-mcp-access.md:233-234`), but that does not
prove a `worker_posture` lifecycle event reaches `get_run_events`.

Recommendation: add a Cursor-specific telemetry path, for example an
`initialEvents` field on `CursorRunState` or explicit append in
`drainAndFinalize()` before the backend stream is drained. Test both
`Agent.create` and `Agent.resume` and assert the run event log contains the
Cursor posture event.

### Low: Profile management surfaces are not explicitly in T-Profile-1

T-Profile-1 covers the manifest and direct-mode schemas
(`58-worker-project-mcp-access.md:224`), but profile management also goes
through `upsert_worker_profile`, `list_worker_profiles`, profile formatting for
supervisors, and generated MCP tool schemas. Current code has separate paths for
`UpsertWorkerProfileInputSchema`, `workerProfileFromUpsert()`,
`formatValidProfile()`, and MCP tool descriptions
(`src/contract.ts:439-485`, `src/orchestratorService.ts:2080-2115`,
`src/mcpTools.ts:1-70`).

Recommendation: expand T-Profile-1 acceptance to include upsert/list
round-trip, MCP tool schema exposure, and supervisor profile-rendering updates
so operators can actually set and inspect `worker_posture`.

## Overall Assessment

The rewrite is directionally much stronger than rev. 1. It resolves the main
product framing issue: workers are trusted execution agents, the supervisor is
curated, and Codex/Cursor are now real implementation scope rather than audit
only.

I would revise before implementation. The two blockers are the Codex resume
argv issue and the unresolved persistence/inheritance semantics for
`worker_posture`. The Cursor and Codex-default concerns are also worth tightening
now because they affect whether the implementation really delivers "manual
parity" rather than a partial approximation.

## Verification

- Read the two plan files directly; they are currently untracked, so
  `git diff HEAD` has no content for them.
- Cross-checked current source in `contract.ts`, `orchestratorService.ts`,
  `codex.ts`, `cursor/runtime.ts`, `cursor/sdk.ts`, `processManager.ts`, and
  `WorkerBackend.ts`.
- Checked local `codex exec --help` and `codex exec resume --help`.
- Did not run build/test; this was a plan review only.
