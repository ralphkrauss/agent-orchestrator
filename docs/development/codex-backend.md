# Codex Worker Backend

The codex backend dispatches `codex exec` worker runs through the
agent-orchestrator daemon. This document covers the codex argv assembled by the
daemon, the `codex_network` profile field that controls codex sandbox / network
egress posture, and the migration path for the breaking change introduced by
issue #31.

## Argv Assembled By The Daemon

For a normal codex worker `start_run`, the daemon spawns approximately:

```
codex exec --json --skip-git-repo-check [<sandbox-args>] --cd <cwd> [--model <model>] [-c model_reasoning_effort="<effort>"] [-c service_tier="<tier>"] -
```

For a `send_followup` resume:

```
codex exec resume --json --skip-git-repo-check [<sandbox-args>] [--model <model>] [-c model_reasoning_effort="<effort>"] [-c service_tier="<tier>"] <session-id> -
```

The `<sandbox-args>` segment is driven entirely by `codex_network`, see below.

`service_tier="normal"` is suppressed in the argv because it is the codex CLI
default. `service_tier="fast"` and `service_tier="flex"` are passed through
verbatim. `model` is passed through as provided; codex validates only that the
value is a non-empty string.

## codex_network Profile Field

### What it does

`codex_network` is a codex-only profile field with three values. Each value
maps to a specific argv shape that controls whether codex reads
`$CODEX_HOME/config.toml` and whether bash-tool network egress inside the
worker sandbox is allowed.

| `codex_network`  | Argv added to `codex exec`                                               | Effect                                                                                                                                             |
|------------------|--------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| `isolated`       | `--ignore-user-config`                                                   | Codex skips `$CODEX_HOME/config.toml`; bash sandbox network is closed by codex defaults. Deterministic across machines.                            |
| `workspace`      | `--ignore-user-config -c sandbox_workspace_write.network_access=true`    | Codex skips `$CODEX_HOME/config.toml`; bash sandbox network is granted via the explicit codex CLI override. Deterministic across machines.         |
| `user-config`    | (no flags added)                                                         | Codex reads `$CODEX_HOME/config.toml` verbatim and honors whatever sandbox / network policy lives there. Per-machine; can be non-deterministic.    |

> Per `codex exec --help` on codex-cli 0.128.0, `--ignore-user-config`
> "skips `$CODEX_HOME/config.toml`". This is the precise effect — the wording
> in this doc matches the codex CLI's own help text to avoid drift.

### Default

When a codex profile (or a direct-mode `start_run`) does **not** set
`codex_network`, the daemon resolves it to `'isolated'`. This default is
**uniform for every codex profile**, regardless of `service_tier`.

### Where to set it

- **Profile manifest** (recommended): set `codex_network` on a codex profile
  in `~/.config/agent-orchestrator/profiles.json`. The profile applies to every
  worker run dispatched against that alias.
