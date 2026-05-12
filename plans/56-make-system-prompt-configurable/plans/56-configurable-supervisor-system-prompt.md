# Configurable Claude Supervisor System Prompt (Append-Only)

Branch: `56-make-system-prompt-configurable`
Plan Slug: `configurable-supervisor-system-prompt`
Parent Issue: #56
Created: 2026-05-12
Updated: 2026-05-12
Status: planning

## Context

Issue #56 asks for the orchestrator agent's system prompt to be configurable
by package users while preserving a sensible default. Today the Claude
supervisor system prompt is built entirely by
`buildSupervisorSystemPrompt()` in `src/claude/config.ts` and contains
load-bearing isolation guarantees (allowed MCP tools, Bash allowlist
description, monitor-pin invariants, profile diagnostics, embedded
`orchestrate-*` skill text). The launcher writes that prompt to
`<envelopeDir>/system-prompt.md` and passes it to Claude via
`--append-system-prompt-file` (see `src/claude/launcher.ts:499` for the
envelope path, `src/claude/launcher.ts:506` for the write, and
`src/claude/launcher.ts:587` for the spawn arg). The Claude passthrough
validator (`src/claude/passthrough.ts:19-22`) already forbids users from
supplying `--system-prompt(-file)` and `--append-system-prompt(-file)`
*after* the `--` separator because the harness owns that flag.

User-confirmed invariants (locked, do not relitigate):
- Append-only. Harness-owned isolation contract, MCP allowlist, monitor pin,
  profile diagnostics, and embedded `orchestrate-*` instructions stay intact.
  User text is concatenated *after* the harness prompt.
- Supervisor-only. Worker run prompts are out of scope.
- Three surfaces: CLI flag (`--append-system-prompt` / `--append-system-prompt-file`),
  env-var fallback, auto-loaded `<targetCwd>/.agents/orchestrator/system-prompt.md`.
- CLI wins over env wins over the convention file with a single-line stderr
  notice when a present convention file is preempted.
- `--print-config` always emits `# user system prompt source` (with `none`
  sentinel) and the append section when non-empty.
- `--no-append-system-prompt` is an explicit escape hatch that suppresses
  ALL append sources (CLI + env + convention).
- Single concatenated envelope file. Spawn args stay exactly
  `--append-system-prompt-file <envelope-file>` (no new Claude flag surface,
  no second instance).
- 64 KB user-append cap (byte-based); missing CLI-named file errors loudly;
  missing convention file is silent; BOM stripped, trailing whitespace
  trimmed, leading Markdown preserved.

Sources read:
- `src/claude/config.ts` (current prompt construction, `ClaudeHarnessConfig`)
- `src/claude/launcher.ts` (envelope build, spawn args, help text, parser,
  cwd resolution)
