# Add --version Flag To CLI Bins

Branch: `41-add---version`
Plan Slug: `add-version-flag`
Parent Issue: #41
Created: 2026-05-06
Updated: 2026-05-07
Status: complete

## Context

Issue #41 ("add --version") asks for a `--version` flag on the package CLI.
The package exposes four bins via `package.json#bin`:

- `agent-orchestrator` → `dist/cli.js`
- `agent-orchestrator-daemon` → `dist/daemonCli.js`
- `agent-orchestrator-opencode` → `dist/opencodeCli.js`
- `agent-orchestrator-claude` → `dist/claudeCli.js`

`src/packageMetadata.ts` already exposes `getPackageVersion()` and
`getPackageMetadata()` (returning `{ name, version }`) by reading the
package's own `package.json`. The package version today is `0.2.1`.

All four bins handle `--help` / `-h` today; none handle `--version`. The
`claude` and `opencode` launchers parse their own argv with a `--`
passthrough boundary that forwards remaining args to the wrapped CLI.

### Sources Read

- `package.json`
- `src/cli.ts`, `src/daemonCli.ts`, `src/claudeCli.ts`, `src/opencodeCli.ts`
- `src/daemon/daemonCli.ts`
- `src/packageMetadata.ts`
- `src/claude/launcher.ts` (argv parser, help text)
- `src/opencode/launcher.ts` (argv parser, help text)
- `.agents/rules/node-typescript.md` (CLI changes must verify human-readable
  and JSON output where applicable)
- `AGENTS.md` (build/test commands; CLI behavior stability)

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Which bins accept `--version` | All four (`agent-orchestrator`, `-daemon`, `-opencode`, `-claude`) | All bins ship from the same package and share the same version; partial coverage would be surprising. | Only the main `agent-orchestrator` bin. |
| 2 | Default output shape | `agent-orchestrator <version>\n` (name + version) on the main bin; each launcher bin uses its own bin name (`agent-orchestrator-daemon <version>`, etc.) | Matches `gh --version`, helpful when bins are aliased or invoked from logs. | Just the version string; just the package name from `package.json` (would not match the invoked bin). |
| 3 | `--json` support | `--version --json` prints `{ "name": "@ralphkrauss/agent-orchestrator", "version": "0.2.1" }` (single line + trailing newline) | Mirrors `doctor --json` and `status --json`; satisfies the `node-typescript` rule about verifying both human and JSON output. | Human-only output; multi-line JSON. |
| 4 | Flag form | `--version` only; no `-v` shorthand and no `version` subcommand | `--verbose` already exists on `daemon status`; `-v` would invite confusion. A `version` subcommand is not requested. | `-v` / `-V` shorthand; `version` subcommand. |
| 5 | Behavior in launcher subcommands | `agent-orchestrator claude --version`, `agent-orchestrator opencode --version`, `agent-orchestrator-claude --version`, `agent-orchestrator-opencode --version` print the orchestrator's version. To query the wrapped CLI, use `-- --version`. | The launcher owns its argv; intercepting is consistent with `--help` behavior in the same parser. The `--` passthrough boundary remains the documented escape hatch. | Forward `--version` to the wrapped CLI by default. |
| 6 | Daemon-CLI surface | `agent-orchestrator <daemon-cmd> --version` and the standalone `agent-orchestrator-daemon --version` are handled identically (top-level intercept in `cli.ts` for the shared bin; intercept in `runDaemonCli` for the standalone bin). | Both bins share the same dispatcher and must behave the same. | Handle only one of the two entry paths. |
| 7 | Position of `--version` | Top-level only: must appear as the first argv token (or before any subcommand). `agent-orchestrator doctor --version` is treated as part of the `doctor` subcommand args (current `doctor` ignores it; no new behavior here). | Avoids ambiguity inside subcommands that may legitimately accept their own `--version`-like passthrough or future flags. | Recursive `--version` handling on every subcommand. |
| 8 | Exit code | `0` after printing version. | Standard CLI convention. | Non-zero. |