- **Direct-mode `start_run` / `send_followup`**: pass `codex_network` directly
  for one-off overrides (issue #31 OD2 = B). Profile-mode runs reject the
  argument; the schema-side `superRefine` returns `INVALID_INPUT` so a
  supervisor that mixes them sees the error early.

### Example profile snippets

```jsonc
{
  "version": 1,
  "profiles": {
    "implementer": {
      "backend": "codex",
      "model": "gpt-5.5",
      "reasoning_effort": "high",
      "codex_network": "isolated"
    },
    "pr-comment-reviewer": {
      "backend": "codex",
      "model": "gpt-5.5",
      "reasoning_effort": "xhigh",
      "service_tier": "normal",
      "codex_network": "workspace",
      "description": "Reviews PR comments; needs gh api access"
    },
    "legacy-network-trust": {
      "backend": "codex",
      "model": "gpt-5.5",
      "codex_network": "user-config",
      "description": "Honors ~/.codex/config.toml for network policy"
    }
  }
}
```

## Per-Run Warning

When a codex worker run starts and `codex_network` was not set explicitly on
the profile or on the direct-mode `start_run` argument, the daemon emits a
single non-blocking lifecycle event into the run's event log:

```
agent-orchestrator codex_network not set on <profile or direct-mode run>; defaulting to 'isolated' (no network access). Set codex_network explicitly to silence this warning. See docs/development/codex-backend.md for migration.
```

The warning never blocks the run. It is per-run (so silencing the warning by
setting `codex_network` on a profile silences it for every subsequent run on
that profile) and it surfaces alongside any failing tool calls so users
hitting the breaking change can correlate.

The warning is emitted as a `lifecycle` event with payload
`state: 'codex_network_defaulted'`. The full warning text lives on the event
payload and is returned by `get_run_events`. `get_run_progress` only
surfaces the lifecycle marker (the compact `lifecycle: codex_network_defaulted`
summary), so to read the full warning copy use `get_run_events` (or filter the
event log directly).

## Migration: BREAKING (codex)

> **Affected releases:** the locked OD1 = B decision in issue #31 (2026-05-05)
> changes the codex backend's default network egress posture from
> "honor `~/.codex/config.toml`" to `'isolated'` for every codex profile that
> does not set `codex_network` explicitly.

### Who is affected

A codex profile that:

1. Has `backend: 'codex'`, **and**
2. Has `service_tier` set to `'fast'` or `'flex'`, **or** has no
   `service_tier` set, **and**
3. Relies on `~/.codex/config.toml` for network access (the most common shape
   today is `[sandbox_workspace_write]\nnetwork_access = true`), **and**
4. Does not yet set `codex_network`.

After upgrade, that profile passes `--ignore-user-config` to `codex exec`, so
codex stops reading `~/.codex/config.toml`, so the user's network allowlist is
no longer applied, so bash tools inside the worker that rely on outbound HTTP
(`gh api`, `curl`, `npm install` from a private registry, etc.) will fail.

### Migration table

| Existing profile shape                              | Today's argv                      | Argv after upgrade with no manifest change | Required action                                                                                                |
|-----------------------------------------------------|-----------------------------------|--------------------------------------------|----------------------------------------------------------------------------------------------------------------|
| `service_tier: 'normal'`                            | includes `--ignore-user-config`   | includes `--ignore-user-config`            | **None — same posture.** Pre-fetch external data in the supervisor when needed.                                |
| `service_tier: 'fast'`                              | no `--ignore-user-config`         | **includes `--ignore-user-config`**        | Set `codex_network: 'user-config'` to restore prior behavior, or `'workspace'` for codex-managed network-on.   |
| `service_tier: 'flex'`                              | no `--ignore-user-config`         | **includes `--ignore-user-config`**        | Same as above.                                                                                                  |
| `service_tier` unset                                | no `--ignore-user-config`         | **includes `--ignore-user-config`**        | Same as above.                                                                                                  |
| `codex_network` set explicitly                      | per C3 mapping                    | per C3 mapping                             | None — explicit value wins over the default.                                                                   |

### Three concrete migration options

In increasing security cost:

1. **`codex_network: 'user-config'`** — keep today's behavior verbatim. Codex
   continues to read `~/.codex/config.toml`. This is the closest to a no-op
   migration and is the recommended default for users who relied on the legacy
   posture.
2. **`codex_network: 'workspace'`** — use the codex CLI's own network
   override. Network is on; sandbox is deterministic across machines.
3. **`codex_network: 'isolated'`** (the new default) — keep network closed.
   Recommended for review-only or implementation profiles that do not need
   outbound HTTP. Combine with the supervisor-side pre-fetch pattern (see
   `orchestrate-resolve-pr-comments`) for skills that need to fetch external
   data.

### Why this changed

Previously, codex network egress was an unintended side effect of
`service_tier: 'normal'`: the daemon mapped that to an internal `mode='normal'`
flag, which then triggered `--ignore-user-config`. Profiles with `service_tier`
set to anything else (or unset) silently honored `~/.codex/config.toml`. Users
who only knew about `service_tier` could not predict whether their codex
config was being applied. Decoupling network egress from speed-tier and making
the posture explicit (and uniform) closes that foot-gun.

## Recommended Patterns

### Pre-fetch external data in the supervisor

Where possible, fetch external data (PR comments, issue bodies, public APIs)
from the supervisor process and pass the resulting JSON to the worker via
prompt or a temp file under the worker's `cwd`. The worker then reads from
disk and never needs outbound HTTP. This works regardless of backend.

`orchestrate-resolve-pr-comments` documents this as the recommended default.

### Use codex_network: 'workspace' on review-only profiles

If a worker truly needs outbound HTTP (for example a PR-comment reviewer that
must call `gh api` itself), set `codex_network: 'workspace'` on a *narrow*,
review-only profile. Do not grant `'workspace'` to a general-purpose
implementation profile, because the same profile may also run untrusted
implementation tasks that should not have network egress.

### codex_network: 'user-config' is the escape hatch

Use `codex_network: 'user-config'` only when you have an existing
`$CODEX_HOME/config.toml` that you intentionally want the worker to honor.
Bug reports should reproduce on `'isolated'` first; non-determinism in
`'user-config'` mode is per-machine.

## Manual Smoke Procedure (T6)

Run before merging a release that touches the codex argv builder. **Not part
of `pnpm verify` or CI**: the codex CLI is not available in CI and the
`gh api /zen` smoke needs the human's `gh auth` state.

1. Ensure `codex --version` reports the version under release (`>= 0.128.0`).
2. Start the local daemon: `agent-orchestrator start` (or use the harness).
3. Start a direct-mode worker run with `codex_network: 'workspace'`:
   ```
   start_run({
     backend: 'codex',
     prompt: 'Run `gh api /zen` and report the response verbatim.',
     cwd: '/tmp/codex-network-smoke',
     model: 'gpt-5.5',
     codex_network: 'workspace'
   })
   ```
4. Wait for the run to complete and confirm:
   - exit code is 0;
   - the run's tool-use events show `gh api /zen` returning a zen sentence;
   - the recorded `worker_invocation.args` contains both `--ignore-user-config`
     and the literal `-c sandbox_workspace_write.network_access=true`.
5. If the smoke fails on the version under release, mark `'workspace'` as
   `experimental: true` in the codex capability advertised by
   `createWorkerCapabilityCatalog` and document under "Future Options".

Record the codex version, the exact argv, the prompt, and the worker's stdout /
exit in the relevant plan's Execution Log entry for T6.

> Use `gh api /zen` (no host prefix). `gh api` resolves bare paths against the
> configured GitHub host; passing `api.github.com/zen` as a bare URL is parsed
> oddly by `gh api`.

## See Also

- `docs/development/cursor-backend.md` — the Cursor SDK backend.
- `docs/development/auth-setup.md` — credential resolution for worker
  backends.
- `README.md` — MCP tool tables that advertise `codex_network` on
  `start_run`, `send_followup`, `upsert_worker_profile`.
- Issue #31 — the locked OD1 = B / OD2 = B decisions and full plan history.