- `src/claude/passthrough.ts` (forbidden/allowed flag tokens)
- `src/__tests__/claudeHarness.test.ts` (existing harness coverage)
- `AGENTS.md`, `CLAUDE.md`, `.agents/rules/node-typescript.md`
- `docs/development/mcp-tooling.md`, `docs/development/orchestrator-status-hooks.md`,
  `docs/ai-workspace.md`

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Customization model | Append-only — user text is concatenated after the harness prompt | Preserves load-bearing isolation contract, MCP allowlist, monitor-pin invariants, and `orchestrate-*` embeds. Matches the issue's "fine-tune" wording. | Prepend slot; full replacement (rejected — would silently break isolation). |
| 2 | Scope | Claude supervisor only | Issue names the "orchestrator agent". Worker runs already accept arbitrary instructions via `start_run` prompts. Keeps blast radius small. | Also seed worker run prompts (rejected — separate user request, larger surface). |
| 3 | Configuration surfaces | (a) CLI flags `--append-system-prompt <text>` and `--append-system-prompt-file <path>` on `agent-orchestrator claude`; (b) env-var fallbacks `AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT` (inline text) and `AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE` (path); (c) auto-loaded convention file `<targetCwd>/.agents/orchestrator/system-prompt.md` | CLI is explicit and ergonomic. Env vars match the existing `AGENT_ORCHESTRATOR_CLAUDE_*` family used for cwd, profiles, and state-dir. Convention file gives zero-config baseline for project teams and lives inside the existing `.agents/` AI-workspace tree (consistent with skills/rules/agents). | Profiles manifest field (rejected — couples prompt to profiles); `.agent-orchestrator/` top-level dir (rejected — new dotdir for one file); `.claude/...` (rejected — mixes generated and source artifacts). |
| 4 | Templating | Raw text, included verbatim | Predictable, no escaping rules, no leaking implementation paths into prompts. | `{{target_cwd}}`-style placeholders (rejected — complexity without clear ask). |
| 5 | Source model + precedence | Discriminated `AppendSource = 'cli-inline' \| 'cli-file' \| 'env-inline' \| 'env-file' \| 'convention-file' \| 'none'`. Precedence (top wins): (1) `--no-append-system-prompt` → forces `none` and suppresses every other source; (2) `--append-system-prompt` inline → `cli-inline`; (3) `--append-system-prompt-file <path>` → `cli-file`; (4) `AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT` → `env-inline`; (5) `AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE` → `env-file`; (6) convention file present → `convention-file`; (7) nothing → `none`. CLI-inline and CLI-file together is a parse error. Env-inline and env-file together is the same parse error. When a higher-precedence source preempts a present convention file, emit a single-line stderr notice naming the skipped path. | Explicit invocation overrides repo defaults; env vars are still per-launch and override repo defaults; convention file is opt-in by presence. The stderr notice prevents silent surprise. The discriminated source tag makes every transition testable and visible in `--print-config`. | Boolean "has-any" flag (rejected — loses provenance for `--print-config`); concatenate all sources (rejected — composition rules become unreasonable); refuse-to-launch when multiple sources present (rejected — too disruptive). |
| 6 | `--print-config` visibility | Renders `# user system prompt source` (always emitted; value is the literal source tag — `cli-inline`, `cli-file`, `env-inline`, `env-file`, `convention-file`, or `none`; path appended on a `# user system prompt path` line when the source is a file). When user text is non-empty, renders a `# user system prompt (append)` section above `# settings.json`. | Stable schema. Matches existing transparency for system prompt, settings, mcp, spawn args. Source tag is precise enough to debug precedence. | Summary-only (rejected — harder to debug content escaping or trimming); single combined line (rejected — `cli-inline:<text>` mixes provenance with content). |
| 7 | Combination strategy at the wire | Concatenate the harness prompt and the user append into the single existing envelope file `<envelopeDir>/system-prompt.md`, separated by a literal delimiter line `\n\n---\n# User-supplied supervisor prompt\n\n`. The file is still injected via `--append-system-prompt-file`. Spawn args are unchanged (one `--append-system-prompt-file <envelope-file>`, no second instance, no new Claude flag). | Keeps the spawn-arg surface unchanged. One file, one flag, one read by Claude Code. Avoids guessing whether Claude supports multiple `--append-system-prompt-file` instances. | Pass user append as a second `--append-system-prompt-file` (rejected — unknown multi-flag support, harder to test deterministically). |
| 8 | Empty / missing / encoding | Missing convention file → silent no-op. Missing CLI- or env-named file → fail launch with a typed error naming the source and path. Empty or whitespace-only content → source/path preserved but no append section emitted; `--print-config` still prints the source line, plus `# user system prompt path` for file sources, and an `(empty)` annotation on the source line. User append is read as **bytes**; the 64 KB cap is byte-based. UTF-8 decoding follows the same policy already used by the launcher's file reads (`readFile(..., 'utf8')` — Node's default replaces invalid UTF-8 sequences with U+FFFD; we do not change that). A leading UTF-8 BOM (`EF BB BF`) is stripped. `trimEnd` removes trailing whitespace/newlines. CRLF line endings inside the body are preserved (we do not normalize line endings). Leading Markdown (headings, lists) is preserved. | Loud failure when the user explicitly named a file (CLI or env); quiet absence when no one asked for one. Byte-based cap matches the real cost driver (token-budget bloat); BOM strip avoids zero-width artifacts in the prompt; CRLF preservation avoids surprise on Windows-edited files. | Always warn on missing convention file (rejected — defeats the zero-config goal); cap measured in code points (rejected — encoding-dependent and harder to reason about). |
| 9 | Suppression escape hatch | Flag `--no-append-system-prompt` short-circuits all resolution: it forces `source = 'none'`, suppresses CLI text/file, env text/file, and the convention file lookup. It is NOT an error when combined with any other append flag or env var — it overrides them. `--print-config` still prints `# user system prompt source\nnone`. | Lets users bypass repo-level conventions and inherited env settings for one-off debugging without renaming files or unsetting variables. Forcing `none` is the dominant intent of the flag — making the combination an error would defeat the escape-hatch use case. | Treat as parse error when combined with explicit sources (rejected — removes the primary use case: overriding a repo's convention file or a CI-injected env var). |
| 10 | Size cap | Reject user append larger than 64 KB after the byte-length is measured (post-BOM-strip but pre-trim). Error mentions the cap, the byte length, and the source tag + path. Boundary: exactly 65 536 bytes is accepted; 65 537 bytes is rejected. | Prevents accidental megabyte-scale prompt files from inflating every supervisor turn and consuming token budget. Today's harness prompt is ~5 KB, so 64 KB is ~13x headroom — plenty for project customization, small enough to refuse pathological inputs. | No cap (rejected — silent token-budget blowups). |
| 11 | Symlink handling | For the **auto-loaded convention file** only (the path the user did not type): `lstat` the path first; if it is not a regular file (e.g., symlink, directory, FIFO, socket, character device) refuse to read it, treat the source as absent (no append), and surface a single-line skip notice naming the path and the reason (e.g., `agent-orchestrator: skipping convention system-prompt file at <path>: not a regular file`). Do NOT fail the launch — this matches the silent-absence semantics for the convention file. The notice flows through the same `BuiltClaudeEnvelope.conventionSkipNotice` channel as the precedence-based skip notice (see Decision 5 / T4); `runClaudeLauncher` remains the single writer to `io.stderr`. The loader and resolver never write to stderr directly. For **explicit CLI-named or env-named paths** (`cli-file`, `env-file`), keep ordinary behavior: read with `fs/promises.readFile` (which follows symlinks) and trust the user-supplied path. | The user explicitly named the CLI/env file path — that's an opt-in to whatever it points at. The convention file is opt-in by presence only; an unexpected symlink (e.g., a malicious or stale link checked into a clone) deserves a refuse-and-notify rather than silently slurping arbitrary content into the supervisor prompt. Single-channel routing keeps `runClaudeLauncher` as the sole stderr writer. | Always follow symlinks (rejected — convention file is a zero-config attractor; symlink target surprises are real); refuse symlinks everywhere (rejected — would block legitimate dotfile setups that symlink CLI-named paths); separate `appendPromptNotice` field for the lstat case (rejected — splitting one stderr channel into two for the same "convention file skipped" semantics adds plumbing without a clear consumer benefit). |
| 12 | Public type contract | Keep the existing `ClaudeHarnessConfig.appendSystemPrompt?: string` field in `src/claude/config.ts` semantically unchanged (continues to mean "additional text appended by `buildClaudeHarnessConfig` callers", currently unused by the launcher path). Add NEW dedicated fields for the user append on both the input and the result, and on the built envelope: on `ClaudeHarnessConfigInput` add `userAppendSystemPrompt?: { source: AppendSource; path: string \| null; text: string \| null }`; on `ClaudeHarnessConfig` add `userSystemPromptSource: AppendSource`, `userSystemPromptPath: string \| null`, `userSystemPromptAppend: string \| null`; on `BuiltClaudeEnvelope` mirror those same three fields. `BuiltClaudeEnvelope.systemPrompt` continues to hold the full concatenated string written to disk. | Backwards-compatible. No existing callers of `appendSystemPrompt` change. The user-append provenance is exposed as first-class typed fields that downstream consumers (`--print-config`, future telemetry, tests) can read without parsing the concatenated prompt string. | Repurpose `appendSystemPrompt` (rejected — silently changes semantics for any external consumer that might rely on it). |
| 13 | Path resolution | `--append-system-prompt-file <path>` and `AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE` paths are resolved against the **resolved target cwd** (`ParsedClaudeLauncherArgs.cwd`), matching how profiles and skills are resolved in `parseClaudeLauncherArgs` (`src/claude/launcher.ts:118-123`). The convention file path is always `<resolvedCwd>/.agents/orchestrator/system-prompt.md`. Not `process.cwd()`, not `defaultCwd` directly. | Consistent with the existing profiles/skills resolution and with `--cwd` semantics: the target workspace is the source of truth, not the shell's CWD when the launcher happened to start. | Resolve against `process.cwd()` (rejected — diverges from existing options and breaks reproducible `--print-config` output when `--cwd` is used). |

## Scope

### In Scope
- New CLI options on `agent-orchestrator claude` (and `agent-orchestrator-claude`):
  `--append-system-prompt <text>`, `--append-system-prompt-file <path>`,
  `--no-append-system-prompt`.
- Env-var fallbacks: `AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT` (inline
  text) and `AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE` (path).
- Auto-loaded convention file at
  `<resolvedCwd>/.agents/orchestrator/system-prompt.md` (only when no
  higher-precedence source is in effect and `--no-append-system-prompt` is
  not set), with symlink/non-regular-file guard (Decision 11).
- Discriminated `AppendSource` discriminator and precedence resolution
  (Decision 5).
- Concatenation of harness prompt + delimiter + user append into the
  existing envelope `system-prompt.md` (Decision 7).
- Single-line stderr notice when a present convention file is preempted by
  a higher-precedence source, and when a convention file is refused because
  it is not a regular file (Decision 11).
- `--print-config` output gains a `# user system prompt source` line
  (always), a `# user system prompt path` line when applicable, and a
  `# user system prompt (append)` section when non-empty.
- New typed fields on `ClaudeHarnessConfigInput`, `ClaudeHarnessConfig`, and
  `BuiltClaudeEnvelope` (Decision 12).
- Tests covering parsing, precedence transitions, missing/empty/oversize
  handling, BOM/trim/CRLF, byte-based 64 KB boundary, envelope file
  contents, spawn args unchanged, `--print-config` rendering, and
  `--no-append-system-prompt` short-circuiting every other source.
- Help text and docs (`agent-orchestrator claude --help`, the
  `docs/development/` updates listed in T8, AGENTS.md note if relevant).

### Out Of Scope
- Worker run system prompts (start_run / send_followup payloads stay
  unchanged).
- Full replacement of the harness prompt.
- Variable interpolation / templating.
- Prepend slots.
- A profiles-manifest `supervisor.append_system_prompt` field.
- Codex/Cursor/CCS/OpenCode backends' own prompts.
- Changing the spawn-arg shape passed to Claude (still a single
  `--append-system-prompt-file <envelope-file>` and no new Claude flag).
- Hot-reload of the convention file mid-session.
- Hooks behavior changes — hooks are not touched by this work.
- Creating new `.agents/rules/` content (the Rule Candidates section is
  explicitly deferred — see below).

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | User append contradicts the harness isolation contract (e.g., "use Edit and WebFetch freely") | Append happens *after* the harness prompt; Claude tool surface is still restricted by `--tools` / `--allowed-tools` / `--permission-mode dontAsk`, so the wire-level allowlist is the authoritative gate regardless of prompt text. Documented explicitly. | T8 (docs); existing harness allowlist tests in `claudeHarness.test.ts`. |
| 2 | User append swells beyond reasonable size, consuming token budget per turn | 64 KB byte-based cap (Decision 10) with a clear typed error pointing at the source tag and path. Boundary test at exactly 65 536 / 65 537 bytes. | T7 unit test. |
| 3 | Convention file exists on a contributor's machine but not in CI / users' machines, causing prompt drift | Convention file is opt-in by *presence*. If a project wants it everywhere, they check it into the repo under `.agents/orchestrator/system-prompt.md`. Documented in `docs/development/` and in `--help`. | T8 (docs); T7 (convention file presence test). |
| 4 | User adds `--append-system-prompt-file` *after* `--` (intending Claude's flag) | Passthrough validator already rejects with a clear error pointing at the harness-owned surface (`src/claude/passthrough.ts:19-22`). Help text gains a one-liner pointing users at the launcher flag. | T8 (help text); existing passthrough test. |
| 5 | User provides both `--append-system-prompt` and `--append-system-prompt-file` | Parse error with a precise message: only one CLI inline/file source allowed. | T7 unit test. |
| 6 | User provides both `AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT` and `AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE` | Same parse error pattern as Risk 5: only one env inline/file source allowed. Symmetrical message. | T7 unit test. |
| 7 | `--no-append-system-prompt` combined with an explicit append flag, env var, or a present convention file | Per Decision 9, this is the **escape hatch** and not an error. The flag forces `source = 'none'` and suppresses all other sources. `--print-config` prints `# user system prompt source\nnone`. | T7 unit test (one combined test verifying suppression of CLI inline, CLI file, env inline, env file, and convention file). |
| 8 | Convention file is a symlink, directory, FIFO, or other non-regular file | `lstat` first; refuse to read; treat as absent and emit a single-line stderr notice naming the path and reason. Launch continues. CLI/env-named paths are read as-is and trust the user-supplied path (Decision 11). | T7 tests: convention is a symlink → skipped with notice; convention is a directory → skipped with notice; convention is a regular file → loaded normally. |
| 9 | UTF-8 BOM, trailing whitespace, CRLF line endings in user text | Strip a leading UTF-8 BOM; `trimEnd` trailing whitespace/newlines; preserve CRLF in the body; preserve leading content (headings, lists). | T7 unit tests (BOM stripped, trailing whitespace trimmed, CRLF preserved, leading Markdown preserved). |
| 10 | `--print-config` is used in CI to assert the supervisor envelope; existing snapshots/assertions might break | Always emit `# user system prompt source` (with the `none` sentinel) so the new line is stable. The `# user system prompt path` line and the append section are only emitted when applicable. | T7 print-config tests. |
| 11 | Downstream consumers of `BuiltClaudeEnvelope.systemPrompt` | The envelope's `systemPrompt` field continues to be the *full* concatenated string written to `<envelopeDir>/system-prompt.md` (harness + delimiter + user append, when present). The only existing consumers in `src/claude/launcher.ts` are `--print-config` (line 242) and the envelope-file write / spawn flow (lines 506, 587) — not the hooks pipeline. New typed fields `userSystemPromptSource`, `userSystemPromptPath`, `userSystemPromptAppend` are added for callers that want the user segment separately. | T3, T5, T7 (T7 adds an assertion that generated settings/hooks output is byte-identical to the no-append baseline, confirming hooks are unaffected). |
| 12 | Local Claude tmux smoke (AGENTS.md "Local Claude Tmux Smoke Testing") relies on the supervisor envelope behaving like prior runs | The wire shape (`--append-system-prompt-file`, `--tools`, `--allowed-tools`, `--permission-mode`) is unchanged. The smoke checklist already inspects the envelope path content, not a specific byte; it will continue to pass when no convention file is present in the test workspace. | T9 manual smoke note. |
| 13 | Stderr notice fires more than once per launch (e.g., once from resolver + once from envelope wiring) | The resolver returns `conventionSkipNotice: string \| null`; the envelope builder propagates it as `BuiltClaudeEnvelope.conventionSkipNotice`; `runClaudeLauncher` is the single place that writes it to `io.stderr`. Resolver and loader do not write to stderr themselves. | T7 unit test asserts the notice fires exactly once per launch, and only when both a higher-precedence source AND a present convention file existed before precedence applied. |
| 14 | Stderr writes from inside the resolver/loader couple them to I/O | Resolver is a pure function (Decision 12 + T2). The loader handles file I/O + size cap + BOM/trim but does not write to stderr — it surfaces failures via typed errors and surfaces the convention-skip notice via the resolver's return value. The launcher is the single writer to `io.stderr`. | T2, T4 acceptance criteria. |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T1 | Extend `ParsedClaudeLauncherArgs` + `parseClaudeLauncherArgs` with the new options and a structured `appendSource` discriminator | — | pending | Add fields: `appendInlineText: string \| null`, `appendFilePath: string \| null`, `appendInlineSource: 'cli' \| 'env' \| null`, `appendFileSource: 'cli' \| 'env' \| null`, `disableAppendSystemPrompt: boolean`. (Equivalent shape: a single `appendCandidates: { cliInline, cliFile, envInline, envFile }` plus the disable boolean. Pick whichever keeps the parser readable.) Reads `--append-system-prompt <text>`, `--append-system-prompt-file <path>`, `--no-append-system-prompt`, plus env-var fallbacks `AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT` and `AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE`. Conflicts (`--append-system-prompt` + `--append-system-prompt-file`; `AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT` + `..._FILE`) return `{ ok: false, error: ... }` with precise, symmetric messages. `--no-append-system-prompt` is **not** an error in combination with any other source — it is captured as `disableAppendSystemPrompt: true` and acted on by the resolver. File paths (`--append-system-prompt-file` value, env-var file value) are resolved against the resolved target cwd (matching profiles/skills resolution at `src/claude/launcher.ts:118-123`). Unit-tested per T7 (a). |
| T2 | Add `resolveSupervisorAppendPrompt()` pure helper in a new `src/claude/appendPrompt.ts` (or in `src/claude/config.ts` if it stays small) | T1 | pending | **Pure function** with no file I/O. Input: `{ cliInlineText, cliFilePath, envInlineText, envFilePath, conventionFilePresent, conventionFilePath, disable, loaded: { cliFile?: LoadedContent, envFile?: LoadedContent, convention?: LoadedContent } }` where `LoadedContent = { bytes: Buffer; path: string }`. Output: `{ source: AppendSource; path: string \| null; text: string \| null; conventionSkipNotice: string \| null }`. `AppendSource = 'cli-inline' \| 'cli-file' \| 'env-inline' \| 'env-file' \| 'convention-file' \| 'none'`. Behavior: if `disable` is true, return `{ source: 'none', path: null, text: null, conventionSkipNotice: null }` unconditionally. Otherwise apply Decision 5 precedence. When a higher-precedence source is in effect AND the convention file was present before precedence applied, set `conventionSkipNotice` to a single-line message naming the skipped convention path; otherwise null. For the selected source, decode bytes per Decision 8 (UTF-8 via the launcher's existing `readFile` policy; strip leading BOM; apply `trimEnd`; preserve CRLF body), then return the decoded text (or `null` when the result is empty/whitespace-only — but keep `source` and `path` set so `--print-config` can still report provenance with an `(empty)` annotation). Errors are returned as a typed sum (see "Errors" below), not thrown, so T4 can propagate cleanly. |
| T3 | Plumb the resolved append into `buildClaudeHarnessConfig` and `buildSupervisorSystemPrompt` | T2 | pending | `ClaudeHarnessConfigInput` gains `userAppendSystemPrompt?: { source: AppendSource; path: string \| null; text: string \| null }` (optional; defaults to `{ source: 'none', path: null, text: null }` semantics). `ClaudeHarnessConfig` gains three new fields: `userSystemPromptSource: AppendSource`, `userSystemPromptPath: string \| null`, `userSystemPromptAppend: string \| null`. The existing `appendSystemPrompt?: string` field is **preserved unchanged** (Decision 12) — no semantic change, no rename. `buildSupervisorSystemPrompt` appends the delimiter `\n\n---\n# User-supplied supervisor prompt\n\n` and the user text only when `text` is a non-empty string (Decision 7). When `text` is null or empty, the full system prompt is byte-identical to today's output. |
| T4 | Add `loadAppendPromptSource()` loader + wire `buildClaudeEnvelope` to call resolver, loader, propagate the convention-skip notice via `BuiltClaudeEnvelope`, and feed the resolved append into `buildClaudeHarnessConfig` | T1, T2, T3 | pending | `loadAppendPromptSource()` is the async I/O adapter: given a `{ kind: 'cli-file' \| 'env-file' \| 'convention-file'; path: string }`, it (a) for `convention-file`: `lstat` the path and refuse if not a regular file (return `{ kind: 'skipped-non-regular', path, reason }`); (b) for any kind: `readFile` returns bytes; enforce the 64 KB byte cap (post-BOM-strip, pre-trim); return `{ kind: 'loaded', path, bytes }`. Missing convention file → `{ kind: 'absent' }`. Missing CLI/env file → `{ kind: 'error', code: 'missing-file', source, path, message }`. `buildClaudeEnvelope` calls the loader for whichever sources are configured (skipping convention lookup entirely when `disable` is true), then calls `resolveSupervisorAppendPrompt` with the loaded contents, then feeds the result into `buildClaudeHarnessConfig`. `BuiltClaudeEnvelope` gains `userSystemPromptSource: AppendSource`, `userSystemPromptPath: string \| null`, `userSystemPromptAppend: string \| null`, and `conventionSkipNotice: string \| null`. **The `conventionSkipNotice` field is the single channel for any convention-file skip notice — both the precedence-based skip (Decision 5: higher-precedence source preempts a present convention file) and the lstat-based skip (Decision 11: convention path is not a regular file).** Exactly one of these can fire per launch — the lstat guard runs before the resolver, so if it skips, the resolver sees `convention-file` as absent and never produces a precedence notice for it. **The envelope builder does NOT write to stderr.** The single `<envelopeDir>/system-prompt.md` file holds the concatenated content. Spawn args list remains unchanged (still one `--append-system-prompt-file`, no second instance, no new Claude flag). Loader errors propagate up as a thrown typed error that `runClaudeLauncher` turns into an exit-1 with the typed message. |
| T5 | Extend `--print-config` output, help text in `runClaudeLauncher` / `claudeLauncherHelp`, and the convention-skip stderr write | T4 | pending | `runClaudeLauncher` is the **single writer** of the convention-skip notice: after `buildClaudeEnvelope` returns, if `built.conventionSkipNotice` is non-null write it to `io.stderr` followed by `\n`. `--print-config` output additions: always include `# user system prompt source\n<tag>\n` where `<tag>` is the literal `AppendSource` value (one of `cli-inline`, `cli-file`, `env-inline`, `env-file`, `convention-file`, `none`); when the source is `cli-file`, `env-file`, or `convention-file`, also include `# user system prompt path\n<resolved-path>\n`; when the resolved text is non-empty, append a `# user system prompt (append)\n<text>\n` section *above* `# settings.json`; when the source is set but text is empty/whitespace-only, annotate the source line as `<tag> (empty)`. Help text documents the three flags (`--append-system-prompt`, `--append-system-prompt-file`, `--no-append-system-prompt`), both env vars, the convention file path, the precedence rule, the 64 KB cap, and reminds users that `--append-system-prompt[-file]` *after* `--` is forbidden by the passthrough validator. |
| T6 | Update passthrough validator help-text reference if needed | T5 | pending | If the rejection message for `--append-system-prompt(-file)` after `--` would benefit from naming the new launcher flag, update the validator's error string in `src/claude/passthrough.ts` (the FORBIDDEN_FLAGS set at lines 19-22 is unchanged; only the error message wording may improve). No allowlist/denylist semantics change. |
| T7 | Tests | T1–T6 | pending | New unit tests in `src/__tests__/claudeHarness.test.ts` (or a new sibling file if it grows large) covering: **(a)** parser accepts each flag/env combo and resolves file paths against the resolved target cwd; **(b)** parser rejects `--append-system-prompt` + `--append-system-prompt-file` and rejects both env vars set simultaneously with precise symmetric messages (Risks 5, 6); **(c)** resolver precedence transitions: `cli-inline` preempts everything below; `cli-file` preempts env + convention; `env-inline` preempts convention; `env-file` preempts convention; convention selected only when nothing higher is set; `none` when nothing is set; (parse-error coverage for `env-inline` + `env-file` set together stays in T7 (b)); **(d)** missing CLI-named file errors out with the typed error; missing env-named file errors out with the typed error; **(e)** missing convention file is silent (no stderr write, no error); **(f)** byte-based 64 KB cap: exactly 65 536 bytes is accepted; 65 537 bytes is rejected with the exact error wording mentioning the cap, the byte length, and the source tag + path; **(g)** content normalization: leading UTF-8 BOM (`EF BB BF`) is stripped; trailing whitespace and newlines are trimmed; CRLF inside the body is preserved; leading Markdown (headings, lists) is preserved; **(h)** `buildSupervisorSystemPrompt` includes the delimiter + user text when present; when text is null/empty the full prompt is byte-identical to the no-append baseline; **(i)** the envelope writes one concatenated `system-prompt.md` and spawn args remain exactly `--append-system-prompt-file <envelope-file>` (no new flag, no second instance); **(j)** `--print-config` snapshots: source line emitted in all cases including `none`; path line emitted for file sources; append section only when non-empty; `(empty)` annotation when source set but text empty; **(k)** stderr convention-skip notice fires exactly once per launch and only when both a higher-precedence source AND a present convention file existed before precedence applied; **(l)** `--no-append-system-prompt` short-circuits every other source — covers (i) `--append-system-prompt`, (ii) `--append-system-prompt-file`, (iii) `AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT`, (iv) `AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE`, (v) a present convention file; in every case `source === 'none'` and no append section is emitted; **(m)** symlink/non-regular convention file: symlink → skipped with stderr notice; directory → skipped with stderr notice; regular file → loaded normally; CLI-named symlink is read normally (no refuse); env-named symlink is read normally; the lstat-skip notice is surfaced through `BuiltClaudeEnvelope.conventionSkipNotice` and written to `io.stderr` by `runClaudeLauncher` exactly once per launch (assert the stderr writer count is 1 and that the loader/resolver did not also write); when both a non-regular convention path and a higher-precedence source are present, only one notice (the lstat one) is emitted because the resolver sees the convention as absent; **(n)** hooks output unchanged: when a user append is present, the generated `settings.json` content (which carries hook config) is byte-identical to the no-append baseline. Use existing `mkdtemp` patterns. |
| T8 | Docs and help-text alignment | T5 | pending | Update `agent-orchestrator claude --help` (already in T5). Update `docs/development/mcp-tooling.md` — it already documents the Claude supervisor spawn flags and `--append-system-prompt-file` (see line 142); add a short subsection describing the new launcher flags, the env-var fallbacks, the convention file path, precedence, append-only semantics, the byte-based 64 KB cap, the symlink-refusal rule for the convention file, and that the harness allowlist is the authoritative tool gate regardless of prompt text. `docs/development/orchestrator-status-hooks.md` is listed here only as a *no-change* reference — hooks behavior is not touched (Risk 11) and the file does not need edits; mention it in the PR description only if a reviewer asks. Add a one-liner to AGENTS.md "Local Claude Tmux Smoke Testing" only if the smoke checklist needs to reference the new flag; otherwise skip. Add a one-line note in `docs/reference.md` if it lists supervisor flags. |
| T9 | Verify with the repository's release-quality check | T1–T8 | pending | Run `pnpm install --frozen-lockfile` then `pnpm verify`. Record command exit codes and key output lines (build OK, tests OK, npm-pack dry run OK, audit OK, dist-tag resolved) in the Execution Log section. Sync the AI workspace projection (`node scripts/sync-ai-workspace.mjs`) if any `.agents/` content was touched, and re-run `pnpm verify` after sync. |

### Errors (typed)

The resolver and loader use a discriminated error union (shape may live next
to `resolveSupervisorAppendPrompt` in `src/claude/appendPrompt.ts`):

```ts
type AppendPromptError =
  | { code: 'missing-file'; source: 'cli-file' | 'env-file'; path: string; message: string }
  | { code: 'oversize'; source: AppendSource; path: string | null; bytes: number; cap: number; message: string }
  | { code: 'read-failed'; source: AppendSource; path: string; cause: string; message: string };
```

The resolver returns `{ ok: true, value } | { ok: false, error: AppendPromptError }`.
`buildClaudeEnvelope` converts an `error` into a thrown `Error` whose
`message` is `error.message`; `runClaudeLauncher` catches at the existing
top-level and writes to `io.stderr` with exit code 1. Missing convention
file is **not** an error — the loader returns `{ kind: 'absent' }` and the
resolver treats it as "convention not present".

## Rule Candidates

**Status: deferred follow-up.** Creating `.agents/rules/` content is NOT
part of this implementation. The candidates below are recorded so future
work can pick them up if the pattern recurs; they do not gate T9.

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | "Append-only customization of supervisor system prompts" rule: never expose a path that lets user input replace or precede the harness contract; always concatenate after, and rely on the wire-level tool allowlist as the authoritative gate. | `.agents/rules/` (claude harness) | Only if a second similar instance appears (e.g., when extending to another backend) and is separately approved. |
| 2 | "Stable `--print-config` schema" rule: when adding a new envelope field, always emit a header line (with a sentinel value) so external snapshots remain stable. | `.agents/rules/` (release tooling) | Only if a second similar instance appears and is separately approved. |

## Quality Gates

- [ ] `pnpm build` succeeds with no new `tsconfig.json` looseness.
- [ ] `pnpm test` passes including new harness tests.
- [ ] `pnpm verify` passes (build + tests + publish-readiness + audit + dist-tag + `npm pack` dry run).
- [ ] `agent-orchestrator claude --help` documents the three flags, both env vars, convention file path, precedence, and 64 KB cap.
- [ ] `agent-orchestrator claude --print-config` always emits `# user system prompt source` (with `none` sentinel when no append is active).
- [ ] When a user append is present, generated `settings.json` content is byte-identical to the no-append baseline (hooks unaffected).
- [ ] `.agents/rules/node-typescript.md` requirements honored (pnpm, Node 22+, strict TS).
- [ ] If `.agents/` content changed: `node scripts/sync-ai-workspace.mjs` was re-run and projected `.claude/` / `.cursor/` artifacts are in sync.
- [ ] No new dependencies introduced.
- [ ] No secrets, credentials, or env-token reads added.

## Reviewer Questions

none

## Open Human Decisions

none

## Execution Log

### T1: Extend parser
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T2: Resolver helper
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T3: Plumb into config
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T4: Loader + envelope builder wiring
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T5: --print-config + help + stderr notice
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T6: Passthrough help alignment
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T7: Tests
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T8: Docs
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending

### T9: pnpm verify
- **Status:** pending
- **Evidence:** pending
- **Notes:** pending
