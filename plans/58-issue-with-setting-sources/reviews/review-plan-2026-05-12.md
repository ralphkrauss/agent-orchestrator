# Plan Review: Worker Project MCP Access

Date: 2026-05-12
Reviewer: Codex
Scope:
- `plans/58-issue-with-setting-sources/plan.md`
- `plans/58-issue-with-setting-sources/plans/58-worker-project-mcp-access.md`

## Findings

### High: `--setting-sources user,project,local` is broader than project MCP access

The plan frames the Claude change mostly as "load `.mcp.json` and maybe
`.claude/settings.json`" (`58-worker-project-mcp-access.md:63-66`,
`122-134`). Claude's current docs say scopes apply to settings, subagents, MCP
servers, plugins, and `CLAUDE.md`, with local > project > user precedence.

So when a project has `.mcp.json`, this plan would also let Claude workers load
project/local Claude memory and project subagents/plugins. That may be the
right product direction, but it is not called out as an accepted blast radius.
This matters because behavior changes only for projects with `.mcp.json`, so
the same worker profile may receive different instruction/plugin surfaces based
on whether MCP is configured.

Recommendation: add an explicit decision/risk that the Claude worker is opting
back into normal project/local Claude Code scope behavior, not just project MCP
servers. If that is not intended, reconsider `--mcp-config <cwd>/.mcp.json`
or another MCP-only path despite the extra implementation work.

### High: project `.mcp.json` is executable configuration and runs outside the model tool path

Project-scoped stdio MCP servers are local processes. The local Claude CLI help
for `mcp list` says the workspace trust dialog is skipped and stdio servers
from `.mcp.json` are spawned for health checks. A temp-dir probe on Claude Code
2.1.139 confirmed that `--setting-sources user,project,local` caused a
project `.mcp.json` stdio command to execute, while `--setting-sources user`
did not.

That does not make the plan wrong: workers are already trusted-local,
full-access processes. But this is still a distinct implication because MCP
server startup can happen as part of Claude/MCP initialization and not as a
visible Bash/Edit tool action. It also means those server processes inherit the
worker environment after the daemon's env policy is applied.

Recommendation: document this explicitly in Risks and in
`docs/development/mcp-tooling.md`: enabling project MCP for Claude workers
means trusting project `.mcp.json` command entries as executable local config.
Also state that secret-bearing entries must keep using
`scripts/mcp-secret-bridge.mjs`.

### Medium: T2's lifecycle event placement is underspecified and can become false telemetry

T2 says `prepareWorkerIsolation` should emit a lifecycle event
(`58-worker-project-mcp-access.md:141`). But `prepareWorkerIsolation` is called
from `ClaudeBackend.start()`/`resume()` while building a `WorkerInvocation`, and
`CliRuntime.buildStartInvocation()` also calls `backend.start()` to pre-bake a
retry invocation for Claude rotation before that invocation is necessarily
spawned (`src/backend/runtime.ts:102-112`, `src/orchestratorService.ts:973-999`).

If the backend appends the event directly from `prepareWorkerIsolation`, a
rotation resume could record `worker_setting_sources` for a fresh-chat retry
that never actually happened. It would also append before
`ProcessManager`'s normal `status: started` lifecycle marker.

Recommendation: either drop T2, or implement it as spawn-time telemetry owned
by the runtime/process manager, e.g. an optional `WorkerInvocation.initialEvents`
array persisted only when `ProcessManager.start()` actually spawns the attempt.
Add tests covering normal start/resume and the build-only retry-invocation path.

### Medium: the plan can appear to close #58 while codex/cursor remain unfixed

Issue #58 explicitly says this is needed for all backends. Decisions 6 and 7
make codex/cursor "audit + documentation only" unless a clean fix is discovered
(`58-worker-project-mcp-access.md:68-69`, `100-106`, `146-149`). That is a
reasonable engineering stance, but it should be represented as a partial
delivery, not a full issue fix, if the audits produce follow-up issues.

Recommendation: add an explicit release/closure rule: this plan may land a
Claude fix plus codex/cursor audit, but #58 stays open or is split unless the
codex and cursor worker gaps are actually resolved. Also move final
`pnpm verify` after T9/T10; today T6 runs before the codex/cursor audit docs
and optional fixes, so it is not a final verification gate for the full plan.

