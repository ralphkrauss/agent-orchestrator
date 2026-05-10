# Open Source Readiness Direction

Date: 2026-05-10

This document is a handoff plan for polishing `@ralphkrauss/agent-orchestrator`
into a project that feels ready to share with outside users and contributors.

The repository is already well beyond a prototype: it has npm metadata, an MIT
license, TypeScript strictness, CI, release workflows, published npm versions,
and a large test suite. The remaining work is mostly about trust, first-run
clarity, public maintenance signals, and cross-platform confidence.

## Current Baseline

- GitHub repo: `https://github.com/ralphkrauss/agent-orchestrator`
- npm package: `@ralphkrauss/agent-orchestrator`
- Current local commit inspected: `4d1de7d4526cb1990edbd3604f6c9ca5903ef4fe`
- Current npm latest inspected: `0.2.2`
- Node engine: `>=22`
- Package manager: `pnpm@10.30.3`
- License: MIT

Important: before any public push, make `pnpm verify` pass on a clean checkout.
At the time this plan was written, a clean local verification run failed:

```text
tests 553
pass 541
fail 10
skipped 2
```

The failures were concentrated in:

- `claudeRotation.test.js`: rotation/session JSONL copy behavior
- `diagnostics.test.js`: Windows cmd shim version checks
- `gitSnapshot.test.js`: macOS `/private/var` vs `/var` path normalization
- `opencodeHarness.test.js`: macOS `/private/var` vs `/var` path normalization
- `processManager.test.js`: terminal finalization failure settling

Treat those as release blockers unless later CI proves they are local-only and
the reason is documented.

## Target Outcome

The repo should give a new visitor these signals within the first few minutes:

1. They understand what the project does and whether it is for them.
2. They can install it and run one safe diagnostic command.
3. They can configure one MCP client and see one successful flow.
4. They understand the security model and local-credential boundaries.
5. They can report issues or contribute without guessing the workflow.
6. CI and local verification agree across supported platforms.

## Work Plan

### 1. Make The Verification Baseline Green

Goal: `pnpm verify` must pass locally and in CI from a clean clone.

Tasks:

- Reproduce the current failures with `pnpm install --frozen-lockfile` and
  `pnpm verify`.
- Fix or explicitly quarantine the failing tests.
- Normalize temporary paths on macOS where tests compare `/var/...` and
  `/private/var/...`.
- Investigate the Claude rotation/session-copy failures as product behavior,
  not just test failures.
- Investigate `ProcessManager` completion settling when terminal finalization
  throws.
- Add narrower regression tests for any fixed behavior.

Acceptance criteria:

- `pnpm verify` passes locally on macOS.
- Existing Ubuntu CI remains green.
- No test is skipped without a short comment explaining why and what issue
  tracks re-enabling it.

### 2. Add Real Cross-Platform CI

Goal: CI should match the platform support claimed in the README.

Current state:

- `.github/workflows/ci.yml` runs on Ubuntu only.
- README documents Linux, macOS, and Windows behavior.

Tasks:

- Add a CI matrix for `ubuntu-latest`, `macos-latest`, and `windows-latest`.
- Keep Node versions `22` and `24` if runtime coverage remains valuable.
- If Windows cannot run the full suite immediately, split CI into:
  - Full suite on Ubuntu/macOS.
  - Build plus Windows-specific smoke tests on Windows.
- Add a packed-tarball smoke test on each supported OS where practical.

Acceptance criteria:

- Pull requests show platform-specific status checks.
- The README support claims match the CI matrix.
- Any platform caveats are documented in the README and `CONTRIBUTING.md`.

### 3. Rewrite The README Around First-Time Success

Goal: the README should be a landing page, not the full reference manual.

Current state:

- `README.md` is about 830 lines.
- It contains valuable details, but too much operational and reference content
  appears before a newcomer gets a simple success path.

Suggested README structure:

1. Project name and one-sentence value proposition.
2. Short "What it does" section.
3. "Who this is for" and "What this does not do".
4. Install.
5. Five-minute quickstart.
6. Supported backends: Codex, Claude, Cursor.
7. MCP client configuration examples.
8. Security model summary.
9. Development and contribution links.
10. Links to reference docs.

Tasks:

