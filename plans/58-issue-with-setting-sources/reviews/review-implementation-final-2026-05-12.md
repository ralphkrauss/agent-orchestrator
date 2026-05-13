# Implementation Final Review - 2026-05-12

## Findings

### Medium - Public docs still teach `codex_network: "isolated"` as closed network without `worker_posture: "restricted"`

The code fixes for the two previous findings are in place:

- `maybeEmitCodexNetworkDefaultWarning()` now returns early unless
  `worker_posture === 'restricted'` (`src/orchestratorService.ts:403-413`).
- `validateProfile()` now rejects unsupported `worker_posture` values during
  profile inspection (`src/harness/capabilities.ts:259-266`).

One docs issue remains. The first-run examples in `README.md:95-102` and
`docs/first-run.md:73-82` still create a Codex profile with only
`codex_network: "isolated"` and describe it as "closed network egress". Under
the new default `worker_posture: "trusted"`, explicit
`codex_network: "isolated"` emits no sandbox flags and still loads user/project
Codex config, so it is not the old closed envelope. Those examples need to set
`worker_posture: "restricted"` if they are meant to demonstrate closed network
egress, or change the text to explain trusted/manual-parity behavior.

The later migration section in `docs/development/codex-backend.md:159-205` is
also still written as if omitted `codex_network` always upgrades to isolated /
`--ignore-user-config`. That is now restricted-only after #58; under trusted,
omission is the intended default and persists `codex_network: null`. This
section should either be reframed as historical / restricted-posture migration
guidance, or updated to the same two-axis model used in `docs/reference.md`.

## Notes

The previous review findings are otherwise resolved:

- Trusted+absent Codex no longer emits `codex_network_defaulted`.
- Restricted+absent Codex still emits the warning with posture-specific text.
- Bad `worker_posture` values now land in profile inspection diagnostics.

I did not rerun `pnpm verify`; the implementer reported it passing after this
round.
