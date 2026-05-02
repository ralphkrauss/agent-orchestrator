# Robust OpenCode Orchestration Harness

Branch: `11-add-robust-opencode-orchestration-harness-with-model-settings-and-orchestration-skills`
Plan Slug: `opencode-orchestration-harness`
Parent Issue: #11
Created: 2026-05-02
Status: implementation updated for shared skill-root orchestration flow; focused checks passed

## Context

Issue #11 asks for a first-class OpenCode supervisor harness for this package. The supervisor should inspect the repository, use `agent-orchestrator` MCP tools to delegate work to worker agents, evaluate outputs, and avoid becoming the direct implementer. It must be isolated from normal OpenCode sessions, constrain direct writes and external-service mutation, support separate model settings for the OpenCode supervisor and worker profiles, and add orchestration skills that compose normal worker skills one level higher.

Additional planning decisions from the user:

- The harness must not be designed around Codex and Claude as special cases. Codex and Claude can be the first concrete backends because that is what the daemon supports today, but the orchestration surface must be provider-agnostic.
- The supervisor needs validated worker capability and routing information before it starts worker runs. If routing is missing or invalid, the OpenCode orchestration agent can still launch to discuss the profile aliases the user needs and may write the configured user-level routing manifest on request, but must not delegate workers until validation succeeds.
- Orchestration skills should live in the normal project skill path and be distinguished by an `orchestrate-*` name. The package should not create default orchestration skills; users manage project-owned orchestration skills through the OpenCode supervisor.
- The OpenCode supervisor should be launched in the target workspace where workers should run, and worker prompts/MCP calls should use that workspace as the default `cwd`.
- Users choose concrete worker models through the route/profile manifest. The supervisor can fine-tune only the configured route manifest and `orchestrate-*` skill files under `.agents/skills/`, and those skills must reference route names and profile aliases rather than raw model names or variants.
- The default route/profile manifest should be user-level at `~/.config/agent-orchestrator/routes.json` so personal model preferences are not checked into git and can be reused across repositories.

Sources read:

- `AGENTS.md`
- `.agents/rules/node-typescript.md`
- `.agents/rules/mcp-tool-configs.md`
- `.agents/rules/ai-workspace-projections.md`
- GitHub issue #11 and issue comments
- `package.json`
- `README.md`
- `docs/development/mcp-tooling.md`
- `.agents/README.md`
- `opencode.json`
- `.mcp.json`
- `.codex/config.toml`
- `.cursor/mcp.json`
- `justfile`
- `scripts/sync-ai-workspace.mjs`
- `.agents/skills/create-pr/SKILL.md`
- `.agents/skills/implement-plan/SKILL.md`
- `.agents/skills/review-pr/SKILL.md`
- `.agents/skills/create-test-plan/SKILL.md`
- `.agents/skills/resolve-pr-comments/SKILL.md`
- `src/cli.ts`
- `src/server.ts`
- `src/mcpTools.ts`
- `src/contract.ts`
- `src/orchestratorService.ts`
- `src/__tests__/mcpTools.test.ts`
- `src/__tests__/daemonCli.test.ts`
- `src/__tests__/diagnostics.test.ts`
- `src/__tests__/workspaceScripts.test.ts`
- Official OpenCode docs for config, agents, tools, CLI, and `https://opencode.ai/config.json`
- Local OpenCode session exports (redacted)
- Local OpenCode log `~/.local/share/opencode/log/<redacted>.log`

Current repository shape:

