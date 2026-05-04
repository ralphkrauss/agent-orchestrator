# Cursor Agents SDK Backend (SDK-first)

Branch: `16-add-coding-backend-for-cursor-sdk`
Plan Slug: `cursor-sdk-backend` (file retained as `16-cursor-agent-backend.md` for branch continuity)
Parent Issue: #16
Created: 2026-05-02
Updated: 2026-05-03 (RQ1 superseded — human policy: always pull the latest `@cursor/sdk` version; spec relaxed to `^1.0.12` so the optional dependency tracks new releases through the lockfile)
Status: implementation complete (Round-2 PR review fixes applied 2026-05-04; `pnpm verify` clean via `pnpm.overrides`).

## Context

Issue #16 asks for a coding backend that uses Cursor's recently released
coding SDK. The user has explicitly chosen the **`@cursor/sdk` TypeScript
SDK** as the integration target, even where that requires changing the
backend abstraction. Rationale (verbatim from the user): "using an SDK should
provide better typed results and better integrations; if current backend
abstraction does not fit, design a better abstraction."

### How `@cursor/sdk` Differs From Codex/Claude

The existing two backends (`src/backend/codex.ts`, `src/backend/claude.ts`)
spawn a CLI subprocess, write a prompt to stdin/argv, and parse a JSONL
event stream from stdout. The `WorkerBackend` interface
(`src/backend/WorkerBackend.ts`) is built around that subprocess shape:
`start()` and `resume()` return `WorkerInvocation { command, args, cwd,
stdinPayload }` which `processManager` then spawns and pipes through
`parseEvent`.

`@cursor/sdk` is fundamentally different:

- **In-process Node library**, not a CLI. There is no binary to spawn,
  no stdin to pipe, no stdout to parse line-by-line.
- Lifecycle is **two-tiered**: a durable `SDKAgent` (long-lived
  conversation/workspace container, identified by `agentId`) and a
  `Run` (one prompt submission, identified by `runId`).
- Events are a **typed discriminated union** (`SDKMessage`) consumed
  via `for await (const event of run.stream())`.
- Cancellation is a method call: `run.cancel(): Promise<void>`, not a
  POSIX signal to a child process.
- Resume is `Agent.resume(agentId, options?)`; the orchestrator must
  persist the durable `agentId`, not just a single session id.
- Errors are a **typed class hierarchy**
  (`CursorAgentError` and subclasses like `AuthenticationError`,
  `RateLimitError`, `ConfigurationError`, `NetworkError`).
- Auth is `CURSOR_API_KEY` (env var or constructor option). No CLI
  binary on PATH.
- Runtime is selectable: `local: { cwd }` (in-process, files from
  disk), `cloud: { repos, ... }` (Cursor-hosted VMs, repo cloning,
  optional auto-PR), or self-hosted pool.

This means the existing abstraction must be widened to support a
non-subprocess backend kind. This plan designs that widening (one new
interface, no behavior change for Codex/Claude) and lays the SDK
backend on top.

### Sources Read

- `AGENTS.md`, `CLAUDE.md`, `.agents/rules/node-typescript.md`,
  `.agents/rules/ai-workspace-projections.md`, `.agents/rules/mcp-tool-configs.md`
- `src/contract.ts` (`BackendSchema`, `WorkerResultStatusSchema`,
  `BackendDiagnosticSchema`, `RunModelSettingsSchema`, `RunSummarySchema`)
- `src/backend/WorkerBackend.ts`, `src/backend/common.ts`,
  `src/backend/registry.ts`, `src/backend/codex.ts`, `src/backend/claude.ts`
- `src/diagnostics.ts` (binary detection, env-var auth detection)
- `src/orchestratorService.ts` (`startManagedRun`, `modelSettingsForBackend`,
  `validateInheritedModelSettingsForBackend`, direct + profile + follow-up paths)
- `src/processManager.ts` (subprocess lifecycle, signal-based cancel)
- `src/mcpTools.ts` (the `start_run` schema literally hardcodes
  `enum: ['codex', 'claude']` for `backend`; this file must be edited)
- `src/opencode/capabilities.ts` (catalog and profile validation)
- `src/__tests__/backendInvocation.test.ts`, `src/__tests__/codexBackend.test.ts`,
  `src/__tests__/integration/orchestrator.test.ts`
- Cursor SDK docs:
  - https://cursor.com/docs/sdk/typescript
  - https://cursor.com/docs/api/sdk/typescript
  - https://cursor.com/blog/typescript-sdk
  - https://github.com/cursor/cookbook
