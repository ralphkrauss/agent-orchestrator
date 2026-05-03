# Plan Index

Branch: `13-add-support-for-claude-code`
Updated: 2026-05-03

## Sub-Plans

| Plan | Scope | Status | File |
|---|---|---|---|
| Claude Code Support | Backend-agnostic daemon-owned run-notification model, then a production-grade isolated Claude Code supervisor harness that becomes the recommended rich-feature orchestration mode. Includes explicit isolation boundary (ephemeral settings + MCP config, `--strict-mcp-config`, no inherited user/project Claude state), curated permission/tool/MCP/skill allowlists, leak-proof tests, and an extracted shared harness core so OpenCode keeps its parity/improvement track without divergence. OpenCode remains a supported harness. | implemented | `plans/13-add-support-for-claude-code/plans/13-claude-code-support.md` |
