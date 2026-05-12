# Codex Worker Backend

The codex backend dispatches `codex exec` worker runs through the
agent-orchestrator daemon. This document covers the codex argv assembled by the
daemon, the `codex_network` profile field that controls codex sandbox / network
egress posture, and the migration path for the breaking change introduced by
issue #31.

## Argv Assembled By The Daemon

For a normal codex worker `start_run`, the daemon spawns approximately:

```text
codex exec --json --skip-git-repo-check [<sandbox-args>] --cd <cwd> [--model <model>] [-c model_reasoning_effort="<effort>"] [-c service_tier="<tier>"] -
```

For a `send_followup` resume:

```text
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
worker sandbox is allowed. **The exact argv depends on `worker_posture`**
(issue #58); the table below has one row per posture × value.

Under `worker_posture: 'trusted'` (the default since issue #58):

| `codex_network`  | Argv added to `codex exec` (and `codex exec resume`)             | Persisted `model_settings.codex_network` | Effect                                                                                                                                  |
|------------------|------------------------------------------------------------------|------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| absent / unset   | `-c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true` | `null` (intentionally — distinguishes the trusted-default from explicit `'isolated'`) | Workspace-write sandbox with network on. Codex loads user + project `config.toml`. Matches a manual `codex exec` from the project. |
| `isolated`       | (no sandbox flags)                                               | `'isolated'` | Codex defaults apply. Codex still loads user + project `config.toml`.                                                                  |
| `workspace`      | `-c sandbox_workspace_write.network_access=true`                 | `'workspace'` | Workspace-write network enabled. Codex loads user + project `config.toml`. **No `--ignore-user-config`** — see migration note below.   |
| `user-config`    | (no flags)                                                       | `'user-config'` | Codex defaults apply. Codex reads user + project `config.toml`.                                                                        |

Under `worker_posture: 'restricted'` (issue #31 v1 envelope; profile opt-in):

| `codex_network`  | Argv added to `codex exec`                                               | Effect                                                                                                                                             |
|------------------|--------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| `isolated`       | `--ignore-user-config`                                                   | Codex skips `$CODEX_HOME/config.toml`; bash sandbox network is closed by codex defaults. Deterministic across machines.                            |
| `workspace`      | `--ignore-user-config -c sandbox_workspace_write.network_access=true`    | Codex skips `$CODEX_HOME/config.toml`; bash sandbox network is granted via the explicit codex CLI override. Deterministic across machines.         |
| `user-config`    | (no flags added)                                                         | Codex reads `$CODEX_HOME/config.toml` verbatim and honors whatever sandbox / network policy lives there. Per-machine; can be non-deterministic.    |

> Per `codex exec --help` on codex-cli 0.130.0, `--ignore-user-config`
> "skips `$CODEX_HOME/config.toml`". The trusted-posture argv uses
> `-c sandbox_mode="workspace-write"` (not `--sandbox`) because
> `codex exec resume --help` does not accept `--sandbox`; the daemon's shared
> `sandboxArgs()` helper produces argv accepted by both `codex exec` and
> `codex exec resume`.

> **Migration (issue #58):** existing profiles with explicit
> `codex_network: 'workspace'` no longer emit `--ignore-user-config` under
> the new `trusted` default. If you depended on the side effect of skipping
> `$CODEX_HOME/config.toml`, set `worker_posture: 'restricted'` on the
> profile to preserve the pre-#58 argv.

### Default

When a codex profile (or a direct-mode `start_run`) does **not** set
`codex_network`, the daemon's resolution depends on `worker_posture`
(issue #58):

- **`worker_posture: 'trusted'` (the default since #58)** — the run record
  persists `codex_network: null` and the worker spawns with
  `-c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true`.
  No `--ignore-user-config`; user + project `config.toml` load normally.
  This null value is intentional and distinct from explicit `'isolated'`
  (which would emit no sandbox flags at all).
- **`worker_posture: 'restricted'` (opt-in)** — the daemon resolves to
  `'isolated'`, matching the pre-#58 OD1=B uniform default. Used by callers
  that want the closed-by-default envelope.

### Where to set it

- **Profile manifest** (recommended): set `codex_network` on a codex profile
  in `~/.config/agent-orchestrator/profiles.json`. The profile applies to every
  worker run dispatched against that alias.
- **Direct-mode `start_run` / `send_followup`**: pass `codex_network` directly
  for one-off overrides (issue #31 OD2 = B). Profile-mode runs reject the
  argument and return `INVALID_INPUT`. For `start_run` the rejection fires at
  schema parse time via `StartRunInputSchema.superRefine`. For `send_followup`
  the rejection fires at runtime in the orchestrator service after walking the
  run chain to locate the originating start (a profile-mode root cannot be
  bypassed by chained direct-mode follow-ups).

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
      "description": "Honors $CODEX_HOME/config.toml for network policy"
    }
  }
}
```

## Per-Run Warning

When a `worker_posture: 'restricted'` codex worker run starts and
`codex_network` was not set explicitly on the profile or on the direct-mode
`start_run` argument, the daemon emits a single non-blocking lifecycle event
into the run's event log:

```text
agent-orchestrator codex_network not set on <profile or direct-mode run> (worker_posture=restricted); defaulting to 'isolated' (no network access, --ignore-user-config). Set codex_network explicitly to silence this warning, or move the profile to worker_posture: 'trusted' to opt into backend-native parity. See docs/development/codex-backend.md for migration.
```

