# Daemon Auth Setup For Provider Credentials

Branch: `27-add-first-class-daemon-auth-setup-for-cursor-api-keys`
Plan Slug: `27-daemon-auth-setup`
Parent Issue: #27
Created: 2026-05-04
Status: planning

## Context

For a public npm package the Cursor SDK backend currently demands that
`CURSOR_API_KEY` is present in the daemon's process environment. That forces
end users to understand daemon process inheritance, shell startup files,
or systemd just to make Cursor auth survive a restart or a package upgrade.

This plan adds a first-class auth setup flow:

- A new user-level secrets file dedicated to daemon worker auth (separate
  from the existing repo-development `mcp-secrets.env`).
- A generic `agent-orchestrator auth` command surface that drives that
  file, with Cursor wired end-to-end and other providers reserved as
  registry entries.
- The daemon loads the secrets file on startup, merging into the daemon
  process env without overriding values already supplied by the
  environment (so CI/advanced users keep precedence).
- `doctor` reports the auth source ("env" or "file: …") in human output
  without exposing the secret, using additive optional diagnostic fields.

### Sources Read

- `AGENTS.md`, `CLAUDE.md`, `.agents/rules/node-typescript.md`,
  `.agents/rules/mcp-tool-configs.md`
- `src/cli.ts` (top-level command dispatch and help text)
- `src/daemon/daemonCli.ts` (`start()` spawns `daemonMain.js` with
  `env: process.env`)
- `src/daemon/daemonMain.ts` (daemon entry point; constructs
  `OrchestratorService` with `process.env`-derived state)
- `src/daemon/paths.ts` (`daemonPaths()`, `resolveStoreRoot()` via
  `runStore`)
- `src/runStore.ts:1055` (`resolveStoreRoot` =
  `AGENT_ORCHESTRATOR_HOME || ~/.agent-orchestrator`)
- `src/diagnostics.ts` (`getBackendStatus`, `diagnoseCursorBackend`,
  `formatBackendStatus`; reads `process.env.CURSOR_API_KEY` directly)
- `src/backend/cursor/runtime.ts` (uses `env.CURSOR_API_KEY`; produces
  a `SPAWN_FAILED` auth failure when absent, and `WORKER_BINARY_MISSING`
  when the SDK is absent)
- `scripts/mcp-secret-bridge.mjs` (existing repo-dev secrets pattern at
  `~/.config/agent-orchestrator/mcp-secrets.env`; precedent for env-style
  file parsing and secret-source resolution)
- `docs/development/mcp-tooling.md` (reference for how the existing
  user-level secrets file is documented)
- Issue #27 acceptance criteria; Issue #25 / PR #25 (Cursor backend
  context)

### User Decisions Captured

- D1: dedicated new file (separate from `mcp-secrets.env`).
- D2: generic provider auth registry; Cursor wired now,
  `claude`/`codex` reserved.
- D3: daemon loads the file in `daemonMain.ts` at startup; env wins.
- D4: format-only validation (non-empty, plausible charset/length, no
  whitespace); no live network probe.
