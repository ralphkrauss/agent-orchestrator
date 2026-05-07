## Root Command Prints Help On A TTY

Branch: `33-root-command-should-give-you-the-help`
Plan Slug: `33-root-command-help`
Parent Issue: #33
Created: 2026-05-06
Status: implemented (awaiting review)

## Context

Issue #33: when a user runs `agent-orchestrator` interactively, they see "a stream of json messages" because the no-args branch of `src/cli.ts` immediately starts the stdio MCP server (which begins accepting JSON-RPC over stdin/stdout). The user wants `agent-orchestrator` with no args to behave like `agent-orchestrator --help`.

Plan #14 explicitly preserved no-args server startup (Decision 2 of `plans/14-clean-up-the-cli-surface/plans/14-clean-cli-surface.md`) because every MCP client config in the README invokes `npx -y @ralphkrauss/agent-orchestrator@latest` with no command arguments. A naive flip to "always show help" would break those configs in the wild. The chosen reconciliation is to switch on whether stdin is a TTY: humans get help, piped stdio (MCP clients) get the server. This keeps every existing MCP client config working unchanged.

Sources read:

- `AGENTS.md`: keep public package behavior stable unless the task is explicitly an API/contract change; verify both human-readable and JSON CLI output where applicable; record concrete verification evidence; do not commit/push without instruction.
- `.agents/rules/node-typescript.md` (source of truth; `.claude/rules/node-typescript.md` is a generated mirror): pnpm-only, Node 22+, keep `tsconfig.json` strict, prefer Node built-ins, no new deps without asking, verify CLI human + JSON output where applicable.
- GitHub issue #33: "now when I run agent-orchestrator I see some stream of json messages, not very useful. it should just work like help and give you assistance on how to use the tool".
- `src/cli.ts`: dispatch table; current branches are `doctor`, no-arg/`server`, `opencode`, `claude`, `monitor`, `auth`, `supervisor`, daemon commands via `isDaemonCliCommand`, and `--help`/`-h`/`help`. The help text and the no-args dispatch live inline in this file today.
- `src/server.ts`: imports start the MCP wiring, call `await ensureDaemon({ allowVersionMismatch: true })` (which spawns `daemonMain.js` with `detached: true`/`stdio: 'ignore'` if no daemon is running) and `await server.connect(transport)` at module top level. So *any* import of `./server.js` — including from a unit test — will auto-start the daemon and connect MCP stdio. Helper code intended for unit tests must live in a separate, side-effect-free module.
- `src/__tests__/daemonCli.test.ts`: spawns `dist/cli.js --help` with `execFile` to assert help output (provides the help-text test pattern); and isolates daemon state in tests by `mkdtemp(...)`-ing a temp root, setting `env.AGENT_ORCHESTRATOR_HOME = <home>` for the spawn, and cleaning up with `cliPath stop --force` plus a `waitForStopped(env)` helper (see lines 56–104 and 166–177). The new spawn test copies this isolation + cleanup pattern into its own file so it cannot leak a daemon onto the developer's `~/.agent-orchestrator/`. (We do not `import` from `daemonCli.test.ts`; importing another test file would execute its top-level `describe`/`it` definitions.)
- `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js` (SDK 1.29.0, the version pinned in this repo): MCP stdio transport uses **newline-delimited JSON**, not `Content-Length` framing. `serializeMessage(message) = JSON.stringify(message) + '\n'` (lines 28–30). `ReadBuffer.readMessage` splits on the first `\n`, strips a trailing `\r`, and `JSON.parse`s the result (lines 13–19). The new spawn test in T3 must write and read using this exact framing.
- `node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js`: `StdioServerTransport.send` calls `serializeMessage` and writes to `process.stdout`; `start()` listens for `data` on `process.stdin` and feeds it through `ReadBuffer` (lines 26–47, 63–73). Confirms the server reads the same NDJSON framing the test will write.
- `package.json`: `bin.agent-orchestrator -> dist/cli.js`; Node 22+; no new deps required.
- `README.md`: every MCP client config example invokes the package with no args (`npx -y @ralphkrauss/agent-orchestrator@latest`); MCP clients always pipe stdio. Line ~15 ("For local development from a checkout") shows a bare `node dist/cli.js` invocation that is intended as an MCP-style smoke test and will, after this change, print help when the developer's terminal is a TTY.
- `docs/development/mcp-tooling.md` ~line 301 ("Agent Orchestrator Server"): instructs running `node dist/cli.js` to start the local-checkout MCP server. This is the local-dogfood entry point and must keep working — either via piped stdin from the MCP client (which is what really happens) or via an explicit `server` subcommand.
- `plans/14-clean-up-the-cli-surface/plans/14-clean-cli-surface.md` Decision 2: prior choice to keep no-args server startup, which this plan revises to TTY-based dispatch.

