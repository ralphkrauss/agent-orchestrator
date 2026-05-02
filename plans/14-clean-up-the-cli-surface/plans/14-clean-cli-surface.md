# Clean CLI Surface After Rename

Branch: `14-clean-up-the-cli-surface`
Plan Slug: `clean-cli-surface`
Parent Issue: #14
Created: 2026-05-02
Status: completed

## Context

Issue #14 asks for a clean command surface such as `agent-orchestrator opencode`, `agent-orchestrator start`, `agent-orchestrator stop`, and `agent-orchestrator watch`, so users can install the package globally and use one memorable command family. After this branch was created, `main` performed the full package rename from `@ralphkrauss/agent-orchestrator-mcp` to `@ralphkrauss/agent-orchestrator`, with `agent-orchestrator` and `agent-orchestrator-daemon` as the primary bins. This plan now treats that rename as the baseline instead of planning or preserving the old `-mcp` names.

Sources read:

- `AGENTS.md`: use `pnpm` scripts, keep public package behavior stable unless explicitly changing an API or contract, update focused tests for CLI/release behavior, and record verification evidence.
- `.agents/rules/node-typescript.md`: Node 22+, strict TypeScript, no new package manager or dependency changes, verify human-readable and JSON CLI output where applicable.
- `.agents/rules/mcp-tool-configs.md`: never place tokens in repo files or command arguments; MCP config examples must avoid secrets and stay consistent across supported clients.
- `.agents/rules/ai-workspace-projections.md`: `.agents/` is canonical; generated projections came from `main` and are not manually edited for this CLI plan.
- GitHub issue `#14`: `clean up the cli surface`.
- `origin/main` merge on 2026-05-02: package name, repository URLs, docs, and daemon bin references now use `@ralphkrauss/agent-orchestrator`, `agent-orchestrator`, and `agent-orchestrator-daemon`.
- `package.json`: resolved merged bin surface is `agent-orchestrator`, `agent-orchestrator-daemon`, and `agent-orchestrator-opencode`.
- `src/cli.ts`: resolved merged CLI keeps no-argument and `server` MCP startup, `doctor`, and `opencode`; help text uses renamed command names.
- `src/daemon/daemonCli.ts` and `src/daemonCli.ts`: daemon lifecycle commands still live behind the standalone daemon CLI and read process argv directly.
- `src/opencode/launcher.ts` and `src/opencodeCli.ts`: OpenCode launcher is reusable and now documents `agent-orchestrator opencode` first, with `agent-orchestrator-opencode` as a standalone launcher.
- `src/__tests__/daemonCli.test.ts` and `src/__tests__/opencodeHarness.test.ts`: existing coverage validates renamed daemon help, daemon lifecycle behavior, and OpenCode launcher parsing.
- `README.md` and `docs/development/mcp-tooling.md`: merge resolution updated stale OpenCode examples to the renamed command surface.
- `PUBLISHING.md` and `scripts/check-publish-ready.mjs`: publishing docs and package metadata now target `@ralphkrauss/agent-orchestrator`; `pnpm verify` remains the release-quality gate.

Affected verification commands:

- `pnpm build`
- `node --test dist/__tests__/daemonCli.test.js dist/__tests__/opencodeHarness.test.js`
- `pnpm test`
- `pnpm verify`

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Rename baseline | Accept `main`'s full rename: package `@ralphkrauss/agent-orchestrator`, primary bin `agent-orchestrator`, daemon bin `agent-orchestrator-daemon`. | The rename already landed on `main`; this branch should not reintroduce stale `-mcp` package or bin names. | Preserve `@ralphkrauss/agent-orchestrator-mcp`; keep `agent-orchestrator-mcp` or `agent-orchestrator-mcp-daemon` aliases in this branch. |
| 2 | MCP server invocation | Preserve no-argument and `server` behavior on `agent-orchestrator` as stdio MCP server startup. | MCP clients invoke the package with no command arguments, and the renamed package still needs stable stdio behavior. | Require all clients to pass `server`; move the MCP server behind a separate executable. |
| 3 | Daemon command shape | Add direct daemon aliases to the top-level CLI: `agent-orchestrator status`, `runs`, `watch`, `start`, `stop`, `restart`, and `prune`, while keeping `agent-orchestrator-daemon`. | This matches issue #14's desired surface and keeps the standalone daemon CLI as an explicit compatibility and scripting path. | Keep only `agent-orchestrator-daemon`; require `agent-orchestrator daemon start`; hide daemon commands from human shell usage. |
| 4 | OpenCode command | Prefer `agent-orchestrator opencode`; keep `agent-orchestrator-opencode` as a standalone launcher. | The top-level command is the clean user-facing flow, and the standalone launcher remains useful for scripts and direct bin discovery. | Remove the standalone launcher; only expose the standalone launcher; document old `agent-orchestrator-mcp opencode`. |
| 5 | CLI implementation structure | Refactor daemon CLI logic into a reusable runner that accepts argv, then delegate from `src/cli.ts`. | The current daemon CLI assumes `process.argv[2]` is the command, which is brittle when called from another CLI entry point. | Mutate `process.argv`; shell out to the daemon CLI bin; duplicate daemon command implementations in `src/cli.ts`. |

