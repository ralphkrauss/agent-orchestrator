# Fix MCP Secret Fallback And Stale AI Projection Checks

Branch: `3-fix-mcp-secret-fallback-and-stale-ai-workspace-projection-checks`
Plan Slug: `mcp-secret-fallback-stale-ai-projection-checks`
Parent Issue: #3
Created: 2026-05-02
Status: implemented; package verification blocked

## Context

GitHub issue #3, "Fix MCP secret fallback and stale AI workspace projection checks", reports two tooling regressions:

- A blank `GITHUB_TOKEN=` entry in the user-level `mcp-secrets.env` template can mask a non-blank exported `GITHUB_TOKEN`.
- `node scripts/sync-ai-workspace.mjs --check` can miss stale generated projection files after canonical `.agents/` files are deleted or renamed.

Context sources read:

- `AGENTS.md`: repository scripts are `pnpm build`, `pnpm test`, and `pnpm verify`; secret changes must not add real tokens; generated Claude/Cursor projections come from `.agents/`.
- GitHub issue #3: acceptance criteria require blank secret fallback, `github` profile mapping to `GITHUB_PERSONAL_ACCESS_TOKEN`, stale checks for `.claude/skills/`, `.claude/rules/`, `.claude/agents/`, and `.cursor/rules/`, and focused tests or reproducible verification.
- `.agents/rules/node-typescript.md`: use `pnpm`, Node.js 22+, Node built-ins, and existing scripts.
- `.agents/rules/mcp-tool-configs.md`: secret-bearing MCP entries must use `scripts/mcp-secret-bridge.mjs`; canonical `GITHUB_TOKEN` may map to child names; never commit real secrets.
- `.agents/rules/ai-workspace-projections.md`: `.agents/` is canonical; generated projections under `.claude/` and `.cursor/rules/` are not edited manually; drift check is `node scripts/sync-ai-workspace.mjs --check`.
- `scripts/init-mcp-secrets.mjs`: creates a user-level template with `GITHUB_TOKEN=` and documents that blank values fall back to process env and then `gh auth token`.
- `scripts/mcp-secret-bridge.mjs`: currently builds `secrets` with `{ ...process.env, ...fileSecrets }`, so a blank file value overrides a non-blank environment value before profile mappings and required-secret checks.
- `docs/development/mcp-tooling.md`: documents credential resolution through the secrets file, process environment, then `gh auth token`, and maps `GITHUB_TOKEN` to `GITHUB_PERSONAL_ACCESS_TOKEN` for the `github` profile.
- `scripts/sync-ai-workspace.mjs`: mutating sync cleans generated targets, but `--check` skips cleanup and only compares expected paths from existing `.agents/` sources, so extras under generated dirs are not reported.
- `docs/ai-workspace.md`: documents `node scripts/sync-ai-workspace.mjs --check` as the projection drift check.
- Existing tests under `src/__tests__/`: use Node's built-in `node:test` and are compiled to `dist/` by `pnpm build`; `pnpm test` runs `dist/__tests__/*.test.js` and integration tests.

No nested `AGENTS.md` files were found inside this worktree. No existing `plans/` directory or branch plan existed before this plan was created.

## Decisions

| # | Decision | Choice | Rationale | Rejected Alternatives |
|---|---|---|---|---|
| 1 | Blank secret semantics | Treat blank or whitespace-only values from `mcp-secrets.env` as unset for fallback purposes. Preserve non-blank file values as higher precedence than process env. | Matches `init-mcp-secrets.mjs`, issue #3, and docs: the template `GITHUB_TOKEN=` must not disable exported or `gh` tokens. | Switching all precedence to environment before file would contradict documented source order. Treating blank file values as an explicit clear would contradict the template comments and issue acceptance criteria. |
| 2 | MCP profile mapping | Keep profile mappings driven by canonical `GITHUB_TOKEN`, and ensure aliases such as `GH_TOKEN` and `gh auth token` can populate that canonical value before required-secret checks. | Keeps existing public profile contracts while fixing the bug that blocks `github` profile startup with a template secrets file. | Adding profile-specific fallback logic would duplicate secret resolution and make future profile mappings harder to reason about. |
| 3 | Projection stale detection | In `--check`, compute expected generated paths and compare them with existing files under `.claude/skills/`, `.claude/rules/`, `.claude/agents/`, and `.cursor/rules/`; report extras without deleting them. | Detects stale projections from deleted or renamed canonical files while keeping `--check` read-only. | Running cleanup in `--check` would be surprising and mutating. Only comparing expected outputs preserves the current bug. |
| 4 | Test strategy | Add focused Node test coverage under `src/__tests__/` that copies the affected scripts into temporary fixture roots and invokes them as subprocesses with dummy environment values. | Keeps tests in the existing build/test pipeline, avoids mutating real generated projections, and avoids real secrets. | Manual-only verification would be weaker. Testing against the repo's real `.claude/` and `.cursor/` trees would risk dirty worktree side effects. |
| 5 | Documentation | Keep existing docs accurate; update script comments or docs only if implementation changes make current wording incomplete. | The intended behavior is already documented, so the main defect is implementation drift. | Rewriting MCP or AI workspace documentation without a behavior change would add churn. |

