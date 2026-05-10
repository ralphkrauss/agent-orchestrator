# Roadmap

Agent Orchestrator is published and usable, but it is still a `0.x` package. The near-term roadmap focuses on trust, setup clarity, platform confidence, and stable contracts rather than new features.

## Stable Today

- Local daemon-backed MCP server.
- Durable run store with status, events, prompts, stdout, stderr, and results.
- Codex worker runs and follow-ups.
- Claude worker runs, follow-ups, account registry, and rate-limit rotation.
- Cursor SDK worker runs.
- OpenCode and Claude supervision harnesses.
- Diagnostics through CLI and MCP tools.
- npm package publication with Trusted Publishing.

## Experimental Or Still Hardening

- Broad Windows coverage beyond focused smoke and platform-specific tests.
- Claude account rotation edge cases around vendor CLI session files.
- OpenCode orchestration UX and supervisor permissions.
- Long-running task ergonomics across different MCP clients.
- Public support workflow and issue triage cadence.

## Near-Term Priorities

- Keep `pnpm verify` green on local macOS and CI.
- Expand CI coverage while keeping Windows expectations explicit.
- Improve first-run docs and failure messages from real user reports.
- Keep package contents intentional and small enough to inspect.
- Preserve backward-compatible MCP contracts during `0.x` hardening.

## Platform Goals

- Linux: full build, test, pack, and smoke coverage.
- macOS: full build, test, pack, and smoke coverage.
- Windows: build, focused platform tests, packed CLI smoke coverage, and documented caveats.

## Backend Goals

- Codex: deterministic network posture through explicit `codex_network`.
- Claude: reliable account isolation, session-copy behavior, and rotation auditability.
- Cursor: clear SDK installation and auth diagnostics.
- OpenCode: constrained supervisor setup that remains understandable to users.

## Non-Goals

- Hosted orchestration service.
- Secret broker for third-party providers.
- Filesystem isolation beyond backend-provided sandboxing.
- Automatic worktree management.
- Guaranteed support for every backend vendor beta flag.

## Support Policy

The latest npm version and `main` receive best-effort fixes. No response-time SLA is offered. Security reports should use `SECURITY.md`; normal bugs and features should use GitHub issues.
