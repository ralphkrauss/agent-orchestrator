# Changelog

## Unreleased — BREAKING: codex profiles now default to closed network egress

> Issue #31. Decisions OD1 = B and OD2 = B locked on 2026-05-05.

### BREAKING (codex)

The codex backend's network egress posture is now controlled by an explicit
`codex_network` profile field (`isolated`, `workspace`, `user-config`) rather
than as a side effect of `service_tier`. **Every codex profile that does not
set `codex_network` resolves to `'isolated'` on upgrade**, regardless of
`service_tier`. Profiles that previously honored `~/.codex/config.toml` for
network access via `service_tier ∈ {'fast','flex',unset}` will lose that
access until they migrate.

#### Behavior change summary

| Existing codex profile shape                        | Today's argv                      | Argv after upgrade with no manifest change       | Required action                                                                        |
|-----------------------------------------------------|-----------------------------------|--------------------------------------------------|----------------------------------------------------------------------------------------|
| `service_tier: 'normal'`                            | includes `--ignore-user-config`   | includes `--ignore-user-config`                  | None — same posture.                                                                   |
| `service_tier: 'fast'`                              | no `--ignore-user-config`         | **includes `--ignore-user-config`**              | Set `codex_network` explicitly (see migration options).                                |
| `service_tier: 'flex'`                              | no `--ignore-user-config`         | **includes `--ignore-user-config`**              | Same as above.                                                                         |
| `service_tier` unset                                | no `--ignore-user-config`         | **includes `--ignore-user-config`**              | Same as above.                                                                         |
| `codex_network` set explicitly                      | per docs/development/codex-backend.md | per docs/development/codex-backend.md         | None — explicit value wins.                                                            |

#### Three migration options

In increasing security cost:

1. **Restore today's behavior verbatim** (closest to a no-op):

   ```jsonc
   {
     "version": 1,
     "profiles": {
       "<your-profile>": {
         "backend": "codex",
         "model": "gpt-5.5",
         "codex_network": "user-config"
       }
     }
   }
   ```

2. **Use codex's own network override** (network on, deterministic across
   machines):

   ```jsonc
   {
     "version": 1,
     "profiles": {
       "<your-profile>": {
         "backend": "codex",
         "model": "gpt-5.5",
         "codex_network": "workspace"
       }
     }
   }
   ```

3. **Adopt the new closed-by-default posture** (recommended for
   review-only and implementation profiles that do not need outbound HTTP):

   ```jsonc
   {
     "version": 1,
     "profiles": {
       "<your-profile>": {
         "backend": "codex",
         "model": "gpt-5.5",
         "codex_network": "isolated"
       }
     }
   }
   ```

For workflows that need PR or external data, prefer the supervisor pre-fetch
pattern documented in `orchestrate-resolve-pr-comments`: the supervisor calls
`gh api ...` itself and writes the JSON to a temp file the worker reads from
disk, so the worker never needs outbound HTTP.

#### Per-run warning copy

When a codex worker run starts and `codex_network` was not set explicitly on
the profile or on the direct-mode `start_run` argument, the daemon emits a
single non-blocking lifecycle event into the run's event log:

```
agent-orchestrator codex_network not set on <profile or direct-mode run>; defaulting to 'isolated' (no network access). Set codex_network explicitly to silence this warning. See docs/development/codex-backend.md for migration.
```

The warning is a `lifecycle` event with payload
`state: 'codex_network_defaulted'`. Use `get_run_events` to read the full
warning text on the event payload (`get_run_progress` only surfaces the
compact lifecycle marker, not the full message).

#### Where to read more

- `docs/development/codex-backend.md` — full migration table, argv mapping,
  per-run warning, recommended patterns, and the manual smoke procedure
  (T6).
- README MCP tool tables — `start_run`, `send_followup`, and
  `upsert_worker_profile` advertise the new optional `codex_network`
  argument.

#### Manual smoke evidence

Manual smoke procedure for `codex_network: 'workspace'` is documented in
`docs/development/codex-backend.md` ("Manual Smoke Procedure (T6)"). The
smoke runs a real `codex exec` against `gh api /zen` and confirms the
returned zen sentence and the literal
`-c sandbox_workspace_write.network_access=true` argv. It is intentionally
**not** part of `pnpm verify` or CI: codex CLI is not available in CI and
the `gh api /zen` smoke needs the human's `gh auth` state.

### Internal changes

- `RunModelSettings` gains an optional `codex_network` field. Legacy run
  records load with `codex_network: null` (schema default).
- `WorkerProfileSchema` accepts `codex_network` only on codex profiles;
  claude / cursor profiles that set it are rejected with a clear validation
  error.
- The codex `WorkerBackendCapability` advertises
  `network_modes: ['isolated','workspace','user-config']` so MCP clients can
  render selectors. Other backends advertise an empty `network_modes` list
  (no schema break for clients that already iterate `settings`).
- Supervisor system-prompt formatters in both the OpenCode and Claude
  harnesses now render `codex_network=<value>` for codex profiles (and
  `codex_network=isolated (default)` for codex profiles that do not set it),
  plus `network_modes=...` in the catalog for the codex backend.
- Observability: `uniqueSettings` aggregation key includes `codex_network`,
  so two runs differing only by `codex_network` no longer collide into a
  single dedup row.
- `start_run` / `send_followup`: `codex_network` is direct-mode-only
  (OD2 = B). The schema-side `superRefine` rejects `profile + codex_network`
  with `INVALID_INPUT`, mirroring the existing carve-out for `model` /
  `reasoning_effort` / `service_tier`.
