# Review Fixes

Date: 2026-05-02
Branch: `11-add-robust-opencode-orchestration-harness-with-model-settings-and-orchestration-skills`
Scope: Uncommitted fixes for PR #15 review comments and failing CI tarball smoke.

## Findings

No blocking findings.

## Notes

- The OpenCode `external_directory` permission is narrowed to the exact profiles manifest.
- Project skill discovery now ignores only missing `SKILL.md` and surfaces other access failures.
- Follow-up metadata strips inherited `worker_profile` provenance while preserving explicit child metadata.
- Process-manager stderr heuristics no longer promote benign stderr text into successful run results.
- `start_run` MCP schema advertises the direct/profile union with `oneOf`.
- Claude effort validation uses exact normalized direct model ids and preserves `claude-opus-4-7[1m]`.
- Local OpenCode session/log identifiers are redacted from the plan.
- CI packed-tarball smoke now targets current package bins.

## Verification

- `pnpm build`
- `node --test dist/__tests__/mcpTools.test.js dist/__tests__/opencodeCapabilities.test.js dist/__tests__/opencodeHarness.test.js dist/__tests__/processManager.test.js dist/__tests__/daemonCli.test.js dist/__tests__/integration/orchestrator.test.js`
  - 40 tests passed
- Local packed-tarball smoke matching CI:
  - `agent-orchestrator --help`
  - `agent-orchestrator doctor --json`
  - `agent-orchestrator-daemon --help`
  - `agent-orchestrator-opencode --help`
  - `agent-orchestrator-opencode --print-config`
  - `agent-orchestrator opencode --print-config`