## Scope

### In Scope

- Fix `scripts/mcp-secret-bridge.mjs` so blank file secrets do not mask non-blank process env secrets.
- Preserve non-blank user-level secrets file precedence over process env.
- Preserve `GITHUB_TOKEN`/`GH_TOKEN` alias behavior and `gh auth token` fallback.
- Verify the `github` profile maps exported `GITHUB_TOKEN` to `GITHUB_PERSONAL_ACCESS_TOKEN` when the secrets file contains `GITHUB_TOKEN=`.
- Fix `scripts/sync-ai-workspace.mjs --check` so it reports stale generated files under:
  - `.claude/skills/`
  - `.claude/rules/`
  - `.claude/agents/`
  - `.cursor/rules/`
- Add focused tests for both script behaviors using temporary fixtures and dummy token values.
- Review docs and comments for accuracy after implementation.

### Out Of Scope

- Adding, removing, or renaming MCP profiles.
- Changing MCP client config files unless a test proves the scripts require it.
- Writing, reading, or modifying real user secrets.
- Passing real tokens through command arguments, docs, examples, or test fixtures.
- Activating or deactivating git hooks.
- Changing the canonical `.agents/` source model.
- Manually editing generated `.claude/` or `.cursor/rules/` projection files except through `node scripts/sync-ai-workspace.mjs` if implementation work requires regeneration.
- Publishing, committing, pushing, or writing to external services.

## Risks And Edge Cases

| # | Scenario | Mitigation | Covered By |
|---|---|---|---|
| 1 | A user has `GITHUB_TOKEN=` in the secrets file and a valid exported `GITHUB_TOKEN`. | Treat blank file values as unset, then use the exported value. | T1, T2 |
| 2 | A user has a non-blank token in the secrets file and a different exported token. | Preserve documented file precedence by using the non-blank file value. | T2, T5 |
| 3 | Only `GH_TOKEN` is exported. | Preserve alias normalization so `GITHUB_TOKEN` can be populated from `GH_TOKEN` before profile checks. | T2, T5 |
| 4 | No file or env token exists, but `gh auth token` succeeds. | Keep existing `gh auth token` fallback behavior. | T2, T5 |
| 5 | Canonical `.agents/skills/foo/` is deleted but `.claude/skills/foo/SKILL.md` remains. | Compare existing `.claude/skills/` files against an expected set during `--check`. | T1, T3 |
| 6 | Canonical rule or agent files are renamed, leaving old `.claude` or `.cursor` projection files. | Compare generated rule and agent directories against expected target filenames. | T1, T3 |
| 7 | `--check` accidentally mutates generated directories while reporting stale files. | Keep cleanup in mutating mode only; tests assert check mode reports drift without deleting stale files. | T1, T3 |
| 8 | Stale detection flags unrelated files in generated directories. | Limit checks to documented generated directories and generated file extensions where projections are extension-specific. | T3 |
| 9 | Tests leak tokens into process output or repository files. | Use dummy values, temp secrets files, subprocess exit assertions, and no real token reads. | T1, T5 |

## Implementation Tasks

| Task ID | Title | Depends On | Status | Acceptance Criteria |
|---|---|---|---|---|
| T1 | Add focused regression tests for workspace scripts | None | completed | A new `src/__tests__/workspaceScripts.test.ts` or equivalent uses temp directories and subprocesses; one test proves `github` profile receives `GITHUB_PERSONAL_ACCESS_TOKEN` from exported `GITHUB_TOKEN` when the secrets file contains `GITHUB_TOKEN=`; one test proves `sync-ai-workspace.mjs --check` reports stale files in all four generated projection locations without mutating the fixture. |
| T2 | Fix MCP secret fallback resolution | T1 | completed | `scripts/mcp-secret-bridge.mjs` treats blank file entries as unset; non-blank file secrets still override process env; `GITHUB_TOKEN` and `GH_TOKEN` aliases still normalize; required-secret checks run after fallback resolution; no secret values are printed. |
| T3 | Fix AI workspace stale projection detection | T1 | completed | `scripts/sync-ai-workspace.mjs --check` reports extra generated files under `.claude/skills/`, `.claude/rules/`, `.claude/agents/`, and `.cursor/rules/`; check mode does not delete files; normal sync mode continues to clean and regenerate projections; drift output uses repo-relative paths and deterministic ordering. |
| T4 | Review docs and inline comments | T2, T3 | completed | `docs/development/mcp-tooling.md`, `docs/ai-workspace.md`, and script comments remain accurate; any wording updates avoid real tokens and keep existing public behavior clear. |
| T5 | Run focused and release-relevant verification | T2, T3, T4 | blocked | `pnpm build` passes; `pnpm test` passes; `node scripts/sync-ai-workspace.mjs --check` passes on the real workspace; consider `pnpm verify` if final PR confidence or release readiness is requested. Evidence is recorded with concrete command results. |

