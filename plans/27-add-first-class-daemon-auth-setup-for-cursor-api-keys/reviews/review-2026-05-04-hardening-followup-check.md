Review: hardening follow-up check
Date: 2026-05-04

Findings

No blocking findings found in this pass.

Checked

- `auth status` now reports reserved-provider file entries as drift only:
  `file_set: true`, `effective_status: "unknown"`, and
  `effective_source: null`, while keeping env-backed reserved providers
  effective.
- Cursor diagnostics now builds auth hints once and includes secrets-file
  refusal hints in both SDK-missing and SDK-available branches.
- Tests cover the reserved-provider drift matrix and the SDK-missing plus
  refused-secrets path.
- `docs/development/auth-setup.md` documents the reserved-provider drift
  behavior.

Residual Risk

Review only. I did not rerun `pnpm verify`; the implementation summary reports
`pnpm verify` passed with 290 passing tests, 0 failures, 1 skipped, clean audit,
and a clean npm pack dry run.
