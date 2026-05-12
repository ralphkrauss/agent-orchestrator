# Watch TUI Refactor

Branch: `59-improve-watch`
Plan Slug: `watch-tui-refactor`
Created: 2026-05-12
Status: completed

## Context

- User objective: fully refactor the existing `watch` command into an SSH-friendly terminal UI focused on live orchestrator sessions and grouped workers, with archive access after orchestrators exit.
- Repository instructions read: `AGENTS.md`.
- Rules read: `.agents/rules/node-typescript.md`, `.agents/rules/ai-workspace-projections.md`, `.agents/rules/mcp-tool-configs.md`.
- Relevant implementation read: `src/daemon/daemonCli.ts`, `src/daemon/observabilityFormat.ts`, `src/observability.ts`, `src/contract.ts`, `src/orchestratorService.ts`, `src/daemon/orchestratorRegistry.ts`, `src/daemon/orchestratorStatus.ts`, `src/runStore.ts`.
- Relevant tests read: `src/__tests__/observabilityFormat.test.ts`, `src/__tests__/observability.test.ts`, `src/__tests__/orchestratorStatus.test.ts`, `src/__tests__/orchestratorRegistry.test.ts`.
- Relevant docs read: `docs/reference.md`, `docs/development/mcp-tooling.md`, `README.md`.

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| D1 | Session model | Use existing live supervisor registry plus run `metadata.orchestrator_id`; add additive observability snapshot fields for live and archived orchestrator groups. | The daemon already owns supervisor lifecycle, aggregate status, and worker ownership. This avoids inventing a parallel session model. | Group by backend session ID only; infer orchestrators from titles. |
| D2 | Command shape | Keep `agent-orchestrator watch` and retain non-TTY snapshot fallback. | Requirement keeps the command stable and preserves script/SSH fallback behavior. | Add a separate subcommand. |
| D3 | UI implementation | Use Ink/React for the interactive TUI while keeping the non-TTY formatter dependency-free. | The finished watch experience needs stable two-pane layout, raw input handling, mouse-wheel support, and repaint behavior that are safer to maintain through Ink than bespoke ANSI rendering. | Continue extending the earlier hand-rolled dashboard renderer. |
| D4 | Transcript source | Build transcript lines from prompt text, recent worker events, and final response summaries in oldest-to-newest order. | Existing run-store event logs are durable and already power progress APIs. | Dump raw JSON events or stdout/stderr logs by default. |
| D5 | Tool rendering | Summarize tool calls/results by default, showing names, commands/previews, status, and concise errors. | Matches requirement to avoid raw noisy output while preserving progress and failure context. | Render full tool payloads inline. |

## Scope

### In Scope

- Add observability data for live orchestrators and archived orchestrator groups.
- Group workers under orchestrator sessions, including completed workers while the orchestrator is live.
- Replace the old watch dashboard with a two-pane live/archive TUI state model.
- Render transcript-like prompt, assistant, lifecycle, tool call/result, error, and final response blocks.
- Preserve non-TTY `watch` fallback and existing `runs`/`status --verbose` human output.
- Add focused tests and docs.

### Out Of Scope

