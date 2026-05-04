Review: implementation hardening pass
Date: 2026-05-04

Findings

1. Medium: The daemon imports every key from `secrets.env`, not just wired provider secrets.

`src/auth/userSecrets.ts` `loadUserSecretsIntoEnv()` copies every parsed `KEY=value` into the daemon environment when the key is not already set. Because `bootDaemon()` calls this against `process.env`, a hand-edited secrets file can inject unrelated environment such as `NODE_OPTIONS`, proxy settings, or reserved provider keys. That contradicts the documented/plan boundary that Cursor is the only wired provider and Claude/Codex are reserved. It also broadens this auth file into general daemon env injection.

Suggested fix: make daemon loading allowlisted. Preserve arbitrary/commented entries on disk if desired, but only import env vars for providers whose auth is actually wired today, currently Cursor's env vars. Add a test that a secrets file containing `NODE_OPTIONS` and `ANTHROPIC_API_KEY` leaves those keys unset in the booted daemon environment while still loading `CURSOR_API_KEY`.

Relevant code:
- `src/auth/userSecrets.ts:106`
- `src/daemon/bootDaemon.ts:44`
- `docs/development/auth-setup.md:3`

2. Medium: `doctor` can still fail on a bad secrets path, even when `CURSOR_API_KEY` is already set.

`getBackendStatus()` unconditionally calls `loadUserSecrets()` before checking env precedence. `loadUserSecrets()` catches neither `statSync()` nor `readFileSync()` failures, so a directory path, unreadable file, or race can throw out of `doctor`. This violates the D14 behavior that env wins and the file is not probed when `process.env.CURSOR_API_KEY` is already available; it also means the expected graceful chmod hint path is not robust for read failures that are not just mode refusal.

Suggested fix: in diagnostics, skip the secrets-file read entirely when `process.env.CURSOR_API_KEY` is set. When env is absent, wrap file loading and convert read failures into an auth diagnostic hint rather than letting `doctor` crash. Add tests for an env-present bad path and an env-absent bad path.

Relevant code:
- `src/diagnostics.ts:75`
- `src/auth/userSecrets.ts:53`
- `src/auth/userSecrets.ts:77`

Verification

Review only. I did not rerun `pnpm verify`; the implementation summary reports it passed before this review.