- The package already exposes `agent-orchestrator` and `agent-orchestrator-daemon`.
- `opencode.json` configures `github`, `gh`, and `agent-orchestrator` MCP servers for normal development.
- The current daemon contract has concrete `codex` and `claude` backend names, and current MCP tools accept per-run `model`, `reasoning_effort`, and `service_tier` settings. The harness should wrap these behind worker profiles so future backends can be added without redesigning supervisor behavior.
- OpenCode project/global configs are merged, not replaced. Inline `OPENCODE_CONFIG_CONTENT` has high precedence, so the harness can overlay a supervisor config without editing normal config files.
- OpenCode supports `model`, `small_model`, `default_agent`, `agent`, `permission`, `mcp`, and `skills.paths` in config.
- OpenCode permissions can deny built-ins such as `edit`, `todowrite`, and `bash`, and can match MCP tool names with wildcard patterns such as `{server}_*`.
- OpenCode's `edit` permission covers file modifications including edit, write, and apply-patch behavior.
- OpenCode skill discovery can be controlled by `permission.skill`; denied skills are hidden from the agent and rejected if loaded. Per-agent skill permissions can override global defaults.
- OpenCode permission wildcard rules must be ordered with broad `*` denies before narrower allows. A local setup transcript showed the reversed order denied the manifest write and caused OpenCode to return JSON instead of creating the file.
- Worker starts can now use `start_run` with a live `route` or `profile` alias plus `routes_file`. The daemon reads and validates the current route/profile manifest at worker-start time, so profile edits take effect without relaunching OpenCode. Direct `backend`/`model` starts remain available for explicit one-off overrides or broken profile setup.
- OpenCode evaluates `apply_patch` file edits against relative project paths such as `.agents/skills/orchestrate-review/SKILL.md`, even when the patch header uses an absolute path. Scoped edit permissions must allow both the absolute skill path and the relative path inside the target workspace.
- Project-owned orchestration skills live beside normal skills at `.agents/skills/orchestrate-{name}/SKILL.md`. The launcher includes `.agents/skills/` in `skills.paths`, allows only `orchestrate-*` skills for the supervisor, and does not materialize package defaults.
- OpenCode does not provide an inline skill-definition config surface in the docs checked for this plan. The practical approach is to point `skills.paths` at the shared project skill root and give the supervisor prompt-level guidance for creating `orchestrate-*` `SKILL.md` files there.
- OpenCode 1.14.31 is installed locally, and its CLI supports `opencode`, `opencode run`, `--agent`, `--model`, `--variant`, and `--dangerously-skip-permissions`.
- Existing tests favor Node built-ins, `node:test`, local temp fixtures, and no live model calls.

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Harness entry points | Add `agent-orchestrator opencode` and a dedicated `agent-orchestrator-opencode` bin that share one launcher implementation. | Matches the issue's suggested UX, keeps the existing package CLI useful, and gives users a short command for the supported mode. | Documentation-only launch instructions; replacing normal `opencode`; only adding a new bin with no package CLI command. |
| 2 | Config isolation | Generate an in-memory OpenCode config and pass it through `OPENCODE_CONFIG_CONTENT`; do not edit global, user, or project OpenCode config during normal orchestration mode. | OpenCode treats inline config as a high-precedence runtime override, so this isolates orchestration sessions while preserving normal development sessions. | Writing `opencode.json`; writing global `~/.config/opencode/opencode.json`; requiring users to copy a config template. |
| 3 | Agent profile | Define a dedicated primary agent named `agent-orchestrator` and set `default_agent` to it in the overlay config. | Makes the supervisor role explicit and avoids relying on the default `build` agent, which has broad implementation powers. | Using built-in `plan`; relying only on prompt text without a named agent. |
| 4 | Direct-write permissions | Deny direct source edits, `todowrite`, bash, web mutation, and non-orchestrator MCP tools; allow file read/list/glob/grep/skill, questions, `agent-orchestrator` MCP tools, and scoped edits only for the configured route manifest and `.agents/skills/orchestrate-*/SKILL.md`. | The supervisor needs context-gathering, orchestration, profile setup, and skill-maintenance powers, but direct implementation and external-service mutation must stay unavailable. | Letting OpenCode ask for broad writes; relying only on supervisor prompt; allowing shell command prefixes that look read-only but can mutate. |
| 5 | GitHub and `gh` MCP in orchestration mode | Explicitly disable known high-risk MCP servers `github` and `gh` in the overlay and deny their wildcard tool names as a second layer. | The normal repo config includes these servers, and OpenCode merges configs. Disabling and denying them prevents accidental external-service writes. | Omitting them from the overlay only; leaving them available with approval prompts. |
| 6 | Worker orchestration MCP tools | Allow `agent-orchestrator` MCP tools by default, including `start_run`, `send_followup`, `wait_for_run`, `get_run_*`, `get_observability_snapshot`, and `cancel_run`. | Delegating to workers is the point of this mode. The trust boundary is that workers implement; the OpenCode supervisor coordinates and evaluates. | Requiring approval for every worker run; denying cancellation; exposing only read-only run inspection. |
| 7 | Worker capability model | Add a provider-agnostic worker capability catalog and worker profile/routing policy. The launcher must validate both before OpenCode starts. | The supervisor cannot choose correctly unless it knows which worker profiles, variants, effort levels, and backend constraints are available, and which use cases the user wants each profile to handle. | Hard-coded Codex/Claude defaults; letting the supervisor infer model choices from names alone; starting without a routing policy. |
| 8 | Capability source | Derive available backend capabilities from the daemon/backend registry and merge them with user-defined worker profiles/routes supplied by a JSON file, inline JSON, or explicit CLI/env options. | Some backends can report availability but not enumerate every model. User profiles provide intentional model/variant/effort choices while daemon capabilities validate whether those choices can be started. | Static docs-only model lists; requiring backend model enumeration for all providers; hidden defaults. |
| 9 | Worker-run gate | Allow the OpenCode supervisor to launch without valid routes only so it can discuss setup and write orchestrate-* skills; forbid worker delegation in the prompt until the routing policy validates and covers required use cases. | This keeps setup conversational while preserving the requirement that actual orchestration cannot happen without explicit worker routing. | Refusing to launch at all; using arbitrary fallback profiles; asking the model to decide without structured inputs. |
| 10 | Worker selection in prompts and MCP calls | Inject a generated capability table and route map into the supervisor prompt and orchestration skill guidance; `start_run` can either resolve a live route/profile alias from the configured routes file or accept direct backend/model settings for explicit overrides. | The prompt gives the supervisor setup context, while the daemon reads the live manifest at worker-start time so profile edits apply immediately and direct runs stay auditable. | Daemon-global hidden worker defaults; requiring relaunch after profile edits; forcing every run through raw model fields. |
| 11 | Working directory model | Launch OpenCode in the target workspace (`process.cwd()` by default, overrideable with `--cwd`) and inject that absolute path into the supervisor prompt as the default worker `cwd`. | Users want to start the supervisor from the repository where worker agents should operate. The MCP run tools still require explicit `cwd`, so the supervisor must be told to pass the target workspace on every worker start unless the user explicitly changes it. | Launching from the package directory; relying on OpenCode cwd implicitly; making workers infer cwd from daemon state. |
| 12 | Orchestration skill source | Load project-owned orchestration skills from the shared `.agents/skills/` root by `orchestrate-*` prefix; do not materialize package-owned default skills. | This makes registration behave like normal skills while keeping orchestration workflows visibly distinct by name. | Keeping a separate `.agents/orchestration/skills/` root; relying on package-owned temp skills; storing them in `.opencode/skills`. |
| 13 | Skill visibility policy | The `agent-orchestrator` agent allows `orchestrate-*` skills and denies `*` otherwise; the overlay includes the shared `.agents/skills/` root. | OpenCode's `permission.skill` hides denied normal skills while allowing orchestration skills to live in the same directory. | Trusting prompt instructions; disabling the skill tool entirely; requiring a separate orchestration skill root. |
| 14 | Single-agent setup | Use the same `agent-orchestrator` OpenCode agent for orchestration, profile setup, and skill setup. It can write only the configured route manifest and `.agents/skills/orchestrate-*/SKILL.md`, and cannot start workers until routes validate. | The user wants one conversational surface for orchestration and skill management, while model/profile choices stay scoped to a user-level manifest. | Separate setup agent; broad edit permissions; repo-checked-in model preferences. |
| 15 | Orchestration skill guidance | Put provider-agnostic guidance for creating one-level-higher orchestration skills in the supervisor prompt instead of shipping default skill files, and require skill content to use route names/profile aliases instead of raw model settings. | The issue asks for skills that select, sequence, delegate, evaluate, and request follow-ups, but the user wants to own model choices through profile aliases. | One large package-owned skill; modifying implementation skills to double as orchestration skills; backend-specific default orchestration skills. |
| 16 | OS-level hardening | Document stronger optional protections such as read-only worktree mounts, a separate OS user, a disposable container, or bind-mounted writable output directories. The first implementation does not automate containers. | OpenCode permissions are application-level guardrails, not an OS sandbox. Clear docs set the real trust boundary without adding platform-heavy automation. | Claiming permissions are a security sandbox; building container orchestration into the first slice. |
| 17 | Verification strategy | Use unit tests around capability/routing validation, generated config, CLI parsing, permission shape, env handling, project-owned skill loading, scoped setup writes, and docs/projection checks. Do not run live OpenCode model calls in automated tests. | Keeps tests deterministic, fast, and credential-free while covering the high-risk behavior. | End-to-end model calls; snapshotting all of OpenCode's schema; relying only on manual testing. |

