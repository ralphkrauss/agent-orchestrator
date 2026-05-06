# Claude Multi-Account Support

Lets a single orchestrator instance drive Claude Code runs against any of
several Pro/Max plans or `ANTHROPIC_API_KEY`-style credentials, and rotate to
the next healthy account when the active one trips a rate-limit or quota
signal. `BackendSchema` stays `['codex', 'claude', 'cursor']` — multi-account
is layered onto the existing `claude` backend.

## Account model

Each registered account is one of:

- **`config_dir`** — a daemon-owned `CLAUDE_CONFIG_DIR` rooted at
  `<run_store>/claude/accounts/<name>/`. Holds whatever auth state Claude
  Code itself manages (Pro/Max OAuth login, etc.). The daemon never reads or
  modifies the contents of this directory beyond pointing the spawned
  `claude` child process at it.
- **`api_env`** — a single `ANTHROPIC_API_KEY` value stored under a
  deterministic slug-and-hash key (e.g. `ANTHROPIC_API_KEY__work__7K3F2QXA`)
  in the daemon's user-secrets file (`~/.config/agent-orchestrator/secrets.env`
  by default). The registry stores only the key reference; the raw secret
  value is never written to the registry.

The registry lives at `<run_store>/claude/accounts.json` and tracks
`{ name, mode, config_dir_path?, secret_key?, registered_at,
last_error_category?, cooldown_until_ms? }` plus a top-level `version: 1`.
Concurrent writes are serialised by a per-file lock; a corrupt JSON file is
recovered to an empty registry with a warning.

## Registering accounts

```bash
# Pro/Max plan — fresh account (interactive OAuth in your TTY).
# The daemon-owned CLAUDE_CONFIG_DIR is empty, so Claude's first-run setup
# (theme → security notice → login) handles the OAuth flow exactly once.
# Type /exit (or Ctrl-D) when login completes to finish registering the account.
agent-orchestrator auth login claude --account work

# Re-authenticate an already-registered account against the SAME config_dir.
# The dir is already configured, so we explicitly drive `claude /login` here —
# Claude's first-run setup will not run a second time.
agent-orchestrator auth login claude --account work --refresh

# ANTHROPIC_API_KEY (interactive prompt by default; --from-env / --from-stdin in scripts):
agent-orchestrator auth set claude --account alt-key
agent-orchestrator auth set claude --account alt-key --from-env ANTHROPIC_API_KEY
echo -n "$KEY" | agent-orchestrator auth set claude --account alt-key --from-stdin
```

`--api-key sk-...` and other value-bearing secret flags are rejected — the
secret would otherwise leak into shell history and process listings. This
mirrors the existing cursor provider precedent.

The fresh-vs-`--refresh` distinction matters: launching `claude /login`
against a brand-new `CLAUDE_CONFIG_DIR` would make the user authenticate
twice (once during the first-run setup, again when the explicit `/login`
slash command fires). The fresh path therefore launches `claude` with no
arguments and lets the first-run flow drive the single login; `--refresh`
keeps the explicit `/login` because the dir is already past first-run
setup.

```bash
# List registered accounts (defaults to human-readable; pass --json for full data):
agent-orchestrator auth list claude
agent-orchestrator auth list claude --json

# Remove the registry entry. config_dir state is preserved on disk by default
# so you can recover the Claude session DB after a mistake; pass
# --delete-config-dir to also recursively delete the daemon-owned dir.
agent-orchestrator auth remove claude --account work
agent-orchestrator auth remove claude --account work --delete-config-dir
```

## Worker profile shape

```jsonc
{
  "version": 1,
  "profiles": {
    "ratelimit-resilient": {
      "backend": "claude",
      "model": "claude-opus-4-7",
      "claude_account": "work",
      "claude_account_priority": ["work", "alt-key", "team"],
      "claude_cooldown_seconds": 900
    },
    "single-account": {
      "backend": "claude",
      "model": "claude-opus-4-7",
      "claude_account": "work"
    }
  }
}
```

- `claude_account` (optional): default account used by runs that resolve this
  profile.
- `claude_account_priority` (optional): rotation list. When set, the
  orchestrator picks the first non-cooled-down account at `start_run` time
  and rotates to the next on `send_followup` if the parent terminated with
  `latest_error.category` in `{rate_limit, quota}`. `claude_account` (when
  also set) must be a member of the priority list.
- `claude_cooldown_seconds` (optional, positive integer ≤ 86400 / 24h):
  per-profile cooldown TTL. Defaults to 900 (15m).