- D5: additive `auth.source_kind` + `auth.source_path` fields on
  `BackendDiagnostic` (both optional); the human formatter consumes
  them. (Earlier draft said "no contract change" — corrected per
  plan-review 2026-05-04: the formatter has no other reliable way to
  know the source.)

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| D1 | Secrets file location | `~/.config/agent-orchestrator/secrets.env` (XDG-style; separate from the repo-dev `mcp-secrets.env`). Path overridable via `AGENT_ORCHESTRATOR_SECRETS_FILE`. Lives outside the run store (`~/.agent-orchestrator/`) so resetting daemon state does not nuke saved credentials, and outside the repo. | Keeps repo-dev MCP tooling secrets and end-user daemon worker auth in different domains; same parent dir as `mcp-secrets.env` so users only have to remember `~/.config/agent-orchestrator/`. Following XDG convention is what the existing bridge already does. Run-store reset (a debug action) shouldn't wipe user credentials. | (a) Reuse `mcp-secrets.env` — mixes repo-dev tooling with end-user worker auth in one file; harder to reason about scope and risk of accidentally committing repo paths into the user file. (b) Live under `AGENT_ORCHESTRATOR_HOME` (run store) — wiping the run store should not destroy credentials. (c) `~/.agent-orchestrator/secrets.env` — collides with the run store dir's purpose. |
| D2 | Provider abstraction | Introduce `src/auth/providers.ts` with a typed `AuthProvider` table: `{ id: 'cursor' \| 'claude' \| 'codex', envVars: string[], primaryEnvVar: string, label, hint, validate(value): { ok: true } \| { ok: false; reason: string } }`. Cursor entry is fully wired; `claude` and `codex` entries are present in the table for `auth status` parity but `auth claude` / `auth codex` print a "not yet supported; use the CLI's own auth flow" message and exit non-zero. | Issue explicitly asks for "generic provider auth infrastructure rather than Cursor-only"; the table is small enough to add now and avoids a refactor when the second provider needs file-backed auth. Stubs document intent without claiming behavior we haven't validated. | (a) Cursor-only with no registry — re-extraction cost when a second provider needs the same flow. (b) Wire Claude/Codex too — they already have working CLI auth flows; doing them blind risks incorrect guidance. |
| D3 | Where the daemon loads the file | Inside `daemonMain.ts` `main()`, *before* constructing `OrchestratorService`. A new `loadUserSecretsIntoEnv(filePath, env)` helper reads the file and writes any keys not already set on `process.env`. **Precedence:** existing `process.env` value > file value > unset. Secrets-file load failures are logged via the existing `log()` helper and never throw. The `daemonCli.ts` start path is unchanged. | Single owner (the daemon process), so the behavior is the same regardless of who started the daemon (CLI, systemd, package-upgrade restart). Env precedence preserves the CI/advanced-user override path the issue requires. Load failures must not prevent the daemon from starting — at worst, runs fall back to today's behavior (missing-auth failed run). | (a) Load in `daemonCli.ts start` and pass via spawn env — couples to one launch path; systemd/manual `node daemonMain.js` would skip it. (b) Load on every IPC request — repeated I/O for no benefit. (c) Live re-read on file change — fs watching is fragile across platforms; restart is fine and explicit. |
| D4 | Validation | Format-only. The `validate()` function for cursor checks: trimmed, non-empty, length within `[16, 512]`, matches `^[A-Za-z0-9_\-:.]+$`, no whitespace. No network probe. The CLI applies `validate()` after capturing the value and refuses to save on failure with a precise reason. | A live `Cursor.me()` probe requires the optional `@cursor/sdk` to be installed and reachable, which makes pre-install setup brittle and CI-hostile. Format check rejects the obvious typos (pasted whitespace, wrong field) without external dependencies. | (a) Live probe by default — requires SDK installed; flaky in headless/offline. (b) Both — live probe still couples to optional dep; revisit as a follow-up `--check-live` flag. (c) No validation — defeats the issue's "validated before saving" criterion. |
| D5 | Doctor source identification | **Additive contract change.** Extend `BackendDiagnosticSchema.auth` with two optional, non-secret fields: `source_kind?: 'env' \| 'file'` and `source_path?: string` (the resolved secrets-file path; only set when `source_kind === 'file'`). `auth.source` keeps its current meaning (the env-var name, e.g. `"CURSOR_API_KEY"`). `formatBackendStatus` reads `source_kind`/`source_path` to render `auth: ready (CURSOR_API_KEY, env)` or `auth: ready (CURSOR_API_KEY, file: ~/.config/agent-orchestrator/secrets.env)`. Both new fields are optional and default to absent for non-cursor backends, so no JSON consumer breaks. The accompanying `contract.test.ts` is updated to assert the optional fields parse. **Note:** an earlier draft assumed no contract change, but `formatBackendStatus(report)` has no other reliable way to know the source — see plan-review finding 2026-05-04. | Issue requires identifying source without exposing the secret. Adding two optional non-secret fields is the smallest change that lets the formatter render the truth without leaking UI concerns into the meaning of `source`. | (a) Encode "(env)/(file)" into `source` — overloads the field's meaning and breaks programmatic consumers reading the env-var name out of `source`. (b) Hide it in `hints[]` — fragile string matching. (c) Skip it entirely — fails the issue's "identifies the source" criterion. |
| D6 | CLI surface | New top-level `auth` subcommand under both `agent-orchestrator` and `agent-orchestrator-daemon` (the existing daemon-cli alias gets the same subcommand for parity with `status`/`runs`). Subcommands: `auth status [--json]`, `auth <provider>` (interactive prompt; TTY required), `auth <provider> --from-env` (reads the provider's `primaryEnvVar`, e.g. `CURSOR_API_KEY`), `auth <provider> --from-env VAR` (reads exactly the named `VAR` instead — never falls back; if `VAR` is unset or empty, fail), `auth <provider> --from-stdin` (reads a single trimmed line from stdin), `auth unset <provider>`. After successful save/unset, print a two-line hint: line one says "Saved to `<path>`."; line two says "A running daemon is unchanged until restart — run `agent-orchestrator restart` to pick up the new value." (when stopped, line two says "Run `agent-orchestrator start` to use the new credentials."). | Matches the four commands the issue listed; covers TTY humans, scripted setup, and removal. `auth status` covers per-provider state for the generic table. The explicit "running daemon is unchanged" line removes any ambiguity about whether the save took effect immediately. The `--from-env` argument is positional and authoritative when present, never a fallback (plan-review finding #4, 2026-05-04). | Matches the four commands the issue listed; covers TTY humans, scripted setup, and removal. `auth status` covers per-provider state for the generic table. The restart hint avoids the silent-mismatch failure mode where a user updates the file but the running daemon still has the old env. | (a) `agent-orchestrator cursor auth` (provider-first) — clashes with the existing `agent-orchestrator opencode` / `claude` launchers, which are not auth subcommands. (b) Auto-restart the daemon on save — too magical; restarting must be explicit because in-flight runs may be impacted. |
| D7 | Interactive prompt mechanism | Use Node's `node:readline` with a custom muted output: subclass-equivalent (writeable that swallows anything except `\r`/`\n` while reading the password line). TTY-only; if stdin or stdout is not a TTY, `auth <provider>` (interactive form) fails with a clear message pointing at `--from-env` / `--from-stdin`. The captured value is trimmed, passed to `validate()`, and never logged. | Built-in (no new dependency, per `node-typescript.md`); the existing `monitorCli.ts` already drives `setRawMode`/readline so the pattern is in-house. Refusing non-TTY prevents accidental leaks (e.g., a script piping into `auth cursor` and the value showing up in process listings or shell history). | (a) Add a prompt dependency (`enquirer`/`prompts`) — the rule prefers Node built-ins and existing deps. (b) Allow non-TTY interactive — too easy to expose the secret unintentionally. |
| D8 | File format and permissions | Env-style `KEY=value` lines with comments (`#` prefix), reusing the same regex `mcp-secret-bridge.mjs` uses (`^([A-Za-z_][A-Za-z0-9_]*)=(.*)$`) for parse parity. Saves are **atomic**: write `secrets.env.<pid>.<ts>.tmp` with mode `0o600`, `fsync`, `rename` over the target. Parent dir created with `0o700` on POSIX. On read, **on POSIX**, if `stat().mode & 0o077` is non-zero, refuse to load and log a clear remediation message ("file permissions are too permissive; run `chmod 600 …`"). On Windows the permission check is skipped (best-effort, like `ensureSecureRoot`). Save preserves comments and ordering by parsing into an ordered list of entries; `auth unset` removes the matching entry without disturbing the rest. | Matches the existing user-level secrets pattern; atomic rename avoids partial writes; permission check refuses to read a credential file world-readable. Preserving comments/ordering means a user who hand-edits the file (allowed; documented) does not lose their notes when running `auth cursor` or `auth unset`. | (a) JSON file — the existing pattern is env-style; consistency wins. (b) Plain overwrite without atomic rename — risk of truncated file on crash. (c) Reject any non-key lines — would clobber user comments. |
| D9 | Existing-key replacement and unset semantics | `auth <provider>` overwrites the provider's `primaryEnvVar` key in-place if it already exists (or appends if not). Other entries (including unrelated provider keys, comments, blank lines) are untouched. `auth unset <provider>` removes only the `primaryEnvVar` for that provider. Re-running `auth status` reflects the new file state immediately. | Predictable. Lets a user rotate keys without losing other configuration. Aligns with the explicit "an unset/remove path" criterion. | (a) `auth unset` deletes the whole file when only one entry remains — too clever; explicit is better. (b) Rewriting the file from scratch — would discard user comments. |
| D10 | Daemon restart UX | After a successful `auth <provider>` or `auth unset <provider>`, the CLI prints two lines: "Saved to `<path>`." followed by, when daemon is **running**, "A running daemon is unchanged until restart — run `agent-orchestrator restart` to pick up the new value." or, when **stopped**, "Run `agent-orchestrator start` to use the new credentials." `auth status` always reflects file contents and indicates whether the daemon is running so the user can correlate. | Issue requires file changes to be picked up by the daemon; the cheapest correct mechanism is restart, which we already support. The "running daemon is unchanged" wording is explicit (per plan-review 2026-05-04) so users do not silently assume the save propagated. | (a) Auto-restart — risks killing in-flight runs. (b) IPC `reload_secrets` method — schema-bump and concurrency edges (env mutation while runs are active); revisit as a follow-up if users complain. |
| D11 | Tests strategy | (i) `userSecrets.test.ts`: parse, atomic write, perm-too-permissive refusal, comment/ordering preservation, unset preserves siblings, `AGENT_ORCHESTRATOR_SECRETS_FILE` override. (ii) `authProviders.test.ts`: cursor `validate()` accepts plausible keys and rejects whitespace/empty/short/charset violations. (iii) `authCli.test.ts`: `auth status` JSON shape, `auth cursor --from-env` happy path, `auth cursor --from-stdin` happy path, `auth cursor --from-env VAR` happy path, `auth cursor --from-env VAR` missing-var failure, `auth unset cursor`, non-TTY rejection of interactive form, two-line restart-hint text (running daemon vs stopped daemon). (iv) `diagnostics.test.ts` extension — **diagnostics is in the CLI process (D14), so all five cases are tested in-process by injecting `process.env` and `AGENT_ORCHESTRATOR_SECRETS_FILE`**: (1) env-only → `auth.status: ready`, `source_kind: 'env'`, `source_path` absent, formatter prints `(CURSOR_API_KEY, env)`. (2) file-only → `auth.status: ready`, `source_kind: 'file'`, `source_path` set, formatter prints `(CURSOR_API_KEY, file: <path>)`. (3) both set, **including the case where file value equals env value** → env wins; `source_kind: 'env'` (the file value is irrelevant; we never claim a file source when env is set). (4) env-absent + file present but `0o644` → `auth.status: unknown`, no `source_kind`, chmod hint in `hints[]`. (5) env-set + file present but `0o644` → `auth.status: ready`, `source_kind: 'env'`, **no chmod hint** (per D14: file permission noise must not surface when the user already has env). (v) Daemon load proof — **does not use `doctor`** (which under D14 reads the file in the CLI process and would green-pass even if `daemonMain` skipped the load) and **does not rely on the runtime returning a particular failure code** (which would also green-pass on `WORKER_BINARY_MISSING` when `@cursor/sdk` isn't installed, *before* the apiKey check ever runs — per `src/backend/cursor/runtime.ts:76-100`). Instead, `daemonAuthLoad.test.ts` calls `bootDaemon(...)` **in-process** with a fake `CursorSdkAdapter` (D15) that exposes `available()` as `{ ok: true }` and records the `apiKey` passed into `Agent.create`. The test writes a temp secrets file with a known `CURSOR_API_KEY` value, strips that var from the env passed to `bootDaemon`, issues a `start_run` over the in-process IPC server, and asserts the fake adapter captured **the file value**. (vi) Precedence (daemon side): same harness, but the env passed to `bootDaemon` includes `CURSOR_API_KEY` set to a sentinel distinct from the file's value — assert the captured `apiKey` is the sentinel (env wins; file value is unused). | Covers every acceptance criterion. Distinguishes CLI-process diagnostics tests (D14) from daemon-process load tests (D3) so neither suite paper-fits over a regression in the other. (Plan-review finding #3, 2026-05-04: the prior draft confused these and would have shown a green test even if `daemonMain` never loaded the file.) | Integration-only tests — slow and skip the precedence/permission edges. Using `doctor --json` to prove daemon-side loading — does not actually prove it (D14). |
| D12 | Docs | New page `docs/development/auth-setup.md` covering: where the file lives, format, permissions, `auth status` / `auth <provider>` / `auth unset` flows, **explicit warnings** ("do not put secrets in shell profiles, MCP server config, or any repo file"), and the env-var-overrides-file precedence. README gets a one-paragraph link to it next to the existing Cursor backend mention. `docs/development/cursor-backend.md` cross-links the new page in its `CURSOR_API_KEY` section instead of telling users to "set it in the daemon environment". `docs/development/mcp-tooling.md` gets a one-line clarification that `mcp-secrets.env` is repo-MCP-tooling and *not* read by the daemon. | Issue's "Document the setup flow" criterion is explicit. Cross-linking from existing pages prevents stale `set CURSOR_API_KEY` instructions from continuing to mislead users. | Docs-only without README link — discoverability fails. |
| D15 | Daemon boot test seam | Extract the body of `daemonMain.ts`'s `main()` into a new exported function `bootDaemon(options: { paths: DaemonPaths; log: (msg: string) => void; cursorSdkAdapter?: CursorSdkAdapter; loadSecrets?: (env: NodeJS.ProcessEnv) => void })` in a new module `src/daemon/bootDaemon.ts`. The shipping `daemonMain.ts` becomes a thin entry that calls `bootDaemon({ paths: daemonPaths(), log, cursorSdkAdapter: defaultCursorSdkAdapter(), loadSecrets: (env) => loadUserSecretsIntoEnv(env) })`. Both options are **only** for tests; production never overrides them. The cursor adapter override is plumbed through `createBackendRegistry(store, { cursorSdkAdapter? })` (registry constructor gains an optional second argument); production callers omit it and the registry continues to use `defaultCursorSdkAdapter()`. This gives tests a deterministic in-process seam that proves "the daemon boot sequence loaded the file *and* the loaded value reaches the cursor runtime", without requiring `@cursor/sdk` to be installed and without spawning a child process. The seam is internal (no MCP/CLI/contract surface change) and adds zero production behavior. | Without this, the daemon-load assertion has no honest test — running a real cursor invocation across process boundaries either requires the real SDK (CI-fragile), masks the apiKey check behind `WORKER_BINARY_MISSING` when the SDK is missing (false green), or relies on probing `process.env` of a child process (not portable, and what we want to prove is that the *runtime* observed the value, not just that env carries it). The two override hooks are tightly scoped to constructor injection — no test-only env vars, no global mutable state. (Plan-review round 4, finding #1, 2026-05-04.) | (a) Test-only env var like `AGENT_ORCHESTRATOR_TEST_CURSOR_ADAPTER_MODULE` — leaks a test seam into the production env-var surface; risks accidental enablement. (b) Stub `@cursor/sdk` on disk for the test — fragile across pnpm/npm install layouts and slow. (c) Spawn the daemon child and read its env over IPC — requires a debug IPC method that becomes a permanent contract surface. (d) Skip the test — the issue's "daemon automatically loads the user secrets file on startup" criterion would be unverified. |
| D14 | Effective-auth resolution for `doctor` | `agent-orchestrator doctor` runs in the **CLI process**, not via IPC into the daemon (`src/cli.ts:7` calls `getBackendStatus()` directly). The daemon-side load (D3) is therefore not enough on its own to make `doctor` show `auth.status: ready` when only the file is set. `getBackendStatus()` must compute *effective auth* in-process: build an effective env by overlaying `loadUserSecrets()` onto `process.env` with **`process.env` winning** (same precedence as the daemon, D3). Cursor diagnostics then reads `CURSOR_API_KEY` from the effective env, not raw `process.env`. The check is read-only — `getBackendStatus()` does **not** mutate `process.env`. **Permission failures must respect env precedence:** if `process.env.CURSOR_API_KEY` is set, the diagnostic stays `auth.status: ready` with `source_kind: 'env'` regardless of file readability — the file is irrelevant in that case and is not even probed for parsing. The chmod-remediation `hints[]` entry is only added when (a) the env var is **absent** *and* (b) the file exists but is permission-blocked; in that case `auth.status` is `unknown`. When the env var is set and the file also fails permission checks, no chmod hint is emitted (the user is fine; surfacing it would be noise). The doctor still runs to completion in all cases. | Without this, the issue's "doctor reports Cursor auth as ready" criterion only holds when the daemon is the diagnostic source — which it isn't today. Mutating `process.env` in a read-only diagnostic would surprise callers. (Plan-review finding #1, 2026-05-04.) | (a) Have `doctor` call into the daemon over IPC — only works when the daemon is running and adds a roundtrip for a local lookup. (b) Mutate `process.env` from `getBackendStatus()` — read-only function should stay read-only; would also paper over the in-CLI/in-daemon split. (c) Document that `doctor` lies until the daemon runs — fails the criterion. |
| D13 | Out-of-scope guardrails | This plan does **not**: make any **breaking** MCP contract changes (the **additive** D5 fields `auth.source_kind` and `auth.source_path` are in scope and are the only contract change); add an IPC method to reload secrets without restart; add live SDK validation; touch Claude/Codex auth flows beyond reserving table entries; introduce a new dependency. Each excluded item is captured under "Future Options". | Keeps the scope inside one focused PR and respects `node-typescript.md` ("ask before installing packages"). The contract carve-out matches D5's reasoning. | Bundling any of the above — blast radius creep. |

## Backend Auth Provider Table (sketch only)

```text
type AuthProvider = {
  id: 'cursor' | 'claude' | 'codex';
  label: string;             // human-readable, e.g. "Cursor"
  envVars: string[];         // every env var the runtime accepts
  primaryEnvVar: string;     // the var the auth command reads/writes
  helpUrl: string;           // docs/dashboard URL surfaced in hints
  status: 'wired' | 'reserved'; // 'reserved' rejects auth <provider>
  validate(value: string): { ok: true } | { ok: false; reason: string };
};
```

Cursor entry: `id: 'cursor'`, `primaryEnvVar: 'CURSOR_API_KEY'`,
`status: 'wired'`, `validate` per D4. Claude/Codex entries: `status: 'reserved'`,
`validate` returns ok-on-any-non-empty (so `auth status --json` can still
report `unknown`/`ready` per env-var presence) but `auth <provider>` for
reserved entries prints the "use CLI auth flow" notice and exits 2.

## Scope

### In Scope

- New `src/auth/userSecrets.ts` (load/save/unset for the secrets file
  with permission checks).
- New `src/auth/providers.ts` (the provider table above).
- New `src/auth/authCli.ts` exporting `runAuthCli(argv)`; dispatched from
  `src/cli.ts` and from `src/daemon/daemonCli.ts` (so both binaries
  expose `auth`).
- `daemonMain.ts` integration: extract its boot body into `src/daemon/bootDaemon.ts` (`bootDaemon(options)`) per D15; the entry script becomes a thin wrapper. `bootDaemon` calls `loadUserSecretsIntoEnv(process.env)` before constructing the registry.
- `src/backend/registry.ts`: `createBackendRegistry(store, options?)` gains an optional `{ cursorSdkAdapter? }` for test injection; production callers pass nothing and the default adapter is used.
- `diagnostics.ts`: build effective env (env + file, env wins) inside `getBackendStatus()` so `doctor` works without going through the daemon (D14); populate the new optional `auth.source_kind`/`auth.source_path` fields and render them in `formatBackendStatus`.
- `contract.ts`: additive optional fields on `BackendDiagnosticSchema.auth` (`source_kind`, `source_path`); `contract.test.ts` covers the additive shape.
- Help text in both CLIs.
- Unit + integration tests per D11.
- Docs per D12.

### Out Of Scope

- Live SDK validation of the cursor key.
- Claude / Codex auth flows beyond the reserved provider entries.
- IPC method to hot-reload secrets without daemon restart.
- Encrypted-at-rest storage (system keychain integration). Captured as
  Future Options.
- Breaking changes to the MCP tool contract: no field is renamed,
  removed, or made stricter, and no existing required field becomes
  optional. The **additive** D5 change to `BackendDiagnostic.auth`
  (new optional `source_kind` and `source_path`) is in scope.
- Migrating `mcp-secrets.env` users (the two files coexist; docs
  explain).

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| R1 | User runs `auth cursor`, then forgets to restart, then files a bug that "auth still missing". | After save, CLI prints an explicit restart hint (D10); `auth status` shows daemon-running flag so the user can correlate. | D10 + tests in `authCli.test.ts`. |
| R2 | File permissions get widened by `umask`, backup tools, or manual edit. | Loader refuses to read on POSIX if `mode & 0o077 != 0` and logs a chmod hint via daemon `log()`. CLI's load-on-status path surfaces the same message in the human output. | D8 + `userSecrets.test.ts` perm test. |
| R3 | Concurrent writes (user runs two `auth cursor` at once). | Atomic `tmp + rename` so the file is never partial; last-write wins, which is acceptable for a manual setup tool. | D8. |
| R4 | Daemon started with an env-var override; user later runs `auth cursor` and expects the new key to take effect. | The CLI prints the restart hint, *and* `auth status` shows the env-var override is active and that file value is masked by it. After restart with the env-var still set, env still wins (this is intentional per the criterion). Documented. | D6 + D10 + `auth status` tests. |
| R5 | `AGENT_ORCHESTRATOR_SECRETS_FILE` points outside `~/.config/`. | Allowed (covers tests + advanced setups), but the loader still permission-checks the resolved path. | D1 + D8. |
| R6 | User lands on Windows where POSIX perms don't apply. | Loader skips the perm check on Windows (parity with `ensureSecureRoot`). Docs note this and recommend ACL-protecting the user profile dir. | D8 + D12. |
| R7 | Loader reads a malformed line. | Reuse the existing `mcp-secret-bridge.mjs` regex; non-matching lines are ignored (comments/blank lines pass through unchanged). Covered by unit test. | D8 + `userSecrets.test.ts`. |
| R8 | User's `validate()` rejects a legitimate-but-unusual key Cursor introduces later. | Validation is intentionally permissive on charset and bounded only loosely (16–512 chars). If real-world keys ever violate this, relax the regex/bounds in one place. Tracked as Future Options. | D4 (documented loose bounds). |
| R9 | A reserved provider (`claude`/`codex`) is invoked by a user. | `auth <reserved-provider>` exits 2 with a "not yet supported; use the CLI's own auth flow" message. `auth status` still reports the provider so the user sees parity. | D2 + tests. |
| R10 | Save races with daemon restart. | The daemon reads the file at startup (single point in time); restart picks up whatever is on disk at that moment. No live mutation path means no torn reads inside the daemon. | D3. |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T1 | Add user-secrets loader/saver module | — | pending | `src/auth/userSecrets.ts` exports `loadUserSecrets(opts?)`, `loadUserSecretsIntoEnv(env, opts?)`, `saveUserSecret(provider, key, value, opts?)`, `unsetUserSecret(provider, key, opts?)`, `resolveSecretsPath(env?)`. POSIX perm check refuses to load when `mode & 0o077 != 0`. Atomic write via tmp+rename at `0o600`. Comments and ordering preserved. Honors `AGENT_ORCHESTRATOR_SECRETS_FILE` override. Unit tests in `src/__tests__/userSecrets.test.ts` cover parse, save, unset, perm refusal, env override. |
| T2 | Add provider auth registry | — | pending | `src/auth/providers.ts` exports `AUTH_PROVIDERS` (typed table) and `getProvider(id)`. Cursor entry wired with `validate()` per D4. Claude/Codex entries marked `status: 'reserved'`. Unit tests in `src/__tests__/authProviders.test.ts` cover `validate()` boundaries. |
| T3 | Add interactive masked prompt helper | — | pending | `src/auth/prompt.ts` exports `promptSecret(question)` that returns a Promise<string>. Refuses to run when `process.stdin.isTTY` or `process.stdout.isTTY` is false (throws a typed error). Echo is suppressed. No new dependency. |
| T4 | Add `auth` CLI dispatcher | T1, T2, T3 | pending | `src/auth/authCli.ts` exports `runAuthCli(argv)` handling `status [--json]`, `<provider>`, `<provider> --from-env` (reads provider's `primaryEnvVar`), `<provider> --from-env VAR` (reads exactly `VAR`; missing/empty is a hard failure with exit 1), `<provider> --from-stdin`, `unset <provider>`. Returns numeric exit code. Reserved providers exit 2 with the documented message. After successful save/unset prints the two-line daemon-restart hint per D10. |
| T5 | Wire `auth` into `cli.ts` and `daemonCli.ts` | T4 | pending | `agent-orchestrator auth …` and `agent-orchestrator-daemon auth …` both dispatch to `runAuthCli`. Help text updated in both. `isDaemonCliCommand` recognizes `auth`. Tests in `src/__tests__/authCli.test.ts` cover all subcommand happy/sad paths and JSON shape of `auth status`. |
| T6 | Daemon-side secrets load on startup | T1 | pending | (a) Extract `daemonMain.ts`'s `main()` into `src/daemon/bootDaemon.ts` exporting `bootDaemon(options)` per D15; the entry script becomes a thin wrapper. (b) Add an optional second parameter to `createBackendRegistry(store, options?)` to accept `{ cursorSdkAdapter? }`; production callers pass nothing. (c) `bootDaemon` calls `options.loadSecrets ?? loadUserSecretsIntoEnv` against `process.env` before constructing the registry. Existing `process.env` keys are not overwritten. Load failures (parse, perms, missing file) are caught and routed through `log()`; daemon does not crash. (d) New `daemonAuthLoad.test.ts` invokes `bootDaemon` **in-process** with a fake `CursorSdkAdapter` that records the `apiKey` passed to `Agent.create`, then issues a `start_run` over the (in-process) IPC server and asserts: file-only case → captured `apiKey` equals the file's value; env-set + file case → captured `apiKey` equals the env sentinel (file value is *not* used). The test does not require `@cursor/sdk` to be installed — that's the whole point of the fake adapter. The shipping daemon entry script is unchanged externally. |
| T7 | Effective-auth in `getBackendStatus()` + doctor source identification | T1 | pending | (a) `BackendDiagnosticSchema.auth` gains optional `source_kind: 'env' \| 'file'` and `source_path: string` (D5); `contract.test.ts` updated to assert existing payloads still parse and the new fields parse when present. (b) `getBackendStatus()` builds a read-only "effective env" by overlaying `loadUserSecrets()` onto `process.env` with `process.env` winning (D14); it does **not** mutate `process.env`. (c) `diagnoseCursorBackend` populates `auth.source_kind`/`auth.source_path` based on whether `CURSOR_API_KEY` came from env vs file (env wins → `'env'`, file-only → `'file'`). (d) Permission failures respect env precedence (D14): when env is set, the file is irrelevant — `auth.status: ready`, `source_kind: 'env'`, no chmod hint. When env is absent and the file is permission-blocked, `auth.status: unknown` and a single non-secret chmod hint is added to `hints[]`. The doctor exits successfully in all cases. (e) `formatBackendStatus` renders `auth: ready (CURSOR_API_KEY, env)` or `auth: ready (CURSOR_API_KEY, file: <path>)`. Tests in `diagnostics.test.ts` cover all five matrix cases listed in D11(iv). |
| T8 | Precedence + missing-key tests | T1, T2, T6 | pending | Tests assert: (a) env-var present + file present → env wins; the doctor reports `source_kind: 'env'` and the file value is *not* used by the runtime. (b) env-var absent + file present → file wins; daemon `loadUserSecretsIntoEnv` populates `CURSOR_API_KEY` and the run starts; doctor reports `source_kind: 'file'`. (c) both absent → backend stays `auth_unknown`; the runtime emits the **existing** failure shape unchanged: `code: 'SPAWN_FAILED'`, `details: { binary: '@cursor/sdk', auth_env: 'CURSOR_API_KEY', category: 'auth', retryable: false, install_hint: ... }` (per `src/backend/cursor/runtime.ts:104`). This plan does **not** change that failure shape; T8 only asserts it is preserved. (Plan-review finding #3, 2026-05-04: the earlier draft mis-cited `WORKER_BINARY_MISSING`, which is what the SDK-not-installed path returns, not the missing-auth path.) |
| T9 | Docs | T4, T5, T6 | pending | New `docs/development/auth-setup.md` with the flows, format, permissions, warnings, and precedence. README links to it from the prerequisites section. `docs/development/cursor-backend.md` updates the `CURSOR_API_KEY` section to point at the auth-setup doc. `docs/development/mcp-tooling.md` adds a one-line note that `mcp-secrets.env` is repo-dev-only and not loaded by the daemon. |
| T10 | Release-quality verification | all | pending | `pnpm build`, `pnpm test`, `pnpm verify` all run; record their outputs. Note any pre-existing audit/upstream issue (e.g. `@cursor/sdk` advisories noted in plan #16) without bypassing it. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| RC1 | "User-level secrets must live under `~/.config/agent-orchestrator/` and never under the run store or repo. Daemon worker auth uses `secrets.env`; repo-dev MCP tooling uses `mcp-secrets.env`." | repo-wide | T6 lands. |
| RC2 | "Secrets-bearing file writes use `0o600` + atomic tmp+rename, and reads refuse permissive modes on POSIX." | repo-wide | T1 lands. |

## Quality Gates

- [ ] `pnpm build` passes (evidence captured).
- [ ] `pnpm test` passes (evidence captured).
- [ ] `pnpm verify` invoked; any audit/publish failures attributed and
  not silently bypassed.
- [ ] No new runtime dependency added.
- [ ] No MCP contract field renamed/removed. `BackendDiagnostic.auth`
  gains only optional additive fields (`source_kind`, `source_path`)
  per D5; `contract.test.ts` asserts existing payloads still parse and
  the new fields parse when present.
- [ ] `.agents/rules/node-typescript.md` and
  `.agents/rules/mcp-tool-configs.md` checks satisfied (no committed
  secrets, no new package manager, Node 22+ compatible).

## Future Options

- Live SDK probe via `--check-live` (`Cursor.me()`-style) once the SDK
  is reliably available locally.
- IPC method to reload secrets without restart (requires careful
  handling of in-flight runs).
- System keychain integration (macOS Keychain, libsecret, Windows DPAPI)
  for at-rest encryption.
- Wire `auth claude` / `auth codex` once we have a definitive answer
  for whether storing those vendors' API keys here is desirable vs
  using their own CLI auth flows.
- `auth rotate <provider>` convenience that combines `unset` + new
  prompt in one command.

## Execution Log

### T1: Add user-secrets loader/saver module
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T2: Add provider auth registry
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T3: Add interactive masked prompt helper
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T4: Add `auth` CLI dispatcher
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T5: Wire `auth` into `cli.ts` and `daemonCli.ts`
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T6: Daemon-side secrets load on startup
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T7: Doctor formatter source identification
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T8: Precedence + missing-key tests
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T9: Docs
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T10: Release-quality verification
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending
