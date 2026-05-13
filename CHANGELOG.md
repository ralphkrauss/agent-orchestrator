# Changelog

This project uses npm dist-tags as documented in `PUBLISHING.md`: prereleases publish to `next`, and stable releases publish to `latest`.

## Unreleased

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