Verification commands:

- `pnpm build`
- `node --test dist/__tests__/daemonCli.test.js` (existing `--help` coverage)
- `node --test dist/__tests__/cliRoot.test.js` (new file, see T3)
- `pnpm test`
- `pnpm verify`

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | No-args dispatch | When `process.stdin.isTTY` is truthy, print the shared help text and exit 0. Otherwise import `./server.js` exactly as today. | Issue #33 wants help on a terminal; existing MCP client configs (every README example) use no args and pipe stdio, so a TTY check splits the cases without breaking any deployed config. | (a) Hard switch to help and require `agent-orchestrator server` for MCP — breaks every MCP config in the README and in user installations. (b) Deprecation period (warn on stderr, still start server) — drags out the bad UX the issue is about and adds noise to MCP stderr streams that some clients surface to users. |
| 2 | Detection signal | Use `process.stdin.isTTY`. | MCP stdio clients always pipe stdin (and stdout). Humans launching the CLI have a TTY on stdin. `stdin` is more reliable than `stdout` because users sometimes redirect stdout (e.g., piping help to `less`) without intending an MCP client invocation. | (a) `process.stdout.isTTY` — false-negatives when humans pipe help into a pager. (b) Both stdin and stdout TTY — too restrictive. (c) Env-var opt-in (`AGENT_ORCHESTRATOR_HELP_ON_TTY=1`) — users would never set it; defeats the purpose. |
| 3 | Escape hatch | None beyond the existing explicit `agent-orchestrator server` subcommand. | `server` already starts the MCP server explicitly and is documented; that is the documented way to override TTY detection if it ever misfires. | Adding `AGENT_ORCHESTRATOR_FORCE_SERVER=1` — premature; we have no reported case of misdetection. Can be added later if needed. |
| 4 | Help content | Reuse one shared help string for all help paths (`agent-orchestrator` no-args TTY branch, `--help`, `-h`, and `help`). The string lives in the new side-effect-free module (see Decision 6) and `cli.ts` writes it to stdout in every help path. The body of the help is unchanged from today except for the wording change in Decision 5. | Smallest diff; one source of truth for help text; no test churn for the help body. The existing block already groups commands and is good enough. | Reformatting the help with sections/examples — out of scope for this issue; can be a follow-up. |
| 5 | Help text wording for the no-args line | Change the "agent-orchestrator              Start the stdio MCP server" line to "agent-orchestrator              Show this help in a terminal; start the MCP server for piped stdio". Keep the explicit "agent-orchestrator server       Start the stdio MCP server" line unchanged. | Honestly describes the new behavior so a user reading help understands why the same command may have done something different in an MCP client context. | Removing the no-args line — confusing. Leaving the line unchanged — misleading after the behavior change. |
| 6 | Refactor shape | Create a new side-effect-free module `src/cliRoot.ts` that exports (a) `HELP_TEXT` (the shared help string used by all help paths) and (b) a pure helper `decideRootMode(stdinIsTty: boolean \| undefined): 'help' \| 'server'`. `src/cli.ts` imports both and uses them in the no-args and explicit-help branches. The dispatch caller still does `await import('./server.js')` for the `'server'` branch, so the import-time `await server.connect(transport)` behavior of `src/server.ts` is unchanged. The unit test imports `src/cliRoot.ts` only, never `src/cli.ts` or `src/server.ts`, so it cannot trigger the daemon-spawn / MCP-connect side effects. | A pure function in a side-effect-free module is unit-testable without a pty *and* without spawning a daemon. Keeping `await import('./server.js')` in `cli.ts` preserves the current import-time `server.connect(transport)` behavior. Importing `src/cli.ts` from a unit test would execute the top-level dispatch (and may import `./server.js`, which auto-starts the daemon), so the helper must not live in `cli.ts`. | (a) Put the helper in `src/cli.ts` — importing `src/cli.ts` runs CLI top-level code and may transitively start the daemon. (b) Wrap server startup in a function inside `src/server.ts` — invasive change to a hot path; risks regressing the stdio handshake. (c) Use a pty-based test — would need a new dev dependency (`node-pty`) we have no other reason to add. |
| 7 | Exit code on help | `process.exit(0)` (or fall through to natural exit) for the help-on-TTY path. | `--help` today exits 0 (no explicit exit; falls through after writing); matching that keeps shells, pipelines, and CI consistent. | Non-zero exit for "no command" — would break any script that relies on TTY-less invocation; we rely on TTY presence as the discriminator instead. |