## Scope

### In Scope

- Add a reusable OpenCode harness launcher module.
- Add `agent-orchestrator opencode` and `agent-orchestrator-opencode` entry points.
- Launch OpenCode with `OPENCODE_CONFIG_CONTENT` overlay config and no persistent OpenCode config writes.
- Support `--cwd` or current-directory target workspace semantics.
- Define the dedicated `agent-orchestrator` primary agent with a supervisor prompt.
- Set OpenCode `model`, `small_model`, and default agent in the overlay.
- Add a provider-agnostic worker profile and routing manifest format.
- Query or derive worker backend capabilities before launch.
- Start with route diagnostics when routing is missing or invalid, but instruct the supervisor not to start worker runs until worker routes validate.
- Inject validated worker profile, variant, effort, and route data into the supervisor prompt.
- Inject target workspace path into the supervisor prompt and orchestration skills as the default worker `cwd`.
- Reject or neutralize OpenCode launch options that would bypass the supervisor agent unless an explicit documented unsafe escape hatch is added.
- Disable or deny broad GitHub/`gh` MCP access in orchestration mode.
- Allow `agent-orchestrator` MCP tools for worker lifecycle orchestration.
- Load project-owned orchestration skills from the shared `.agents/skills/` root by `orchestrate-*` prefix.
- Allow the single supervisor to create or update only the configured route manifest and `.agents/skills/orchestrate-*/SKILL.md` files.
- Update AI workspace documentation so normal skills and `orchestrate-*` orchestration skills share the same surface.
- Update README and MCP tooling docs with launch commands, model settings, trust boundary, permissions, and OS-level hardening guidance.
- Add focused tests for launcher config generation, permission policy, model option handling, CLI entry points, and skill discovery/projection integration.

