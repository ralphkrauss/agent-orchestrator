# Changelog

This project uses npm dist-tags as documented in `PUBLISHING.md`: prereleases publish to `next`, and stable releases publish to `latest`.

## Unreleased

## 0.2.7 - 2026-05-13

### Fixed

- Fixed `agent-orchestrator watch` timeline prompts so selecting a worker
  lazily loads the bounded full prompt text from the local store instead of
  showing only the truncated preview.
- Kept watch refreshes lightweight by leaving full prompt text out of the base
  snapshot and hydrating only the selected worker conversation.

## 0.2.6 - 2026-05-13

### Fixed

- Fixed `agent-orchestrator watch` so live orchestrators come from a
  lightweight daemon registry read while worker/session details still come from
  the bounded local store snapshot.
- Fixed stale sidebar rows in the watch TUI when the live/archive lists shrink
  between refreshes.
- Added sidebar click selection in the watch TUI and clarified worker totals
  when details are outside the current watch `--limit`.

## 0.2.5 - 2026-05-13

### Fixed

- Made `agent-orchestrator watch` read lightweight snapshots from the local run
  store instead of polling rich daemon IPC snapshots on every refresh.
- Bounded dashboard event parsing and stdout terminal recovery so oversized
  worker payloads cannot force full-log parsing or large JSON serialization.
- Fixed daemon restarts to recover completed workers from stdout and adopt
  still-live worker processes instead of marking them orphaned immediately.
- Sanitized daemon auto-start environments from Claude supervisor launches so
  restarted daemons use the intended user home, cwd, and daemon log stream.

## 0.2.4 - 2026-05-13

### Fixed

- Fixed `agent-orchestrator claude` so it auto-starts the daemon before
  supervisor registration when the daemon store is stopped.
- Fixed `agent-orchestrator watch` so large run histories do not exceed the IPC
  frame cap while rendering the dashboard snapshot.

## 0.2.3 - 2026-05-13

### Added

- Added the interactive watch TUI for live supervisor and worker conversations.
- Added append-only Claude supervisor system prompt configuration.
- Added `worker_posture` controls for backend-native trusted and restricted worker behavior.

### Repository Setup

- Added public contributor, security, support, code-of-conduct, issue-template, PR-template, roadmap, and repository-map files.
- Reworked the README into a newcomer-focused landing page and moved reference material into `docs/`.
- Added cross-platform CI coverage: full verification on Linux/macOS and focused Windows build/smoke coverage.

### Fixed

- Fixed Claude config-dir rotation session-copy lookup on macOS paths where worker processes observe `/private/var/...` while callers pass `/var/...`.
- Fixed Claude subscription-cap banners so they classify as `rate_limit` and trigger account rotation.
- Fixed observability worker ordering for runs created within the same millisecond.
- Normalized macOS temporary-path expectations in git snapshot and OpenCode harness tests.
- Updated the lockfile to patched transitive `fast-uri` and `hono` versions so `pnpm audit --prod` remains green.

## 0.2.2 - 2026-05-07

### BREAKING: Codex Network Posture Defaults To Isolated

Codex backend network egress is now controlled by the explicit `codex_network` field:

- `isolated`
- `workspace`
- `user-config`

Every Codex profile that omits `codex_network` resolves to `isolated`, regardless of `service_tier`. Profiles that previously relied on `~/.codex/config.toml` for network access via `service_tier: "fast"`, `service_tier: "flex"`, or an unset `service_tier` must set `codex_network` explicitly.

Migration options:

| Desired behavior | Set |
|---|---|
| Restore prior user-config behavior | `codex_network: "user-config"` |
| Enable Codex workspace network explicitly | `codex_network: "workspace"` |
| Keep the new closed-by-default posture | `codex_network: "isolated"` |

Read the full migration table in `docs/development/codex-backend.md`.

### Added

- `codex_network` on Codex worker profiles and direct-mode Codex `start_run` / `send_followup`.
- Capability metadata advertising Codex network modes.
- Per-run lifecycle warning when Codex network posture defaults to `isolated`.
- Observability aggregation that distinguishes runs by `codex_network`.

### Changed

- `service_tier` no longer implicitly controls whether Codex reads user config.
- Profile-mode follow-ups reject direct `codex_network` overrides; edit the profile or start a direct-mode run instead.

## 0.2.1 - 2026-05-06

### Changed

- Stable release following the `0.2.1-beta.0` prerelease.
- Continued hardening of worker orchestration, package metadata, and release checks.

## 0.2.1-beta.0 - 2026-05-06

### Added

- Prerelease validation of the `0.2.1` release line on the npm `next` dist-tag.

## 0.2.0 - 2026-05-04

### Added

- Minor release line for expanded local worker orchestration capabilities and daemon hardening.

## 0.1.5 - 2026-05-04

### Changed

- Patch release in the initial public package series.

## 0.1.4 - 2026-05-04

### Changed

- Patch release in the initial public package series.

## 0.1.3 - 2026-05-03

### Changed

- Patch release in the initial public package series.

## 0.1.2 - 2026-05-02

### Changed

- Patch release in the initial public package series.

## 0.1.1 - 2026-05-02

### Added

- Initial public npm release of `@ralphkrauss/agent-orchestrator`.