## Scope

### In Scope

- New file `src/cliRoot.ts`: exports `HELP_TEXT` and `decideRootMode(stdinIsTty)`. No imports of `./server.js`, `./daemon/*`, or anything with import-time side effects. Pure module.
- `src/cli.ts`: imports `HELP_TEXT` and `decideRootMode` from `./cliRoot.js`. The no-args branch consults `decideRootMode(process.stdin.isTTY)` and either writes `HELP_TEXT` or `await import('./server.js')`. The existing `--help`/`-h`/`help` branch writes the same `HELP_TEXT`.
- `src/cliRoot.ts`: help-text wording for the no-args line (Decision 5) baked into the shared `HELP_TEXT`.
- One small focused test file `src/__tests__/cliRoot.test.ts` that:
  - Imports `src/cliRoot.ts` directly (no `cli.ts`, no `server.ts`) and asserts the pure dispatch helper returns `'help'` for `stdinIsTty: true` and `'server'` for `stdinIsTty: false` and `stdinIsTty: undefined`.
  - Asserts `HELP_TEXT` contains the new no-args wording line and the unchanged explicit-`server` line.
  - Spawn test (defense-in-depth): isolates state with `mkdtemp` + `AGENT_ORCHESTRATOR_HOME`, spawns `dist/cli.js` with default piped stdin, sends a real MCP `initialize` JSON-RPC request over stdin, asserts a framed JSON-RPC response on stdout, then cleans up with `dist/cli.js stop --force` and `waitForStopped(env)`. Reuses the isolation pattern from `src/__tests__/daemonCli.test.ts` lines 56–104 and 166–177.
- README clarification (line ~15 region and the MCP client config block): one-line note that the bare `node dist/cli.js` example is for piped MCP-client use, and that the same command from a terminal now prints help.
- `docs/development/mcp-tooling.md` ~line 301: clarify that `node dist/cli.js` starts the MCP server when invoked over piped stdio (e.g., from an MCP client) and prints help on a TTY; explicitly point at `node dist/cli.js server` as the always-server form.

### Out Of Scope