- Move long reference sections into `docs/`.
- Keep the top-level README focused on install, quickstart, concepts, and links.
- Add expected output snippets for `doctor` and one successful run.
- Make the first backend path explicit. For example, choose Codex or simulated
  diagnostics as the easiest starting point.

Acceptance criteria:

- A new user can read the first 150 lines and understand how to try the project.
- Detailed tables and long backend-specific notes live in `docs/`.
- README links are checked manually after restructuring.

### 4. Add A "First Successful Run" Guide

Goal: remove ambiguity from the first usable experience.

Tasks:

- Add `docs/quickstart.md` or `docs/first-run.md`.
- Include copy-paste commands for:
  - install via `npx`
  - `doctor`
  - one MCP client config
  - one worker profile
  - one `start_run`
  - inspecting status and result
  - stopping or restarting the daemon
- Include expected success output and common failure output.
- Include a "no model call" diagnostic path for cautious users.

Acceptance criteria:

- A user with Node 22+ can complete the guide without reading implementation
  docs.
- The guide clearly states which steps require Codex, Claude, Cursor, or API
  credentials.
- The guide avoids asking users to paste secrets into prompts or MCP arguments.

### 5. Add Contributor And Maintainer Files

Goal: make the project feel open to participation and reduce support friction.

Add these files:

- `CONTRIBUTING.md`
- `SECURITY.md`
- `SUPPORT.md` or a support section in `CONTRIBUTING.md`
- `.github/ISSUE_TEMPLATE/bug_report.yml`
- `.github/ISSUE_TEMPLATE/feature_request.yml`
- `.github/PULL_REQUEST_TEMPLATE.md`
- Optional: `CODE_OF_CONDUCT.md`

`CONTRIBUTING.md` should include:

- Supported Node and pnpm versions.
- Setup commands.
- Local verification commands.
- How to run a focused test.
- How to test packed npm output.
- How to handle external CLIs in tests.
- Coding style expectations.
- Release behavior: contributors should not publish.

`SECURITY.md` should include:

- How to report vulnerabilities.
- Supported versions.
- The local trust model.
- Warnings about prompts, credentials, daemon IPC, run-store files, and worker
  process privileges.

Acceptance criteria:

- A first-time contributor can open a PR without needing private context.
- Security-sensitive reports have a clear private reporting path.
- Issue templates collect OS, Node version, package version, backend, MCP client,
  command run, and relevant logs.

### 6. Set GitHub Repository Metadata

Goal: the GitHub page should look intentional before users read a file.

Current GitHub metadata inspected:

- Description: empty
- Homepage: empty
- Topics: empty
- Issues: enabled
- Discussions: disabled

Tasks:

- Add a concise GitHub description, for example:

  ```text
  Local MCP orchestrator for supervising Codex, Claude, Cursor, and OpenCode worker runs.
  ```

- Add topics such as:

  ```text
  mcp, model-context-protocol, agent-orchestration, codex-cli,
  claude-code, cursor, opencode, typescript, nodejs
  ```

- Set homepage to the npm page or README.
- Decide whether to enable GitHub Discussions. If enabled, add categories for
  questions, ideas, and show-and-tell.

Acceptance criteria:

- GitHub repo header explains the project without opening the README.
- Topics make the repo discoverable.
- The chosen support channel is documented.

### 7. Clean Up Release Notes And Public Version History

Goal: release notes should tell users what changed in published versions.

Current state:

- `CHANGELOG.md` begins with an `Unreleased` breaking-change section, while
  npm `latest` is already `0.2.2`.

Tasks:

- Convert shipped changes into versioned sections such as `0.2.2 - YYYY-MM-DD`.
- Keep `Unreleased` only for work not yet published.
- Make breaking changes easy to scan.
- Link migration docs from the relevant version entry.
- Keep implementation details out of top-level changelog unless they affect
  users, contributors, or operators.

Acceptance criteria:

- A user upgrading from npm can map their installed version to release notes.
- Breaking changes are clearly marked under the version that introduced them.
- `PUBLISHING.md` and `CHANGELOG.md` agree on release process and dist-tags.

### 8. Decide What To Do With Internal Planning Artifacts

Goal: keep valuable dogfooding material without overwhelming outside visitors.

Current state:

- The repo includes many `plans/` records, review artifacts, `.agents`,
  `.claude`, `.cursor`, and MCP config files.
- This may be intentional, but it makes the public tree look more like an
  internal workspace than a focused open-source package.