### Out Of Scope

- Adding an OpenCode worker backend to `agent-orchestrator`.
- Adding non-Codex/non-Claude backends in this first implementation.
- Changing `send_followup` routing behavior; follow-ups continue from the parent run unless explicitly overridden by direct model settings.
- Automating containers, bind mounts, or separate-user setup.
- Making GitHub writes available to the OpenCode supervisor by default.
- Publishing, tagging, or changing npm release behavior.
- Live OpenCode model-call tests in CI.
- Editing user-level OpenCode configuration.
- Shipping package-owned default orchestration skills.
- Allowing the supervisor to edit arbitrary source, docs, package metadata, normal skills, MCP configs, secrets, or external services.
- Adding new npm dependencies unless later justified and explicitly approved.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | OpenCode config merging keeps project/global MCP servers enabled. | Explicitly set known high-risk MCP servers to `enabled: false` and deny wildcard MCP tool patterns for GitHub/`gh` plus unknown tools. | Config generation tests. |
| 2 | A user passes OpenCode global, run, or control options and bypasses the supervisor. | Allow either no passthrough arguments or `run` followed only by positional prompt tokens; reject non-run subcommands and any option token after `run`. | CLI parsing tests. |
| 3 | OpenCode tool permission names drift. | Keep permissions limited to documented keys and schema-supported wildcard entries; include `--print-config`/dry-run output for inspection; document tested OpenCode version. | Config tests plus manual smoke. |
| 4 | App-level permissions are mistaken for hard security. | Document that permissions reduce accidental direct writes but OS-level protections are needed for hard enforcement. | Docs review. |
| 5 | The supervisor still launches workers that mutate the worktree. | Make the trust boundary explicit: supervisor orchestrates, workers implement. Worker prompts and skills must set cwd/model deliberately and evaluate dirty worktree state before parallel work. | Orchestration skill tests and docs. |
| 6 | The supervisor starts without enough worker-selection information. | Start with explicit route diagnostics and prompt instructions that worker runs are blocked until required routes validate. | Capability validation and config tests. |
| 7 | A route points to an unavailable backend or unsupported settings. | Validate route profiles against daemon/backend capability descriptors; invalid routes are injected as prompt diagnostics and cannot be used for worker starts. | Capability validation tests. |
| 8 | Backend capability discovery cannot enumerate model names. | Require user-defined profiles for model ids and variants; backend descriptors validate supported setting shapes and availability. | Routing manifest tests. |
| 9 | Normal agents see orchestration skills. | Accept this as the simplified mixed-skill model and require `orchestrate-*` names so the distinction is explicit. | Docs and config tests. |
| 10 | The orchestration agent sees normal implementation skills. | Point `skills.paths` at the shared skill root but deny all skills except `orchestrate-*`. | Config generation tests. |
| 11 | Users expect package default skills to exist. | The supervisor prompt states that no default orchestration skills are generated and gives concise instructions for creating project-owned `SKILL.md` files. | Config prompt tests and docs. |
| 12 | Supervisor writes outside scoped setup files. | Permission policy allows edits only to the configured route manifest and `.agents/skills/orchestrate-*/SKILL.md`; prompt forbids source, normal-skill, unrelated config, secret, and external-service writes; tests assert generated permissions. | Config tests. |
| 13 | The target workspace is ambiguous. | Resolve `--cwd` or process cwd to an absolute path, validate it exists, launch OpenCode there, and inject it into the supervisor prompt as the default worker `cwd`. | CLI parsing and config tests. |
| 14 | The `agent-orchestrator` MCP server points at stale `dist/cli.js`. | Docs keep the current `pnpm build` and daemon restart guidance; launcher diagnostics can warn when `dist/cli.js` is missing in local dev. | CLI/docs tests or manual smoke. |
| 15 | The generated supervisor prompt grows too large or brittle. | Keep prompt concise and include only setup guidance, validated capability table, route summary, project skill list, and target workspace. | Prompt tests. |
| 16 | OpenCode is not installed. | Launcher reports a clear missing-binary error and points to OpenCode installation/auth docs without mutating config. | CLI error-path tests. |
| 17 | Users need shell checks from the supervisor. | Deny supervisor bash and document that shell inspection should be delegated to workers or handled through future parsed MCP tools. | Permission tests and docs. |
| 18 | Permission wildcard ordering accidentally denies narrow setup writes or orchestration skills. | Emit broad `*` denies before narrower allow rules and assert key order in config tests; smoke-check resolved OpenCode config with `opencode debug config`. | Config order tests and local smoke. |
| 19 | Scoped skill writes are denied because OpenCode evaluates edit paths relative to the workspace. | Allow both the absolute `.agents/skills/orchestrate-*/SKILL.md` path and the workspace-relative pattern in edit permissions. | Config tests and resolved-config smoke. |
| 20 | User-managed orchestration skills are not visible to the supervisor. | The launcher points `skills.paths` at the shared project skill root and lists only `orchestrate-*` skills in the prompt. | Skill loader and config tests. |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| OPC-1 | Add provider-agnostic worker capability and routing model | none | implemented; verified | A TypeScript module defines worker capabilities, worker profiles, setting variants, and use-case routes without hard-coding Codex/Claude into the harness API; current Codex/Claude backend descriptors are adapters into this generic model; invalid profile ids, empty routes, unavailable backends, and unsupported settings fail validation. |
| OPC-2 | Expose or derive worker capabilities before launch | OPC-1 | implemented; verified | The launcher can obtain a current capability catalog from daemon/backend diagnostics or a shared local capability builder; it reports available worker agent ids, backend names, model/variant/effort/service-tier constraints, and start/resume support; if no usable capability data is available, orchestration launch fails. |
| OPC-3 | Add project orchestration skill loader | OPC-1, OPC-2 | implemented; verified | Project-owned orchestration skills can be loaded from the shared `.agents/skills/` root by `orchestrate-*` prefix; no package-owned defaults or temp fallback skills are created; the loader returns the project skill root and discovered orchestration skill names. |
| OPC-4 | Add OpenCode harness config builder | OPC-1, OPC-2, OPC-3 | implemented; verified | A TypeScript module builds a deterministic OpenCode config object/string with `$schema`, `model`, `small_model`, `default_agent`, `agent.agent-orchestrator`, shared `skills.paths`, `mcp` overrides, and permission policy; it injects validated capability data, route diagnostics, target workspace, shared skill root, and orchestrate-* skill names into the supervisor prompt; writes are scoped to the configured route manifest and `.agents/skills/orchestrate-*/SKILL.md`. |
| OPC-5 | Add launcher CLI and bin wiring | OPC-4 | implemented; verified | `agent-orchestrator opencode` and `agent-orchestrator-opencode` are wired through package bins and shared code; help text documents options; launcher resolves `--cwd` or process cwd, finds/spawns `opencode` in that workspace, injects `OPENCODE_CONFIG_CONTENT`, preserves normal environment, supports `--print-config` or dry-run inspection, rejects non-run OpenCode passthrough and run options, and starts with diagnostics when routes are missing or invalid. |
| OPC-6 | Implement supervisor prompt and permission policy | OPC-4 | implemented; verified | The dedicated primary agent prompt states the supervisor must not directly edit source/todowrite/bash/commit/push/PR/publish or mutate external services; config disables GitHub/`gh`, allows repository reads, allows `agent-orchestrator` MCP tools, allows only `orchestrate-*` skills, allows scoped edits for the configured route manifest and orchestrate-* `SKILL.md` files, and instructs worker starts to prefer live route/profile aliases. |
| OPC-7 | Add single-agent setup writes | OPC-4, OPC-5 | implemented; verified | `agent-orchestrator-opencode` launches one `agent-orchestrator` agent that can inspect capabilities and write only the configured route manifest and `.agents/skills/orchestrate-*/SKILL.md`; the launcher creates the shared skill root and route-manifest directory before OpenCode starts; edit permissions allow both absolute and workspace-relative skill paths when applicable. |
| OPC-8 | Add model, route, and skill-root option handling | OPC-1, OPC-5, OPC-7 | implemented; verified | CLI flags/env/config input cover orchestrator model, small model, worker profile definitions, worker variants/settings, use-case routes, target workspace, user-level manifest path, shared skill root, and optional inline route JSON; `start_run` supports live route/profile resolution from the routes file plus direct backend/model starts for explicit overrides; missing or invalid routing information is surfaced as setup diagnostics. |
| OPC-9 | Add orchestration skill creation guidance | OPC-6, OPC-8 | implemented; verified | The supervisor prompt explains how to create project-owned `orchestrate-*` skill files under `.agents/skills/orchestrate-{name}/SKILL.md` and tells skills to use route/profile aliases instead of raw model settings; no package-owned orchestration skill templates are shipped or materialized. |
| OPC-10 | Update AI workspace docs and projection expectations | OPC-9 | implemented; verified | AI workspace docs explain that normal canonical skills and `orchestrate-*` OpenCode orchestration skills share `.agents/skills/`; `scripts/sync-ai-workspace.mjs --check` continues to pass. |
| OPC-11 | Update docs and examples | OPC-5, OPC-7, OPC-9 | implemented; verified | `README.md` and `docs/development/mcp-tooling.md` document launch commands, single-agent skill setup behavior, target cwd behavior, local dev prerequisites, capability discovery, route/profile config examples, model flags/env vars, shared skill behavior, permission boundary, disabled GitHub/`gh` behavior, OS-level hardening options, and no-persistent-config behavior. |
| OPC-12 | Add focused tests | OPC-1, OPC-2, OPC-3, OPC-4, OPC-5, OPC-6, OPC-7, OPC-8, OPC-9, OPC-10 | implemented; verified | Tests cover capability and route validation, project skill loading, config generation, permission denial/allowance shape, scoped setup write paths, known MCP server disablement, live route/profile resolution, model/profile/route/cwd precedence, unsafe `--agent` rejection, no-routes diagnostic launch, print-config output, missing OpenCode binary error handling, and projection expectations without live model calls. |
| OPC-13 | Verify affected checks | OPC-10, OPC-11, OPC-12 | complete | `pnpm build`, targeted built tests for the harness/workspace areas, `pnpm test`, and `node scripts/sync-ai-workspace.mjs --check` pass; `pnpm verify` passes. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | Orchestration harnesses must deny direct write tools and disable high-risk external-service MCP servers by default. | Future supervisor harness work. | After OPC-5 if this pattern is reused beyond OpenCode. |
| 2 | Orchestration skills must be one level higher than implementation skills and must delegate implementation to workers instead of editing directly. | Project-owned OpenCode orchestration skill guidance. | After OPC-9 if additional orchestration skills are planned. |
| 3 | AI client config overlays that handle secrets or external writes must document app-level permissions versus OS-level enforcement. | MCP/tooling docs and launcher design. | After OPC-11 if similar launchers are added. |
| 4 | Supervisor harnesses must not start worker runs without validated worker capability and routing information. | Future orchestrator entry points. | After OPC-5 if additional supervisor clients are planned. |
| 5 | Supervisor setup writes must be limited to explicit config paths and must not include source, normal skills, secrets, docs, or external services. | Future setup/config-generation flows. | After OPC-7 if similar setup flows are added. |