## Scope

### In Scope

- Top-level `--version` (and `--version --json`) on `agent-orchestrator`,
  `agent-orchestrator-daemon`, `agent-orchestrator-opencode`, and
  `agent-orchestrator-claude`.
- Updating each bin's `--help` text to list `--version` and `--version --json`.
- Tests covering: human output for each bin, JSON output for one bin,
  exit code, that `--version` does not start the daemon / launch the wrapped
  CLI, and that `claude --` / `opencode --` passthrough still forwards
  `--version` to the wrapped binary.
- Updating `README.md` if it documents the CLI surface (verify and add a
  brief mention).

### Out Of Scope

- Adding a `version` subcommand.
- Adding `-v` / `-V` shorthand.
- Any change to the npm publish flow, dist-tag selection, or
  `daemonVersion` mismatch logic.
- Recursive `--version` inside `doctor`, `status`, `runs`, `watch`, `prune`,
  `auth`, `supervisor`, `monitor`. Those subcommands keep their current argv
  handling.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | `--version` accidentally falls through and starts the MCP server (current `cli.ts` treats unknown / missing first arg as `server`). | Intercept before the `server` branch in `cli.ts`. | Task T1; test covering top-level `--version` exit before server import. |
| 2 | `--version` accidentally falls through to the wrapped `claude`/`opencode` binary or to `runClaudeLauncher`'s parser, which would currently treat it as an unknown flag and emit an error. | Intercept inside the launcher's argv parser before any other validation; before the `--` passthrough split. | Task T2; tests on launcher bins. |
| 3 | `--version --json` produces malformed or multi-line JSON that breaks downstream tools. | Single-line `JSON.stringify({ name, version })` plus trailing newline. | Task T1; JSON test. |
| 4 | Help text rots if `--version` is not added. | Update help strings in `cli.ts`, `daemon/daemonCli.ts`, `claude/launcher.ts`, `opencode/launcher.ts` in the same task. | Task T3. |
| 5 | Tests that spawn `dist/cli.js` would require a build step before running. | Reuse the existing `pnpm build && pnpm test` flow; tests live as `node:test` files compiled into `dist/__tests__`. Spawn `process.execPath` against the built JS, matching the existing daemon-cli spawn pattern. | Task T4. |
| 6 | `getPackageMetadata()` returns a `version: 'unknown'` fallback when `package.json` is unreadable; tests must not bake in `0.2.1` literally. | Tests assert against `getPackageVersion()` (matches existing patterns in `diagnostics.test.ts` / `ipc.test.ts`). | Task T4. |
| 7 | Adding a new code path in `cli.ts` could perturb startup latency for the default (no-arg) MCP server case. | New branch is a synchronous string compare ahead of the existing dispatch; no extra imports on the no-arg path. | Task T1. |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T1 | Intercept `--version` in `src/cli.ts` | — | done | When `process.argv[2] === '--version'`, print `agent-orchestrator <version>\n` (or single-line JSON if `--json` is also present) and exit `0`. The `server`, `doctor`, `opencode`, `claude`, `monitor`, `auth`, `supervisor`, and daemon-command branches are not entered. Uses `getPackageMetadata()` from `src/packageMetadata.js`. No new imports added to the no-arg server-start path. |
| T2 | Intercept `--version` in `runDaemonCli` (`src/daemon/daemonCli.ts`) | — | done | When the first argv to `runDaemonCli` is `--version`, print `agent-orchestrator-daemon <version>\n` (or `--json` form) and return without dispatching. Behavior is identical whether invoked via the standalone `agent-orchestrator-daemon` bin (`src/daemonCli.ts`) or via `agent-orchestrator <daemon-cmd>` routed through `cli.ts`. The `cli.ts` top-level `--version` handler from T1 still wins for the shared bin (i.e., `agent-orchestrator --version` prints the `agent-orchestrator` name, not the daemon name). |
| T3 | Intercept `--version` in `runClaudeLauncher` and `runOpenCodeLauncher` argv parsers | — | done | When the first own-arg (i.e., before any `--` separator) is `--version`, print `agent-orchestrator-claude <version>\n` / `agent-orchestrator-opencode <version>\n` (or `--json` form) and return exit code `0` without spawning the wrapped binary. `agent-orchestrator claude -- --version` still forwards `--version` to the claude binary unchanged. |
| T4 | Update `--help` text on all four bins | T1, T2, T3 | done | Help output for `agent-orchestrator`, `agent-orchestrator-daemon`, `agent-orchestrator claude`, `agent-orchestrator-claude`, `agent-orchestrator opencode`, and `agent-orchestrator-opencode` lists `--version` and `--version --json`. |
| T5 | Add tests | T1, T2, T3 | done | New `src/__tests__/cliVersion.test.ts` (14 tests) covers all four bins, JSON output, subcommand routing, launcher run-function intercept, parser-level confirmation that `-- --version` is forwarded, and regression tests confirming a misplaced `--version` (not at position 0 of own-args) falls through to the parser. |
| T6 | Update README | T1–T4 | not needed | README does not enumerate `--help`/`--version` style flags; per acceptance criteria, no change required. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | None proposed | — | — |