- Reformatting or expanding the help text body (Decision 4).
- Changing `agent-orchestrator server`, `doctor`, `opencode`, `claude`, `monitor`, `auth`, `supervisor`, or any daemon subcommand.
- Changing MCP tool names, schemas, server transport, or daemon IPC.
- Changing `src/server.ts` startup ordering (`ensureDaemon` then `server.connect(transport)`).
- Adding a `node-pty` or any other new dependency.
- Adding env-var overrides for TTY detection (Decision 3).
- Bumping the package version, publishing, or pushing.
- Editing `.agents/` rule files unless a new repeatable rule emerges (see Rule Candidates).

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | An MCP client launches `agent-orchestrator` in a way where stdin is unexpectedly a TTY (none known today). | Document `agent-orchestrator server` as the explicit MCP-server entry point and keep it always working. The help text we print on a TTY tells the user how to start the server. | Decision 3, T1, T4 |
| 2 | A CI script runs `agent-orchestrator` with no stdin attached and expects the server to start. | `process.stdin.isTTY` is `undefined`/`false` when stdin is a pipe or `/dev/null`, so the server still starts. This matches the current behavior for non-TTY invocation. | T1, T3 |
| 3 | The README and `docs/development/mcp-tooling.md` show bare `node dist/cli.js` examples that humans may run on a TTY. After this change those will print help, not start the server. | T4 adds a one-line clarification next to each example explaining the TTY-vs-piped-stdio split, and points at `agent-orchestrator server` (or `node dist/cli.js server`) as the always-server form. The MCP-client configs themselves are unchanged because they always pipe stdio. | T4 |
| 4 | A test that spawns `dist/cli.js` with piped stdin auto-starts the daemon (`ensureDaemon` in `src/server.ts`) and writes to the user's `~/.agent-orchestrator/` if `AGENT_ORCHESTRATOR_HOME` is unset. This would pollute the developer's machine and could fight a real daemon. | The spawn test sets `AGENT_ORCHESTRATOR_HOME=<mkdtemp>` for the child process and ends the test by calling `dist/cli.js stop --force` against the same env, then `waitForStopped(env)`, then `rm -rf` the temp root. This is the pattern already used by `daemonCli.test.ts` (`controls the daemon through the top-level CLI`). | T3 |
| 5 | A spawn smoke test that just checks "child did not exit within N ms" can pass for a hung child and does not prove MCP stdio still works. | The spawn test sends a real MCP `initialize` JSON-RPC request and asserts a successful framed JSON-RPC response on stdout (matching `id=1`, `result` set, `result.serverInfo.name === "agent-orchestrator"`). The framing matches what `StdioServerTransport` actually uses today — newline-delimited JSON, `JSON.stringify(message) + '\n'` — verified at `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js` line 28–30 and line 13–19. That proves the stdio MCP transport is still wired up after the dispatch refactor. | T3 |
| 6 | The help-on-TTY path on Windows (Node 22) where `process.stdin.isTTY` semantics in PowerShell vs. Git Bash vs. cmd.exe could differ. | Node's `tty.ReadStream.isTTY` is documented and consistent across platforms when stdin is attached to a console; the spawn test (piped stdin) covers the non-TTY direction on all platforms. Manual smoke on a TTY is sufficient for the positive direction. | T3, T6 |
| 7 | The existing `--help` test in `src/__tests__/daemonCli.test.ts` greps the help text. | The help text content does not change except for one line wording (Decision 5). Update the assertion only if it pins that exact line; today's test asserts on subcommand lines that are unaffected. | T1, T2 |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T1 | Add `src/cliRoot.ts` with `HELP_TEXT` + `decideRootMode` | None | pending | New file `src/cliRoot.ts` exists and is side-effect-free (no top-level `await`; no import of `./server.js`, `./daemon/*`, `./diagnostics.js`, or any module with import-time side effects). It exports `export const HELP_TEXT: string` (the same body as today's `--help` block, with the no-args wording change from Decision 5 baked in) and `export function decideRootMode(stdinIsTty: boolean \| undefined): 'help' \| 'server'` returning `'help'` iff `stdinIsTty === true`. `pnpm build` succeeds. |
| T2 | Wire `src/cli.ts` to use the new module | T1 | pending | `src/cli.ts` imports `HELP_TEXT` and `decideRootMode` from `./cliRoot.js`. The no-args branch (`!command`) calls `decideRootMode(process.stdin.isTTY)` and writes `HELP_TEXT` to stdout (and falls through / `process.exit(0)`) for `'help'`, or `await import('./server.js')` for `'server'`. The explicit `command === 'server'` branch is unchanged: it always imports `./server.js`. The `--help`/`-h`/`help` branch writes the same `HELP_TEXT`. The inline help block in `src/cli.ts` is removed (no duplication). `pnpm build` succeeds and the existing `daemonCli.test.ts --help` assertions still pass (the subcommand lines are unchanged; only one wording line moves). |
| T3 | Add focused tests in `src/__tests__/cliRoot.test.ts` | T1, T2 | pending | New `src/__tests__/cliRoot.test.ts` covers: (a) unit: import `../cliRoot.js` and assert `decideRootMode(true) === 'help'`, `decideRootMode(false) === 'server'`, `decideRootMode(undefined) === 'server'`; (b) unit: assert `HELP_TEXT` contains both `agent-orchestrator              Show this help in a terminal; start the MCP server for piped stdio` and `agent-orchestrator server       Start the stdio MCP server`; (c) spawn test: `mkdtemp(join(tmpdir(), 'agent-cli-root-'))` for an isolated home; spawn `dist/cli.js` with `env = { ...process.env, AGENT_ORCHESTRATOR_HOME: home }` and default (piped) stdio; write the JSON-RPC `initialize` request to the child's stdin using the framing `StdioServerTransport` actually expects — `JSON.stringify(message) + '\n'` (newline-delimited JSON), per `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js` line 28–30 (`serializeMessage`) and line 13–19 (`ReadBuffer.readMessage` splits on `\n` and strips a trailing `\r`). The exact bytes written: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cliRoot.test","version":"0.0.0"}}}\n`. Parse the child's stdout the same way: accumulate chunks into a buffer, split on `\n`, strip trailing `\r`, JSON.parse each non-empty line, take the first message with `id === 1`. Assert the parsed message has `jsonrpc === "2.0"`, `id === 1`, a `result` (not an `error`), `result.protocolVersion` is a string, and `result.serverInfo?.name === "agent-orchestrator"` (matches `src/server.ts` `new Server({ name: 'agent-orchestrator', ... })`). Then kill the child; cleanup in `finally`: `execFileAsync(process.execPath, [cliPath, 'stop', '--force'], { env, timeout: 10_000 }).catch(() => undefined)`, then a locally-defined `waitForStopped(env)` helper (copy the function body from `src/__tests__/daemonCli.test.ts` lines 166–177 into this test file — do NOT `import` from the other test file, since that would execute its top-level `describe`/`it` definitions), then `rm(root, { recursive: true, force: true })`. The test must not run without `AGENT_ORCHESTRATOR_HOME` isolation. (d) spawn test: `dist/cli.js --help` still prints the help text (regression check; may be redundant with the existing `daemonCli.test.ts --help` test — keep it there if so). |
| T4 | Update README and human-facing docs | T2 | pending | `README.md` ~line 15 ("For local development from a checkout"): leave the `node dist/cli.js doctor` line alone; for the bare `node dist/cli.js` line, change it to `node dist/cli.js server` (explicit MCP-server entry — the intended behavior of the example). Add one short sentence near the MCP client config block clarifying that no-args invocation starts the stdio MCP server because clients pipe stdin/stdout, and that running `agent-orchestrator` from a terminal now prints help. `docs/development/mcp-tooling.md` ~line 301: change the example from `node dist/cli.js` to `node dist/cli.js server` (explicit MCP-server entry) and add a one-line note that the bare form prints help on a TTY. No other docs reword. |
| T5 | Sync AI workspace if any rule/skill changed | T4 | pending | If T4 or any earlier task edits `.agents/`, run `node scripts/sync-ai-workspace.mjs`. Otherwise this task is a documented no-op. |
| T6 | Verify and record evidence | T1, T2, T3, T4, T5 | pending | `pnpm build` passes. `node --test dist/__tests__/daemonCli.test.js dist/__tests__/cliRoot.test.js` passes. `pnpm test` passes. `pnpm verify` passes (or any failure is documented with concrete output and next step). Manual smoke (recorded in execution log): in this terminal, `node dist/cli.js` prints help and exits 0; then run the piped-stdin smoke as: <br>`TEMP_HOME=$(mktemp -d)` <br>`printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}\n' \| AGENT_ORCHESTRATOR_HOME=$TEMP_HOME node dist/cli.js` <br>and confirm a JSON-RPC response with `id=1` and `result.serverInfo.name === "agent-orchestrator"`; then <br>`AGENT_ORCHESTRATOR_HOME=$TEMP_HOME node dist/cli.js stop --force` <br>`rm -rf "$TEMP_HOME"` <br>The same `$TEMP_HOME` is used for the smoke and the cleanup so the spawned daemon is shut down deterministically. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | When a CLI is also an MCP stdio entry point, gate human-friendly behavior (help, banners, prompts) on `process.stdin.isTTY` so MCP clients that pipe stdio are never affected. | All CLI work that adds interactive output to a binary that doubles as an MCP server. | After T6, if this comes up again on `opencode`/`claude` launchers. |
| 2 | Helpers intended for unit tests must live in side-effect-free modules; never put them in `cli.ts` or any file with top-level `await` / import-time side effects (e.g., `server.connect`). | All CLI source files. | After T6 if this distinction needs explicit guidance. |

