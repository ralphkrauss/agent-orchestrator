# Publishing

This package is intended to be published publicly as:

```text
@ralphkrauss/agent-orchestrator-mcp
```

Before the first public publish, run:

```bash
pnpm verify
```

## Automatic npm Publish

The `Publish npm` workflow publishes automatically when either:

- a tag matching `v*.*.*` is pushed
- a GitHub Release is published

The tag must match `package.json` exactly. For example, version `0.1.0` must be released from tag `v0.1.0`.

Release command sequence:

```bash
pnpm verify
git tag v0.1.0
git push origin main v0.1.0
```

For later releases, bump the package version and push the generated tag:

```bash
pnpm verify
npm version patch
git push origin main --follow-tags
```

The workflow verifies the package, skips safely if that exact package version is already on npm, and publishes with npm Trusted Publishing.

## First Manual npm Publish

The first public publish of a scoped npm package must make public access explicit:

```bash
npm login
pnpm install --frozen-lockfile
pnpm verify
npm publish --access public
```

`publishConfig.access` is also set to `public`, but keep `--access public` in the first manual publish command so the intent is visible.

## GitHub Actions Trusted Publishing

The `Publish npm` workflow is ready for npm Trusted Publishing.

Configure the package on npm with these values:

| Field | Value |
|---|---|
| Package | `@ralphkrauss/agent-orchestrator-mcp` |
| Repository owner | `ralphkrauss` |
| Repository name | `agent-orchestrator-mcp` |
| Workflow filename | `publish-npm.yml` |
| Environment | leave empty unless you add a GitHub environment |

The workflow uses GitHub OIDC with `id-token: write` and publishes with:

```bash
npm publish --access public --provenance
```

When using trusted publishing, npm automatically generates provenance attestations. The workflow still passes `--provenance` so the intent is explicit and remains compatible with token fallback publishing.

If Trusted Publishing is not configured yet, use the manual publish path above. A long-lived `NPM_TOKEN` should be a fallback, not the default.

## CodeArtifact Publishing

The `Publish CodeArtifact` workflow is manual because the target AWS account/repository is intentionally not hardcoded.

Required inputs:

| Input | Meaning |
|---|---|
| `aws-region` | AWS region for CodeArtifact, for example `eu-west-1` |
| `role-to-assume` | IAM role ARN allowed to publish |
| `codeartifact-domain` | CodeArtifact domain |
| `codeartifact-domain-owner` | AWS account ID that owns the domain |
| `codeartifact-repository` | CodeArtifact repository |

The workflow confirms AWS identity, runs build/tests, checks publish readiness, logs npm into CodeArtifact, prints the active npm registry, and then runs:

```bash
npm publish
```

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