## Quality Gates

- [x] `pnpm build` passes (`tsc` clean).
- [x] `pnpm test` passes — 549 tests, 547 pass, 2 skipped, 0 fail (includes new `cliVersion.test.ts` with 17 tests).
- [x] Manual smoke covered by spawn-based tests in `cliVersion.test.ts`.
- [x] `--help` text on each bin lists `--version` (covered by the help-text assertion in `cliVersion.test.ts` plus inline edits to `claudeLauncherHelp()` / `openCodeLauncherHelp()`).
- [x] `node-typescript` rule satisfied: both human-readable and JSON output verified.

## Execution Log

### T1: Intercept `--version` in `src/cli.ts`
- **Status:** done
- **Evidence:** `src/cli.ts:5-12` — adds the `--version` branch ahead of all other dispatch paths (including the no-arg `server` fallthrough). Uses `formatVersionOutput('agent-orchestrator', process.argv.includes('--json'))`. Help-text block also updated to list `--version` / `--version --json` for the main bin and the daemon alias.
- **Notes:** A small shared helper `formatVersionOutput(binName, json)` was added to `src/packageMetadata.ts` so all four bins emit identical shapes from a single formatter.

### T2: Intercept `--version` in `runDaemonCli`
- **Status:** done
- **Evidence:** `src/daemon/daemonCli.ts` — added a `case '--version'` arm in `runDaemonCli`'s switch. `daemonHelp()` updated to mention `--version [--json]`. Standalone bin (`src/daemonCli.ts`) dispatches to `runDaemonCli` so this covers both call paths; `cli.ts` (T1) still wins for the shared `agent-orchestrator` bin so the printed name matches the invoked bin.
- **Notes:** `--version` is not in `daemonCommands`, so it cannot be reached via `cli.ts`'s `isDaemonCliCommand` path; only the standalone `agent-orchestrator-daemon --version` invocation reaches this handler.

### T3: Intercept `--version` in launcher argv parsers
- **Status:** done
- **Evidence:**
  - `src/claude/launcher.ts` — `runClaudeLauncher` slices own-args (drops a leading `setup` token, then everything before the `--` separator) and intercepts `--version` only when it is the first own-arg (`ownArgs[0] === '--version'`). Help text in `claudeLauncherHelp()` updated.
  - `src/opencode/launcher.ts` — same intercept pattern in `runOpenCodeLauncher`. Help text in `openCodeLauncherHelp()` updated.
