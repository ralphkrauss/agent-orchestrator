# Make Justfile Recipes Run Natively On Windows

Branch: `42-project-doesnt-work-on-windows`
Plan Slug: `42-justfile-windows-native`
Parent Issue: #42
Created: 2026-05-06
Updated: 2026-05-06 (reviewer-approved after third pass)
Status: ready-for-implementation

## Context

### Issue Summary

Issue #42 ("project doesnt work on windows") reported that
`agent-orchestrator claude` failed on Windows. The first sub-plan
(`42-claude-launcher-windows-monitor-pin`, merged in PR #44) fixed the
Claude launcher monitor pin. PR #44 also landed a follow-up
(commit `a1e5136`) that pinned `set windows-shell := ["sh.exe", "-cu"]`
in the `justfile` so that `just` would parse and run on Windows at
all. That second commit is a **partial** fix: it requires Git Bash's
`sh.exe` to be discoverable. The user wants the developer workflow to
work on the native Windows shell so that a fresh-checkout developer
with only Node, `pnpm`, and `just` (no Git Bash) can run every
`just <recipe>`.

### Two Distinct Git Bash Concerns — Do Not Conflate

This plan removes Git Bash as a prerequisite for **`just` recipe
execution**. It does **not** remove Git Bash as a prerequisite for
**`agent-orchestrator claude`**. The Claude launcher still requires
Git Bash because Claude Code uses Bash for its `Bash` tool; that
requirement was set deliberately in PR #44 / commit `ac576ec` and is
documented in README L69–74. The two concerns are independent.

### How Just Substitutes Recipe Parameters (Re-Verified)

A first draft of this plan asserted that `node scripts/just/foo.mjs {{args}}`
makes Node own argv parsing. **That premise is false.** `just`
performs literal text substitution of `{{args}}`, `{{branch}}`, and
`{{days}}` **before** the configured shell parses the recipe body. A
reviewer verified this with `just --dry-run`:

```
$ just --dry-run orchestrator-status 'status; echo SHOULD_NOT_RUN'
node dist/cli.js status status; echo SHOULD_NOT_RUN
```

The substituted `;` then runs as a shell separator. Therefore **every
recipe that interpolates a user-supplied parameter** (`*args`, named
parameters such as `branch` and `days`) is unsafe under naive
`{{...}}` substitution.

### Why `set positional-arguments` Plus `[unix]`/`[windows]` Was Insufficient

A second draft fixed POSIX with `set positional-arguments` plus
`[unix]` recipe bodies referencing `"$@"` / `"$1"` (verified locally
by the reviewer to work for adversarial inputs on Linux). The
proposed `[windows]` half used
`set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]`
plus `$args[0]` / `@args` to read positional args. **That second
half is broken on PowerShell:**

- The just manual states that PowerShell does not handle
  `set positional-arguments` like POSIX shells do. With Windows
  PowerShell 5.1 (`powershell.exe -Command "<body>"`), additional
  command-line args after the body are not exposed as `$args` inside
  the command body. `$args` inside `-Command` is empty (or the
  recipe name when using PowerShell 7+ `-CommandWithArgs`, with the
  documented working pattern being `$args[1..]`).
- PowerShell 7.4 added `-CommandWithArgs` precisely to populate
  `$args` for the command body — but PowerShell 7.x (`pwsh`) is **not
  preinstalled on Windows**. Windows ships with PowerShell Desktop
  5.1; users would have to install `pwsh` separately. That is a new
  dev-time dependency and triggers a Human Approval Trigger from
  this plan's own list.

So the prior `[unix]` + `[windows]` design needs to be replaced for
the parameter-taking recipes specifically. The chosen replacement
(decision #3 below) avoids both the `pwsh` install requirement and
the PowerShell `-Command` argv gap.

### Just Version Floor (Corrected)

The reviewer verified locally that `[unix]` / `[windows]` recipe
attributes are gated on `just >= 1.8.0`, not `>= 1.5` as a previous
draft documented. The corrected floor is documented as part of
decision #4 below.

The local `just` is **1.21.0** (verified via `just --version` and
`just --changelog`). Its changelog shows `set positional-arguments`,
`set windows-shell`, `[unix]`, `[windows]`, and `[no-cd]` all
present. It does **not** show the `[script]` attribute. The `[script]`
attribute history (per the just changelog) is: `[script(COMMAND)]`
syntax added in 1.32, empty `[script]` added in 1.33, and the attribute
was **stabilized** in 1.44 (`[1.44.0] - 2025-12-06 — Stabilize [script]
attribute`). The conservative floor is therefore `>= 1.44` (decision #4).
T0 verifies this floor before the rest of the implementation lands.

### Current `justfile` Inventory (Re-Classified)

36 recipes total. The classification from the prior draft is correct
and preserved:

**Class 1 — leave alone (no parameters, no POSIX-only logic, body is
a single external-program invocation that already works in
PowerShell, `cmd.exe`, and `sh` identically). 20 recipes:**

- `default` (`@just --list`)
- `ai-sync`, `ai-sync-check`, `ai-hooks-status`, `ai-hooks-enable`,
  `ai-hooks-disable`
- `init-mcp-secrets`, `mcp-profiles`
- `orchestrator-build`, `orchestrator-help`, `orchestrator-doctor`,
  `orchestrator-start`, `orchestrator-restart`
- `local-env`, `local-home`, `local-clean` (each `@just <other>`)
- `agent-orchestrator-local-env`, `agent-orchestrator-local-bin`
- `worktree-list`, `worktree-prune`

**Class 2 — accepts user-supplied parameters; needs cross-platform
argv-safe forwarding into Node. 11 recipes:**

- `mcp-secret-bridge *args`
- `orchestrator-opencode-config *args`, `orchestrator-opencode *args`
- `orchestrator-status *args`, `orchestrator-runs *args`,
  `orchestrator-watch *args`, `orchestrator-stop *args`
- `orchestrator-prune-dry-run days="30"`,
  `orchestrator-prune days="30"`
- `worktree branch`, `worktree-remove branch`

**Class 3 — POSIX-only logic. 5 recipes:**

- `agent-orchestrator *args` and `local *args` — both parameter-taking
  AND POSIX-only logic (`if [ "${1:-}" = "--" ]; then shift; fi`).
- `agent-orchestrator-local-home` — `printf '%s\n' ...`. No params.
- `agent-orchestrator-local-clean` — `[ -f ... ]`, `rm -rf`, `printf`,
  `>/dev/null 2>&1 \|\| true`. No params.
- `ai-files` — `find ... -maxdepth 4 -type f 2>/dev/null \| sort`.
  No params.

**Total: 20 + 11 + 5 = 36.**

### `scripts/` Conventions

`scripts/` holds 12 ESM Node scripts (`*.mjs`) using only `node:`-
prefixed built-ins. Pattern: shebang `#!/usr/bin/env node`, ESM
`import`, output to `process.stdout`/`stderr`, no third-party deps.
New helpers under `scripts/just/` inherit this convention.
`scripts/local-orchestrator-home.mjs` and
`scripts/local-orchestrator-shims.mjs` currently each compute the
local-home path independently; a shared `scripts/local-home-lib.mjs`
consolidates that.

### `pnpm test` Scope

`package.json`'s `test` script only executes compiled tests under
`dist/__tests__/`. Tests for new Node helpers under
`scripts/just/__tests__/` would not run under `pnpm test`. An
explicit additional Quality Gate (decision #11) covers them.

### Context Sources Read

- `justfile` (end-to-end, 168 lines).
- `scripts/local-orchestrator-home.mjs`,
  `scripts/local-orchestrator-shims.mjs`.
- `package.json` `test` script scope.
- `AGENTS.md`, `CLAUDE.md`,
  `.agents/rules/node-typescript.md`.
- Recent commits `a1e5136` and `ac576ec`.
- `README.md` Windows section (L65–80).
- The implemented sibling sub-plan
  `plans/42-project-doesnt-work-on-windows/plans/42-claude-launcher-windows-monitor-pin.md`.
- Reviewer's `just --dry-run` evidence demonstrating literal-text
  substitution.
- Reviewer's PowerShell argv evidence
  (https://github.com/casey/just#positional-arguments,
  https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_pwsh,
  https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_powershell_exe).
- Local `just --version` (1.21.0) and `just --changelog`.

## Confirmed Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Scope | Rewrite the `justfile` and add focused Node helpers under `scripts/just/` so every recipe runs on PowerShell Desktop and POSIX shells without Git Bash. No source under `src/` changes. No CLI, MCP, runtime, Bash deny list, secret, hook, or release behavior changes. | The reported failure for the dev workflow is the Git Bash dependency for `just`. The scope cut keeps the change small and reviewable. | Re-planning issue #42; auditing every dev workflow surface beyond `just`. |
| 2 | `windows-shell` pin | Pin `set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]`. This shell still drives Class 1 and no-param Class 3 recipe execution (those have no `{{...}}` interpolation, so the PowerShell `-Command` argv gap does not apply). PowerShell Desktop ships preinstalled on every supported Windows host. | Class 1 and no-param Class 3 bodies are simple program invocations (`node scripts/X.mjs`, `pnpm build`, `@just <other>`). PowerShell parses these identically to `sh` and `cmd.exe`. PowerShell Desktop is universal; `pwsh` is not. | `pwsh.exe` (new dev dep); `cmd.exe` (poorer UTF-8); leaving `windows-shell` unset (falls back to `sh.exe` lookup, the original Git Bash dependency). |
| 3 | Architecture (Option γ — `[script("node")]` for parameter-taking recipes) | All Class 2 recipes (11) and the two parameter-taking Class 3 recipes (`agent-orchestrator *args`, `local *args`) use the `[script("node")]` attribute. The recipe body is a one-line Node expression that imports a focused helper under `scripts/just/` and calls it; `just` writes the body to a tempfile, runs `node <tempfile> <recipe-args>`, and Node receives the recipe args directly via `process.argv` without ever passing through a shell tokenizer. The remaining no-param Class 3 recipes (3) keep a plain `@node scripts/just/<helper>.mjs` body that goes through `windows-shell`. Class 1 recipes (20) are unchanged. | Solves the PowerShell argv gap without adding a new dev dep — `node` is already required everywhere, and `just` is already required to use the recipes at all. `[script]` skips shell tokenization entirely, so user-supplied metacharacters (`;`, `&`, `\|`, `$`, `"`, `'`) reach Node as inert argv data on every platform. The cost is raising the `just` floor (decision #4); the benefit is one cross-platform recipe body per parameter-taking recipe instead of `[unix]`/`[windows]` parallel pairs and instead of `pwsh -CommandWithArgs`. | (α) `pwsh -CommandWithArgs` — adds a hard dev-time dep on PowerShell 7.4+ which is **not** preinstalled on Windows. Triggers a Human Approval Trigger; rejected because (γ) is a no-new-dep alternative. (β) Move parameter-taking recipes to Node helpers via plain shell invocation — collapses to (γ) once you require argv to bypass shell tokenization. (δ) `cmd.exe` shell — argv parsing is even worse than PowerShell. (ε) Single-shell unified design — same problem. (E from prior draft, the `[unix]`/`[windows]` parallel-bodies design) — broken on PowerShell per the reviewer's PowerShell-argv finding. |
| 4 | Just version floor | Document `just >= 1.44` as the conservative floor. The `[script(COMMAND)]` syntax was added in 1.32, the empty `[script]` attribute in 1.33, and the `[script]` attribute was **stabilized** in 1.44 (just changelog: `[1.44.0] - 2025-12-06 — Stabilize [script] attribute`). Below 1.44 the attribute is unstable and requires `set unstable`; pinning the floor to the stability boundary avoids both (a) the need for `set unstable` and (b) the risk of feature-flag-shape drift across the 1.32–1.43 window. The local `just` is 1.21.0 and must be upgraded on the implementation host before T0 can complete; T0 documents the upgrade and re-runs every probe on `just >= 1.44`. | `[script]` stability lands in 1.44. Anything older requires `set unstable` plus the implicit risk of attribute-shape changes; that conflicts with this plan's preference for a clean, documented floor. The cost (`just` minor-version upgrade) is small relative to (α)'s new `pwsh` requirement. | (1.33 floor) — `[script]` was unstable on 1.33 and required `set unstable`. (1.32 floor) — older empty-`[script]` form not even available. (1.5 floor) — drops `[script]` and falls back to the broken PowerShell `[windows]` design. (1.21 floor) — same. |
| 5 | `set positional-arguments` | **Keep, globally.** T0 proved that `[script("node")]` alone does **not** forward recipe arguments to `process.argv`: with no `set positional-arguments` (and no per-recipe `[positional-arguments]`), `process.argv` inside the script body is exactly `[node, tempfile]` — the recipe args do not arrive. With `set positional-arguments` at the top of the justfile, `process.argv` becomes `[node, tempfile, ...recipeArgs]` and adversarial tokens (`;`, `&`, `\|`, `$x`, `"`, `'`) land as inert single argv entries. The directive is therefore *load-bearing* for the entire `[script("node")]` design. The original safety property — that parameter-taking shell recipes are forbidden — is preserved by the top-of-file invariant comment (decision #20); `set positional-arguments` does not enable shell-based parameter-taking recipes, it only forwards recipe args to `[script(...)]` interpreters. | Required to make `[script("node")]` recipes receive their arguments at all. T0 evidence (Implementation Evidence section below) makes this concrete with probe outputs. | Drop the directive — would mean none of the parameter-taking `[script("node")]` recipes work. Use per-recipe `[positional-arguments]` — works but requires repeating the attribute on every parameter-taking recipe, increasing drift surface; the global form is one line and equivalent. |
| 6 | `[script("node")]` argv semantics | The recipe body inside `[script("node")]` runs as a Node script: `just` writes the body to a tempfile and invokes `node <tempfile> <recipe-arg-1> <recipe-arg-2> ...` **only when `set positional-arguments` (or per-recipe `[positional-arguments]`) is enabled**. Without that directive, `just` invokes `node <tempfile>` with no further argv entries — the recipe arguments are dropped on the floor. With the directive, `process.argv[0]` is the Node executable, `process.argv[1]` is the tempfile path, and `process.argv.slice(2)` is the recipe arguments — `*args` expands to multiple entries, named parameters (`branch`, `days`) each occupy one entry, and the recipe NAME is **not** in `process.argv`. T0 verifies these semantics with probe recipes (`_probe-args` without the directive shows the empty case; `_probe-pos` with the directive shows the populated case). If any T0 assertion failed, the plan would halt and re-plan; T0 in the Implementation Evidence section confirms the documented behavior. | Documented `[script]` behavior interacts with `set positional-arguments` in a way the prior plan draft missed. T0 captures the actual contract; this decision documents it precisely. | Assuming the recipe name is in `process.argv` (incorrect under any setting). Assuming recipe args reach `process.argv` regardless of `set positional-arguments` (incorrect — without it, argv stops at the tempfile). |
| 7 | Cross-platform module-path resolution inside `[script("node")]` recipe bodies | Recipe bodies construct the helper import URL **inside the Node script body** using Node's documented `url.pathToFileURL(path.resolve(<relative-path>))` pattern. The recipe body is two lines: a `require` line for `node:url` and `node:path`, then a single `import(...).then(m => m.default(...))` call. `path.resolve('scripts/just/<helper>.mjs')` resolves against `process.cwd()`, which `just` sets to `justfile_directory()` for every recipe (documented `just` behavior; T0 verifies this also holds for `[script]` recipes specifically). `pathToFileURL` percent-encodes `#`, `%`, `?`, single-quote, and any other URL-control or JS-string-delimiter characters in the absolute repo path, normalizes path separators on Windows, and produces a valid `file://` URL with a `.href` property suitable for `import()`. Concrete pattern (one of 13 parameter-taking recipes shown):<br/><br/>```just<br/>[script("node")]<br/>orchestrator-status *args: orchestrator-build<br/>    const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path');<br/>    import(pathToFileURL(resolve('scripts/just/cli.mjs')).href).then(m => m.default({ prefix: ['status'] }));<br/>```<br/><br/>The first line is identical across every parameter-taking recipe; the second varies only in the helper module path and the call-time configuration object (per decision #8). | This pattern is the one Node's ESM documentation explicitly recommends for converting a path to an importable URL (https://nodejs.org/api/esm.html#urls). It is safe against any repo-path content (backslashes, percent characters, `#`, `?`, single quotes), produces no JS-string-literal-escape concerns (the URL is constructed at runtime, not interpolated from `just` into a JS string literal), and requires no `just` builtins beyond the 1.33 floor's defaults. The previous draft's `repo_url` parse-time variable embedded `justfile_directory()` directly into a JS string literal at substitution time, which was unsafe against legitimate path characters and had a probe-line typo (the T0 probe rendered as an unquoted JS token). | Parse-time `repo_url` variable that hand-builds a `file://` URL — only normalizes backslashes; does not percent-encode URL control characters; does not escape JS string delimiters; produced an unquoted-JS T0 probe bug. Per-recipe inline `pathToFileURL` is two lines per recipe (manageable; first line identical across recipes), and the safety property is mechanical (delegated to a Node built-in). String-escaping `justfile_directory()` for embedding in a JS literal — fragile against repo paths with `'`, `` ` ``, `\`. Computing via `process.cwd()` alone, without `path.resolve` — works in practice but couples to cwd implicitly; `path.resolve('relative')` is identical in effect (resolves against `process.cwd()`) but reads as explicit. |
| 8 | Class 2 recipe rewrite pattern + helper contracts | Each Class 2 recipe gains a `[script("node")]` attribute. Body is two lines: a `require` line for `node:url` and `node:path`, then `import(pathToFileURL(resolve('scripts/just/<helper>.mjs')).href).then(m => m.default(<config>))`. Helpers expose a default function that takes a `{ prefix, suffix }` config and reads user args from `process.argv.slice(2)`, spawning the underlying program with `node <program> ...prefix ...userArgs ...suffix` via `stdio: 'inherit'`.<br/><br/>**`scripts/just/cli.mjs::default({ prefix = [], suffix = [] }) -> Promise<void>`** — spawns `node dist/cli.js ...prefix ...userArgs ...suffix`. Per-recipe arg mapping (8 recipes total — prior draft listed "7" by mistake):<br/><br/>1. `orchestrator-opencode-config *args` → `prefix: ['opencode', '--print-config']`, `suffix: []`.<br/>2. `orchestrator-opencode *args` → `prefix: ['opencode']`, `suffix: []`.<br/>3. `orchestrator-status *args` → `prefix: ['status']`, `suffix: []`.<br/>4. `orchestrator-runs *args` → `prefix: ['runs']`, `suffix: []`.<br/>5. `orchestrator-watch *args` → `prefix: ['watch']`, `suffix: []`.<br/>6. `orchestrator-stop *args` → `prefix: ['stop']`, `suffix: []`.<br/>7. `orchestrator-prune-dry-run days="30"` → `prefix: ['prune', '--older-than-days']`, `suffix: ['--dry-run']`.<br/>8. `orchestrator-prune days="30"` → `prefix: ['prune', '--older-than-days']`, `suffix: []`.<br/><br/>Recipes 7 and 8 require both prefix-and-suffix support; the helper contract is therefore `prefix + userArgs + suffix`, not `prefix + userArgs` alone.<br/><br/>**`scripts/just/passthrough.mjs::default({ script, prefix = [], suffix = [] }) -> Promise<void>`** — spawns `node <script> ...prefix ...userArgs ...suffix`. Per-recipe arg mapping (3 recipes):<br/><br/>1. `mcp-secret-bridge *args` → `script: 'scripts/mcp-secret-bridge.mjs'`, `prefix: []`, `suffix: []`.<br/>2. `worktree branch` → `script: 'scripts/worktree.mjs'`, `prefix: ['create']`, `suffix: []`. (`branch` arrives via `process.argv.slice(2)` as a single named-parameter token.)<br/>3. `worktree-remove branch` → `script: 'scripts/worktree.mjs'`, `prefix: ['remove']`, `suffix: []`.<br/><br/>**`scripts/just/local-cli.mjs::default() -> Promise<void>`** — covers `agent-orchestrator *args` and `local *args` (decision #9). Both call `m.default()` with no config; the helper handles the leading-`--` strip and env injection internally.<br/><br/>Total Class 2 + parameter-taking Class 3: 11 + 2 = 13 recipes through `[script("node")]`. | Smallest possible recipe-body diff per recipe; three shared helpers covering 11 of the 13 recipes (cli.mjs: 8; passthrough.mjs: 3; local-cli.mjs: 2); explicit per-recipe arg mapping spelled out so the implementer does not re-derive it from the `justfile`; helper API supports both prefix-only and prefix-plus-suffix forms (recipes 7 and 8 of cli.mjs need the suffix). | Inline `spawnSync` per recipe (~5 lines of body each = ~65 lines of repetition). One mega-helper that dispatches by recipe name (couples helper to recipe naming). Helper contract that accepts only a `prefix` (would force `orchestrator-prune-dry-run` to inject `--dry-run` after user args via a hack). |
| 9 | Class 3 rewrite (`agent-orchestrator *args`, `local *args`) | Both recipes use `[script("node")]`. Body imports `scripts/just/local-cli.mjs::default(args)` where `args = process.argv.slice(2)`. Inside the helper: drop a single leading `--` if present, resolve the local-home path via the new shared module (decision #14), set `AGENT_ORCHESTRATOR_HOME` for the child, and `spawnSync(process.execPath, [path.resolve('dist/cli.js'), ...remaining], { stdio: 'inherit', env })`. Propagate exit per decision #15. | Single helper for both recipes (they are functionally identical); no duplication. | Two helpers (drift surface); inline body via `[script("node")]` only (POSIX-only `--` strip duplicates across two recipes). |
| 10 | Class 3 rewrite (`agent-orchestrator-local-clean`) | New helper `scripts/just/local-clean.mjs`. Recipe body becomes `@node scripts/just/local-clean.mjs` (no `[script]`, no params, single line, identical across shells). Helper: when `dist/cli.js` exists, `spawnSync(process.execPath, [cliPath, 'stop', '--force'], { stdio: 'ignore', env: { ...process.env, AGENT_ORCHESTRATOR_HOME: localHome }, timeout: 10_000 })` and ignore non-zero exit (matches the original `>/dev/null 2>&1 \|\| true`). Then `fs.rmSync(localHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })` and same for `localShimRoot`. Print `removed <localHome>\n` and `removed <localShimRoot>\n` byte-for-byte. | No params — `[script]` is unnecessary. Plain `@node ...` runs in any shell. | Using `[script]` for consistency (overkill for a no-param body). |
| 11 | Class 3 rewrite (`ai-files`) | New helper `scripts/just/ai-files.mjs`. Recipe body becomes `@node scripts/just/ai-files.mjs` (no params, no `[script]`). Walks the eight roots up to depth 4, regular files only (no symlink follow), includes hidden files, suppresses **all** traversal errors silently to mirror `find ... 2>/dev/null` (`ENOENT`, `EACCES`, `EPERM`, `ELOOP`, etc.), slash-normalizes path separators (`path.sep` → `/`), sorts byte-wise, prints one path per line with `\n` terminator. Equivalent POSIX command: `LC_ALL=C find AGENTS.md CLAUDE.md .agents .claude .cursor .codex .githooks docs/development -maxdepth 4 -type f 2>/dev/null \| LC_ALL=C sort`. | Reviewer answer to Q9 + B4 corrections preserved from prior draft. | Following symlinks; emitting platform-native separators; suppressing only ENOENT; locale-dependent sort. |
| 12 | Class 3 rewrite (`agent-orchestrator-local-home`) | Recipe body becomes `@node scripts/local-orchestrator-home.mjs` (call the existing helper that already prints the path with a trailing newline; no `[script]`, no params). | Reuses an existing helper. Eliminates `printf` and the parse-time backtick. | Writing a new helper (already exists). |
| 13 | Test execution scope | Add a new Quality Gate command `node --test 'scripts/just/__tests__/**/*.test.mjs'` (single-quoted so the glob is interpreted by Node's internal glob expansion, not the shell — both PowerShell and `sh` pass single-quoted args through literally, so the same command works on both). The plain directory-form (`node --test 'scripts/just/__tests__/**/*.test.mjs'`) does **not** auto-walk on Node 22+; Node treats the directory path as a single test file and fails. Document the gate explicitly in the Quality Gates section. Do **not** modify `package.json`'s `test` script. The `pnpm test` scope (compiled `dist/__tests__/`) is unchanged. | Reviewer answer to B3 + Q7. Adds visible test coverage without broadening a long-stable script. The single-quoted glob is the portable form because Node owns the expansion. | Modifying `package.json`'s `test` script; relying silently on `pnpm test` to cover `scripts/just/__tests__/`; using a directory path argument that Node would treat as a missing file. |
| 14 | Shared local-home module | New file `scripts/local-home-lib.mjs` exporting `resolveLocalOrchestratorHome(repoRoot)`. The two existing scripts (`local-orchestrator-home.mjs`, `local-orchestrator-shims.mjs`) and the two new helpers (`scripts/just/local-cli.mjs`, `scripts/just/local-clean.mjs`) all import from it. Existing scripts' externally-observable behavior (stdout content, exit code) is byte-for-byte unchanged. | Reviewer answer to Q4. Net reduction in drift surface (currently two independent computations; after this plan, one). | Each script keeps its own copy. |
| 15 | Exit-code propagation for child processes | When the child exits normally, propagate `child.status`. When the child is signal-terminated, propagate `128 + signal_number` on POSIX and `1` on Windows. Map the signal name (`child.signal`, a string like `"SIGTERM"`) to a number via `os.constants.signals[name]`, falling back to `1` if the name is missing from the table. Do **not** use `Number(child.signal)` — that returns `NaN`. | Reviewer correction in Q11 (preserved from prior draft). | `Number(child.signal)`; always exit 1 on POSIX. |
| 16 | Parse-time backtick removed | Remove `local_orchestrator_home := \`node scripts/local-orchestrator-home.mjs\`` from the `justfile`. After decisions #9–#12, no recipe body needs the variable; the path is computed inside the Node helpers via the shared module (decision #14). | Reviewer answer to Q4 (preserved). Eliminates a parse-time shell exec from every `just` invocation. | Keeping the backtick. |
| 17 | No parse-time path-shape variables in the justfile | The justfile contains no parse-time variables that depend on shell execution or on string-shaping a path for downstream JS interpolation. The only justfile parse-time work is `set windows-shell` (a list literal) and the recipe definitions themselves. Module path resolution for `[script("node")]` recipe bodies happens at recipe-runtime via `pathToFileURL(path.resolve(...))` (decision #7), which is mechanical Node-built-in behavior. | The previous draft's parse-time `repo_url` variable was unsafe against legitimate path content and had a probe-line typo. Eliminating parse-time path shaping removes a class of injection-shape bug and lets reviewers reason about the justfile as pure recipe metadata. | Keeping a parse-time URL variable for "shorter recipe bodies" — saves at most one line per recipe at the cost of a real safety hole. |
| 18 | Behavior preservation | Every recipe name stays the same. Externally-observable behavior (exit codes, stdout content, side effects, env vars set for child processes, propagated args) is byte-for-byte preserved on POSIX. On Windows, externally-observable behavior matches POSIX as closely as the underlying programs allow. | No user has asked for a recipe to do something different. | Reorganizing recipe names. |
| 19 | README updates | Replace the existing "The repository's `justfile` recipes also rely on POSIX shell idioms..." paragraph (README.md L76–80) with: "On Windows, `just` recipes run under PowerShell Desktop and through `node` directly for parameter-taking recipes (via `just`'s `[script]` attribute, which requires `just >= 1.44`); no Git Bash or `sh.exe` is required for the dev workflow. The Git Bash requirement for `agent-orchestrator claude` itself (described above) is unchanged because Claude Code uses Bash for its `Bash` tool." Keep the existing Claude-launcher Git Bash paragraph (L69–74) **verbatim**. | Decision #4 made the `just >= 1.44` floor user-visible; the README must call it out so a fresh-checkout developer knows what to install. The two Git Bash concerns are kept distinct. | Hiding the version floor; collapsing the two paragraphs. |
| 20 | New helpers location | New helpers under `scripts/just/`. Shared local-home module at `scripts/local-home-lib.mjs` (top-level because two existing scripts also import it). Top-of-file comment in the `justfile` documents the cross-shell invariant: "Recipe bodies must be (a) a single external-program invocation that works in any shell, or (b) `[script("node")]` recipes that import a helper under `scripts/just/`. Never use POSIX-only shell idioms (`[ ... ]`, `printf`, `find`, `rm`, `\|`, `&&`) in a recipe body. `set positional-arguments` is required for `[script("node")]` recipes to receive their arguments via `process.argv` (it is **not** a license to introduce shell-based parameter-taking recipes — those remain forbidden). `just >= 1.44` required (`[script]` attribute, stabilized in 1.44)." | Reviewer answer to Q6 + Risk #11 mitigation. | All flat. |
| 21 | No new runtime or dev deps | Helpers use only Node 22+ built-ins. No third-party deps in `scripts/just/`, `scripts/local-home-lib.mjs`, or runtime. The `just` upgrade required to satisfy the floor is a tool-version bump, not a new dependency. | `.agents/rules/node-typescript.md` mandates this; AGENTS.md requires asking before adding deps. | Adding `shelljs`, `cross-spawn`, `globby`, etc. |
| 22 | No Git Bash fallback for recipes | Once `windows-shell` is pinned to PowerShell, recipes always execute under PowerShell on Windows, even for users who happen to have Git Bash on `PATH`. There is no hybrid mode. | Reviewer answer to Q12. Mixing shells creates inconsistency. | Detecting Git Bash and preferring it. |
| 23 | `local-env` POSIX-export accepted limitation | `agent-orchestrator-local-env` (and the `local-env` alias) continues to print a POSIX-shell `export PATH=...:"$PATH"` snippet on every platform. This is a Class 1 recipe; this plan does **not** change its body. On Windows, a developer must translate the line into PowerShell (`$env:PATH = "...;${env:PATH}"`). PowerShell-native output is a separate follow-up. | Reviewer answer to Q8. Avoids scope creep into `scripts/local-orchestrator-shims.mjs --print-env`. | Bundling a PowerShell-aware rewrite. |

## Assumptions

These are residual technical claims that hold given documented
behavior of `just`, Node, and PowerShell. Each is verifiable in T0
before the rest of the implementation lands.

- `just >= 1.44` honors the `[script("node")]` attribute as a stabilized
  feature, writing the recipe body to a tempfile and running
  `node <tempfile> <recipe-arg-1> <recipe-arg-2> ...` **when
  `set positional-arguments` is enabled** (decision #5/#6).
  `process.argv[0]` is the Node executable, `process.argv[1]` is the
  tempfile, and `process.argv.slice(2)` is the recipe args. The recipe
  name is not in `process.argv`. `*args`, named parameters, and
  defaulted parameters all flow through the same positional-args
  mechanism. (T0 evidence below verifies all three parameter shapes
  on `just 1.50.0`.)
- `just` sets the working directory to `justfile_directory()` before
  running each recipe, including `[script]` recipes, so
  `process.cwd()` inside the script body equals the repo root and
  `path.resolve('scripts/just/cli.mjs')` produces the absolute path
  to the helper. (Documented just behavior; T0 verifies the cwd
  assumption holds for `[script]` recipes specifically by running
  a probe from a subdirectory.)
- Node 22+'s `url.pathToFileURL(absolutePath).href` is the
  documented mechanism for converting an absolute filesystem path
  to a `file://` URL suitable for dynamic `import()`. It
  percent-encodes URL-control characters (`#`, `%`, `?`, single
  quote, etc.) and normalizes path separators on Windows. The
  resulting URL is a runtime-constructed JS string and never gets
  interpolated from `just` into a JS string literal, eliminating
  the JS-escape concerns that the prior draft's parse-time
  `repo_url` variable had. (https://nodejs.org/api/url.html#urlpathtofileurlpath)
- Node 22+'s `import(<file:// URL>)` resolves cross-platform,
  including `file:///C:/...` on Windows.
- `os.constants.signals[name]` returns the platform's signal number
  for the supplied name on POSIX; on Windows the table is sparse and
  the helper falls back to exit `1`.
- `fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })`
  successfully removes a non-empty directory on Windows even when a
  file briefly retains an open handle. (Documented Node mitigation.)
- Node 22+'s built-in test runner (`node --test`) accepts a quoted
  glob argument and expands it via Node's internal glob to discover
  `*.test.{mjs,cjs,js}` files. The Quality Gate uses
  `node --test 'scripts/just/__tests__/**/*.test.mjs'` (decision #13);
  passing a bare directory path does **not** auto-walk on Node 22+
  — Node treats it as a missing test file and fails.
- The local `just` is 1.21.0, below the 1.44 floor. The implementer
  upgrades to `just >= 1.44` before T0; the upgrade is a single
  binary replace via `cargo install just`, `winget install Casey.Just`,
  Homebrew (`brew upgrade just`), or a direct release-binary download.

## Behavior Invariants

- **Linux and macOS recipe behavior is byte-for-byte preserved** for
  any input that previously succeeded.
- **Recipe names are unchanged.**
- **No source code under `src/` changes.**
- **No new runtime or dev dependencies.** A `just` minor-version bump
  is not a new dependency (just is already required).
- **No CI, release, hook, secret, or external-service changes.**
- **Argument-safety invariant (corrected for Option γ):** No recipe
  body uses `{{args}}` / `{{branch}}` / `{{days}}` interpolation.
  All recipes that accept user-supplied parameters use
  `[script("node")]`, which makes `just` invoke
  `node <tempfile> <recipe-args>` directly without a shell tokenizer
  in the path. User-supplied metacharacters arrive in `process.argv`
  as inert data. **No intermediate state during the rewrite has a
  parameter-taking recipe interpolating `{{...}}` directly.**
- **`just` recipe execution does not require Git Bash.** A fresh
  Windows host with PowerShell Desktop, Node 22+, `pnpm`, and
  `just >= 1.44` on `PATH` (and no Git Bash) can run every recipe.
- **`agent-orchestrator claude` continues to require Git Bash on
  Windows.** Unchanged from PR #44 / commit `ac576ec`; documented at
  README L69–74.

## Human Approval Triggers

- **Recipe rename, removal, or addition** beyond the body changes
  described in decisions #8–#12.
- **Behavior change visible to users.**
- **New dev-time dependency**: `pwsh`, Git Bash, WSL, MSYS, Cygwin,
  `make`, or any third-party Node package in `scripts/just/`,
  `scripts/`, or runtime. (A `just` minor-version upgrade is not a
  new dep.)
- **Source / runtime / CLI / MCP / Bash deny-list change.**
- **CI workflow change** (e.g. adding a Windows runner).
- **Release / publish behavior.**
- **Secret / hook / external-service.**
- **Switching `windows-shell` to `cmd.exe` or `pwsh`** after
  decision #2 fixes PowerShell Desktop.
- **Removing `set positional-arguments`** (decision #5 keeps it
  globally; removing it would silently break every parameter-taking
  `[script("node")]` recipe — T0 evidence below shows the directive is
  load-bearing for argv forwarding).
- **Modifying `package.json`'s `test` script** (decision #13 forbids).

## Reviewer Questions

`none` — every question from the prior reviewer passes (Q1–Q12,
B1–B4) plus the second-pass blocking finding (PowerShell argv) and
factual correction (`[unix]`/`[windows]` floor) is resolved as a
confirmed decision or assumption.

- Q1 → decisions #3 + #4 (now resolves to Option γ, `[script("node")]`,
  with `just >= 1.44` floor).
- Q2 → decision #2 (PowerShell Desktop pin retained for Class 1 and
  no-param Class 3).
- Q3 → decision #5 (keep `set positional-arguments` globally — required
  for `[script("node")]` argv forwarding per T0 evidence).
- Q4 → decisions #14 + #16 (drop the parse-time backtick; introduce
  shared local-home module).
- Q5 → decision #4 (just version floor `>= 1.44`).
- Q6 → decision #20 (`scripts/just/` subdirectory).
- Q7 + B3 → decision #13 (explicit `node --test` Quality Gate).
- Q8 → decision #19 (README rewrite, version floor surfaced).
- Q9 + B4 → decision #11 (no symlink follow; include hidden;
  suppress all traversal errors; slash-normalize; byte-wise sort).
- Q10 → decision #10 (`local-clean` byte-for-byte output).
- Q11 → decision #15 (`os.constants.signals[name]`; Windows → `1`).
- Q12 → decision #22 (no Git Bash fallback).
- Second-pass PowerShell argv finding → decisions #3 + #4 + #5 + #6.
- Second-pass `[unix]`/`[windows]` 1.8 floor correction → moot under
  decision #3 (no longer using `[unix]`/`[windows]`); decision #4
  documents the actual 1.44 floor.
- Third-pass blocking finding (brittle `repo_url` parse-time variable
  + JS string-literal interpolation hazard + T0 probe quoting bug) →
  decisions #7 + #17 (drop the parse-time variable; resolve module
  paths via `pathToFileURL(path.resolve(...))` inside the script
  body) + T0 step (e) and (f) (probe the new mechanism + verify the
  cwd assumption).
- Third-pass minor cleanups → decision #4 footnote (`[script(COMMAND)]`
  added in 1.32, empty `[script]` in 1.33, stabilized in 1.44; floor set to 1.44); T0 expanded with
  named-parameter (step c) and defaulted-parameter (step d) probes;
  T2 + T3 reconciled — decision #8 enumerates 8 recipes for
  `cli.mjs` and 3 for `passthrough.mjs` with explicit per-recipe
  `{ prefix, suffix }` mappings; helper contract supports both
  prefix and suffix because `orchestrator-prune-dry-run` and
  `orchestrator-prune` need a `--dry-run` suffix after the user
  `days` value.

## Open Human Decisions

`none` — the reviewer's second-pass finding is fully resolved by
Option γ, which does not add a new dev dependency. Decision #3
explicitly rejects Option α (`pwsh -CommandWithArgs`) on the basis
that it would add a hard dev-time dependency on PowerShell 7.4+.
Promoting an Open Human Decision was therefore unnecessary.

## Risks

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | The `[script("node")]` attribute does not behave exactly as documented on the implementer's host (e.g. `process.argv.slice(2)` does not equal the recipe args, or just writes the body in a way Node interprets unexpectedly). | T0 verifies with a probe recipe `_probe-script *args:` whose body is `console.log(JSON.stringify(process.argv));` (after the `[script("node")]` attribute), invoked with adversarial input. The captured `process.argv` array must be `[<node-path>, <tempfile-path>, ...recipe-args]` with each adversarial token appearing as a single, inert array entry. If this fails, halt and re-plan; do not silently fall back to a shell-based approach. | T0. |
| 2 | A user invokes `just` with a `just` version below 1.44 (the floor). | The `justfile` parser will fail with an error about the unstable / unknown attribute. `just` 1.44+ is documented as the floor in the top-of-file invariant comment (decision #20) and in the README rewrite (decision #19). T7 manual smoke verifies behavior on a 1.44+ host. | Documentation; T7. |
| 3 | The local `just` is 1.21.0; the implementer cannot run T0 verification without upgrading. | T0 documents the upgrade step (`cargo install just`, `winget install Casey.Just`, `brew upgrade just`, or release-binary download) and captures the upgraded version in the implementation log. | T0. |
| 4 | A user runs `just orchestrator-status -- '{"prompt":"a;b\|c"}'` and a metacharacter still reaches a shell because of an unexpected interaction between `just` and `[script]`. | Decision #3 makes the path "just → tempfile → `node` → helper". No shell sits between `just` and `node` on the parameter-taking path. T6 explicitly runs adversarial inputs (`;`, `&`, `\|`, `$`, `"`, `'`, embedded whitespace, embedded `--`) on both Linux and Windows and asserts `process.argv` receives them as single tokens. | T6. |
| 5 | A Class 1 recipe still passes user input to a shell because of an oversight (e.g. a future contributor adds `*args` to `orchestrator-help`). | Decision #5 keeps `set positional-arguments` globally (load-bearing for `[script("node")]` argv forwarding), but the top-of-file invariant comment (decision #20) explicitly forbids parameter-taking shell recipes — any future Class 1 recipe that grew `*args` and used `{{args}}` interpolation in a shell body would violate that invariant on review and would also be visibly unsafe on the first dry-run test. T6 sweeps every parameter-taking recipe; a regressing change would fail T6 immediately. | T6 + top-of-file invariant comment (decision #20). |
| 6 | `pathToFileURL(path.resolve(...))` fails or produces a non-importable URL for a fringe Windows path (UNC, mapped drive, path with `#` / `%` / `?`, single-quote in repo name). | T0 step (e) verifies `pathToFileURL` resolution end-to-end for the standard repo-root path on both Linux and Windows; the runtime mechanism is the Node-documented one and percent-encodes URL-control characters by construction. UNC paths are explicitly out of scope (issue #42 reports a normal `C:\Users\...` install path); the sibling sub-plan rejected UNC for the Claude monitor pin on the same basis. The `process.cwd()` assumption is verified by T0 step (f). | T0 (e), (f). |
| 7 | `ai-files` output ordering or path shape diverges from `find ... \| sort`. | Decision #11 mandates slash-normalization, suppressed traversal errors, byte-wise sort. T4 includes a `node --test` that builds a fixture (regular files, hidden, depth-4 boundary, missing root, symlink, permission-restricted dir on POSIX) and asserts the helper's output matches a known-good fixture string AND on POSIX matches `LC_ALL=C find ... 2>/dev/null \| LC_ALL=C sort` after both outputs are slash-normalized. | T4. |
| 8 | `agent-orchestrator-local-clean`'s `dist/cli.js stop --force` invocation hangs on Windows. | `spawnSync` with `timeout: 10_000`, `stdio: 'ignore'`; ignore non-zero exit. | Code review of `scripts/just/local-clean.mjs`; T7. |
| 9 | `fs.rmSync(localHome, { recursive: true })` raises `EBUSY` on Windows. | `maxRetries: 3, retryDelay: 100`. | Decision #10; T7. |
| 10 | `scripts/local-home-lib.mjs` consolidation introduces a regression in `scripts/local-orchestrator-home.mjs` or `scripts/local-orchestrator-shims.mjs`. | Decision #14: existing scripts' stdout and exit code are byte-for-byte preserved. T1 includes a `node --test` that runs both existing scripts in a fixture and asserts stdout. | T1. |
| 11 | A future contributor reintroduces a POSIX-only recipe and re-introduces a `sh.exe` requirement. | Top-of-file invariant comment (decision #20) explicitly forbids POSIX-only shell idioms in recipe bodies and documents the `>= 1.44` floor. Not enforced in CI. | Top-of-file comment. |
| 12 | A PowerShell-Desktop-only Windows host attempts to use `just` 1.44+ — does the `[script]` mechanism work without `pwsh`? | `[script("node")]` invokes `node` directly; PowerShell Desktop is unrelated to the script-recipe path. PowerShell is only used for Class 1 and no-param Class 3 bodies (which contain no parameter interpolation). T7 verifies on a PowerShell-Desktop-only host. | T7. |
| 13 | `[script]` writes the tempfile in a way that Node treats as CJS, and the recipe body uses ESM-only syntax (top-level `await`, `import` statement). | Recipe bodies use `require('node:url')` and `require('node:path')` (CJS-compatible) on line 1, then dynamic `import(...).then(m => m.default(...))` on line 2 (works in CJS context, no top-level `await`). The async helper does its own work. | T0 step (b)/(c)/(d)/(e) probes exercise this exact body shape. |
| 14 | The README rewrite (decision #19) is misread to mean Git Bash is no longer needed for `agent-orchestrator claude`. | Decision #19 explicitly preserves L69–74 verbatim and adds the cross-reference "described above". T5 grep-checks the file for ambiguous wording. | T5. |
| 15 | Other docs (`docs/`, `AGENTS.md`, `CLAUDE.md`, `.agents/`) contain stale "Git Bash needed for `just`" claims. | T5 sweeps the repo and updates each occurrence about recipe execution. Claude-launcher Git Bash references are left untouched. | T5. |
| 16 | A fresh Windows developer does not have `just >= 1.44` on `PATH` (e.g. they installed an older `just` from chocolatey). | The README rewrite (decision #19) documents the 1.44 floor. The `justfile` parse fails with a clear error if the floor is not met. | Documentation; user-visible parse error. |
| 17 | `local-env` continues to print a POSIX `export` snippet that a Windows developer cannot directly use. | Decision #23 documents this as an accepted limitation; separate follow-up. | Documented. |

## Implementation Tasks

| Task ID | Title | Depends On | Acceptance Criteria |
|---|---|---|---|
| T0 | Verify `[script("node")]` argv semantics + `pathToFileURL` resolution + cwd assumption + just version | none | (a) Upgrade local `just` to `>= 1.44` (the implementation host's `just` is 1.21.0); record the upgraded version in the implementation log via `just --version`. (b) **`*args` probe — must run with `set positional-arguments` enabled.** Land a temporary probe recipe `_probe-args *args:` with the `[script("node")]` attribute and body `console.log(JSON.stringify(process.argv));`. Run `just _probe-args -- 'a;b' 'c d' '$x' '"q"'` and capture `process.argv`. Assert `process.argv.slice(2)` equals `['--', 'a;b', 'c d', '$x', '"q"']` (recipe name not in argv; tempfile path at `process.argv[1]`). Also run the same probe **without** `set positional-arguments` to confirm the failure mode (`process.argv.slice(2)` becomes empty). (c) **Named-parameter probe.** Land `_probe-named branch:` with `[script("node")]` and the same body. Run `just _probe-named main` and assert `process.argv.slice(2)` equals `['main']`. Run `just _probe-named 'feature/foo;bar'` and assert `process.argv.slice(2)` equals `['feature/foo;bar']`. (d) **Defaulted-parameter probe.** Land `_probe-default days="30":` with `[script("node")]` and the same body. Run `just _probe-default` (no arg) and assert `process.argv.slice(2)` equals `['30']`. Run `just _probe-default 7` and assert `['7']`. Run `just _probe-default '13;rm'` and assert `['13;rm']`. (e) **`pathToFileURL` resolution probe.** Land `_probe-pathurl:` with `[script("node")]` and body `const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path'); console.log(pathToFileURL(resolve('justfile')).href);`. Assert the printed URL is a valid `file://` URL pointing at the actual `justfile` location. (f) **Working-directory probe.** Land `_probe-cwd:` with `[script("node")]` and body `console.log(process.cwd());`. Run from `justfile_directory()` and from a subdirectory. Assert `process.cwd()` equals `justfile_directory()` in both cases. If `[script]` does not change cwd, halt and switch decision #7 to use `justfile_directory()` injected via env var. (g) **Signal-table sanity.** Verify `require('node:os').constants.signals['SIGTERM']` returns a number on Linux. (h) Remove all probe recipes after verification. Evidence captured in the Implementation Evidence section below. **If any assertion fails, halt and re-plan; do not silently fall back to any shell-based approach.** |
| T1 | Add shared local-home module | T0 | New file `scripts/local-home-lib.mjs` exports `resolveLocalOrchestratorHome(repoRoot)`. The two existing scripts (`scripts/local-orchestrator-home.mjs`, `scripts/local-orchestrator-shims.mjs`) are updated to import the function instead of inlining the logic. New `node --test scripts/just/__tests__/local-home-lib.test.mjs` asserts: (i) `resolveLocalOrchestratorHome('/some/repo')` is deterministic; (ii) `node scripts/local-orchestrator-home.mjs` produces stdout byte-for-byte identical to the pre-change behavior for a fixture repo root; (iii) `scripts/local-orchestrator-shims.mjs` produces the same shim-bin path. |
| T2 | Add `scripts/just/cli.mjs` | T1 | New helper exporting a default function `({ prefix = [], suffix = [] } = {}) => Promise<void>` that: (a) reads `process.argv.slice(2)` as `userArgs`; (b) `spawnSync(process.execPath, [path.resolve('dist/cli.js'), ...prefix, ...userArgs, ...suffix], { stdio: 'inherit' })`; (c) propagates exit per decision #15. Used by **8 recipes** with the per-recipe `{ prefix, suffix }` mapping spelled out in decision #8 (`orchestrator-opencode-config` → `prefix: ['opencode', '--print-config']`; `orchestrator-opencode` → `prefix: ['opencode']`; `orchestrator-status`/`-runs`/`-watch`/`-stop` → `prefix: [<verb>]`; `orchestrator-prune-dry-run` → `prefix: ['prune', '--older-than-days'], suffix: ['--dry-run']`; `orchestrator-prune` → `prefix: ['prune', '--older-than-days']`). The implementer writes each recipe body with the exact mapping from decision #8 — no per-recipe judgment required. |
| T3 | Add `scripts/just/passthrough.mjs` | T1 | New helper exporting a default function `({ script, prefix = [], suffix = [] }) => Promise<void>` that: (a) reads `process.argv.slice(2)` as `userArgs`; (b) `spawnSync(process.execPath, [path.resolve(script), ...prefix, ...userArgs, ...suffix], { stdio: 'inherit' })`; (c) propagates exit per decision #15. Used by **3 recipes** with the per-recipe mapping spelled out in decision #8 (`mcp-secret-bridge` → `script: 'scripts/mcp-secret-bridge.mjs', prefix: []`; `worktree` → `script: 'scripts/worktree.mjs', prefix: ['create']`; `worktree-remove` → `script: 'scripts/worktree.mjs', prefix: ['remove']`). |
| T4 | Add `scripts/just/local-cli.mjs` | T1 | New helper exporting a default function `() => Promise<void>` that: (a) reads `process.argv.slice(2)`; (b) drops a single leading `--` if `args[0] === '--'`; (c) computes the local-home path via T1's module; (d) `spawnSync(process.execPath, [path.resolve('dist/cli.js'), ...remaining], { stdio: 'inherit', env: { ...process.env, AGENT_ORCHESTRATOR_HOME: localHome } })`; (e) propagates exit per decision #15; (f) writes nothing extra to stdout/stderr. |
| T5 | Add `scripts/just/local-clean.mjs` | T1 | Per decision #10. |
| T6 | Add `scripts/just/ai-files.mjs` and unit test | none (parallelizable with T1–T5) | Per decision #11. New `node --test scripts/just/__tests__/ai-files.test.mjs` asserts the helper's output matches a known-good fixture string AND on POSIX matches `LC_ALL=C find ... -maxdepth 4 -type f 2>/dev/null \| LC_ALL=C sort` after both outputs are slash-normalized. Fixture covers: regular file at depth 0, files at depths 1–4, depth-5 file that must not appear, hidden file `.hidden` that must appear, symlink that must not be followed, ENOENT root that must be silently skipped, and (POSIX-only) a permission-restricted directory that must be silently skipped. |
| T7 | Rewrite the `justfile` and update README | T0–T6 | (a) Change `set windows-shell` to `["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]`. (b) **Keep** `set positional-arguments` globally (load-bearing for `[script("node")]` argv forwarding per decision #5/#6 and T0). (c) Remove the `local_orchestrator_home := \`node ...\`` parse-time backtick. (d) Do **not** add any parse-time path-shape variable (decision #17). (e) Update `agent-orchestrator-local-home` to `@node scripts/local-orchestrator-home.mjs`. (f) Convert each Class 2 recipe (11) to `[script("node")]` with the two-line body pattern from decision #7, using the per-recipe `{ prefix, suffix }` mappings from decision #8 (which split between `scripts/just/cli.mjs` and `scripts/just/passthrough.mjs`). (g) Convert `agent-orchestrator *args` and `local *args` (Class 3 with params, 2 recipes) to `[script("node")]` calling `scripts/just/local-cli.mjs` (no config object — the helper handles `--` strip and env injection internally). (h) Convert `agent-orchestrator-local-clean` and `ai-files` (Class 3 no params) to `@node scripts/just/<helper>.mjs`. (i) Add a top-of-file comment block per decision #20 documenting the cross-shell invariant and the `>= 1.44` floor. (j) README L76–80 paragraph rewritten per decision #19; existing L69–74 preserved verbatim. (k) Sweep `docs/`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `.agents/` for stale recipe-execution references to Git Bash / `sh.exe` / POSIX-shell-required and update each. |
| T8 | `just --dry-run` regression sweep | T7 | For each parameter-taking recipe (Class 2 + the two Class 3 with params: 13 recipes), run `just --dry-run <recipe> '<adversarial-input>'` (with `;`, `&`, `\|`, `$x`, `"`, `'`, embedded whitespace, embedded `--`). For `[script]` recipes, `--dry-run` shows the recipe body unchanged because `just` does not interpolate parameters into `[script]` bodies — it passes them as positional args to the interpreter. Capture the dry-run output for each recipe in the implementation log; assert that no recipe body line contains the adversarial token verbatim. |
| T9 | Cross-platform manual smoke | T1–T8 | On Linux: every Class 1 recipe runs successfully; every Class 2 recipe runs successfully with adversarial inputs and the underlying program receives the inputs as a single argv entry per token (verified with strace / by `process.argv` logging in a temporary debug build of one helper); every Class 3 recipe runs successfully and produces output identical to the merged baseline. On a Windows host with PowerShell Desktop, Node 22+, `pnpm`, and `just >= 1.44` (and **without** Git Bash on `PATH`, verified by an absent `usr\bin` entry in `$env:PATH`), the same set of recipes runs successfully. Adversarial-input cases are repeated on PowerShell. Smoke transcript or terminal log excerpts attached to the PR. |
| T10 | Quality gates | T1–T9 | `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test` (unchanged scope), `node --test 'scripts/just/__tests__/**/*.test.mjs'` (new explicit gate per decision #13), and `pnpm verify` all pass. The pre-existing `ip-address` audit advisory documented in the sibling sub-plan's verification log is allowed to fail `pnpm verify` and is explicitly called out as unrelated. `git diff --check` clean. No files outside `justfile`, `scripts/local-home-lib.mjs`, `scripts/local-orchestrator-home.mjs`, `scripts/local-orchestrator-shims.mjs`, `scripts/just/**`, `scripts/just/__tests__/**`, `README.md`, and the plan files in `plans/` are modified. |

## Acceptance Criteria

- A fresh Windows host with PowerShell Desktop, Node 22+, `pnpm`, and
  `just >= 1.44` on `PATH` (and **no Git Bash**) can run every recipe
  documented in `AGENTS.md` and the README dev workflow.
- Linux and macOS recipe behavior is byte-for-byte unchanged for any
  input that previously succeeded, including adversarial inputs.
- `set positional-arguments` is **kept globally** (load-bearing for
  `[script("node")]` argv forwarding per T0); `set windows-shell` is
  pinned to PowerShell Desktop with `-NoLogo -NoProfile -Command`;
  the `local_orchestrator_home` parse-time backtick is removed; no
  new parse-time path-shape variables are added (decision #17).
- All 11 Class 2 recipes and the two parameter-taking Class 3 recipes
  use `[script("node")]` with the two-line `pathToFileURL`-based
  body pattern from decision #7 and the per-recipe arg mappings
  from decision #8. No recipe body uses `{{args}}` / `{{branch}}` /
  `{{days}}` interpolation. No recipe body embeds a `just`-substituted
  path into a JS string literal.
- The three no-param Class 3 recipes have plain `@node scripts/...`
  bodies that work identically across shells.
- `scripts/local-home-lib.mjs` is the single source of truth for
  local-home resolution.
- README L76–80 reflects the new state and surfaces the `just >= 1.44`
  floor; existing L69–74 Claude-launcher Git Bash paragraph preserved
  verbatim.
- `pnpm build`, `pnpm test`, and the new `node --test 'scripts/just/__tests__/**/*.test.mjs'`
  gate pass on Linux. `pnpm verify` passes modulo the pre-existing
  unrelated `ip-address` advisory.
- T0 captures evidence that `process.argv` semantics under
  `[script("node")]` match the documented behavior; T8 captures
  evidence that no parameter-taking recipe interpolates user input
  into a shell-interpreted position; T9 captures cross-shell live
  evidence on both Linux and Windows PowerShell Desktop without Git
  Bash.

## Quality Gates

- [ ] T0 evidence captured: `just --version >= 1.44`; `[script("node")]`
      `*args` probe (with and without `set positional-arguments` to confirm
      decision #5/#6); named-parameter probe; defaulted-parameter probe;
      `pathToFileURL`-resolution probe; cwd-from-subdirectory probe;
      `os.constants.signals` sanity check; all probe recipes removed.
- [ ] `pnpm install --frozen-lockfile` succeeds.
- [ ] `pnpm build` succeeds.
- [ ] `pnpm test` succeeds (existing scope; unchanged).
- [ ] `node --test 'scripts/just/__tests__/**/*.test.mjs'` succeeds (new explicit
      gate per decision #13).
- [ ] T8 `just --dry-run` regression sweep captured for all 13
      parameter-taking recipes with adversarial inputs.
- [ ] `pnpm verify` succeeds, or the only failure is the pre-existing
      `ip-address` audit advisory.
- [ ] T9 manual cross-shell smoke captured (Linux + Windows
      PowerShell Desktop without Git Bash on `PATH`).
- [ ] `git diff --check` clean.
- [ ] No edits outside `justfile`, `scripts/local-home-lib.mjs`,
      `scripts/local-orchestrator-home.mjs`,
      `scripts/local-orchestrator-shims.mjs`, `scripts/just/**`,
      `scripts/just/__tests__/**`, `README.md`, and the plan files
      under `plans/`.
- [ ] `.agents/rules/node-typescript.md` checks satisfied: Node 22+
      compatibility, no new deps, TypeScript strictness intact (no
      TS files touched).
- [ ] No commits, pushes, secrets, hooks, or dependency installs
      performed without explicit user approval.

## Implementation Evidence

### T0 Corrections (2026-05-06)

A first implementation pass on this plan surfaced two factual contract
errors. They were authorized for inline correction by the supervisor and
plan reviewer; decisions #4, #5, and #6 above carry the corrected
contracts. The following T0 evidence was re-recorded on `just 1.50.0`
(downloaded as a release binary; no production install) to confirm the
corrections:

**`just --version` (after temporary upgrade to 1.50.0):**

```
just 1.50.0
```

**(b1) `*args` probe WITHOUT `set positional-arguments` — argv is empty:**

```
$ just _probe-args -- 'a;b' 'c d' '$x' '"q"'
["/.../node","/run/user/1000/just/just-DPCPIN/_probe-args"]
```

`process.argv.slice(2)` is `[]`. The recipe args are dropped on the floor.

**(b2) `*args` probe WITH `set positional-arguments` — argv populated:**

```
$ just _probe-pos -- 'a;b' 'c d' '$x' '"q"'
["/.../node","/run/user/1000/just/just-Le9sMs/_probe-pos","--","a;b","c d","$x","\"q\""]
```

`process.argv.slice(2)` is `['--', 'a;b', 'c d', '$x', '"q"']` —
adversarial tokens land as inert single argv entries.

**(c) Named-parameter probe (with `set positional-arguments`):**

```
$ just _probe-named main
["/.../node",".../tempfile","main"]
$ just _probe-named 'feature/foo;bar'
["/.../node",".../tempfile","feature/foo;bar"]
```

**(d) Defaulted-parameter probe (with `set positional-arguments`):**

```
$ just _probe-default
["/.../node",".../tempfile","30"]
$ just _probe-default 7
["/.../node",".../tempfile","7"]
$ just _probe-default '13;rm'
["/.../node",".../tempfile","13;rm"]
```

**(e) `pathToFileURL` resolution probe:**

```
$ just _probe-pathurl
file:///tmp/just-probe/justfile
```

**(f) Working-directory probe — same cwd from justfile dir and from a subdir:**

```
$ just _probe-cwd                       # from /tmp/just-probe
/tmp/just-probe
$ cd subdir && just _probe-cwd          # from /tmp/just-probe/subdir
/tmp/just-probe
```

**(g) Signal-table sanity:**

```
$ node -e "console.log('SIGTERM=' + require('node:os').constants.signals.SIGTERM)"
SIGTERM=15
```

**Just changelog reference confirming `[script]` stabilized in 1.44:**

> `[1.44.0] - 2025-12-06 — Stabilize [script] attribute`

Source: `casey/just` 1.50.0 release tarball, `Cargo.lock`/changelog
section. The `[script(COMMAND)]` syntax is older (1.32) and the empty
`[script]` form was added in 1.33, but the attribute was unstable until
1.44 and required `set unstable` on those versions. Pinning the floor
to 1.44 avoids both the `set unstable` requirement and the
feature-flag-shape risk.

**Authorization.** The two corrections (re-add `set positional-arguments`
globally; bump just floor from `>= 1.33` to `>= 1.44`) were approved by
the supervisor after consultation with the plan reviewer before this
implementation began.