## Rule Candidates

| # | Candidate | Scope | Create After |
|---|---|---|---|
| 1 | None currently. Existing `mcp-tool-configs` and `ai-workspace-projections` rules cover the required behavior. | N/A | N/A |

## Quality Gates

- [ ] `pnpm build` passes. Blocked: `tsc` is unavailable because `node_modules` is absent.
- [ ] `pnpm test` passes. Blocked as meaningful package verification until `pnpm build` can produce `dist/`; current `pnpm test` exits 0 with zero discovered tests because `dist/` is absent.
- [x] `node scripts/sync-ai-workspace.mjs --check` passes.
- [x] Relevant `.agents/rules/` checks are satisfied:
  - [x] No real tokens or repo-local secret files are introduced.
  - [x] Secret-bearing behavior remains in `scripts/mcp-secret-bridge.mjs`.
  - [x] `.agents/` remains canonical for AI workspace projections.
  - [x] Generated `.claude/` and `.cursor/rules/` files are not manually edited.

## Execution Log

### T1: Add focused regression tests for workspace scripts
- **Status:** completed
- **Evidence:** Added `src/__tests__/workspaceScripts.test.ts` with subprocess tests for blank-template `GITHUB_TOKEN=` fallback and stale generated projection reporting across `.claude/skills/`, `.claude/rules/`, `.claude/agents/`, and `.cursor/rules/`.
- **Notes:** `pnpm build` was attempted for TypeScript verification, but failed before compiling because `node_modules` is absent and `tsc` is not installed in this worktree.

### T2: Fix MCP secret fallback resolution
- **Status:** completed
- **Evidence:** Updated `scripts/mcp-secret-bridge.mjs` so `loadSecrets()` starts from `process.env` and overlays only non-blank entries from `mcp-secrets.env`; ran a temp-file subprocess check that verified blank `GITHUB_TOKEN=` falls back to exported `GITHUB_TOKEN` and non-blank file `GITHUB_TOKEN` still overrides the exported value.
- **Notes:** Verification used dummy token strings and did not print or persist real secrets.

### T3: Fix AI workspace stale projection detection
- **Status:** completed
- **Evidence:** Updated `scripts/sync-ai-workspace.mjs` to track expected generated paths and, in `--check`, report unexpected files in `.claude/skills/`, top-level `.claude/rules/*.md`, top-level `.claude/agents/*.md`, and top-level `.cursor/rules/*.mdc`; ran a temp-fixture subprocess check that verified stale files in all four locations were reported and remained on disk.
- **Notes:** Drift output is sorted before reporting for deterministic check output.

### T4: Review docs and inline comments
- **Status:** completed
- **Evidence:** Updated `scripts/mcp-secret-bridge.mjs`, `scripts/init-mcp-secrets.mjs`, and `docs/development/mcp-tooling.md` to clarify that non-blank secrets-file values override process env and blank template entries fall through; reviewed `docs/ai-workspace.md` and no projection wording changes were needed.
- **Notes:** `rg` review found only dummy test values and documented variable names; no real tokens, repo-local secret files, MCP config changes, or generated projection edits were introduced.

### T5: Run focused and release-relevant verification
- **Status:** blocked
- **Evidence:** `node --check scripts/mcp-secret-bridge.mjs` passed; `node --check scripts/sync-ai-workspace.mjs` passed; temp subprocess check verified blank `GITHUB_TOKEN=` fallback to exported `GITHUB_TOKEN`; temp subprocess check verified stale generated files in all four projection locations are reported and not deleted; `node scripts/sync-ai-workspace.mjs --check` passed with "AI workspace projections are in sync."; `pnpm build` failed before compiling with `sh: 1: tsc: not found` and `node_modules missing`; `pnpm test` exited 0 but reported zero tests because `dist/` is absent.
- **Notes:** Did not run `pnpm install --frozen-lockfile` because repository instructions require explicit approval before installing packages. `pnpm verify` was not run because it depends on the blocked build/test toolchain.

## Hardening Pass

- Searched for the old `{ ...process.env, ...fileSecrets }` merge pattern and found no remaining instances.
- Confirmed no generated `.claude/`, `.cursor/rules/`, or canonical `.agents/` projection files were changed.
- Reviewed the diff for docs, scripts, and tests; only documented variable names and dummy test token values are present.

## Residual Risks And Deferred Work

- Package-level TypeScript and compiled test verification is still required after dependencies are installed with `pnpm install --frozen-lockfile`.
- `pnpm verify` remains deferred until `pnpm build` and `pnpm test` can run against the compiled `dist/` output.