## Quality Gates

- [x] `pnpm build` passes.
- [x] Targeted harness/workspace tests pass after build.
- [x] `pnpm test` passes.
- [x] `node scripts/sync-ai-workspace.mjs --check` passes.
- [x] Relevant `.agents/rules/` checks are satisfied.
- [x] `pnpm verify` passes before release-quality handoff or PR if requested.

## Execution Log

### OPC-1: Add provider-agnostic worker capability and routing model
- **Status:** implemented; verified
- **Evidence:** Added `src/opencode/capabilities.ts` with generic capability catalog, routing manifest schema, profile validation, required route checks, and Codex/Claude backend adapters. Covered by `src/__tests__/opencodeCapabilities.test.ts`.
- **Notes:** Codex and Claude are represented as current backend descriptors; supervisor routing logic is profile/use-case based.

### OPC-2: Expose or derive worker capabilities before launch
- **Status:** implemented; verified
- **Evidence:** `src/opencode/launcher.ts` derives a launch-time capability catalog from `getBackendStatus()` through `createWorkerCapabilityCatalog()` and injects missing/invalid route diagnostics into the supervisor prompt.
- **Notes:** No live model calls are made for capability validation.

### OPC-3: Add project orchestration skill loader
- **Status:** implemented; verified
- **Evidence:** Removed `src/opencode/skillTemplates.ts` and updated `src/opencode/skills.ts` to load `orchestrate-*` skills from the shared `.agents/skills/` root.
- **Notes:** No package-owned default skills or temporary fallback skill roots are created; normal skills can coexist in the same root but are not listed as orchestration skills.