Options:

- Keep them, but add a short "Repository map" section explaining why they exist.
- Move old plans to `docs/internal-plans/` or `archive/plans/`.
- Keep only active public-facing plans in the repo.
- Exclude generated tool projections if they are not required for users.

Tasks:

- Decide which files are product docs, contributor docs, dogfood config, or
  historical artifacts.
- Add `docs/repository-map.md`.
- Link that map from README or CONTRIBUTING.
- Ensure no private data, tokens, local paths, or stale PR snapshots are present.

Acceptance criteria:

- A visitor can tell which files matter for normal use.
- Internal AI workflow files do not distract from package usage.
- No sensitive or confusing historical artifacts remain unexplained.

### 9. Add Badges And Public Health Signals

Goal: give visitors quick confidence signals.

Tasks:

- Add README badges for:
  - CI status
  - npm version
  - license
  - Node version
  - package provenance if desired
- Add a short "Project status" section:
  - current maturity
  - supported platforms
  - supported backends
  - known limitations

Acceptance criteria:

- The README header quickly shows build and package status.
- The project status is honest and specific.
- Badges point to real workflows and package pages.

### 10. Create A Public Roadmap And Support Boundary

Goal: help users know what is stable, what is experimental, and where the
project is going.

Tasks:

- Add `ROADMAP.md` or use GitHub milestones.
- Include:
  - stable features
  - experimental features
  - known limitations
  - platform support goals
  - backend support goals
  - non-goals
- Add "Support policy" wording:
  - best-effort personal project vs maintained package
  - supported Node versions
  - supported package versions
  - expected response times if any

Acceptance criteria:

- Users can decide whether the package is appropriate for serious use.
- Contributors can pick useful issues without guessing priorities.
- Security and support expectations are not implied silently.

## Suggested Implementation Order

1. Fix `pnpm verify`.
2. Add macOS and Windows CI coverage.
3. Add `CONTRIBUTING.md`, `SECURITY.md`, issue templates, and PR template.
4. Rewrite README into a newcomer-focused landing page.
5. Add `docs/first-run.md`.
6. Clean up `CHANGELOG.md`.
7. Set GitHub repo description, topics, and homepage.
8. Add badges.
9. Add repository map / archive policy for planning artifacts.
10. Add roadmap and support policy.

## Final Readiness Checklist

Before broadly sharing the project:

- [x] `pnpm install --frozen-lockfile` succeeds from a clean clone.
- [x] `pnpm verify` passes locally.
- [x] CI is green on the supported platform matrix.
  - PR #54 passed Ubuntu/macOS full verification and Windows smoke coverage on
    Node 22 and Node 24.
- [x] `npm pack --dry-run` contains only intended package files.
- [x] README gives a clear five-minute path to success.
- [x] Security model is documented.
- [x] CONTRIBUTING flow is documented.
- [x] Issue and PR templates exist.
- [x] CHANGELOG has versioned released entries.
- [x] GitHub repo metadata is filled in.
  - The live repository description, homepage, and topics match
    `docs/repository-map.md`.
- [x] Public roadmap or project-status statement exists.

## Current Audit Status

Last local readiness audit: 2026-05-10.

Verified from a temporary clean copy of the current working tree:

```text
pnpm install --frozen-lockfile
pnpm verify
```

Evidence from the latest clean-copy run:

- `pnpm install --frozen-lockfile` passed.
- `pnpm verify` passed.
- Test summary: 554 tests, 552 passed, 0 failed, 2 skipped.
- Publish readiness check passed.
- npm dist-tag resolution selected `latest`.
- `pnpm audit --prod` reported no known vulnerabilities.
- `npm pack --dry-run` reported 296 files, about 479.4 kB package size, and
  about 2.4 MB unpacked size.
- The temporary clean-copy directory was removed.
- No `.tgz` artifact remained in the worktree after verification.

Additional remote evidence:

- PR #54 ran the supported CI matrix successfully:
  - `Verify on ubuntu-latest / Node 22`
  - `Verify on ubuntu-latest / Node 24`
  - `Verify on macos-latest / Node 22`
  - `Verify on macos-latest / Node 24`
  - `Windows Smoke on Node 22`
  - `Windows Smoke on Node 24`
- Live GitHub repository metadata was verified with the configured description,
  npm homepage, and topics.