- **Notes:** I deliberately did *not* add `--version` (or `--json`) to either parser's known-flag set. Doing so would have implicitly accepted `--json` as a top-level launcher flag, expanding the launcher's argv surface beyond what was scoped. The pre-parse own-args scan keeps the surface tight.
- **Review fix (2026-05-07):** initial implementation used `ownArgs.includes('--version')`, which would intercept `--version` anywhere before the `--` separator. The plan requires *first own-arg* only, so a misplaced `--version` (e.g., `--cwd --version`, `--print-config --version`) must fall through to the parser instead of short-circuiting. Tightened to `ownArgs[0] === '--version'` and added regression tests in T5.

### T4: Update `--help` text on all four bins
- **Status:** done
- **Evidence:**
  - `src/cli.ts` — main and daemon-alias help blocks list `--version` / `--version --json` and `agent-orchestrator-opencode --version`.
  - `src/daemon/daemonCli.ts` — `daemonHelp()` lists `--version [--json]`.
  - `src/claude/launcher.ts` — `claudeLauncherHelp()` lists `--version [--json]` with the `-- --version` passthrough hint.
  - `src/opencode/launcher.ts` — `openCodeLauncherHelp()` lists `--version [--json]` with the `-- --version` passthrough hint.

### T5: Add tests
- **Status:** done
- **Evidence:** `src/__tests__/cliVersion.test.ts` — 17 tests, all passing:
  - 4 spawn tests (one per bin) asserting `^<bin-name> <getPackageVersion()>\n$`.
  - 4 JSON-output tests (one per bin): main and daemon spawn-based, claude and opencode in-process; each parses `{ name, version }` and asserts `name === getPackageMetadata().name` and `version === getPackageMetadata().version`. The main-bin test additionally asserts a single-line shape.
  - 2 spawn tests for subcommand routing (`agent-orchestrator claude --version`, `agent-orchestrator opencode --version`).
  - 2 in-process tests of `runClaudeLauncher` / `runOpenCodeLauncher` via stub streams to confirm exit `0` and no fs/discovery side effects.
  - 2 parser-level tests confirming `-- --version` is forwarded to `claudeArgs` / `opencodeArgs`.
  - 2 regression tests (added 2026-05-07 review) confirming a misplaced `--version` (e.g., `['--print-config', '--version']`) falls through to the parser, prints nothing on stdout, and yields `Unknown option: --version` on stderr.
  - 1 help-text test asserting both `agent-orchestrator --version` and `agent-orchestrator-daemon --version` appear in the main help.
- **Notes:** Tests assert against `getPackageVersion()` / `getPackageMetadata()` rather than literal `0.2.1`, matching the existing pattern in `diagnostics.test.ts` / `ipc.test.ts`. The three additional JSON tests for daemon/claude/opencode were added in PR #49 review round-2 (CodeRabbit nitpick) to close coverage on the shared `formatVersionOutput(..., true)` path.

### T6: Update README
- **Status:** not needed
- **Evidence:** Searched README for `--help` / `agent-orchestrator --help` / `agent-orchestrator-daemon --help` (`grep -n`) — no standalone flag enumeration exists. Per the acceptance criteria, no README change.

## Hardening Pass

- **Missed call sites:** none. The four bins are `cli.ts`, `daemonCli.ts`, `claudeCli.ts`, `opencodeCli.ts`; daemon dispatches via `runDaemonCli` (covered by T2) and the wrappers dispatch via `runClaudeLauncher` / `runOpenCodeLauncher` (covered by T3).
- **No-arg latency:** the `--version` branch in `cli.ts` is a synchronous string compare ahead of the existing dispatch; the only new import on the no-arg server-start path is `formatVersionOutput` (a tiny module already eagerly imported by `daemonCli` etc.). No new I/O on the server-start path.
- **JSON shape:** single-line `JSON.stringify({ name, version })` plus trailing newline; verified by the JSON test.
- **CHANGELOG:** intentionally not updated. The Unreleased section documents an unrelated codex egress change; PUBLISHING.md does not document a CHANGELOG convention; adding this small additive feature there would broaden scope without instruction.
