---
description: "Worker safety contracts: hooks disabled, bypass permissions pinned, dangerously-skip-permissions banned"
paths:
  - "src/backend/claude.ts"
  - "src/backend/codex.ts"
  - "src/backend/cursor/**/*.ts"
  - "src/claude/launcher.ts"
globs:
  - "src/backend/claude.ts"
  - "src/backend/codex.ts"
  - "src/backend/cursor/**/*.ts"
  - "src/claude/launcher.ts"
---

# Worker Safety Contracts

These invariants apply to **every** worker spawn under both `trusted` and
`restricted` postures (issue #58). They are independent of MCP / config
access posture; they exist so non-interactive workers do not stall or fire
unintended user hooks.

- Claude workers always pin `disableAllHooks: true` in the per-run settings
  body (issue #40 T5/T13). Project `.claude/settings.json` cannot re-enable
  hooks under `trusted` because the per-run `--settings <path>` file takes
  precedence over the setting-sources merge.
- Claude workers always pin `permissions.defaultMode: 'bypassPermissions'`
  in the per-run settings body AND `--permission-mode bypassPermissions` on
  the spawn argv (issue #47). The CLI flag survives precedence drift if
  Claude Code ever flips precedence between settings and flags.
- `--dangerously-skip-permissions` is banned on every worker and supervisor
  invocation (issue #13 Decisions 7 / 21). The bypass posture is expressed
  via the documented `defaultMode` / `--permission-mode` surface only.
- Cursor workers must not weaken the SDK's pre-#58 safety defaults. Under
  `restricted`, the shim omits `settingSources` so the SDK behaves as it did
  before issue #58.
- Codex workers must not emit `--sandbox` or `--cd` from the shared
  `sandboxArgs()` helper because `codex exec resume` rejects them. Use
  `-c key=value` overrides that both `codex exec` and `codex exec resume`
  accept.

If you are tempted to make a worker change that touches one of these
invariants, stop and discuss — every one of them was load-bearing in a
prior incident.
