# First Successful Run

This guide gets from a fresh machine to one safe diagnostic check and one worker run. Commands assume Node.js 22 or newer.

## 1. Install-Free Diagnostic

Run diagnostics through `npx`:

```bash
npx -y @ralphkrauss/agent-orchestrator@latest doctor
npx -y @ralphkrauss/agent-orchestrator@latest doctor --json
```

Diagnostics do not make model calls. They check the platform, Node version, run-store access, backend binary or SDK availability, backend version/help support, and auth hints.

Expected human-readable shape:

```text
Agent Orchestrator diagnostics
Frontend version: 0.2.2
Daemon version: not connected
Platform: darwin
Node: v24.15.0
Run store: /Users/example/.agent-orchestrator (accessible)

Backends:
- codex: auth_unknown
- claude: missing
- cursor: missing
```

Common statuses:

| Status | Meaning |
|---|---|
| `available` | The backend is installed and auth can be proven locally without a model call. |
| `auth_unknown` | The backend looks runnable, but auth cannot be proven without asking it to call a model. |
| `missing` | The CLI binary or optional SDK is not available to the daemon. |
| `unsupported` | The installed CLI exists but lacks required flags. |

## 2. Configure One MCP Client

Use the package as an MCP stdio server. Persistent MCP client entries should
pin a concrete package version so restarts use the same MCP surface; this guide
uses `0.2.2`.

```json
{
  "mcpServers": {
    "agent-orchestrator": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ralphkrauss/agent-orchestrator@0.2.2"]
    }
  }
}
```

For client-specific examples, see the README.

After restarting the MCP client, run this tool:

```text
get_backend_status({})
```

That is the MCP equivalent of `doctor` and still makes no model calls.

## 3. Create One Worker Profile

Pick a backend that diagnostics reports as `available` or `auth_unknown`. The examples below use placeholders for model ids because accepted model names belong to the backend CLI or SDK.

Codex profile with closed worker network egress:

```text
upsert_worker_profile({
  "profile": "codex-local",
  "backend": "codex",
  "model": "<codex-model-id>",
  "codex_network": "isolated",
  "description": "Local Codex worker with closed network egress"
})
```

Claude profile using a direct model id:

```text
upsert_worker_profile({
  "profile": "claude-local",
  "backend": "claude",
  "model": "<claude-model-id>",
  "description": "Local Claude worker"
})
```

Cursor profile:

```text
upsert_worker_profile({
  "profile": "cursor-local",
  "backend": "cursor",
  "model": "<cursor-model-id>",
  "description": "Local Cursor SDK worker"
})
```

Profiles are stored in `~/.config/agent-orchestrator/profiles.json` unless a client passes `profiles_file`.

## 4. Start One Run

Use a small prompt in a disposable or clean workspace:

```text
start_run({
  "profile": "codex-local",
  "prompt": "Run pwd and summarize the repository in one sentence.",
  "cwd": "/path/to/workspace",
  "metadata": {
    "session_title": "First run",
    "prompt_title": "Repository summary"
  }
})
```

Expected response:

```json
{ "ok": true, "run_id": "01..." }
```

If the backend is missing or unauthenticated, `start_run` may still create a durable failed run. Inspect it with the tools below.

## 5. Inspect Progress And Result

```text
get_run_progress({ "run_id": "01..." })
get_run_status({ "run_id": "01..." })
get_run_result({ "run_id": "01..." })
```

For long work, prefer `get_run_progress`; it returns a bounded summary instead of the full raw event log.

Common failure shapes:

```json
{
  "ok": true,
  "run_summary": {
    "status": "failed",
    "latest_error": {
      "category": "worker_binary_missing"
    }
  }
}
```

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_INPUT",
    "message": "..."
  }
}
```

`ok: false` means the MCP tool request itself was rejected. `ok: true` with a failed run means the run was created and the worker failure is recorded in the run store.

## 6. Stop Or Restart The Daemon

The MCP server auto-starts the daemon when needed. You can also control it explicitly:

```bash
npx -y @ralphkrauss/agent-orchestrator@latest status
npx -y @ralphkrauss/agent-orchestrator@latest runs
npx -y @ralphkrauss/agent-orchestrator@latest restart
npx -y @ralphkrauss/agent-orchestrator@latest stop
```

Safe defaults refuse to stop or restart while runs are active. To cancel active runs first:

```bash
npx -y @ralphkrauss/agent-orchestrator@latest restart --force
npx -y @ralphkrauss/agent-orchestrator@latest stop --force
```

Use `--force` deliberately; it sends cancellation through the normal run lifecycle.

## 7. No-Model-Call Path

For cautious setup, stop after these checks:

```bash
npx -y @ralphkrauss/agent-orchestrator@latest doctor --json
```

```text
get_backend_status({})
list_worker_profiles({})
```

These checks do not require Codex, Claude, Cursor, or OpenCode to make model calls. The first model call happens only when you start a worker run on a backend that performs one.