The same fields are accepted on `start_run` directly under
`claude_account` / `claude_accounts` (the priority array). Direct values
cannot be mixed with `profile` mode.

## Rotation behaviour

- Rotation is **opt-in**: a profile or `start_run` without a priority array
  behaves like the existing `claude` backend — terminal errors are durable,
  no rotation happens.
- When rotation fires, the orchestrator marks the prior account cooled-down
  with the configured TTL and picks the next healthy account from the frozen
  priority array. The spawn shape depends on the source/target account modes
  (table below).
- **Default behaviour for two `config_dir` accounts**: copy-on-rotate
  cross-account resume. The daemon copies the parent run's session JSONL
  from `<run_store>/claude/accounts/<old>/projects/<encoded-cwd>/<sid>.jsonl`
  to `<run_store>/claude/accounts/<new>/projects/<encoded-cwd>/<sid>.jsonl`
  (atomic `copyFile` → `chmod 0o600` → `rename`), then calls
  `runtime.resume(<sid>)` under the new account so the user sees an actual
  conversation continuation instead of a fresh chat. The rotated child
  carries `terminal_context.kind === "resumed_after_rotation"` plus
  `{ resumed_session_id, source_path, target_path, copied_bytes,
  copy_duration_ms, prior_account, new_account, parent_error_category,
  parent_run_id, collision_resolution? }`. The history entry's `resumed`
  flag is `true`.
- **Fallback to fresh-chat** with `terminal_context.kind ===
  "fresh_chat_after_rotation"` and a structured `copy_skip_reason` covers
  every other rotation path:

  | `copy_skip_reason` | When |
  |---|---|
  | `api_env_in_rotation_path` | Source OR target account is `api_env` mode (no `CLAUDE_CONFIG_DIR`, so the JSONL would be invisible). |
  | `no_observed_session_id` | Parent terminated before producing a session id. |
  | `source_missing` | JSONL not present at the expected path under the old account. |
  | `source_disappeared_during_copy` | `ENOENT` mid-copy. |
  | `source_not_regular_file` | `lstat` showed a symlink, FIFO, device, or socket. |
  | `unsafe_session_id` / `unsafe_account_name` | Input failed regex validation. |
  | `path_escape` | `realpath` + `path.relative` containment check refused the source or target path. |
  | `copy_failed` | `EACCES` / `ENOSPC` / other `fs.copyFile` failure (`details.code`). |
  | `session_jsonl_collision` | A → B → A and B's body diverges from A's; the daemon refuses to overwrite A's audit trail. |
  | `retry_invocation_unavailable` | `WORKER_BINARY_MISSING` while pre-baking the start-shape retry invocation (essentially impossible in practice). |

