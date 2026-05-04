Review: hardening follow-up
Date: 2026-05-04

Findings

1. Medium: `auth status` reports reserved-provider file entries as effective even though the daemon ignores them.

`runStatus()` treats `fileSet` as an effective source for every provider. With `ANTHROPIC_API_KEY=...` or `OPENAI_API_KEY=...` hand-edited into `secrets.env`, the human output reports `claude [reserved]: ready via file` / `codex [reserved]: ready via file`, and JSON reports `effective_status: "ready"`. That contradicts the new allowlist behavior and docs: reserved-provider keys are only surfaced as drift and are not injected into the daemon until the provider is wired.

Suggested fix: keep `file_set: true` for reserved providers, but only set `effective_source: "file"` / `effective_status: "ready"` when `provider.status === "wired"`. Add an `authCli` test with an `ANTHROPIC_API_KEY` file entry proving the row stays reserved/unknown while still surfacing `file_set: true`.

Relevant code:
- `src/auth/authCli.ts:99`
- `src/auth/authCli.ts:101`
- `src/auth/authCli.ts:102`
- `docs/development/auth-setup.md:45`

2. Medium: Cursor secrets-file refusal hints are dropped when `@cursor/sdk` is missing.

`diagnoseCursorBackend()` computes `auth` from env/file state, but if `adapter.available()` fails it returns immediately with only the SDK install/rebuild hint. When env is absent and the secrets file exists but is unreadable/permission-refused, `doctor` already knows the refusal via `secrets.refusal`, yet the user will only see the SDK hint. Fixing the SDK then leaves auth broken with no prior warning.

Suggested fix: build the auth/refusal hint list once and include the non-secret refusal hint in both the SDK-missing and SDK-available return paths when env is unset. Add a diagnostics test with a missing cursor adapter and a refused/bad secrets path.

Relevant code:
- `src/diagnostics.ts:264`
- `src/diagnostics.ts:278`
- `src/diagnostics.ts:288`

Verification

Review only. I did not rerun `pnpm verify`; the implementation summary reports it passed before this review.