## Scope

### In Scope

- Resolve the merge onto the renamed `main` baseline without reintroducing old `-mcp` names.
- Refactor daemon CLI handling so top-level routing can invoke daemon lifecycle commands without relying on fixed global `process.argv` positions.
- Route `status`, `runs`, `watch`, `start`, `stop`, `restart`, and `prune` from `agent-orchestrator`.
- Keep `agent-orchestrator-daemon` working through the same daemon implementation.
- Keep `agent-orchestrator opencode` and `agent-orchestrator-opencode` aligned in help text and docs.
- Preserve `agent-orchestrator` no-arg and `server` MCP startup.
- Update README/help/tests for renamed package and direct top-level daemon aliases.
- Add or update focused tests for command routing, help output, JSON/human daemon output where touched, OpenCode help text, and package bin metadata.

### Out Of Scope

- Reverting or softening the full package rename already merged on `main`.
- Restoring `@ralphkrauss/agent-orchestrator-mcp` package naming or old `agent-orchestrator-mcp*` bins.
- Changing MCP tool names, schemas, request/response contracts, or daemon IPC protocol.
- Changing run-store paths, daemon persistence semantics, worker backend invocation, or OpenCode permission behavior.
- Editing user-level MCP configs, secrets, hooks, or external service state.
- Publishing, versioning, pushing, or force-pushing the package.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | Stale `agent-orchestrator-mcp` references survive the merge. | Search active docs/source for old package and bin names; update current-facing examples to `agent-orchestrator`. | T0, T3 |
| 2 | Top-level daemon delegation reads option indexes incorrectly because current parser assumes `process.argv[2]` is the command. | Move daemon CLI to an argv-driven runner and make option parsing relative to that argv. | T1, T2, T4 |
| 3 | `agent-orchestrator status --json` or `runs --json` regresses human or JSON output. | Add tests that invoke the built top-level CLI with isolated `AGENT_ORCHESTRATOR_HOME` and compare existing output expectations. | T2, T4 |
| 4 | Adding direct daemon aliases changes MCP stdio startup. | Keep no-arg and `server` branches before daemon command dispatch and test help/known commands separately. | T2, T4 |
| 5 | Standalone daemon and top-level daemon aliases drift. | Route both through the same daemon runner. | T1, T2, T4 |
| 6 | OpenCode docs/help drift from package rename. | Prefer `agent-orchestrator opencode` in help and docs, with `agent-orchestrator-opencode` as the standalone alternative. | T0, T3, T4 |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T0 | Merge renamed `main` baseline and resolve stale command names | None | completed | `origin/main` fetched and merged; conflicts in `package.json` and `src/cli.ts` resolved by accepting the package rename and preserving OpenCode wiring; active docs/source no longer reference `agent-orchestrator-mcp`; `git diff --check` passes. |
| T1 | Refactor daemon CLI into a reusable argv-driven runner | T0 | completed | `src/daemon/daemonCli.ts` exports a runner that accepts daemon args; `src/daemonCli.ts` remains a thin standalone wrapper; option parsing no longer depends on fixed global `process.argv` indexes; existing daemon lifecycle tests still pass. |
| T2 | Add direct top-level daemon routing | T1 | completed | `agent-orchestrator status`, `runs`, `watch`, `start`, `stop`, `restart`, and `prune` delegate to daemon behavior; no args and `server` still start the stdio MCP server; `doctor` and `opencode` still work. |
| T3 | Update user-facing docs and help text | T2 | completed | README examples prefer `agent-orchestrator ...` for human shell usage; MCP client config examples use `@ralphkrauss/agent-orchestrator`; daemon and OpenCode help text show the canonical commands; no secret-bearing config examples are introduced. |
| T4 | Add focused tests for renamed CLI surface compatibility | T1, T2, T3 | completed | Tests cover canonical help output, direct daemon command routing through `dist/cli.js`, standalone daemon bin compatibility, OpenCode help text, and package bin metadata; JSON output touched by daemon routing remains valid. |
| T5 | Run verification and record evidence | T4 | completed | `pnpm build` passes; targeted CLI/OpenCode tests pass; `pnpm test` passes; `pnpm verify` passes or any failure is documented with concrete output and next action. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | After the package rename, document `@ralphkrauss/agent-orchestrator` and `agent-orchestrator` as canonical names; do not reintroduce `-mcp` names unless a migration issue explicitly asks for compatibility aliases. | Future CLI/docs changes | After implementation if this naming rule is expected to recur. |

