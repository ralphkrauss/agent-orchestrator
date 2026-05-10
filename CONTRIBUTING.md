# Contributing

Thanks for helping improve Agent Orchestrator. This project is a local MCP server and daemon, so small changes can affect process supervision, credentials, and persisted run state. Keep changes focused and verify them with repository scripts.

## Requirements

- Node.js 22 or newer.
- pnpm 10.30.3.
- Git.
- Optional local CLIs for backend smoke testing: Codex, Claude Code, OpenCode.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Use a local isolated daemon store while dogfooding a checkout:

```bash
just local doctor
just local status
just local stop --force
just local-clean
```

## Verification

Release-quality verification:

```bash
pnpm verify
```

`pnpm verify` builds, runs tests, checks publish readiness, resolves the npm dist-tag, audits production dependencies, and runs `npm pack --dry-run`.

Focused checks:

```bash
pnpm build
node --test dist/__tests__/contract.test.js
node --test dist/__tests__/processManager.test.js
node --test dist/__tests__/integration/orchestrator.test.js
```

Packed-output smoke test:

```bash
package_file="$(npm pack --silent | tail -n 1)"
temp_dir="$(mktemp -d)"
cd "$temp_dir"
npm init -y >/dev/null
npm install "/path/to/agent-orchestrator/$package_file" >/dev/null
./node_modules/.bin/agent-orchestrator doctor --json
```

## Tests With External CLIs

Most tests use mock CLIs. Do not require a real Codex, Claude, Cursor, or OpenCode account for the default test suite.

Manual backend smokes may use host auth state. Keep them out of `pnpm verify` unless they are hermetic and do not make model calls. Document any manual smoke in the relevant `docs/development/` page.

## Coding Style

- Prefer plain TypeScript and Node built-ins.
- Keep runtime compatibility with Node.js 22 and newer.
- Use existing package scripts instead of ad hoc tool invocations.
- Keep public package behavior stable unless the change is explicitly about a contract.
- For MCP contract changes, update schemas, docs, and tests together.
- For CLI behavior changes, verify human-readable and JSON output where applicable.

## Security And Secrets

Never commit real tokens, API keys, `.env` contents, local credential files, or command arguments that contain secrets.

Do not ask users to paste secrets into prompts or MCP tool calls. Provider credentials should come from the backend CLI's normal auth state, environment managed by the daemon owner, or the daemon-managed user secrets file documented in `docs/development/auth-setup.md`.

## Pull Requests

Before opening a PR:

- Run the narrowest useful tests for the touched area.
- Run `pnpm verify` when the change affects release behavior, daemon lifecycle, run-store persistence, backend invocation, MCP contracts, package metadata, or docs linked from the README.
- Update docs when behavior or setup changes.
- Include concrete command evidence in the PR description.

Contributors should not publish packages, push release tags, activate hooks, or change external service configuration from a PR branch.

## Release Behavior

Maintainers publish from matching `v*.*.*` tags through GitHub Actions and npm Trusted Publishing. Prereleases go to the npm `next` dist-tag; stable releases go to `latest`. See `PUBLISHING.md`.
