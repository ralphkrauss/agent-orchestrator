# Daemon Auth Setup

The orchestrator daemon needs provider credentials to launch backend workers.
Today the only worker that pulls auth from a daemon-managed file is **Cursor**
(`CURSOR_API_KEY`). Codex and Claude continue to use their own CLI auth flows
and are surfaced here only so `auth status` can report their effective state.

## Where the file lives

```
~/.config/agent-orchestrator/secrets.env
```

Override the location with the `AGENT_ORCHESTRATOR_SECRETS_FILE` environment
variable (useful for tests and isolated developer setups).

The file is created with mode `0o600` and its parent directory is created with
mode `0o700` on POSIX. The daemon **refuses to load** the file on POSIX if its
mode is group/world-readable (`mode & 0o077 != 0`); fix it with `chmod 600
~/.config/agent-orchestrator/secrets.env`. Permission checks are skipped on
Windows; protect the file via the user-profile ACL instead.

## Format

Standard env-style `KEY=value` lines, with optional `#` comments and blank
lines preserved across edits:

```
# Cursor: https://cursor.com/dashboard
CURSOR_API_KEY=cur_...
```

Values may be quoted with single or double quotes; whitespace inside the
value requires quoting. The file is **not** a shell script — there is no
expansion, sourcing, or interpolation.

## Where it is read

| Process    | Behavior                                                                  |
|------------|---------------------------------------------------------------------------|
| Daemon     | Loaded once at startup (`bootDaemon`) into `process.env`, restricted to **wired-provider env vars only** (currently `CURSOR_API_KEY`). Other keys in the file are parsed but never injected into the daemon environment. Restart to refresh. |
| `doctor`   | Skips the file entirely when `CURSOR_API_KEY` is already set in the env (env wins, the file is irrelevant). When env is unset, reads the file in-process; read failures degrade to a hint instead of crashing. |
| Worker run | Inherits the daemon's `process.env` at spawn — no per-run reload.         |

The wired-provider allowlist exists so a hand-edited `secrets.env` cannot
accidentally inject `NODE_OPTIONS`, proxy vars, or reserved-provider keys
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) into the live daemon.

`auth status` still surfaces a `file_set: true` flag for reserved providers
so the drift is visible — but the row reports `effective_status: "unknown"`
and `effective_source: null` because the daemon will not inject the value
until that provider is wired. Env vars for those providers continue to
count as effective (env precedence is provider-agnostic), since their
respective CLIs read them directly at run-time.

## Precedence

```
process.env > secrets.env > unset
```

Environment variables always win. This preserves CI / advanced-user overrides:
exporting `CURSOR_API_KEY` in the shell that started the daemon (or a service
unit) keeps that value authoritative even when a `secrets.env` entry exists.

## Commands

```bash
# Show effective state (per provider) and daemon status
agent-orchestrator auth status
agent-orchestrator auth status --json

# Save the cursor key (interactive prompt; TTY required)
agent-orchestrator auth cursor

# Save from an env var (default reads provider's primary var, e.g. CURSOR_API_KEY)
agent-orchestrator auth cursor --from-env
agent-orchestrator auth cursor --from-env CUSTOM_VAR

# Save from stdin (single trimmed line)
printf '%s' "$KEY" | agent-orchestrator auth cursor --from-stdin

# Remove a saved provider key (other entries and comments preserved)
agent-orchestrator auth unset cursor
```

After every save / unset the CLI prints a two-line hint: the resolved file
path, and a follow-up indicating whether to `start` (when the daemon is
stopped) or `restart` (when it is running) so the new value takes effect.

The interactive form requires both `stdin` and `stdout` to be a TTY; piped
input is rejected to avoid leaking the secret into shell history or process
listings. Use `--from-env` or `--from-stdin` from scripts.

`claude` and `codex` are listed in `auth status` for parity but are reserved:
running `agent-orchestrator auth claude` or `auth codex` exits with a clear
message pointing at the respective CLI's own auth flow.

## Local checkout

When dogfooding a branch build, use the local CLI wrapper instead of an
installed `agent-orchestrator` binary:

```bash
just local auth cursor
just local restart --force
just local doctor
```

`just local ...` builds `dist/cli.js` and runs it with the branch's isolated
daemon store. To use npm-style command names from the local checkout, run
`eval "$(just local-env)"` in your shell, then use `agent-orchestrator auth ...`
normally.

## Security notes

- **Do not** put real API keys in shell profiles, MCP server config, the
  repo, or any committed file. Use this user-level secrets file or your
  CI / service-manager secret store.
- The file is `0o600` and is never logged, printed, or returned by the
  diagnostic CLI. `auth status` reports presence but not the value.
- A live SDK probe is intentionally not part of validation. The CLI runs
  format-only checks (length / charset / no whitespace) before saving so it
  can refuse obviously malformed pastes without depending on the optional
  `@cursor/sdk` install.

## Refreshing a running daemon

Saving a new value does **not** alter a daemon already running — it has its
own `process.env` snapshot. Run `agent-orchestrator restart` to pick up the
new credentials. In-flight runs are interrupted by the restart, so prefer
quiet windows.

## Relationship to `mcp-secrets.env`

`~/.config/agent-orchestrator/mcp-secrets.env` is a **different** file used
only by the repo-development MCP bridge (`scripts/mcp-secret-bridge.mjs`). It
is **not** loaded by the daemon. The two files coexist; you can populate both
without conflict.