## Quality Gates

- [ ] `pnpm build` passes.
- [ ] `node --test dist/__tests__/daemonCli.test.js dist/__tests__/cliRoot.test.js` passes.
- [ ] `pnpm test` passes.
- [ ] `pnpm verify` passes (or documented failure).
- [ ] `.agents/rules/node-typescript.md` (source of truth): no new deps; pnpm only; TS strictness intact; CLI human + JSON output verified where touched.
- [ ] Manual smoke: `node dist/cli.js` from this terminal prints help; piped-stdin invocation with isolated `AGENT_ORCHESTRATOR_HOME` answers an MCP `initialize` request, then `stop --force` shuts the test daemon down.
- [ ] No commit, push, or version bump performed.

## Reviewer Questions

none

## Open Human Decisions

none

## Execution Log

### T1: Add `src/cliRoot.ts` with `HELP_TEXT` + `decideRootMode`
- **Status:** done
- **Evidence:** New `src/cliRoot.ts` created. No top-level `await`; imports nothing (no `./server.js`, no `./daemon/*`, no `./diagnostics.js`). Exports `HELP_TEXT` (with the Decision 5 wording change baked into the no-args line) and `decideRootMode(stdinIsTty)` returning `'help'` iff `stdinIsTty === true`.
- **Notes:** Module is pure; safe to import from unit tests without daemon side effects.