Issue #58 review follow-up: under the default `worker_posture: 'trusted'`,
this warning is **suppressed**. The trusted default (workspace-write sandbox
+ network on; `codex_network` persisted as `null`) is the intended product
direction, not a surprise breaking change. The warning still fires for
`worker_posture: 'restricted'` runs that omit `codex_network`, since those
preserve the issue #31 closed-by-default isolated argv.

The warning never blocks the run. It is per-run (so silencing the warning by
setting `codex_network` on a restricted profile silences it for every
subsequent run on that profile) and it surfaces alongside any failing tool
calls so users hitting the breaking change can correlate.

The warning is emitted as a `lifecycle` event with payload
`state: 'codex_network_defaulted'`. The full warning text lives on the event
payload and is returned by `get_run_events`. `get_run_progress` only
surfaces the lifecycle marker (the compact `lifecycle: codex_network_defaulted`
summary), so to read the full warning copy use `get_run_events` (or filter the
event log directly).

## Migration: BREAKING (codex)

> **Affected releases:** two breaking changes affect codex profile defaults.
>
> 1. Issue #31 (locked 2026-05-05): when `worker_posture: 'restricted'` and
>    `codex_network` is omitted, the daemon now resolves to `'isolated'`
>    (instead of "honor `~/.codex/config.toml`"). This is the change documented
>    in the migration table below; it still applies under restricted posture.
> 2. Issue #58 (this release): `worker_posture` now defaults to `'trusted'`,
>    which loads user + project `config.toml` and emits the trusted-default
>    sandbox argv (workspace-write + network on) when `codex_network` is
>    omitted. **Most operators do not need the #31 migration anymore** because
>    the trusted default closely matches the pre-#31 manual-run experience.
>    Set `worker_posture: 'restricted'` explicitly to opt into the #31
>    closed-by-default envelope described below.

### Who is affected (restricted posture, post-#58)

A codex profile that:

1. Has `backend: 'codex'`, **and**
2. Has `worker_posture: 'restricted'` (explicit since #58), **and**
3. Relies on `~/.codex/config.toml` for network access (the most common shape
   today is `[sandbox_workspace_write]\nnetwork_access = true`), **and**
4. Does not yet set `codex_network`.

Under restricted with no `codex_network`, that profile passes
`--ignore-user-config` to `codex exec`, so codex stops reading
`~/.codex/config.toml`, so the user's network allowlist is no longer applied,
so bash tools inside the worker that rely on outbound HTTP (`gh api`, `curl`,
`npm install` from a private registry, etc.) will fail.

Under `worker_posture: 'trusted'` (the default since #58), no `codex_network`
emits the trusted-default sandbox (`-c sandbox_mode="workspace-write" -c
sandbox_workspace_write.network_access=true`) without `--ignore-user-config`,
so user + project `config.toml` and the workspace network are both available.

### Migration table (restricted posture)

| Existing restricted profile shape                   | Today's argv                      | Argv after upgrade with no manifest change | Required action                                                                                                |
|-----------------------------------------------------|-----------------------------------|--------------------------------------------|----------------------------------------------------------------------------------------------------------------|
| `service_tier: 'normal'`                            | includes `--ignore-user-config`   | includes `--ignore-user-config`            | **None — same posture.** Pre-fetch external data in the supervisor when needed.                                |
| `service_tier: 'fast'` / `'flex'` / unset           | no `--ignore-user-config`         | **includes `--ignore-user-config`**        | Set `codex_network: 'user-config'` to restore prior behavior, or `'workspace'` for codex-managed network-on, or move to `worker_posture: 'trusted'` for backend-native parity. |
| `codex_network` set explicitly                      | per restricted mapping            | per restricted mapping                     | None — explicit value wins over the default.                                                                   |

### Three concrete migration options (still restricted posture)

In increasing openness:

1. **`worker_posture: 'trusted'`** (the new default since #58) — workers see
   user + project `config.toml` and the trusted-default sandbox. Closest to a
   manual `codex exec` run. Recommended unless you specifically need the
   closed-by-default envelope.
2. **`codex_network: 'user-config'`** — keep the pre-#31 behavior verbatim
   under restricted. Codex continues to read `~/.codex/config.toml`.
3. **`codex_network: 'workspace'`** — under restricted, this still emits
   `--ignore-user-config` but adds the codex CLI's own network override. Use
   when you want deterministic codex config but workspace-write network on.
4. **`codex_network: 'isolated'`** (the restricted default since #31) — keep
   network closed and user config skipped. Recommended for review-only or
   implementation profiles that do not need outbound HTTP. Combine with the
   supervisor-side pre-fetch pattern (see `orchestrate-resolve-pr-comments`).

### Why this changed

Originally (pre-#31), codex network egress was an unintended side effect of
`service_tier: 'normal'`: the daemon mapped that to an internal `mode='normal'`
flag, which then triggered `--ignore-user-config`. Profiles with `service_tier`
set to anything else (or unset) silently honored `~/.codex/config.toml`. Users
who only knew about `service_tier` could not predict whether their codex
config was being applied. Issue #31 decoupled network egress from speed-tier
and made the posture explicit and uniform under restricted.

Issue #58 then reframed the contract again: workers default to backend-native
parity (`worker_posture: 'trusted'`) with a manual run, and the curated
restricted envelope is opt-in. Most operators no longer need to migrate
because the trusted default matches what they would have gotten manually.

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
   ```ts
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
5. If the smoke fails on the version under release, the only two routine
   paths are:
   1. Diagnose and fix the workspace-write argv assembly in
      `src/backend/codex.ts` so the smoke passes against the version under
      release; or
   2. Escalate to the maintainer for explicit human approval before
      making any capability or contract-shape mitigation.

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