### OPC-4: Add OpenCode harness config builder
- **Status:** implemented; verified
- **Evidence:** Added and updated `src/opencode/config.ts` to build the `OPENCODE_CONFIG_CONTENT` overlay with shared project `skills.paths`, disabled GitHub/`gh`, local `agent-orchestrator` MCP command, model fields, target workspace, shared skill root, capability table, route map or diagnostics, orchestrate-* skill list, and scoped setup edit permissions.
- **Notes:** The config builder is deterministic and independently tested.

### OPC-5: Add launcher CLI and bin wiring
- **Status:** implemented; verified
- **Evidence:** Added and updated `src/opencode/launcher.ts`, `src/opencodeCli.ts`, `agent-orchestrator-opencode` package bin, and `agent-orchestrator opencode` top-level command. CLI smoke is covered by build and harness tests.
- **Notes:** OpenCode passthrough allows either no passthrough arguments or `run` followed only by positional prompt tokens. The legacy `setup` word is accepted as a compatibility alias but still launches the single `agent-orchestrator` agent.

### OPC-6: Implement supervisor prompt and permission policy
- **Status:** implemented; verified
- **Evidence:** `src/opencode/config.ts` defines the single supervisor prompt and permission policy that denies source edits, todowrites, and external mutation; allows scoped route-manifest and `.agents/skills/orchestrate-*/SKILL.md` edits; disables GitHub/`gh`; allows `agent-orchestrator_*`; and restricts skills to `orchestrate-*`. Config tests assert broad wildcard denies are emitted before narrower allow rules.
- **Notes:** A local OpenCode transcript exposed the reversed-rule-order failure; fixed by putting `*` first in top-level, skill, and edit permission maps, then later tightened bash to an explicit deny.

