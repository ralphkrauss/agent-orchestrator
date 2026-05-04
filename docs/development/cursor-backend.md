# Cursor Backend (Local SDK Runtime)

The `cursor` backend runs Cursor agents in-process through the
[`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) TypeScript SDK.
Unlike the `codex` and `claude` backends, the cursor backend does not spawn a
CLI subprocess: it loads the SDK in the daemon Node process and streams typed
events.

## Install

`@cursor/sdk` ships as an **optional dependency**. Default installs include it,
but consumers can omit it:

```bash
pnpm add @cursor/sdk            # explicit add
pnpm install                    # default; SDK present
pnpm install --no-optional      # explicit opt-out (cursor backend will report missing)
```

If the module cannot be resolved (registry restrictions, opt-out installs, or
build failures), the daemon stays online for `codex` and `claude` users; the
`cursor` backend reports `status: "missing"` in `get_backend_status` and any
`start_run` against `cursor` produces a durable failed run with
`OrchestratorErrorCode = "WORKER_BINARY_MISSING"` and an install hint.

## Authenticate

The SDK reads `CURSOR_API_KEY` from the daemon process environment. Two
supported sources, in precedence order:

1. `process.env.CURSOR_API_KEY` (export it in the shell that starts the
   daemon, or in the systemd / launchd unit).
2. `~/.config/agent-orchestrator/secrets.env`, populated via
   `agent-orchestrator auth cursor`. The daemon loads this file at startup
   into its `process.env` without overriding existing values.

```bash
# Either:
export CURSOR_API_KEY=cur_...
# Or:
agent-orchestrator auth cursor      # interactive (TTY)
agent-orchestrator auth cursor --from-env
```

See [`auth-setup.md`](auth-setup.md) for the full auth setup flow, file
format, permission rules, and the per-provider `auth status` reporting.

`get_backend_status` flags missing auth as `auth_unknown` with a hint and
identifies the source as `(CURSOR_API_KEY, env)` or
`(CURSOR_API_KEY, file: <path>)` when set.

## Scope

This release ships the **local runtime only** (`local: { cwd }`). The agent
operates against files on disk in the run's `cwd`. Cloud and self-hosted
runtimes (`cloud: { repos, ... }`) are out of scope and tracked as follow-ups.

Other deferred areas:

- subagents (`AgentDefinition`)
- inline MCP server forwarding from the daemon into the SDK
- `.cursor/hooks.json` integration
- artifact downloads (the SDK does not support this for local runtimes)

## Settings

| Setting | Cursor behavior |
|---|---|
| `model` | Required. Pass a Cursor-side model id (e.g. `composer-2`). Resume calls thread per-run model overrides through `SendOptions.model`. |
| `reasoning_effort` | Rejected with `INVALID_INPUT`. The SDK exposes per-model parameter discovery (`Cursor.models.list()`) which is deferred. |
| `service_tier` | Rejected with `INVALID_INPUT`. |

Profiles in the worker profiles manifest follow the same rules: cursor
profiles must declare `model`, must omit `reasoning_effort` and
`service_tier`, and must not declare a `variant` (catalog declares
`variants: []`).

## Sessions and resume

The runtime persists the durable Cursor `agentId` as the run's `session_id`.
Follow-ups call `Agent.resume(agentId, { apiKey, local: { cwd } })` and pass
the per-call `SendOptions.model` only when the follow-up changes the model.

## Error mapping

Cursor SDK error events map to standard `RunErrorCategory` values:

| SDK status / class | Category |
|---|---|
| `AuthenticationError`, "401" | `auth` |
| `RateLimitError`, "429" | `rate_limit` |
| `ConfigurationError`, "invalid model" | `invalid_model` |
| `NetworkError`, 5xx | `backend_unavailable` |
| Other typed errors | `unknown` (fatal) |

A `Run.status === "cancelled"` is recorded with `runStatusOverride =
"cancelled"` so the run finalizes as cancelled rather than completed.

## Limitations and notes

- Tool-call file/command extraction is best-effort: the runtime extracts
  `args.file_path`, `args.path`, and `args.command` shapes from `tool_call`
  messages and assistant `tool_use` blocks. For Cursor-only tool shapes the
  runtime falls back to git snapshot diffs for the `files_changed` list.
- The daemon's MCP servers are **not** forwarded into the SDK in this
  release. Cursor runs do not inherit the daemon's MCP wiring.
- Token usage is billed to your Cursor account.
- The runtime closes the SDK agent (`Symbol.asyncDispose` or `close()`) once
  the run reaches a terminal state.
