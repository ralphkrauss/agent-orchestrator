# Security Policy

## Reporting A Vulnerability

Please report vulnerabilities privately through GitHub Security Advisories:

```text
https://github.com/ralphkrauss/agent-orchestrator/security/advisories/new
```

Do not include exploit details, private repository names, tokens, or sensitive logs in public issues. If private vulnerability reporting is unavailable, open a public issue with only a high-level description and ask for a private contact path.

## Supported Versions

Security fixes target the latest published npm version and the current `main` branch. Older `0.x` versions are best-effort unless a maintainer explicitly marks them supported in a release note.

## Local Trust Model

Agent Orchestrator is a trusted-local MCP server. It does not sandbox worker processes beyond what the selected backend CLI provides.

- Worker processes run with the current user's OS privileges.
- Worker processes inherit the daemon environment after daemon startup.
- Codex, Claude, Cursor, and OpenCode credentials remain owned by those tools or by the daemon owner.
- The daemon IPC endpoint is local and should not be exposed to untrusted users.
- Prompts, events, stdout, stderr, metadata, and results are written to the local run store.
- Run-store files can reveal repository paths, prompts, model output, tool events, and failure details.

## Credential Boundaries

Do not pass credentials in prompts, MCP tool arguments, issue templates, docs, examples, or committed config files.

Use one of these paths instead:

- Backend CLI auth state, such as Codex or Claude Code login.
- Daemon environment variables owned by the local user or service manager.
- `~/.config/agent-orchestrator/secrets.env` for daemon-managed provider keys.
- `~/.config/agent-orchestrator/mcp-secrets.env` for this repository's development MCP bridge.

The daemon refuses overly permissive daemon secrets files on POSIX. Restart the daemon after changing credential files or environment variables.

## Prompts And Logs

Prompts are persisted as `prompt.txt` in each run directory. Logs and event JSONL files may contain model output, command output, file paths, and error messages.

Before sharing logs:

- Remove secrets and private tokens.
- Remove private repository names if needed.
- Keep excerpts minimal.
- Prefer `doctor --json` and `get_backend_status` diagnostics when possible; they do not print secret values.

## Platform Notes

On POSIX, the run store and daemon socket are created with user-only permissions where supported. On Windows, the daemon uses a named pipe derived from the run-store path; protect the user profile and run-store directory with normal Windows account isolation.