### OPC-7: Add single-agent skill writes
- **Status:** implemented; verified
- **Evidence:** `agent-orchestrator-opencode` launches one `agent-orchestrator` agent; prompt and permissions allow edits only to the configured route manifest and `orchestrate-*` skill files, defaulting to `.agents/skills/orchestrate-*/SKILL.md`; launcher creates the shared skill root and route-manifest directory before spawning OpenCode; config includes both absolute and workspace-relative edit allows when the target is inside the workspace.
- **Notes:** Missing or invalid routes do not block OpenCode startup, but the supervisor prompt forbids worker starts until the manifest validates.

### OPC-8: Add model, route, and skill-root option handling
- **Status:** implemented; verified
- **Evidence:** Launcher options and env fallbacks cover `--cwd`, `--routes-file`, `--routes-json`, `--manifest`, `--skills`, compatibility `--orchestration-skills`, `--orchestrator-model`, `--orchestrator-small-model`, `--opencode-binary`, and `--print-config`; `start_run` can resolve live `route` or `profile` aliases from the current routes file, while direct backend/model starts remain available.
- **Notes:** Tests cover parsing, cwd resolution, route validation, no-routes diagnostic launch, malformed inline JSON rejection, and live route edits taking effect without relaunch.

### OPC-9: Add orchestration skill creation guidance
- **Status:** implemented; verified
- **Evidence:** `src/opencode/config.ts` now tells the supervisor how to create project-owned `orchestrate-*` skills under `.agents/skills/orchestrate-{name}/SKILL.md` and to use route/profile aliases instead of raw model settings in skill content.
- **Notes:** The package no longer ships or materializes default orchestration skill templates.