- **Transparent in-run retry on `session_not_found`**: when the resume
  attempt is rejected EARLY by Claude (within `min(50 events, 5 seconds)`
  of spawn) with a stream-classified `session_not_found` error, the daemon
  intercepts at the `ProcessManager` layer: kills the resume worker,
  appends one `lifecycle / session_not_found_in_run_retry` event to the
  child's `events.jsonl`, and re-spawns with `runtime.start()` against the
  same newly-bound account. The child terminates with
  `terminal_context.kind === "fresh_chat_after_rotation"` plus
  `resume_attempted: true` and `resume_failure_reason: "session_not_found"`.
  `claude_rotation_history[i].resumed` stays `true` (per BI-COR6: "resume
  was attempted in this rotation step"). This is **single-shot** — the
  retry worker has no interceptor; if it also fails, the child terminates
  with that error normally. **Late** `session_not_found` (after the
  threshold) is NOT retried; the child terminates with
  `latest_error.category === "session_not_found"` and `kind` stays
  `"resumed_after_rotation"`. **Other** post-spawn resume failures (auth,
  rate_limit, quota, protocol, backend_unavailable, process_exit, …)
  terminate the child with their original category; the supervisor's next
  `send_followup` re-evaluates rotation.
- **Same-parent rotation race**: concurrent `send_followup` calls off the
  same parent are serialized by a per-parent rotation lock and a
  claimed-destinations set, so the second caller picks the next priority
  candidate (NOT the same destination as the first). Priority exhaustion
  surfaces as `INVALID_STATE` with `details.reason ===
  "priority_exhausted_for_parent"` and
  `details: { claimed, cooled_down, priority }`. The claimed set is
  reconstructed from `RunStore` on daemon restart, so durability holds
  across crashes.
- All accounts in the priority list being cooled-down (and not yet
  claimed) produces an `INVALID_STATE` error with `details.cooldown_summary`
  so the supervisor can surface the situation.
- A direct single-account `start_run` (no priority array) ignores the
  cooldown registry — the user is explicitly asking for that account.

### Rotation shape by source/target mode

| prior mode | new mode | Spawn shape | `terminal_context.kind` |
|---|---|---|---|
| `config_dir` | `config_dir` | `runtime.resume(<sid>)` (copy-on-rotate) | `"resumed_after_rotation"` (or `"fresh_chat_after_rotation"` on copy failure) |
| `config_dir` | `api_env` | `runtime.start()` | `"fresh_chat_after_rotation"` (`api_env_in_rotation_path`) |
| `api_env` | `config_dir` | `runtime.start()` | `"fresh_chat_after_rotation"` (`api_env_in_rotation_path`) |
| `api_env` | `api_env` | `runtime.start()` | `"fresh_chat_after_rotation"` (`api_env_in_rotation_path`) |

`metadata.claude_rotation_history[i].resumed` is `true` only on the
first row when the daemon actually selected and spawned
`runtime.resume()`.

### Rotation history shape

`metadata.claude_rotation_history` is capped at 32 entries; the 33rd
write drops the oldest with a `{ truncated_count }` marker. Each
non-marker entry has the shape:

```json
{
  "parent_run_id": "...",
  "prior_account": "work",
  "new_account": "alt",
  "parent_error_category": "rate_limit",
  "rotated_at": "2026-05-06T...Z",
  "resumed": true
}
```

The `resumed` field is optional / absent on legacy entries written
before this slice landed.

## Env scrubbing (security boundary)

Account-bound spawns scrub the daemon-inherited env BEFORE merging account
specifics. The deny list is fixed at the verified deep-dive list and is
**not** configurable via worker profile fields in v1; any later change goes
through HAT1 approval.

Must-scrub explicit keys:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_MODEL`
- `CLAUDE_CONFIG_DIR`
- `CLAUDECODE`

Should-also-scrub globs:

- `ANTHROPIC_*`
- `*_API_KEY`
- `*_AUTH_TOKEN`
- `*_ACCESS_TOKEN`
- `*_SECRET_KEY`
- `*_BEARER_TOKEN`
- `*_SESSION_TOKEN`

Unbound `backend: "claude"` runs (no `claude_account` field) inherit the
daemon env unchanged. This preserves single-account behaviour for users
who have not migrated to the registry.

A registered `api_env` account whose secret is missing fails `start_run` /
`send_followup` with `INVALID_STATE` (`reason: "missing_account_secret"`).
The daemon does **not** silently fall back to the ambient
`ANTHROPIC_API_KEY` — that fallback applies only to unbound `backend:
"claude"` runs.

## Diagnostics

`agent-orchestrator doctor` surfaces account info via the existing `claude`
backend's `checks[]` and `hints[]` arrays:

- One `checks[]` entry per registered account, capped at 16 in human output.
- An aggregate `hints[]` line lists the overflow when more than 16 accounts
  are registered; `auth list claude --json` always returns the full list.
- A "no accounts registered" hint appears when the registry is empty,
  pointing at `auth login claude --account <name>`.
- Accounts with status `incomplete` (api_env: secret missing; config_dir:
  directory missing) are surfaced with an explanatory message.

## Troubleshooting

- **"all claude accounts in the priority list are currently cooled-down":**
  every account in the priority array has an active cooldown. Inspect with
  `auth list claude --json` to see TTL expiries; either wait, register
  another account, or remove a cooled-down entry and re-register once the
  upstream limit clears.
- **"missing_account_secret" on an `api_env` account:** the registry
  references a `userSecrets` key that has no value. Re-run
  `auth set claude --account <name> --from-env <VAR>` (or the interactive
  prompt) to repopulate.
- **Spawned `claude` exits non-zero during `auth login claude`:** the OAuth
  flow failed (or the user closed the session before it completed); the
  registry entry is not created. Inspect any output from the spawned
  `claude` process and try again. On a fresh dir the spawn is `claude` with
  no args (first-run setup drives login); on `--refresh` the spawn is
  `claude /login` against the existing dir.
- **Deleted account directory by hand:** `auth remove claude --account
  <name>` cleans up the registry entry; re-running `auth login claude
  --account <name>` (without `--refresh`) is the supported way to start
  fresh.

## Future options (not in v1)

- Mid-run pre-emptive rotation (HAT4).
- `api_env` accounts with structured Anthropic env maps
  (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, …) for proxy / Bedrock
  setups.
- Configurable env-scrub deny list per profile (HAT1).
