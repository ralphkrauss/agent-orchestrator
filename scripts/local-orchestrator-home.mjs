#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(resolve(scriptDir, '..'));
const configuredBase = process.env.AGENT_ORCHESTRATOR_LOCAL_BASE || join(tmpdir(), 'agent-orchestrator-local');
const base = resolve(configuredBase);
const slug = sanitizePathSegment(basename(repoRoot) || 'checkout');
const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 12);

process.stdout.write(`${join(base, `${slug}-${hash}`)}\n`);

function sanitizePathSegment(value) {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.slice(0, 40) || 'checkout';
}