- Cursor CLI docs (kept only as rejected-alternative reference): https://cursor.com/cli/headless

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| D1 | Integration target | **`@cursor/sdk` TypeScript SDK**, in-process. | User-chosen; provides typed event/result/error surfaces and avoids brittle JSONL parsing. | (a) `cursor-agent` CLI subprocess — kept only as a rejected alternative / possible future fallback (see "Future Options"). (b) Both at once — premature; ship SDK first. |
| D2 | Backend enum value in `BackendSchema` | `cursor` | Short, matches `codex`/`claude` style. The fact that the implementation uses an SDK rather than a CLI is an internal detail. | `cursor-sdk` (leaks implementation), `cursor-agent` (would suggest the CLI). |
| D3 | Backend abstraction shape | **Introduce a thin `WorkerRuntime` interface** above (or alongside) `WorkerBackend`. `WorkerRuntime.start(input)` and `.resume(...)` each return a **`RuntimeRunHandle`** (deliberately a different name from the existing `ManagedRun` in `src/processManager.ts:12` to avoid collision). The handle owns: an async iterable of parsed events, a cooperative `cancel()`, a `dispose()` for runtime-specific cleanup, a `wait()` that resolves once the run reaches a terminal state, and a `sessionId()` accessor. The existing CLI backends implement `WorkerRuntime` via a `CliRuntime` adapter that wraps the current `processManager` + `WorkerBackend.parseEvent` pipeline (`processManager.ManagedRun` keeps its name and shape internally). The new `CursorSdkRuntime` implements it via the SDK directly. `orchestratorService.startManagedRun` consumes `RuntimeRunHandle`. **Ownership rules (single-writer for in-flight runs):** the runtime is the only writer for `appendEvent`, the terminal `markTerminal` write, and any meta updates triggered by stream events (e.g., `session_id`, `worker_pid`/`worker_pgid` for CLI). `orchestratorService` only writes terminal state on the pre-spawn failure path (binary/import missing, pre-flight validation) and the orphan-recovery path (where no runtime is alive). This eliminates today's risk of `processManager` and `orchestratorService` racing on `markTerminal` for the same run. | (a) Discriminated `kind: 'cli' \| 'sdk'` field on `WorkerBackend` — leaks the discriminator into every call site. (b) Branching inside `processManager` — pollutes process-management logic with non-process code. (c) Wholesale rewrite — out of scope. (d) Reusing the existing `ManagedRun` name across both layers — name shadowing across modules is exactly what the reviewer flagged. |
| D4 | Backward compatibility for Codex/Claude | The `CliRuntime` adapter wraps the **existing** `WorkerBackend` implementations unchanged. `start()`/`resume()`/`parseEvent()` keep their signatures. Only `orchestratorService` and a small slice of `processManager` are touched to call through `RuntimeRunHandle` (the existing `ManagedRun` type inside `processManager.ts` keeps its name and shape). | Avoids regressions in Codex/Claude — both have real-world users and the existing `__tests__/backendInvocation.test.ts` and `__tests__/integration/orchestrator.test.ts` keep passing untouched. | Reshape `WorkerBackend` itself — bigger blast radius for no SDK-specific gain. |
| D5 | Runtime scope | **Local runtime only** (`local: { cwd }`). Cloud and self-hosted are out of scope. | The repo's mission (`AGENTS.md`) is "coordinating local Codex and Claude worker CLI runs". Local SDK runs match that mental model: they run inline in the daemon Node process, files come from the on-disk repo, no remote VM lifecycle. Cloud needs repo URL/ref, autoCreatePR, run-survives-daemon-restart semantics, and webhook-style fetch-by-id — a much bigger plan. | Cloud — captured as Future Options. |
| D6 | Adding `@cursor/sdk` as a runtime dependency | **`@cursor/sdk` is added to `optionalDependencies` AND consumed via a dynamic `import('@cursor/sdk')` behind a small adapter (`src/backend/cursor/sdk.ts`).** Reviewer-approved (OQ1). The package is bundled into the published artifact like any dependency; the dynamic import is what guarantees the daemon still works when the SDK module is absent. **Honest framing of `optionalDependencies`:** by default npm/pnpm install optional deps just like normal ones; the value of marking it optional is (a) install proceeds even if the SDK fails to install (e.g. registry restrictions, platform issues) and (b) consumers can opt out with `pnpm install --no-optional` / `npm install --omit=optional`. This does **not** automatically keep installs lean for Codex/Claude-only users — the dynamic import does the work of making the cursor code path absent-safe at runtime. | (a) `dependencies` — install would hard-fail without the SDK. (b) `peerDependencies` — would push install responsibility onto every consumer. (c) `devDependencies` — wrong; we need it at runtime when present. |
| D7 | Auth | `CURSOR_API_KEY` env var (or pass through to the SDK constructor at start-time). Diagnostics report `auth_unknown` if absent and recommend the dashboard. | Matches the SDK's documented auth flow and mirrors how Codex/Claude check `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`. | Login persistence files — the SDK does not expose them. |
| D8 | Diagnostics shape for an SDK backend | **No schema change.** Reuse `BackendDiagnosticSchema` exactly as-is. Populate `binary: "@cursor/sdk"` and `path: <resolved module path or null>`. The `path === null` case maps to `status: "missing"` with an install hint. Add a check named `"@cursor/sdk module resolvable"` to the `checks` array. Keep `authEnv: ['CURSOR_API_KEY']` so env-var presence drives the auth field. The optional `Cursor.me()` probe is gated (off by default) and surfaces only as an additional `checks` entry when explicitly enabled. | Reuses the existing diagnostic shape so the MCP `get_backend_status` tool needs no schema break. Treats `binary` semantically as "the thing whose presence proves the backend is installed" — for SDK backends that is the npm package id, not a CLI binary. | Add a parallel `SdkDiagnostic` schema — would force a contract change and dual UI in `formatBackendStatus`. Make `binary` optional in the schema — a contract change for one backend's convenience. |
| D9 | Session/resume mapping | Persist **two ids**: `agentId` (durable container, mapped to `RunSummarySchema.session_id`) and `lastRunId` (most recent run id, surfaced in observability metadata only — no schema change). Resume calls `Agent.resume(agentId, { apiKey, local: { cwd } })` (per-call options must include `apiKey` and the original `local.cwd`, since the SDK does not infer them from the prior `Agent.create`), then `agent.send(prompt, sendOptions)`. **Per-follow-up overrides** (model in particular) flow through `agent.send(prompt, { model: { id, params } })` — the SDK documents `model` on `SendOptions` as a per-send override that becomes sticky on the agent. The runtime must therefore pass `SendOptions.model` for follow-ups whose `model` differs from the parent. | The SDK requires `agentId` + reauthenticated options for resume; `runId` is per-prompt and not the resume key. Per-send `model` is the documented override surface. | Use `runId` as `session_id` — would break resume entirely. Pass overrides via a fresh `Agent.create` — discards conversation state. |
| D10 | Event mapping (SDKMessage → ParsedBackendEvent) | `system`/`status` → `lifecycle`; `assistant` (extract `TextBlock` text and `ToolUseBlock`) → `assistant_message` + `tool_use`; `tool_call` → `tool_use`, with `filesChanged` populated when `args.path`/`args.file_path` is present and `commandsRun` when `args.command` is present, and a `tool_result` event when `status === 'completed'`; `thinking` → `lifecycle` (we do not surface raw thinking text into the run log); `task` → `lifecycle`; `request` → `lifecycle`; `error` (from a `status: 'ERROR'` message OR a thrown `CursorAgentError`) → `error` with structured context including the SDK error class name and `code`. | Reuses the existing `WorkerEventTypeSchema` (`assistant_message \| tool_use \| tool_result \| error \| lifecycle`) — no contract break. | Extending `WorkerEventTypeSchema` — would propagate to every consumer for marginal benefit. |
| D11 | Final result derivation | Reuse `finalizeFromObserved` (`src/backend/common.ts`), but **synthesize a CLI-shaped `FinalizeContext` from the SDK terminal state** so existing logic that treats `exitCode !== 0` as failure stays correct: <br>• `Run.status === "finished"` → `exitCode: 0`, `signal: null`, `resultEvent: { summary: Run.result ?? "", stopReason: "complete", raw }`. <br>• `Run.status === "error"` → `exitCode: 1` (or the numeric code from a typed error if available), `signal: null`, `resultEvent: { summary: Run.result ?? "", stopReason: "error", raw }`. <br>• `Run.status === "cancelled"` → `exitCode: null`, `signal: null`, `resultEvent: { summary: Run.result ?? "", stopReason: "cancelled", raw }`, **`runStatusOverride: "cancelled"`** so `deriveObservedResult` does not collapse the cancel into a `completed` state. <br>• Per-run timeout in `orchestratorService` → `runStatusOverride: "timed_out"` (already plumbed today). | The default `deriveObservedResult` in `src/backend/common.ts` predicates failure on `exitCode !== 0`; an SDK run with no real exit code must look "successful" only when explicitly synthesised as 0. The cancel override is required because a `stopReason: "cancelled"` alone is not currently a terminal-status discriminator — only `runStatusOverride` is. (Reviewer fix #1.) | Hand-roll a parallel result derivation just for cursor — drift risk. Pass `exitCode: null` for finished runs — `finalizeFromObserved` would treat the run as a failure. |
| D12 | Cancellation | `RuntimeRunHandle.cancel()` for the cursor backend calls `run.cancel()` on the SDK `Run` object and waits for the `for await` stream to drain (bounded timeout). On any terminal state (completed, failed, cancelled, timed out), the runtime calls `agent[Symbol.asyncDispose]()` (preferred) or `agent.close()` to release the SDK agent's resources before resolving `dispose()`. The CLI backends keep their existing signal-based cancel via `processManager.cancel`; `CliRuntime.dispose()` is a no-op beyond what `processManager` already does. | Matches the SDK's cooperative-cancellation contract and the SDK's documented disposal pattern (`Symbol.asyncDispose` / `await using`). | Skipping disposal — leaks the SDK agent's internal resources across daemon-process lifetime. SIGINT to the daemon process — would also kill Codex/Claude runs. |
| D17 | Missing-SDK semantics on `start_run` | **Match the missing-CLI-binary path, do not use `BACKEND_NOT_FOUND`.** The cursor backend is **always registered** in the runtime registry, even when `@cursor/sdk` cannot be imported. `BACKEND_NOT_FOUND` (in `OrchestratorErrorCodeSchema`) is reserved for "the user passed an unknown backend name" and would lie if returned for a known but uninstalled backend. Instead, `CursorSdkRuntime.start()` (and `.resume()`) detects the SDK absence via the `T-Adapter` `available()` probe and **routes through the existing pre-spawn-failure path** (`orchestratorService.failPreSpawn`-equivalent) so the run becomes a **durable failed run** in the run store with `OrchestratorErrorCodeSchema = "WORKER_BINARY_MISSING"` and `details: { binary: "@cursor/sdk", install_hint: "npm install @cursor/sdk" }`. The error code is reused unchanged so no contract widening is needed; the field semantically already carries "the thing the worker needs in order to start" (D8 makes the same call for diagnostics). Diagnostics independently report `status: "missing"` so observability stays consistent with the failed run. | Reuses an existing OrchestratorErrorCode without contract widening; mirrors the user-facing experience of `claude` or `codex` not being on PATH (also a durable failed run today); makes `list_runs` and observability surface the failure with full context instead of a transient MCP-level error. (Reviewer fix #2.) | (a) `BACKEND_NOT_FOUND` — wrong: the backend is registered, just not runnable. (b) New error code like `WORKER_RUNTIME_UNAVAILABLE` — contract change for one backend's convenience; can be done later if `WORKER_BINARY_MISSING` proves misleading. (c) De-registering cursor when the SDK is absent — would surface as "unknown backend" in CLI/MCP enums, breaking the diagnostic story. |
| D13 | Model handling | First cut: `model` flows through to `model: { id: <model> }` in `Agent.create` (and to `SendOptions.model` for follow-up overrides per D9). `requires_model: true` for parity with Codex/Claude. **`reasoning_effort` AND `service_tier` are both rejected** at the `orchestratorService` boundary with `INVALID_INPUT` for cursor. Reviewer ruling: the SDK exposes per-model parameters (e.g. `thinking: "low"\|"high"`) but the mapping requires `Cursor.models.list()` discovery to be honest about per-model support — that is captured as Future Options. Capability catalog declares `reasoning_efforts: []` and `service_tiers: []` so profile validation rejects them up-front. | Predictable surface; matches what Codex/Claude do today (boundary validation rather than silent drops); avoids hand-wired parameter mapping that drifts as Cursor adds models. | Pre-mapping `reasoning_effort` to `thinking` for "composer-2"-style models — would hardcode model ids and parameter names that change across SDK versions. Silently dropping the settings — surprise behavior. |
| D14 | Capability `variants` | `variants: []` for now. Model discovery (e.g. `Cursor.models.list()`) is an obvious follow-up but adds a network call and a new MCP surface; deferred. | Keeps this plan scoped. | Pre-define `composer-2` as a variant — hardcodes a model id we can already pass via `--model`/`model`. |
| D15 | Test isolation from the SDK | Production code uses a single thin adapter module (`src/backend/cursor/sdk.ts`) that does the dynamic `import('@cursor/sdk')`. Tests inject a fake adapter via constructor injection on `CursorSdkRuntime`. **No test ever calls the real SDK or hits the network.** | Required for hermetic CI; matches the existing pattern for binary mocks (Codex/Claude mock binaries) translated to the SDK world. | Mocking via a global module hook — fragile. |
| D16 | Docs | New page `docs/development/cursor-backend.md` covering: install (`npm install @cursor/sdk`), `CURSOR_API_KEY` setup, local-runtime scope, profile example, supported settings, error mapping, billing note. **README.md** updated for prerequisites, the `cursor` enum value in MCP tools, optional dep, and the local-only scope. | Public MCP contract changes; users need to know the SDK is an optional dep. | Docs-only without README — miss the contract change. |

## Backend Abstraction Design

The new `WorkerRuntime` interface (sketch only; not source code).
Note: the handle type is named **`RuntimeRunHandle`** to avoid collision with
the existing `ManagedRun` in `src/processManager.ts`.

```text
interface RuntimeRunHandle {
  // Async iterable of parsed events as they arrive.
  events: AsyncIterable<ParsedBackendEvent>;
  // Cooperative cancel; resolves once the runtime acknowledges.
  cancel(): Promise<void>;
  // Runtime-specific cleanup (close SDK agent, free resources). Idempotent.
  dispose(): Promise<void>;
  // Resolves when the run reaches a terminal state.
  wait(): Promise<{
    exitCode: number | null;       // null for SDK runs
    signal: NodeJS.Signals | null; // null for SDK runs
    finalize: FinalizeContext;
  }>;
  // Stable session ids surfaced for resume + observability.
  sessionId(): string | null;
}

interface WorkerRuntime {
  readonly name: Backend;
  start(input: BackendStartInput): Promise<RuntimeRunHandle>;
  resume(sessionId: string, input: BackendStartInput): Promise<RuntimeRunHandle>;
}
```

### Ownership rules (single-writer for in-flight runs)

| Concern | Owner |
|---|---|
| `runStore.appendEvent` for stream events | `WorkerRuntime` (via the runtime's internal pump) |
| Meta updates from stream events (`session_id`, CLI `worker_pid`/`worker_pgid`) | `WorkerRuntime` |
| `markTerminal` for normal completion, parser-derived failure, cancel, or per-run timeout | `WorkerRuntime` |
| `markTerminal` for pre-spawn failure (binary missing, dynamic SDK import failure, pre-flight validation) | `orchestratorService` (no runtime exists yet) |
| `markTerminal` for orphan recovery on daemon startup | `orchestratorService` (no runtime is alive) |
| Cancellation request entry point | `orchestratorService.cancel_run` → `RuntimeRunHandle.cancel()` |
| Cancellation state machine (transition to `cancelled`) | `WorkerRuntime` |
| Final `dispose()` (close SDK agent, drain processes) | `WorkerRuntime`, called once after `wait()` resolves or `cancel()` completes |

This eliminates today's risk that `processManager` and `orchestratorService`
both call `markTerminal` for the same run.

### Adapters

`CliRuntime(workerBackend, processManager)` wraps the existing flow:
calls `workerBackend.start()`/`resume()` to get `WorkerInvocation`, hands
it to `processManager.start(...)`, threads each stdout line through
`workerBackend.parseEvent`. The internal `processManager.ManagedRun`
keeps its current name and shape — only the `CliRuntime` is the new
public-facing surface. Codex/Claude code is unchanged.

`CursorSdkRuntime(sdkAdapter)` wraps the SDK:

- `start({ prompt, cwd, model, ... })` →
  `Agent.create({ apiKey, model: { id: model }, local: { cwd } })` →
  `agent.send(prompt)`. Persist `agent.agentId` as the run's session id.
- `resume(agentId, { prompt, cwd, model, ... })` →
  `Agent.resume(agentId, { apiKey, local: { cwd } })` →
  `agent.send(prompt, model ? { model: { id: model } } : undefined)`.
  Per D9, `apiKey` and `local.cwd` must be re-supplied on resume; per-call
  `model` overrides go through `SendOptions.model`.
- `events` iterates `run.stream()` translated by `cursorEvents.ts`.
- `cancel()` calls `run.cancel()` and drains the iterator with a bounded
  timeout.
- `wait()` resolves once `Run.status` is terminal; synthesises a final
  `resultEvent` from `Run.result` + `Run.status`; then awaits `dispose()`.
- `dispose()` calls `agent[Symbol.asyncDispose]()` (preferred) or
  `agent.close()`; idempotent; safe to call after a failed `start`.

`orchestratorService.startManagedRun` becomes `WorkerRuntime`-shaped: it
calls `runtime.start(...)` / `runtime.resume(...)`, stores the returned
handle in `activeRuns`, schedules the per-run timeout against
`handle.cancel()`, and is **not** the writer for in-flight `appendEvent` or
the normal-completion `markTerminal` (per the ownership table above). The
`RunSummary.worker_invocation` field stays populated for CLI backends; for
cursor it is `null` per OQ5 (deferred enhancement).

## Scope

### In Scope

- **Abstraction:** `WorkerRuntime` + `RuntimeRunHandle` introduced; `CliRuntime`
  wraps existing Codex/Claude `WorkerBackend` implementations; `orchestratorService`
  rewired to consume `RuntimeRunHandle`. The pre-existing `ManagedRun` inside
  `src/processManager.ts` keeps its name and remains an internal detail of `CliRuntime`.
- **Cursor backend:** `src/backend/cursor/sdk.ts` (thin SDK adapter with dynamic
  import + injection seam for tests) and `src/backend/cursor/runtime.ts`
  (`CursorSdkRuntime`).
- **Contract:** `BackendSchema` widened to include `cursor`. No other contract
  break (event types, run statuses, diagnostic shape all reused per D8/D10).
- **MCP:** `src/mcpTools.ts` `start_run` `backend` enum extended;
  field descriptions clarified (cursor supports `model`; `service_tier`
  rejected; `reasoning_effort` validated against the chosen cursor model).
- **Service validation:** `orchestratorService.modelSettingsForBackend` gains
  a `cursor` branch (D13). `validateInheritedModelSettingsForBackend` updated
  if cursor needs model/effort coupling like Claude does today.
- **Diagnostics:** New SDK-shaped diagnostic per D8: package resolvability +
  env-var auth + (optional) `Cursor.me()` gated probe.
- **Capabilities:** Cursor entry in `src/opencode/capabilities.ts`
  (`requires_model: true`, supports start/resume, declares which
  `reasoning_efforts` are supported per validated model parameters,
  `service_tiers: []`, notes referencing the SDK and the `agentId`/`runId`
  resume model).
- **Profiles:** Profile validator covers cursor profiles.
- **`package.json`:** Add `@cursor/sdk` to `optionalDependencies`. Update
  `pnpm-lock.yaml`. Confirm the package's runtime works without it installed
  (Codex/Claude users) by running existing tests with the SDK uninstalled.
- **Tests:**
  - Unit: SDK event-mapping (`cursorEvents.test.ts`) using a hand-built
    `SDKMessage` fixture; runtime lifecycle (`cursorRuntime.test.ts`) using
    the injected fake adapter to drive start → events → wait → cancel; service
    validation; diagnostics shape; capability and profile validation; contract
    schema; mcpTools schema.
  - Integration: extend `src/__tests__/integration/orchestrator.test.ts` with
    a cursor variant (uses the injected fake adapter, never the real SDK)
    that drives `start_run` → `wait_for_run` → `get_run_result` →
    `send_followup` (resume) → `cancel_run`. Asserts `agentId` persistence,
    final summary, status mapping, observed model.
- **Docs:** `docs/development/cursor-backend.md` and the README updates per D16.

### Out Of Scope

- Cloud and self-hosted runtimes (`cloud: { repos, ... }`,
  `cloud.env: { type: 'pool' \| 'machine' }`). Captured as Future Options.
- Subagents (`agents: Record<string, AgentDefinition>` in `AgentOptions`).
- Inline MCP server forwarding from the daemon into the SDK
  (`mcpServers` option). Note: leaving this out means cursor runs do not
  inherit the daemon's MCP servers — explicit limitation.
- Hooks (`.cursor/hooks.json` integration).
- Artifact download (`SDKAgent.downloadArtifact`); the SDK docs note this is
  unsupported for local runtimes anyway.
- `Cursor.models.list()`-driven dynamic capability discovery; capabilities are
  static in this plan.
- `cursor-agent` CLI as a runtime — kept as a rejected alternative.
- Any change to billing/telemetry beyond a doc note.

## Future Options (explicitly deferred)

- **Cloud runtime.** Adds repo-URL/ref input, autoCreatePR, agent-survives-daemon
  semantics, and a polling fetch-by-id flow. Re-uses most of the SDK adapter
  but needs new MCP surface (cloud-only inputs) and run-store changes
  (durable cloud agents).
- **`cursor-agent` CLI as a fallback.** If a user cannot install
  `@cursor/sdk` (locked-down npm registry, etc.) we can later add a second
  runtime that wraps the CLI under the same `WorkerRuntime` interface — the
  abstraction introduced here makes that a drop-in.
- **Subagents and DAG fan-out** (cookbook DAG runner pattern).
- **Dynamic model/parameter discovery** via `Cursor.models.list()` to populate
  the capability catalog at boot.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| R1 | SDK is in public beta; `SDKMessage` shape may shift | Adapter parses defensively (only reacts to the documented `type` discriminator values, treats unknown `type` as `lifecycle`); pin a known-good SDK version range; surface SDK errors verbatim in `errors[]`. | T-Adapter, T-Events |
| R2 | `@cursor/sdk` cannot be installed on a given machine | Optional dep + dynamic import; cursor backend reports `missing` in diagnostics with a clear install hint. Codex/Claude users are unaffected. | T-Diag, T-Pkg |
| R3 | SDK adds an unexpected runtime behavior (network egress from the daemon) that surprises users used to local-only Codex/Claude | Documented prominently in README and `docs/development/cursor-backend.md`; the cursor capability `notes` mention "uses Cursor's hosted models; tokens are billed to your Cursor account". | T-Docs |
| R4 | Cancellation race: `run.cancel()` resolves but the `for await` continues to yield buffered events | Drain the iterator with a bounded timeout in `RuntimeRunHandle.cancel()` (default per RQ2); mark run `cancelled` via `runStatusOverride: "cancelled"` (D11) once the SDK Run reports `status: 'cancelled'`. | T-Runtime |
| R5 | `agentId` from a previous run is stale (Cursor evicts it server-side) | `Agent.resume` rejects with a typed error; map to `INVALID_STATE` and surface in `errors[]` so the resume run fails cleanly. | T-Resume |
| R6 | Tool-call payloads do not match Edit/Write/Bash shape; `filesChanged` / `commandsRun` end up empty for cursor runs | Document the limitation; rely on git-snapshot diff (already tracked by `gitSnapshot.ts`) for `filesChanged`. | T-Events, T-Docs |
| R7 | Refactor introduces a regression for Codex or Claude | `CliRuntime` is a thin adapter that delegates to the existing `WorkerBackend` and `processManager` code paths unchanged. All existing Codex/Claude tests pass without modification. | T-Refactor, T8 |
| R8 | The MCP `start_run` schema still advertises only `codex`/`claude` | `src/mcpTools.ts` updated and tested. | T-MCP, T6 |
| R9 | Adding `@cursor/sdk` to `optionalDependencies` doesn't actually keep it out of the install when users do `pnpm install --frozen-lockfile` in CI | Verify with `pnpm pack` dry run + a clean-install smoke test that runs `pnpm test` with the SDK absent. | T-Pkg, T8 |
| R10 | Long-running SDK runs hold the daemon Node event loop and starve other runs | The SDK iterator is async, so concurrency is preserved at the JS level. Existing per-run timeout and concurrency caps in `orchestratorService` apply unchanged. | T-Runtime |
| R11 | Token-based billing surprises users | README + docs `--force`-equivalent safety note: every cursor run consumes Cursor account tokens; no free tier. | T-Docs |
| R12 | `finalizeFromObserved` treats `exitCode: null` as failure, so a "successful" SDK run looks failed; or a cancelled SDK run looks completed because `stopReason: "cancelled"` alone is not the terminal-status discriminator | D11 mandates synthesising `exitCode: 0` for `finished` and passing `runStatusOverride: "cancelled"` for `cancel`. Asserted by a unit test that drives the runtime through finished, error, cancelled, and timeout paths and inspects the resulting `RunStatus` and `WorkerResult`. | T-Runtime, T-Tests-Unit |
| R13 | Missing SDK is reported inconsistently across MCP surfaces (e.g., `BACKEND_NOT_FOUND` from `start_run` vs `missing` from diagnostics vs `cursor` absent from capability catalog) | D17: cursor is **always** registered. `start_run` produces a durable failed run with `WORKER_BINARY_MISSING` (not `BACKEND_NOT_FOUND`); diagnostics report `status: "missing"`; capability flips to `available: false`; the user-visible `backend` enum still includes `cursor`. T-Pkg b1 asserts all four. | T-Pkg, T-Register, T-Diag, T-Cap |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T-Pkg | **Add `@cursor/sdk` as an `optionalDependencies` entry; verify SDK-absent behavior on two paths** | — | pending | (a) `package.json` lists `@cursor/sdk` in `optionalDependencies` with the spec **`^1.0.12`** (human policy: always track the latest `@cursor/sdk` release; the lockfile resolves the actual installed version so `pnpm install --frozen-lockfile` is reproducible). (b) **Two SDK-absent verifications, both required:** <br>(b1) **In-tree unit-level:** a focused test injects an import failure into the cursor SDK adapter (the dynamic-import seam from T-Adapter) and asserts: the cursor diagnostic reports `status: "missing"`, the cursor capability flips to `available: false`, the cursor backend is **still registered** in the runtime registry (D17), and `start_run` with `backend: "cursor"` produces a **durable failed run** in the run store with `OrchestratorErrorCode = "WORKER_BINARY_MISSING"` and `details.binary === "@cursor/sdk"` plus an install hint. **No `BACKEND_NOT_FOUND`** (which would mean the backend name is unknown). <br>(b2) **Install-shape (temp repo copy, NOT packed tarball):** copy the working tree (or use a fresh `git worktree`) into a temp dir, run `pnpm install --frozen-lockfile --no-optional --ignore-scripts`, run `pnpm build`, then run a targeted slice of the Codex/Claude tests (e.g. `pnpm test -- backendInvocation codexBackend claudeBackend processManager` or the equivalent vitest pattern). Asserts: build succeeds and Codex/Claude tests pass with `@cursor/sdk` absent on disk. **Why temp-repo, not packed-tarball:** the published npm package excludes `src/__tests__/**`, so a packed-tarball install has no tests to run. A separate consumer-level "doctor" smoke (import the package entrypoint, call `getBackendStatus`, assert `cursor.status === "missing"`) MAY be added on top of the packed tarball if cheap, but is not the primary gate. (Reviewer fix #3.) |
| T-Contract | Extend `BackendSchema` to include `cursor` | T-Pkg | pending | `BackendSchema.parse('cursor')` succeeds; no other contract field changes; existing tests pass. |
| T-Refactor | Introduce `WorkerRuntime` + `RuntimeRunHandle` and a `CliRuntime` adapter; rewire `orchestratorService.startManagedRun` to consume `RuntimeRunHandle`; enforce the single-writer ownership rules in D3 | T-Contract | pending | New types live under `src/backend/runtime.ts`. The handle type is **`RuntimeRunHandle`** (not `ManagedRun`, which stays in `processManager.ts`). Codex and Claude continue to pass `__tests__/backendInvocation.test.ts`, `__tests__/codexBackend.test.ts`, `__tests__/integration/orchestrator.test.ts` **with no test edits**. `processManager` retains its current public surface; only the new `CliRuntime` calls into it. **Ownership audit included in PR description:** every existing `appendEvent` and `markTerminal` call site is classified as runtime-owned, pre-spawn-owned, or orphan-owned per the table in D3, with no remaining duplicates. |
| T-Adapter | Implement `src/backend/cursor/sdk.ts` (typed shim around `@cursor/sdk` with a dynamic `import()`, an injection seam for tests, and an `available()` probe) | T-Pkg, T-Contract | pending | The shim exports an `Agent` factory plus the minimal SDK type aliases the runtime needs. Production code does the dynamic import; constructor injection accepts a fake. `available()` returns `false` if the import throws (without crashing). The probe also exposes the resolved module path (when present) so `T-Diag` can populate `BackendDiagnostic.path` without re-importing. |
| T-Runtime | Implement `CursorSdkRuntime` in `src/backend/cursor/runtime.ts` | T-Adapter, T-Refactor | pending | Implements `WorkerRuntime` per the abstraction in this plan. **Pre-flight:** `start()`/`resume()` first check the adapter's `available()` probe; if false, short-circuit to a `WORKER_BINARY_MISSING` failure routed through `orchestratorService`'s pre-spawn-failure path (D17). Otherwise: `start()` calls `Agent.create({ apiKey, model: { id: model }, local: { cwd } })` then `agent.send(prompt)`. `resume(agentId, ...)` calls `Agent.resume(agentId, { apiKey, local: { cwd } })` then `agent.send(prompt, model ? { model: { id: model } } : undefined)` (per D9). `RuntimeRunHandle.events` translates `SDKMessage`s through the event mapping in T-Events. `cancel()` calls `run.cancel()` and drains the stream with a bounded timeout (RQ2 default 5 s). `wait()` resolves once `Run.status` is terminal and **synthesises a CLI-shaped `FinalizeContext` per D11** — including `exitCode: 0` for `finished`, nonzero for `error`, and `runStatusOverride: "cancelled"` for `cancelled` so `finalizeFromObserved` does the right thing. **`dispose()` calls `agent[Symbol.asyncDispose]()` (preferred) or `agent.close()`** after the terminal state is reached or after a `cancel()` completes; `dispose()` is idempotent and is also called from the failure path of `start()`/`resume()` so a partially-created agent does not leak. The runtime is the single writer for `appendEvent`, stream-driven meta updates, and the terminal `markTerminal` (per D3 ownership table). |
| T-Events | Implement event-mapping `cursorEvents.ts` per D10 | T-Adapter | pending | Pure-function module that takes an `SDKMessage` and returns `ParsedBackendEvent`. Handles all documented `type`s (`system`, `user`, `assistant`, `thinking`, `tool_call`, `status`, `task`, `request`); unknown `type`s map to `lifecycle`. Tool-call file/command extraction follows the schemas in D10. |
| T-Register | Register the cursor runtime in the backend registry — **always**, even when the SDK is absent (D17) | T-Runtime | pending | `createBackendRegistry` returns runtimes keyed by `Backend`; the cursor entry is included unconditionally. When the SDK adapter's `available()` returns `false`, `CursorSdkRuntime.start()`/`.resume()` short-circuits to a structured failure that `orchestratorService` writes through the existing pre-spawn-failure path with `WORKER_BINARY_MISSING` (D17). Asserted by a unit test alongside T-Pkg b1. (If we end up with both a `WorkerRuntime` map and a legacy `WorkerBackend` map during the transition, the plan documents that and the test asserts both paths reach the same object.) |
| T-SVC | Add direct-mode validation in `orchestratorService.modelSettingsForBackend` and `validateInheritedModelSettingsForBackend` for cursor (D13) | T-Contract | pending | `cursor` branch returns `INVALID_INPUT` if **either `reasoning_effort` or `service_tier`** is set; requires `model`. `validateInheritedModelSettingsForBackend` returns the inherited settings unchanged for cursor when both fields are null (the only state cursor allows), and returns `INVALID_INPUT` if a follow-up tries to inherit non-null cursor settings (which should not happen given the validation in the start path, but is defensive). Unit-tested in both `start_run` and `send_followup` direct-override paths. |
| T-MCP | Update `src/mcpTools.ts`: extend `backend` enum on `start_run`; refresh field descriptions | T-Contract | pending | Enum becomes `['codex', 'claude', 'cursor']`. Descriptions for `model`, `reasoning_effort`, `service_tier` mention cursor's behavior. Other tools that enumerate backends are reviewed and updated. Tested in `mcpTools.test.ts`. |
| T-Diag | Add cursor entry to `src/diagnostics.ts` with the SDK-shaped check (D8) | T-Adapter | pending | Reuses `BackendDiagnosticSchema` **without changing it**. `binary: "@cursor/sdk"`, `path` = resolved module path or `null`. `checks` includes `"@cursor/sdk module resolvable"`. `path === null` ⇒ `status: "missing"`. `authEnv: ['CURSOR_API_KEY']` so env-var presence drives the auth field. Optional gated `Cursor.me()` ping is off by default and surfaces as an additional `checks` entry only when explicitly enabled. Install hint: `npm install @cursor/sdk` (or `pnpm add @cursor/sdk`). Auth hint: Cursor Dashboard → Integrations. |
| T-Cap | Add cursor entry to `src/opencode/capabilities.ts` and route profile validation | T-Contract, T-SVC | pending | Catalog returns a cursor capability with `requires_model: true`, `supports_start: true`, `supports_resume: true`, **`reasoning_efforts: []`** and **`service_tiers: []`** (per D13), notes referencing local-only scope, token billing, and the `agentId`/`runId` resume model. Profile validator rejects cursor profiles that omit `model` or set `reasoning_effort` / `service_tier`. |
| T-Tests-Unit | Focused unit tests | T-Runtime, T-Events, T-MCP, T-SVC, T-Diag, T-Cap | pending | New `cursorEvents.test.ts` covers each `SDKMessage` type. New `cursorRuntime.test.ts` drives a fake adapter through start → stream → wait → cancel and through resume. Extend `backendInvocation.test.ts` for any cursor argv-equivalent (or carve out a `cursorRuntimeStart.test.ts`). Extend `diagnostics.test.ts`, `opencodeCapabilities.test.ts`, `contract.test.ts`, `mcpTools.test.ts`. |
| T-Tests-Int | Integration test driving the orchestrator service end-to-end with the fake SDK adapter | T-Runtime, T-SVC, T-MCP | pending | Extend `src/__tests__/integration/orchestrator.test.ts` (or new file) to exercise `start_run` (cursor) → `wait_for_run` → `get_run_result` → `send_followup` (resume via `agentId`) → `cancel_run`. Asserts persisted `agentId`, terminal status mapping, observed model, recorded events. **Uses the injected fake; never the real SDK.** |
| T-Docs | Docs (D16) | T-Runtime, T-Diag, T-MCP, T-SVC | pending | New `docs/development/cursor-backend.md` covers install (`@cursor/sdk` as optional dep), `CURSOR_API_KEY`, local-only scope, profile example, error mapping, billing note, known limitations (no MCP forwarding, no subagents, no artifact download, tool-call file/command extraction is best-effort). README updated for prerequisites, MCP `start_run` enum, optional dep, billing note. |
| T-Sync | Run `node scripts/sync-ai-workspace.mjs --check`; resync if needed | T-Docs | pending | No projection drift. |
| T8 | Run `pnpm build`, `pnpm test`, `pnpm verify`; record evidence in execution log | All above | pending | All commands succeed; output captured per the "record concrete evidence" rule. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| RC1 | "When adding a worker backend, prefer the `WorkerRuntime` + `RuntimeRunHandle` interface over reaching into `processManager` directly. CLI backends use `CliRuntime` (which keeps `processManager.ManagedRun` as its internal handle); non-subprocess backends (SDK, network) implement `WorkerRuntime` directly." | `.agents/rules/` | After T8 succeeds. |
| RC2 | "MCP-visible backend changes require updates to: `BackendSchema`, `mcpTools.ts` enum and descriptions, `orchestratorService` setting validation, `diagnostics.ts`, `opencode/capabilities.ts`, profile validation, integration test, and README." | `.agents/rules/` | After T8 succeeds. |

## Quality Gates

- [ ] `pnpm build` passes.
- [ ] `pnpm test` passes (new and existing, including new integration test).
- [ ] `pnpm verify` passes.
- [ ] Clean-install smoke test (SDK absent) passes; cursor backend reports `missing`.
- [ ] `node scripts/sync-ai-workspace.mjs --check` shows no projection drift.
- [ ] `.agents/rules/node-typescript.md` honored: Node 22+ compatible, TypeScript
      strictness untouched, MCP contract schemas/docs/tests updated alongside
      `BackendSchema` and `mcpTools.ts`. New runtime dep is `optionalDependencies`
      and has explicit user approval (OQ1).

## Open Questions For Reviewer / User

All previously open OQ1–OQ5 were resolved by the reviewer in the latest pass:

- **OQ1 (resolved):** `@cursor/sdk` approved as `optionalDependencies` consumed via dynamic `import()`. T-Pkg unblocked.
- **OQ2 (resolved):** Local-only is the right first cut. Cloud / self-hosted stay in Future Options.
- **OQ3 (resolved):** Backend enum value `cursor` accepted.
- **OQ4 (resolved):** Do not forward daemon MCP servers into the SDK in this plan. Captured as a documented limitation.
- **OQ5 (resolved):** `RunSummary.worker_invocation` stays `null` for cursor in this cut. No schema change.

The only remaining items are empirical — they will surface during implementation
and do not block design approval:

| # | Question | Why It Matters | Default If Unresolved |
|---|---|---|---|
| RQ1 | Pinned version range for `@cursor/sdk` in `optionalDependencies`. | Originally proposed exact `1.0.12` for first-cut safety. **Resolved 2026-05-03** by human policy: always use the latest available SDK; the spec is `^1.0.12` so future 1.x releases come in on lockfile refresh. Re-evaluate only if SDK reaches a 2.x major. | Resolved: `^1.0.12`. |
| RQ2 | Cancel-drain timeout (D12). How long should `RuntimeRunHandle.cancel()` wait for the SDK iterator to drain after `run.cancel()` resolves before forcing `dispose()`? | Too short → events lost from the run log near cancel. Too long → cancel feels unresponsive. | 5 seconds; revisit if observed in practice. |
| RQ3 | Whether to call `Cursor.me()` from diagnostics by default. | Off by default avoids network egress on every `get_backend_status` call; on by default makes auth diagnosis self-contained. | Off by default; expose an opt-in flag on `get_backend_status` (separate follow-up if requested). |

## Execution Log

### T-Pkg: Optional dep + SDK-absent verification (two paths)
- **Status:** completed
- **Evidence:**
  - `package.json` lists `"@cursor/sdk": "^1.0.12"` under `optionalDependencies` (human policy 2026-05-03: track latest); the lockfile resolves to `1.0.12` (the latest published version at the time of this commit, confirmed via `npm view @cursor/sdk versions`); `pnpm install --frozen-lockfile` succeeds.
  - **b1 unit-level:** `dist/__tests__/cursorRuntime.test.js → CursorSdkRuntime missing-SDK behavior` passes; the test injects `unavailableAdapter()` and asserts the cursor backend stays registered, `start_run` produces a durable failed run with `OrchestratorErrorCode = "WORKER_BINARY_MISSING"`, `details.binary === '@cursor/sdk'`, `details.install_hint === 'npm install @cursor/sdk'`, and `latest_error.category === 'worker_binary_missing'`.
  - **b2 install-shape (temp repo copy, NOT packed tarball):** copied the working tree to a temp dir, ran `pnpm install --frozen-lockfile --no-optional --ignore-scripts` (skipped optionals as logged), `pnpm build` succeeded, `node_modules/@cursor` is absent on disk, then ran `node --test dist/__tests__/backendInvocation.test.js dist/__tests__/codexBackend.test.js dist/__tests__/processManager.test.js` → 17/17 passed; cursor runtime tests also passed (the missing-SDK tests still hit because the runtime is registered unconditionally).
- **Notes:** OQ1 honored. RQ1 resolved by human policy 2026-05-03: always use the latest available `@cursor/sdk`; the package.json spec is `^1.0.12`, the lockfile records the resolved version (`1.0.12` today).

### T-Contract: Extend BackendSchema
- **Status:** completed
- **Evidence:**
  - `src/contract.ts:32` extends `BackendSchema = z.enum(['codex', 'claude', 'cursor'])`.
  - `src/__tests__/contract.test.ts → exposes the cursor backend value alongside codex and claude` passes.

### T-Refactor: WorkerRuntime + RuntimeRunHandle + CliRuntime
- **Status:** completed
- **Evidence:**
  - New file `src/backend/runtime.ts` declares `WorkerRuntime`, `RuntimeRunHandle`, `RuntimeStartResult`, and `CliRuntime` (the CLI adapter that wraps a `WorkerBackend` with a `ProcessManager`). The handle name is `RuntimeRunHandle`, distinct from the existing `processManager.ManagedRun`.
  - `src/backend/registry.ts` rewritten to return `Map<Backend, WorkerRuntime>` keyed by backend; cursor is added unconditionally with `defaultCursorSdkAdapter()` and the runtime's own `store`.
  - `src/orchestratorService.ts` now stores `Map<string, RuntimeRunHandle>` in `activeRuns`, calls `runtime.start({ runId, ... })` / `runtime.resume(...)`, and consolidates pre-spawn failure routing through `failPreSpawn`. The orchestrator only writes terminal state on the pre-spawn failure path and the orphan-recovery path; the runtime owns in-flight `appendEvent` and the normal-completion `markTerminal`. Single-writer rules in D3 satisfied.
  - All Codex/Claude tests still pass (`backendInvocation`, `codexBackend`, `processManager`, `integration/orchestrator`) — the only test edits are the two `createBackendRegistry()` call sites that now pass the store (signature change required by T-Register).
- **Notes:** integration test `createService` and the orphan-sweep restart updated to `createBackendRegistry(store)` (T-Register acceptance criterion). `processManager` public surface and `ManagedRun` shape are unchanged.

### T-Adapter: SDK shim with dynamic import + injection seam
- **Status:** completed
- **Evidence:**
  - `src/backend/cursor/sdk.ts` exports `defaultCursorSdkAdapter()` (production) and `CursorSdkAdapter` interface (injection seam). `available()` resolves to `{ ok: false, reason }` if the dynamic `import('@cursor/sdk')` throws.
  - The shim defines minimal type aliases (`CursorSdkMessage`, `CursorRun`, `CursorAgent`, etc.) that the runtime consumes so the codebase never needs a static import of `@cursor/sdk`.
  - Module path is resolved through `createRequire(import.meta.url).resolve('@cursor/sdk')` when present (RV5) and surfaced for the diagnostics check (T-Diag).

### T-Runtime: CursorSdkRuntime
- **Status:** completed
- **Evidence:**
  - `src/backend/cursor/runtime.ts` implements `WorkerRuntime` per D3/D11/D12. Pre-flight calls `adapter.available()`; on failure short-circuits to `WORKER_BINARY_MISSING`. On success, `Agent.create({ apiKey, model: { id }, local: { cwd } })` (start) or `Agent.resume(agentId, { apiKey, local: { cwd } })` followed by `agent.send(prompt, model ? { model: { id } } : undefined)` (resume). Per-call `model` overrides on resume go through `SendOptions.model` per D9.
  - The runtime owns a single drain pump (`drainAndFinalize`) that writes `appendEvent` for each parsed event and writes the terminal `markTerminal` exactly once. Disposal calls `agent[Symbol.asyncDispose]()` (preferred) or `agent.close()`; idempotent and called from both the success and failure paths.
  - Finalization synthesizes a CLI-shaped `FinalizeContext`: `Run.status === 'finished'` ⇒ `exitCode: 0`; `'cancelled'` ⇒ `runStatusOverride: 'cancelled'`; `'error'` ⇒ `exitCode: 1`; pre-run-timeout cancel from orchestratorService also propagates `runStatusOverride` (R12 mitigated).
  - Cancel is cooperative: `RuntimeRunHandle.cancel()` calls `run.cancel()` and the drain races with a bounded `cancelDrainMs` timeout (default 5_000 — RQ2 default).
  - Tests in `src/__tests__/cursorRuntime.test.ts` exercise the missing-SDK, finished, error, and cancelled paths and the start_run → wait_for_run → get_run_result → send_followup integration with a fake adapter — all green.

### T-Events: cursorEvents mapping
- **Status:** completed
- **Evidence:**
  - `src/backend/cursor/cursorEvents.ts` defines `parseCursorEvent(message)` returning `ParsedBackendEvent`. Maps `system`/`status`/`task`/`request`/`thinking`/`user` → `lifecycle`; `assistant` (with `TextBlock`/`ToolUseBlock`) → `assistant_message` + `tool_use`; `tool_call` (with `args.path`/`file_path` and `args.command` extraction) → `tool_use` + optional `tool_result` when `status: 'completed'`; `error` → `error` with classified `RunError`; unknown types → `lifecycle` (R1 defensive).
  - Tests in `src/__tests__/cursorEvents.test.ts` cover every documented `type`, the unknown-type fallback, ERROR-status mapping, and tool-call file/command extraction — 7/7 passing.

### T-Register: Backend registry
- **Status:** completed
- **Evidence:**
  - `src/backend/registry.ts` always registers the cursor runtime regardless of SDK availability.
  - `src/__tests__/cursorRuntime.test.ts → keeps cursor in the runtime registry even when the SDK is absent` asserts `runtimes.has('cursor')` for a registry built with `unavailableAdapter()`.
  - The missing-SDK path produces a durable failed run with `WORKER_BINARY_MISSING` (D17), not `BACKEND_NOT_FOUND`.

### T-SVC: orchestratorService cursor validation
- **Status:** completed
- **Evidence:**
  - `modelSettingsForBackend` now branches on `backend === 'cursor'` and rejects `reasoning_effort` and `service_tier` with `INVALID_INPUT` (D13).
  - `validateInheritedModelSettingsForBackend` rejects inherited cursor settings if either field is non-null and otherwise passes through.
  - `src/__tests__/cursorRuntime.test.ts → cursor backend service-level validation` exercises both rejection paths.

### T-MCP: mcpTools.ts enum and descriptions
- **Status:** completed
- **Evidence:**
  - `src/mcpTools.ts` `start_run.backend.enum` is now `['codex', 'claude', 'cursor']`. `model`, `reasoning_effort`, `service_tier`, and `get_backend_status` descriptions updated to call out cursor's behavior. Same updates applied to `send_followup`.
  - `src/__tests__/mcpTools.test.ts → advertises cursor as a direct backend in the start_run schema` asserts the enum sort.

### T-Diag: SDK-shaped diagnostics
- **Status:** completed
- **Evidence:**
  - `src/diagnostics.ts` adds a third diagnostic for the cursor SDK without changing `BackendDiagnosticSchema`. `binary: '@cursor/sdk'`, `path` is the resolved module path or `null`, `checks` includes `'@cursor/sdk module resolvable'`, status is `missing` when the adapter probe fails, and falls back to `auth_unknown`/`available` based on `CURSOR_API_KEY` presence.
  - The optional `Cursor.me()` ping is intentionally not invoked by default (RQ3) and is not surfaced as a check unless explicitly added later.
  - Existing tests in `src/__tests__/diagnostics.test.ts` updated to inject a `missingCursorAdapter` fake so they remain deterministic regardless of the local node_modules layout. The "missing binary" test now asserts the cursor entry has `binary: '@cursor/sdk'` and a failed `'@cursor/sdk module resolvable'` check.

### T-Cap: Capability catalog and profile validation
- **Status:** completed
- **Evidence:**
  - `src/opencode/capabilities.ts` adds the cursor capability with `requires_model: true`, `supports_start: true`, `supports_resume: true`, **`reasoning_efforts: []`** and **`service_tiers: []`**. Profile validation rejects cursor profiles that set `reasoning_effort` or `service_tier`, and the catalog-level `requires_model` check already rejects profiles missing `model`.
  - `src/__tests__/opencodeCapabilities.test.ts → accepts cursor profiles that pass model only and rejects unsupported settings` and `→ reports cursor capability metadata in the catalog` cover the new branch.

### T-Tests-Unit: Focused unit tests
- **Status:** completed
- **Evidence:**
  - New: `src/__tests__/cursorEvents.test.ts` (7 tests), `src/__tests__/cursorRuntime.test.ts` (7 tests including the b1 missing-SDK assertions and an end-to-end orchestration test that uses the fake adapter and exercises start → wait → result → followup → resume).
  - Extended: `src/__tests__/contract.test.ts`, `src/__tests__/mcpTools.test.ts`, `src/__tests__/opencodeCapabilities.test.ts`, `src/__tests__/diagnostics.test.ts` for the new cursor surface.

### T-Tests-Int: Integration test with fake SDK
- **Status:** completed
- **Evidence:**
  - `src/__tests__/cursorRuntime.test.ts → CursorSdkRuntime end-to-end orchestration with a fake SDK adapter` drives the orchestrator service through `start_run` → `wait_for_run` → `get_run_result` → `send_followup` (resume via persisted `agentId`) using the injected fake adapter. Asserts persisted `session_id === 'bc-int'`, parent linkage, terminal status, observed result summary, that `Agent.create` is called once and `Agent.resume` once with the captured `agentId`.

### T-Docs: docs/development/cursor-backend.md and README
- **Status:** completed
- **Evidence:**
  - New `docs/development/cursor-backend.md` covers install (optional dep), `CURSOR_API_KEY`, local-only scope, settings rules, sessions/resume model, error mapping, and known limitations (no MCP forwarding, no subagents, no artifact download, billing note).
  - `README.md` updated for prerequisites, the `cursor` enum value in MCP tools, and the local-only scope/billing note.

### T-Sync: sync-ai-workspace --check
- **Status:** completed (with caveat)
- **Evidence:**
  - `node scripts/sync-ai-workspace.mjs --check` reports drift only on `.claude/skills/orchestrate-create-plan/SKILL.md` and `.claude/skills/orchestrate-implement-plan/SKILL.md`. These are the **pre-existing user-owned uncommitted changes** in `.agents/skills/orchestrate-*/SKILL.md` that the implementer was instructed not to touch. No drift was introduced by this branch's changes.

### T8: build, test, verify
- **Status:** completed (release gate clears; see "Audit status" + Round-2 update 2026-05-04)
- **Evidence (Round-2 refresh, 2026-05-04 — overrides path applied):**
  - `pnpm build` ✅ (exits 0).
  - `pnpm test` ✅ — 155 pass, 1 skipped (Windows-only IPC pipe), 0 fail; total 30 suites, 156 tests.
  - `node scripts/check-publish-ready.mjs` ✅ → "package metadata is ready for publish".
  - `node scripts/resolve-publish-tag.mjs` ✅ → "@ralphkrauss/agent-orchestrator@0.1.2 will publish with npm dist-tag latest".
  - `pnpm audit --prod` ✅ → "No known vulnerabilities found" after adding `pnpm.overrides` for `tar` (`^7.5.11`), `undici` (`^6.24.0`), and `@tootallnate/once` (`^3.0.1`) per Open Human Decision 1 (Round-2 Comment 12).
  - `npm pack --dry-run` ✅ — produces `ralphkrauss-agent-orchestrator-0.1.2.tgz` (204.6 kB packed, 1.1 MB unpacked, 164 files).
- **Original Round-1 evidence (2026-05-03, pre-overrides) — preserved for context:**
  - `pnpm build` ✅. `pnpm test` ✅ (141 pass, 1 skipped). `check-publish-ready` ✅. `resolve-publish-tag` ✅.
  - `pnpm audit --prod` ❌ at the time — the currently-resolved `@cursor/sdk` 1.0.12 pulled in `@connectrpc/connect-node` → `undici@<6.24.0`, `sqlite3` → `tar`, and `@tootallnate/once` with 12 known advisories transitively. None of the advisories were in agent-orchestrator's own dependency tree.
  - `npm pack --dry-run` was not reached at the time because audit short-circuited `pnpm verify`.

### Reviewer fix pass (2026-05-03)
- **RV1 — model required for cursor:** `src/orchestratorService.ts` `modelSettingsForBackend('cursor', model, …)` returns `INVALID_INPUT` when `model` is missing or empty; `validateInheritedModelSettingsForBackend` enforces the same on cursor follow-ups (and the dispatcher in `sendFollowup` now always routes cursor through the inherited validator). Tests: `cursorRuntime.test.ts → "rejects direct cursor start_run when model is missing"`, `→ "lets cursor follow-ups inherit the parent model and accepts a valid override"` (also asserts `SendOptions.model.id === 'composer-3'` on resume override). Existing `CursorSdkRuntime missing-SDK` test updated to pass `model: 'composer-2'` so it reaches the runtime layer rather than tripping the new validator.
- **RV2 — SDK error normalization:** `src/backend/cursor/errors.ts` introduces `normalizeCursorSdkError()` that maps known SDK classes (`AuthenticationError`, `RateLimitError`, `ConfigurationError`, `NetworkError`, `IntegrationNotConnectedError`, `UnknownAgentError`) and HTTP-style `status` codes to `RunErrorCategory`, preserving `errorClass`, `code`, `status`, `retryable`. The cursor runtime's create/resume/send `catch` blocks now build a richer `PreSpawnFailure` via `cursorSpawnFailure()`. `preSpawnError()` in `orchestratorService.ts` consumes `context.category` / `context.retryable` when present (backward compatible — falls back to legacy derivation otherwise). Tests cover: auth (preserves `error_class: 'AuthenticationError'`, `status: 401`, `error_code: 'unauthorized'`), invalid model (`ConfigurationError`/400 + "Invalid model" message → `invalid_model`), rate limit (`RateLimitError`/429 → `rate_limit` + `retryable: true`), stale resume (`ConfigurationError`/404 with "agent not found" → `protocol`).
- **RV3 — default artifacts on cursor finalize:** `src/backend/cursor/runtime.ts` `buildFinalizeContext(runId, store, …)` now uses `store.defaultArtifacts(runId)` instead of `[]`, restoring contract parity with CLI and pre-spawn paths. Test: `→ "records the standard run artifacts on cursor finalize (parity with CLI)"` asserts the result contains `events.jsonl`, `prompt.txt`, `result.json`, `stderr.log`, `stdout.log`.
- **RV4 — synthesized timeout/cancel error:** `cursorTerminalOverrideError(status, details)` mirrors `processManager.terminalOverrideError`. The override error is fed into both the finalize context's `errors` array (so `WorkerResult.errors` and `summary` reflect the timeout/cancel) and `markTerminal`'s `latest_error` (so `RunSummary.latest_error` is non-null). Tests: `→ "synthesizes a timeout RunError when the orchestrator cancels with timed_out + idle_timeout reason"` (asserts `latest_error.category === 'timeout'`, `latest_error.message === 'idle timeout exceeded'`, `timeout_reason === 'idle_timeout'`); `→ "synthesizes a cancel RunError for user-initiated cancel even when no terminal context is supplied"` (asserts `latest_error.message === 'cancelled by user'`, status `'cancelled'`).
- **RV5 — `createRequire` SDK path resolution:** `src/backend/cursor/sdk.ts` replaces `Function('return require')()` with `createRequire(import.meta.url)`, so `BackendDiagnostic.path` is populated when the SDK is importable in this ESM build. Confirmed by the existing `diagnostics.test.ts` passing under `pnpm test` after the change.

### Audit status (after RQ1 resolution 2026-05-03; superseded 2026-05-04 by overrides)
Round 1 (2026-05-03) recorded a wait-for-upstream policy: `package.json` was set to `"@cursor/sdk": "^1.0.12"` and `pnpm audit --prod` was expected to clear automatically once Cursor shipped a fixed transitive tree. That left `pnpm verify` red against the 12 advisories transitively pulled in via `@cursor/sdk@1.0.12 > sqlite3 > tar` and `@cursor/sdk@1.0.12 > @connectrpc/connect-node > undici` (plus `@tootallnate/once`).

Round 2 (2026-05-04) — Open Human Decision 1 was answered with the overrides path. `package.json` now carries a `pnpm.overrides` block pinning `tar` to `^7.5.11`, `undici` to `^6.24.0`, and `@tootallnate/once` to `^3.0.1`. The lockfile was refreshed, `pnpm install --frozen-lockfile` is clean, and `pnpm audit --prod` exits 0. `@cursor/sdk` remains in `optionalDependencies` so the bundled-install ergonomics for cursor users are preserved. The override block should be revisited each time `@cursor/sdk` ships a new minor — the goal is for upstream to ship a clean tree so the override can be removed. See `PUBLISHING.md` "`pnpm.overrides` policy for `@cursor/sdk` transitives" for the per-advisory rationale.