### Low: codex audit acceptance mentions flags that are not present in current help

T7 asks the execution log to capture `--config-file` / `--config-dir`
possibilities (`58-worker-project-mcp-access.md:146`). On local `codex-cli
0.130.0`, `codex exec --help` exposes `-c/--config`, `--profile`, `--cd`,
`--ignore-user-config`, and `--ignore-rules`, but no `--config-file` or
`--config-dir`.

Recommendation: keep the audit, but phrase T7 as "capture the config-loading
surface, including whether any config-file/config-dir flag exists" rather than
expecting those flags.

## Overall Assessment

The Claude direction is probably the right narrow first step if the product
goal is "workers behave more like normal Claude Code sessions in trusted
project worktrees." The main gap is that the plan describes the change as MCP
access, while the chosen mechanism restores broader project/local Claude Code
scope behavior. That should be an explicit product decision, not an incidental
side effect.

I would revise the plan before implementation, mostly around the blast-radius
decision and T2 event placement.

## Product Direction Addendum

After follow-up clarification, the desired product behavior is:

> The orchestrator/supervisor is the restricted agent. Worker agents are
> trusted execution agents and should have the same practical access the user
> would get when launching the same backend manually in the project: normal
> network posture, normal project/user configuration, and normal MCP access.

This changes the plan framing. The implementation should not be described as a
small MCP exception inside a generally isolated worker envelope. It should be
described as restoring backend-native worker parity while keeping the
orchestrator envelope curated.

Recommended plan rewrite:

- **Claude workers:** default to normal project/user/local Claude Code sources
  for workers, not only when `.mcp.json` exists. The supervisor remains on its
  curated `--strict-mcp-config` / restricted-tool envelope. Keep
  `--permission-mode bypassPermissions` so non-interactive workers do not
  stall. Re-decide `disableAllHooks: true` explicitly: keeping it preserves
  daemon hook isolation, while removing it is closer to exact manual parity.
- **Codex workers:** default toward user/project config parity, not
  `--ignore-user-config`. The current `codex_network: isolated` default is the
  opposite of the clarified product goal for general-purpose workers. Isolation
  should become a profile opt-in, not the default posture.
- **Cursor workers:** prefer the backend surface that best matches a manual
  Cursor worker. If the SDK cannot prove parity for project/global MCP,
  `cursor-agent` CLI should become the worker runtime or an explicit runtime
  option.

The revised acceptance criterion for #58 should be: a worker can see the same
backend-native project MCP/tools/config that a manual trusted run would see,
unless a profile explicitly opts into a stricter worker posture.

## Documentation Verification Addendum

I checked the upstream tool documentation online on 2026-05-12:

- Claude Code: settings, MCP, and CLI reference docs.
- OpenAI Codex: configuration basics, MCP, approvals/security, and
  configuration reference docs.
- Cursor: CLI usage, CLI MCP, MCP overview, headless CLI, and TypeScript SDK
  docs.
- Local CLI help for the installed tools: Claude Code 2.1.139,
  `codex-cli 0.130.0`, and the installed `cursor-agent`.

### High: worker parity should be the default contract, not a Claude-only MCP exception

The docs for all three backends describe layered project/user configuration
that affects more than MCP. Claude's `--setting-sources` controls project/user
settings surfaces; Codex loads trusted project `.codex/config.toml` plus user
`~/.codex/config.toml`; Cursor CLI and SDK both have documented project/user
configuration and MCP loading paths.

So the plan should not gate worker parity on the presence of a Claude
`.mcp.json`, and it should not treat Codex/Cursor as audit-only unless the issue
is explicitly split. The correct product shape is:

- The orchestrator/supervisor stays tightly controlled.
- Workers default to trusted backend-native project/user access.
- Stricter isolation is an explicit profile option.

### High: Codex has enough documented surface to implement, not just audit

Codex docs confirm that configuration precedence includes CLI overrides,
profiles, trusted project `.codex/config.toml`, user config, system config, and
defaults. They also confirm that MCP servers live in `config.toml`, including
project-scoped `.codex/config.toml` for trusted projects, and that CLI and IDE
share this configuration.

