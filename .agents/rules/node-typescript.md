---
description: "Node.js and TypeScript conventions for package source, tests, scripts, and build configuration"
paths:
  - "src/**/*.ts"
  - "scripts/**/*.mjs"
  - "package.json"
  - "pnpm-lock.yaml"
  - "tsconfig.json"
globs:
  - "src/**/*.ts"
  - "scripts/**/*.mjs"
  - "package.json"
  - "pnpm-lock.yaml"
  - "tsconfig.json"
---

# Node And TypeScript

- Use `pnpm` consistently. Do not introduce another package manager.
- Prefer existing package scripts over direct tool invocations.
- Keep runtime code compatible with Node.js 22 and newer.
- Keep TypeScript strictness intact; do not loosen `tsconfig.json` to make a
  change pass.
- Prefer Node built-ins and existing dependencies over adding new dependencies.
- Ask before installing packages or changing dependency ranges.
- For MCP contract changes, update schemas, docs, and tests in the same change.
- For CLI behavior changes, verify both human-readable and JSON output where
  applicable.
