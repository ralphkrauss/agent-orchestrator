# Plan Review Round 2: Daemon Auth Setup

Reviewed: 2026-05-04
Reviewer: Codex
Scope: revised `plans/27-add-first-class-daemon-auth-setup-for-cursor-api-keys/plans/27-daemon-auth-setup.md`

## Findings

### F1: Out-of-scope section still contradicts the additive contract change

Severity: Medium

D5, scope, T7, and the quality gates now correctly say `BackendDiagnostic.auth` gains optional `source_kind` and `source_path` fields. The out-of-scope section still says "Changing the MCP tool contract (`BackendDiagnostic.auth` shape stays)." That is no longer true and can mislead implementation/review about whether `contract.ts`, MCP docs, and contract tests should change.

Revise the out-of-scope line to say that breaking/renaming/removing MCP fields is out of scope, while the two optional auth source fields are in scope per D5.

### F2: Permission-failure wording conflicts with env precedence

Severity: Medium

D14/T7 say that when the secrets file is unreadable because of permissions, `auth.status` stays `unknown`. That is only correct when there is no usable env var. If `CURSOR_API_KEY` is already present in `process.env`, env precedence means diagnostics should still report `auth.status: ready`, `source_kind: "env"`, and optionally include a non-secret warning about the ignored file.

Revise D14/T7 to distinguish:

- env present + file permission failure: ready from env, surface a warning/hint if useful.
- env absent + file permission failure: unknown, chmod remediation hint.

### F3: D11 still contains stale tests from the previous source-detection design

Severity: Low

D11 says that when the env value matches the secrets-file value, the human formatter includes `(file: ...)`. The revised D14/T7 precedence model says env wins when both are set, so the expected source should be `env` even if the values happen to match. D11 also says the daemon-load integration can start the daemon and assert `doctor --json` is ready, but `doctor` now reads the file in its own CLI process, so that assertion no longer proves the daemon loaded secrets.

Revise D11 to match T7/T8:

- diagnostics tests: env-only, file-only, both-set env-wins, permission-blocked with/without env.
- daemon-load integration: query `get_backend_status` through daemon IPC or start a Cursor runtime test path with a fake adapter/runtime env, not standalone `doctor --json`.

## Notes

The original four findings are otherwise addressed. D1 and D10 remain good choices for the first implementation.
