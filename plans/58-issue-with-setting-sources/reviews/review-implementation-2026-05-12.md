# Implementation Review - 2026-05-12

## Findings

### High - Default trusted Codex runs still do not get the trusted network posture

`modelSettingsForBackend()` resolves an omitted Codex `codex_network` to
`'isolated'` before the backend sees it
(`src/orchestratorService.ts:2366-2385`). The new trusted backend mapping only
emits the workspace-write/network-on `-c` flags when `settings.codex_network`
is absent or `null`; when it sees `'isolated'`, it emits no sandbox flags
(`src/backend/codex.ts:173-183`).

That means the actual `start_run({ backend: 'codex', worker_posture omitted,
codex_network omitted })` path persists `worker_posture: 'trusted'` and
`codex_network: 'isolated'`, then spawns Codex without
`-c sandbox_mode="workspace-write"` or
`-c sandbox_workspace_write.network_access=true`. This contradicts the plan and
docs claim that trusted Codex defaults to workspace-write with network on
(`docs/development/mcp-tooling.md:69-75`) and directly misses the product goal
for default workers.

The existing backend unit test covers a synthetic `codex_network: null` input,
but not the service-resolved start path. Add an integration test for direct and
profile Codex starts with omitted `codex_network` under the default trusted
posture, asserting the recorded worker invocation has the trusted `-c` flags and
no `--ignore-user-config`. The implementation then needs to either preserve the
"unset" signal into `sandboxArgs()` or change the resolver/backend contract so
trusted defaults cannot collapse to the explicit isolated cell.

### Medium - Cursor records `worker_posture` even when `agent.send()` fails

`CursorSdkRuntime.spawn()` appends the `worker_posture` lifecycle event
immediately after `Agent.create()` / `Agent.resume()` succeeds
(`src/backend/cursor/runtime.ts:205-221`), but the prompt is not actually sent
until after that (`src/backend/cursor/runtime.ts:227-235`). If `agent.send()`
throws, the runtime returns a `SPAWN_FAILED` pre-spawn failure while the run's
event log already contains a `worker_posture` event.

That violates the Decision 18 invariant documented in the same block and docs:
pre-spawn failures should emit no posture event
(`docs/development/mcp-tooling.md:83-92`). The current test only covers adapter
load failure before `Agent.create()` (`src/__tests__/cursorRuntime.test.ts:872-886`),
so this send-failure case is not covered.

Move the append until after `agent.send()` returns a `CursorRun` while still
before drain appends SDK stream events, or explicitly reclassify send failures
as post-spawn failures. Add a test with a fake agent whose `send()` rejects and
assert no `worker_posture` event is written if it remains a pre-spawn failure.

### Medium - CLI retry path can drop all `worker_posture` telemetry

`ProcessManager` routes `initialEvents` through `appendEventBuffered()` when an
early retry interceptor is armed (`src/processManager.ts:240-249`). On
`retry_with_start`, that buffer is intentionally dropped
(`src/processManager.ts:340-351`). The retry invocation then has
`initialEvents` stripped by `CliRuntime.buildStartInvocation()`
(`src/backend/runtime.ts:109-118`) and is spawned without a posture event
(`src/processManager.ts:132-134`).

In the Claude rotation/session-not-found path, this can leave the completed
worker run with zero `worker_posture` event even though an actual retry worker
spawned. That conflicts with the new rule that every worker spawn emits one
posture lifecycle event (`.agents/rules/worker-posture.md:40-46`) and with the
documentation that the event answers "what did this worker actually load?"
(`docs/development/mcp-tooling.md:83-89`).

Add a resume-interceptor test with `initialEvents` on the first invocation and a
retry invocation, then assert exactly one posture event remains after the retry.
The fix could preserve the first attempt's posture event outside the cancelled
stream buffer, or attach a fresh posture event to the actual retry spawn while
still keeping the pre-baked invocation from writing false telemetry if it never
spawns.

### Low - Supervisor-facing profile guidance still describes the old Codex posture model

Several surfaces used by supervisors/operators still describe `codex_network`
with pre-#58 semantics: `mcpTools.ts` says `isolated (default)` means
`--ignore-user-config` and no network, and `workspace` also skips user config
(`src/mcpTools.ts:37-45`, `src/mcpTools.ts:121-129`). The capability catalog
note says the same (`src/harness/capabilities.ts:107-116`), and the OpenCode
supervisor prompt says profile ids map to `codex_network` only, without
mentioning `worker_posture` (`src/opencode/config.ts:172-177`).

These are contract surfaces for agents, not just prose docs. After this change,
agents can be told to configure the wrong field for the desired access posture,
or believe `codex_network: isolated` is closed when trusted posture still loads
user/project config. Update the tool descriptions, capability notes, and
supervisor prompt/profile rendering to explain the two axes: `worker_posture`
controls config/MCP visibility; `codex_network` controls the Codex sandbox
network shape within that posture.

## Verification

I did not rerun `pnpm verify`; the implementer reported it passed. This review
inspected the working tree diff, changed source paths, relevant docs, and
project rules.