### T2: Wire `src/cli.ts` to use the new module
- **Status:** done
- **Evidence:** `src/cli.ts` now imports `HELP_TEXT` and `decideRootMode` from `./cliRoot.js`. Inline help block removed (single source of truth). No-args branch consults `decideRootMode(process.stdin.isTTY)` — writes `HELP_TEXT` for `'help'`, falls through to `await import('./server.js')` for `'server'`. Explicit `command === 'server'` is its own branch and unchanged. `--help`/`-h`/`help` writes the same `HELP_TEXT`.
- **Notes:** Existing `daemonCli.test.ts --help` assertions continue to pass because subcommand lines are unchanged.

### T3: Add focused tests in `src/__tests__/cliRoot.test.ts`
- **Status:** done
- **Evidence:** New `src/__tests__/cliRoot.test.ts` covers (a) `decideRootMode` truth table; (b) `HELP_TEXT` contains both the bare-invocation wording and the explicit-server line; (c) regression: `dist/cli.js --help` prints help; (d) spawn test that isolates `AGENT_ORCHESTRATOR_HOME` via `mkdtemp`, sends NDJSON `initialize` to a piped stdin, parses the framed response, asserts `result.serverInfo.name === "agent-orchestrator"`. Cleanup uses `dist/cli.js stop --force` + a locally-defined `waitForStopped` helper + `rm -rf` of the temp home (no import from `daemonCli.test.ts`). All four cliRoot tests pass.
- **Notes:** Run: `node --test dist/__tests__/daemonCli.test.js dist/__tests__/cliRoot.test.js` → 11/11 passing.

### T4: Update README and human-facing docs
- **Status:** done
- **Evidence:** `README.md` local-checkout block changed `node dist/cli.js` → `node dist/cli.js server` and added a one-paragraph note clarifying that bare invocation prints help on a TTY and starts the MCP server when stdin is piped. `docs/development/mcp-tooling.md` ~line 301 changed the example to `node dist/cli.js server` and added a one-line note that the bare form prints help on a TTY. MCP client config blocks left unchanged because they always pipe stdio.
- **Notes:** No changes elsewhere; line ~330 statement that `dist/cli.js` "starts the stdio MCP server" still holds in MCP-client (piped-stdin) context.

### T5: Sync AI workspace if any rule/skill changed
- **Status:** done (no-op)
- **Evidence:** No edits under `.agents/` — `sync-ai-workspace.mjs` not run.
- **Notes:** Per plan, T5 is a documented no-op when no rule/skill changed.

### T6: Verify and record evidence
- **Status:** done
- **Evidence:**
  - `pnpm build` → exit 0.
  - `node --test dist/__tests__/daemonCli.test.js dist/__tests__/cliRoot.test.js` → 11 pass / 0 fail (4 cliRoot, 7 daemon CLI).
  - `pnpm test` → 534 pass / 0 fail / 2 skipped (536 total, 108 suites).
  - `pnpm verify` → exit 0 (build + test + check-publish-ready + resolve-publish-tag + audit + npm pack --dry-run all green).
  - Manual smoke: `TEMP_HOME=$(mktemp -d); printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}\n' | AGENT_ORCHESTRATOR_HOME=$TEMP_HOME node dist/cli.js` returned `{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"agent-orchestrator","version":"0.2.1"}},"jsonrpc":"2.0","id":1}`. `AGENT_ORCHESTRATOR_HOME=$TEMP_HOME node dist/cli.js stop --force` printed `agent-orchestrator daemon stopping store=$TEMP_HOME`. Temp home removed.
  - Manual TTY smoke: `script -qfc "node dist/cli.js" /dev/null < /dev/null` (PTY-allocated stdin) printed the new help text starting with `agent-orchestrator` and the line `agent-orchestrator              Show this help in a terminal; start the MCP server for piped stdio`.
- **Notes:** No commit, push, or version bump performed.
