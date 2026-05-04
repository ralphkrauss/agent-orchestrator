# Publishing and Release Process

This package is published publicly as:

```text
@ralphkrauss/agent-orchestrator
```

The repository uses npm Trusted Publishing. GitHub Actions publishes from git tags; no long-lived `NPM_TOKEN` is required for the normal release flow.

## Mental Model

- `latest` is the stable npm dist-tag. Users get this by default.
- `next` is the test/prerelease npm dist-tag. Users must opt in explicitly.
- Stable versions look like `0.2.0` and publish to `latest`.
- Prerelease versions look like `0.2.0-beta.0` and publish to `next`.
- `npm version ...` updates `package.json`, updates `pnpm-lock.yaml`, creates a git commit, and creates a matching git tag.
- The `Publish npm` GitHub workflow runs when a `v*.*.*` tag is pushed.

## One-Time npm Setup

The first public publish of a scoped package must be done manually so the package exists on npm. After that, configure Trusted Publishing on npm:

| Field | Value |
|---|---|
| Package | `@ralphkrauss/agent-orchestrator` |
| Repository owner | `ralphkrauss` |
| Repository name | `agent-orchestrator` |
| Workflow filename | `publish-npm.yml` |
| Environment | leave empty |

The workflow has `id-token: write`, which is what npm uses for OIDC trusted publishing.

## Verification Before Any Release

Always run:

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` builds, tests, checks publish readiness, resolves the npm dist-tag, audits production dependencies, and runs `npm pack --dry-run`.

### `pnpm.overrides` policy for `@cursor/sdk` transitives

`package.json` carries a `pnpm.overrides` block that pins the following
transitives so `pnpm audit --prod` clears the release gate:

| Override | Reason |
|---|---|
| `tar` `^7.5.11` | Six high-severity advisories pulled in via `@cursor/sdk > sqlite3 > tar` (GHSA-34x7-hfp2-rc4v, GHSA-8qq5-rm4j-mr97, GHSA-83g3-92jg-28cx, GHSA-qffp-2rhf-9h96, GHSA-9ppj-qmqm-q256, GHSA-r6q2-hw4h-h46w) |
| `undici` `^6.24.0` | Two high + three moderate advisories pulled in via `@cursor/sdk > @connectrpc/connect-node > undici` (GHSA-g9mf-h72j-4rw9, GHSA-2mjp-6q6p-2qxm, GHSA-4992-7rv2-5pvq, GHSA-vrm6-8vpv-qv8q, GHSA-v9p9-hfj2-hcw8) |
| `@tootallnate/once` `^3.0.1` | Low-severity GHSA-vpq2-c234-7xj6 pulled in transitively via `@cursor/sdk` |

Revisit these overrides whenever `@cursor/sdk` ships a new minor: the goal is
for upstream to ship a clean tree so the override block can be removed.
`@cursor/sdk` is intentionally kept in `optionalDependencies` so the bundled
install ergonomics for cursor users are preserved.

## Beta/Test Release

Use this when you want to try the package in real projects without changing what default users get.

```bash
pnpm verify
npm version prerelease --preid beta
git push origin main --follow-tags
```

Example result:

```text
0.1.1-beta.0
tag v0.1.1-beta.0
published as @ralphkrauss/agent-orchestrator@next
```

Test the beta from any project:

```bash
npm view @ralphkrauss/agent-orchestrator@next version
npx -y @ralphkrauss/agent-orchestrator@next doctor
```

MCP configs for beta testing should use:

```text
@ralphkrauss/agent-orchestrator@next
```

If the beta needs fixes, make code changes and run the same prerelease command again:

```bash
pnpm verify
npm version prerelease --preid beta
git push origin main --follow-tags
```

This increments `0.1.1-beta.0` to `0.1.1-beta.1`.

## Stable Release

Use this only when the current code is ready for normal users.

```bash
pnpm verify
npm version patch
git push origin main --follow-tags
```

Example result:

```text
0.1.1
tag v0.1.1
published as @ralphkrauss/agent-orchestrator@latest
```

For minor or major releases, use:

```bash
npm version minor
npm version major
```

Then push with:

```bash
git push origin main --follow-tags
```

## What The GitHub Action Checks

The `Publish npm` workflow:

1. Installs dependencies with the lockfile.
2. Checks the git tag matches `package.json`, for example `v0.1.1-beta.0`.
3. Runs `pnpm verify`.
4. Chooses npm dist-tag:
   - prerelease versions publish with `--tag next`
   - stable versions publish with `--tag latest`
5. Checks whether that exact package version is already on npm.
6. Publishes with `npm publish --access public --provenance --tag <tag>`, or skips if already published.

## Manual Workflow Smoke Test

You can run the publish workflow manually from GitHub Actions. Manual dispatch on `main` should verify the package and skip publishing if the current version is already published.

This tests the workflow shape, but it does not prove a new version can publish. To test actual publishing, create a beta release.

## Deprecating Bad Versions

Prefer deprecating over unpublishing:

```bash
npm deprecate @ralphkrauss/agent-orchestrator@0.1.0 "Initial smoke release. Use @next until the next stable release."
```

Unpublishing is discouraged. npm versions are immutable: once `package@version` has been used, that exact version cannot be reused, even if unpublished.

## Inspecting npm State

Useful commands:

```bash
npm view @ralphkrauss/agent-orchestrator version
npm view @ralphkrauss/agent-orchestrator versions --json
npm dist-tag ls @ralphkrauss/agent-orchestrator
npm view @ralphkrauss/agent-orchestrator@next version
```

## Installed-Package Smoke Test

Before publishing, you can test the exact packed tarball locally:

```bash
package_file="$(npm pack --silent | tail -n 1)"
temp_dir="$(mktemp -d)"
cd "$temp_dir"
npm init -y >/dev/null
npm install "/path/to/agent-orchestrator/$package_file"
./node_modules/.bin/agent-orchestrator doctor --json
```

## CodeArtifact Publishing

The `Publish CodeArtifact` workflow is manual because the target AWS account/repository is intentionally not hardcoded.

Required inputs:

| Input | Meaning |
|---|---|
| `aws-region` | AWS region for the CodeArtifact repository, for example `eu-west-1` |
| `role-to-assume` | IAM role ARN allowed to publish |
| `codeartifact-domain` | CodeArtifact domain |
| `codeartifact-domain-owner` | AWS account ID that owns the domain |
| `codeartifact-repository` | CodeArtifact repository |

For local manual CodeArtifact publishing, use AWS CLI 2.9.5 or newer when using npm 10 or newer:

```bash
aws sts get-caller-identity
aws codeartifact login \
  --tool npm \
  --domain <domain> \
  --domain-owner <account-id> \
  --repository <repository> \
  --region <region>
npm ping
npm config get registry
npm publish
```

Reset npm back to the public registry after a CodeArtifact publish:

```bash
npm config set registry https://registry.npmjs.org/
```