The current plan's Codex direction conflicts with the clarified goal if it
keeps `--ignore-user-config` or defaults `codex_network` to `isolated`. Codex's
default `workspace-write` sandbox has network disabled unless
`[sandbox_workspace_write].network_access = true`, while full no-prompt network
and filesystem access requires `danger-full-access` or the documented bypass
flag. The plan should decide whether trusted workers inherit user/project Codex
configuration exactly, or whether the orchestrator passes a documented trusted
worker profile. It should not silently force the isolated posture.

### High: Cursor also has enough documented surface to implement, not just audit

Cursor CLI docs say the CLI uses the same MCP configuration as the editor,
discovers project/global/nested MCP configuration, exposes `agent mcp list`,
`agent mcp list-tools`, `agent mcp login`, `agent mcp enable`, and
`agent mcp disable`, and supports `--approve-mcps` for non-interactive MCP
approval. Local help also shows `--workspace`, `--trust`, `--sandbox`,
`--force`/`--yolo`, `--print`, and structured output flags.

Cursor SDK docs also contradict the assumption that the SDK has no usable
configuration/MCP surface. `Agent.create()` supports `local.cwd`,
`local.settingSources`, `local.sandboxOptions`, and inline `mcpServers`.
`local.settingSources` can select ambient `project`, `user`, `team`, `mdm`,
`plugins`, or `all` settings layers. The docs do warn that inline
`mcpServers` are not persisted across `Agent.resume()`, so file-based ambient
settings are the better parity path when possible.

T8 should therefore become an implementation decision:

- Keep the SDK backend and set `local.settingSources` for worker parity, with
  focused tests around project/user MCP discovery and resume behavior.
- Or add/switch to a Cursor CLI worker runtime using `agent -p --workspace`,
  `--trust`, `--approve-mcps`, and the profile-selected sandbox/force flags.

### Medium: Claude project MCP approval must be handled explicitly

Claude docs state that project-scoped MCP servers live in `.mcp.json`, are
intended to be checked into the repo, and require approval before use. Claude
settings also include `enableAllProjectMcpServers`, `enabledMcpjsonServers`,
and `disabledMcpjsonServers`.

Because workers are non-interactive, the plan should not rely on a project MCP
approval prompt appearing at runtime. For the clarified trusted-worker model,
the plan should either enable all project MCP servers for workers, carry through
the user's local approval state intentionally, or define a profile-level
allowlist. The chosen behavior should be documented because `.mcp.json` can
launch local stdio server commands.

### Medium: "network access" needs a backend-specific profile contract

The tools do not expose one identical network switch:

- Codex documents network-off defaults in `workspace-write`, a config key to
  enable network there, and full-access flags for no-prompt trusted operation.
- Cursor exposes CLI sandbox and force controls, and its headless docs describe
  `--force` as the way to allow direct file changes in scripts. MCP has its own
  approval path via `--approve-mcps`.
- Claude's relevant documented controls here are settings sources, MCP approval
  state, tool availability, and permission mode.

The plan should name the worker posture, e.g. `trusted` / `manual-parity` versus
`restricted`, and map that posture per backend. Otherwise "same access as a
manual run" will keep being interpreted differently by each backend.

### Low: update acceptance criteria and tests around all backends

The revised plan should add acceptance checks for:

- Claude worker sees project/user/local MCP and settings as intended; supervisor
  remains restricted.
- Claude project MCP approval behavior is deterministic in non-interactive
  workers.
- Codex worker loads trusted project/user config and project/user MCP without
  `--ignore-user-config` in the default trusted posture.
- Codex network posture follows the selected worker profile, not the old
  isolated default.
- Cursor worker loads project/global MCP through either SDK `settingSources` or
  the Cursor CLI path, including non-interactive MCP approval behavior.

### Sources Checked

- https://code.claude.com/docs/en/settings
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/cli-reference
- https://developers.openai.com/codex/config-basic#configuration-precedence
- https://developers.openai.com/codex/mcp#connect-codex-to-an-mcp-server
- https://developers.openai.com/codex/agent-approvals-security#network-access
- https://developers.openai.com/codex/config-reference#configtoml
- https://cursor.com/docs/cli/using
- https://cursor.com/docs/cli/mcp
- https://cursor.com/docs/mcp
- https://cursor.com/docs/cli/headless
- https://cursor.com/docs/sdk/typescript