## Quality Gates

- [x] Merge-resolution sanity passes: `git diff --check`.
- [x] Affected build command passes: `pnpm build`.
- [x] Affected tests pass: `node --test dist/__tests__/daemonCli.test.js dist/__tests__/opencodeHarness.test.js`.
- [x] Full test suite passes: `pnpm test`.
- [x] Release-quality check passes or failure is recorded: `pnpm verify`.
- [x] Relevant `.agents/rules/` checks are satisfied, especially Node/TypeScript CLI output and MCP config safety.

## Execution Log

### T0: Merge renamed `main` baseline and resolve stale command names
- **Status:** completed
- **Evidence:** Initial `origin/main` merge resolved `package.json` and `src/cli.ts` conflicts to `@ralphkrauss/agent-orchestrator`, `agent-orchestrator`, `agent-orchestrator-daemon`, and `agent-orchestrator-opencode`. A later `git fetch origin main` brought `origin/main` from `635b679` to `50cb902`; the merge stopped on `README.md`, `docs/development/mcp-tooling.md`, and `src/opencode/launcher.ts`; conflicts were resolved by preserving the #11 OpenCode passthrough hardening while keeping `agent-orchestrator opencode` as the canonical help/docs command. The local CLI refactor was preserved through a temporary stash, reapplied, and second-round conflicts in `src/daemon/daemonCli.ts`, `src/__tests__/daemonCli.test.ts`, and `src/__tests__/opencodeHarness.test.ts` were resolved. `git diff --check` passed.
- **Notes:** User approved concluding merge commits on 2026-05-02. The temporary stash was dropped after successful verification.

### T1: Refactor daemon CLI into a reusable argv-driven runner
- **Status:** completed
- **Evidence:** `src/daemon/daemonCli.ts` now exports `runDaemonCli(argv)` and `isDaemonCliCommand(command)`; `src/daemonCli.ts` calls `runDaemonCli()` as a thin wrapper; daemon option parsing now reads from the passed argv instead of fixed `process.argv` positions; `pnpm build` passed; targeted tests passed.
- **Notes:** Standalone `agent-orchestrator-daemon` remains available as a wrapper around the same runner.

### T2: Add direct top-level daemon routing
- **Status:** completed
- **Evidence:** `src/cli.ts` routes `start`, `stop`, `restart`, `status`, `runs`, `watch`, and `prune` to `runDaemonCli(process.argv.slice(2))`; no-arg and `server` branches still precede daemon dispatch; `doctor` and `opencode` remain separate branches; targeted daemon CLI test controls the daemon through `dist/cli.js` and verifies `status --json`.
- **Notes:** User clarified that daemon control should use the main CLI command.

### T3: Update user-facing docs and help text
- **Status:** completed
- **Evidence:** README daemon lifecycle, npx, observability, cleanup examples now prefer `agent-orchestrator ...`; `src/cli.ts` help lists main daemon commands before the standalone daemon alias; `justfile` dogfood commands now invoke `node dist/cli.js <command>`; `docs/development/mcp-tooling.md` restart examples now use `node dist/cli.js restart`.
- **Notes:** `agent-orchestrator-daemon` remains documented as a standalone alias for scripts.

### T4: Add focused tests for renamed CLI surface compatibility
- **Status:** completed
- **Evidence:** `src/__tests__/daemonCli.test.ts` now covers main-CLI help, package bin metadata, and daemon restart/status/status--json through `dist/cli.js`; existing standalone daemon tests remain; `src/__tests__/opencodeHarness.test.ts` verifies OpenCode help prefers `agent-orchestrator opencode` and launcher option errors point to that command; targeted tests passed with 15 tests passing.
- **Notes:** The malformed profile JSON test intentionally keeps the JSON-specific error without adding a help hint.

### T5: Run verification and record evidence
- **Status:** completed
- **Evidence:** `pnpm install --frozen-lockfile` completed using the existing lockfile; `pnpm build` passed; targeted `node --test dist/__tests__/daemonCli.test.js dist/__tests__/opencodeHarness.test.js` passed with 20 tests passing after the #11 merge; `pnpm test` passed with 98 passing tests and 1 skipped Windows named-pipe test; `pnpm verify` passed, including publish readiness, npm dist-tag resolution to `next`, production audit with no known vulnerabilities, and npm pack dry run.
- **Notes:** `pnpm verify` emitted npm warnings about unknown environment configs (`verify-deps-before-run`, `npm-globalconfig`, `_jsr-registry`), but exited successfully.
