# Plan Review: Daemon Auth Setup

Reviewed: 2026-05-04
Reviewer: Codex
Scope: `plans/27-add-first-class-daemon-auth-setup-for-cursor-api-keys/plans/27-daemon-auth-setup.md`

## Findings

### F1: `doctor` will still report Cursor auth as unknown when only the secrets file exists

Severity: High

The plan loads secrets into `process.env` only in `daemonMain.ts` (D3/T6), but the user-facing `agent-orchestrator doctor` command currently runs `getBackendStatus()` in the frontend CLI process, not by querying the daemon. `diagnoseCursorBackend()` reads `process.env.CURSOR_API_KEY` directly. If a user saves `~/.config/agent-orchestrator/secrets.env` and runs `agent-orchestrator doctor` from a shell that does not export `CURSOR_API_KEY`, the CLI process will not have the key, so `doctor` can still report `auth_unknown`.

Revise D5/T7 so diagnostics resolve effective auth from `process.env` plus the user secrets file, with env precedence, not only by comparing the runtime env value to the file. Add a direct test for `agent-orchestrator doctor --json` or `getBackendStatus()` with `CURSOR_API_KEY` absent and `AGENT_ORCHESTRATOR_SECRETS_FILE` pointing at a temp file.

### F2: The no-contract-change source reporting design has no durable place to carry source detail

Severity: High

D5 says `BackendDiagnostic.auth.source` remains exactly `"CURSOR_API_KEY"` and the MCP/JSON shape is unchanged, while `formatBackendStatus()` should print `(file: <path>)`. Today `formatBackendStatus(report)` only receives the report object. If `auth.source` stays unchanged and no other field is added, the formatter has no reliable source-kind/path data to print without re-reading global process/file state, which will be wrong for stale daemon processes and for reports not produced in the same process.

Revise this explicitly before implementation. The cleanest options are:

- Add optional `auth.source_kind` / `auth.source_path` fields and treat that as a small, additive contract change with schema/docs/tests.
- Or keep the contract shape but allow `auth.source` semantics to become a non-secret source label, then update contract tests/docs accordingly.

The current plan rejects both alternatives but still depends on one of them in practice.

### F3: T8 expects the wrong existing Cursor runtime failure code for missing auth

Severity: Medium

T8 says the missing-key runtime path should continue to emit a `WORKER_BINARY_MISSING`-shaped failure. Current `src/backend/cursor/runtime.ts` returns `SPAWN_FAILED` with `details.category: "auth"` when `CURSOR_API_KEY` is absent. The plan should preserve that existing behavior or explicitly justify changing it.

Revise the T8 acceptance criterion and any planned tests to assert the current `SPAWN_FAILED` auth failure for missing keys.

### F4: `auth <provider> --from-env [VAR]` precedence is ambiguous

Severity: Low

D6 says `--from-env [VAR]` reads `primaryEnvVar` first, falling back to the named var. If a caller supplies an explicit var name, the expected behavior is usually to read that var directly. The current wording can save an old `CURSOR_API_KEY` even when the user intentionally passed `MY_CURSOR_KEY`.

Revise D6/T4 to: no argument means read `primaryEnvVar`; explicit `VAR` means read exactly `VAR` and save it under the provider's `primaryEnvVar`.

## Notes

D1 looks right: keep `secrets.env` separate from `mcp-secrets.env`. The two files have different audiences and different precedence semantics.

D10 is acceptable for the first implementation. Keep restart explicit, but make the save message say that the currently running daemon is unchanged until restart.