- Changing worker start/cancel/follow-up MCP contracts beyond additive observability snapshot fields.
- Persisting live supervisor registry across daemon restarts beyond existing sidecar behavior.
- Changing release, publishing, secret, hook, or external-service behavior.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| R1 | Registered orchestrator disappears while selected. | Clamp selection by stable item id and fall back to first live/archive item. | Formatter/TUI tests. |
| R2 | Completed workers should remain visible only while parent orchestrator remains live. | Live groups come from registry plus owned run metadata; archive groups come from historical run metadata after live registry membership is absent. | Observability tests. |
| R3 | Transcript history exceeds terminal height. | Maintain per-selection scroll offset and auto-follow only when not manually scrolled up. | TUI state tests. |
| R4 | Markdown text contains lists/code/basic emphasis. | Render simple terminal Markdown blocks, lists, code fences, and paragraph wrapping without raw fence/list artifacts where avoidable. | Transcript renderer tests. |
| R5 | Tool result payloads are huge. | Summarize names/status/errors/text preview with bounded line length. | Transcript renderer tests. |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| W1 | Extend observability snapshot with orchestrator groups | none | completed | Snapshot includes live orchestrators from registry/status, owned workers by `metadata.orchestrator_id`, and archive groups for non-live historical orchestrator IDs. |
| W2 | Build transcript rendering model | W1 | completed | Renderer produces oldest-to-newest blocks with prompt inspection, Markdown-ish message rendering, high-level tool summaries, and bounded output. |
| W3 | Replace `watch` interactive state and rendering | W1, W2 | completed | TUI shows left sidebar collapsible live sessions/workers plus archive flow and main transcript pane; keyboard navigation handles arrows, Enter, Escape, Tab/archive toggle, and scroll/follow. |
| W4 | Add focused tests | W1, W2, W3 | completed | Tests cover grouping, live/archive behavior, worker selection, transcript rendering, and navigation/real-time clamping. |
| W5 | Update docs/help | W3 | completed | Docs describe new watch UX, keys, live/archive semantics, transcript/Markdown/tool rendering expectations. |
| W6 | Verify and harden | W4, W5 | completed | Targeted tests and build pass; strongest appropriate repo checks are run or documented. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| RC1 | Prefer existing orchestrator registry and run metadata for watch/session features. | Future observability changes. | After implementation proves the pattern. |

## Quality Gates

- [x] `pnpm build`
- [x] `pnpm test`
- [x] `pnpm verify`

## Execution Log

### W1: Extend observability snapshot with orchestrator groups
- **Status:** completed
- **Evidence:** `src/contract.ts` adds additive `orchestrators` snapshot data; `src/observability.ts` derives live groups from daemon-provided registry/status snapshots and archived groups from historical `metadata.orchestrator_id`; `src/orchestratorService.ts` passes live registry state into observability snapshots. Covered by `observability.test.ts`.
- **Notes:** Existing `sessions` and `runs` snapshot fields remain intact.

### W2: Build transcript rendering model
- **Status:** completed
- **Evidence:** `src/daemon/watchViewModel.ts` builds orchestrator overview and worker timeline blocks with prompt blocks, event boundaries, terminal Markdown rendering, and tool call/result summaries.
- **Notes:** `watch` requests a larger default `--recent-events` window than other snapshot consumers.

### W3: Replace `watch` interactive state and rendering
- **Status:** completed
- **Evidence:** `src/daemon/watchApp.tsx` now provides the Ink-based two-pane TUI for live/archive mode, selection, collapsing/expanding, arrow and j/k navigation, smooth scrollback, mouse-wheel support, text-selection toggle, scroll indicators, and follow mode.
- **Notes:** Non-TTY `watch` fallback remains `formatSnapshot` in `src/daemon/observabilityFormat.ts`.

### W4: Add focused tests
- **Status:** completed
- **Evidence:** `src/__tests__/observability.test.ts` covers live/archive orchestrator grouping; `src/__tests__/observabilityFormat.test.ts` covers non-TTY fallback formatting; `src/__tests__/watchViewModel.test.ts` covers grouped worker conversations, overview rows, worker transcripts, Markdown/final-response preservation, tool summaries, archive flow, selection clamping, mouse-wheel decoding, and scroll/follow state.
- **Notes:** Targeted command passed: `pnpm build && node --test dist/__tests__/observability.test.js dist/__tests__/observabilityFormat.test.js`.

### W5: Update docs/help
- **Status:** completed
- **Evidence:** `docs/reference.md` documents the new watch UX, live/archive behavior, keyboard controls, transcript behavior, Markdown rendering, mouse/text-selection behavior, and tool-call summaries. `src/cliRoot.ts` and `src/daemon/daemonCli.ts` document `--recent-events`.
- **Notes:** No release, secret, hook, or external-service behavior changed.

### W6: Verify and harden
- **Status:** completed
- **Evidence:** `pnpm build` passed. `pnpm test` passed 576 tests, 574 pass, 2 skipped, 0 failed. `pnpm verify` passed earlier for the branch after the initial refactor; rerun before PR for final evidence.
- **Notes:** `pnpm install --frozen-lockfile` was run first because `node_modules` was absent and `tsc` was unavailable.