### OPC-10: Update AI workspace docs and projection expectations
- **Status:** implemented; verified
- **Evidence:** Updated `.agents/README.md` and `docs/ai-workspace.md` to explain the shared `.agents/skills/` root and the `orchestrate-*` naming convention. `node scripts/sync-ai-workspace.mjs --check` is rerun after this change.
- **Notes:** No generated Claude/Cursor projection changes were required.

### OPC-11: Update docs and examples
- **Status:** implemented; verified
- **Evidence:** Updated `README.md`, `docs/development/mcp-tooling.md`, and `justfile` with OpenCode orchestration launch, single-agent skill setup behavior, route manifest example, cwd behavior, shared `orchestrate-*` skills, permission boundary, and OS-level hardening guidance.
- **Notes:** Recipes remain for config inspection and orchestration launch; the separate setup recipe was removed.

### OPC-12: Add focused tests
- **Status:** implemented; verified
- **Evidence:** Added and updated `src/__tests__/opencodeCapabilities.test.ts`, `src/__tests__/opencodeHarness.test.ts`, `src/__tests__/mcpTools.test.ts`, and `src/__tests__/integration/orchestrator.test.ts`. Targeted command `pnpm build && node --test dist/__tests__/opencodeCapabilities.test.js dist/__tests__/opencodeHarness.test.js dist/__tests__/mcpTools.test.js dist/__tests__/integration/orchestrator.test.js` passed with 22 tests after live route/profile resolution and scoped setup permission changes.
- **Notes:** Full `pnpm test` and `pnpm verify` passed after this change.

### OPC-13: Verify affected checks
- **Status:** complete
- **Evidence:** `pnpm build` passed; targeted OpenCode harness/capability/MCP/integration tests passed with 22 tests; `node dist/opencodeCli.js --cwd /home/ubuntu/agent-orchestrator --print-config` showed one `agent-orchestrator` agent, `skills.paths` pointed at `.agents/skills`, the user-level route manifest was writable, and edit permissions allowed only that manifest plus `.agents/skills/orchestrate-*/SKILL.md`.
- **Notes:** `pnpm verify` emitted npm warnings about unknown environment config keys, but audit and npm pack dry run succeeded.
