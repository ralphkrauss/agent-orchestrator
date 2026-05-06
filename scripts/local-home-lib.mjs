import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export function resolveLocalOrchestratorHome(repoRoot) {
  const configuredBase = process.env.AGENT_ORCHESTRATOR_LOCAL_BASE || join(tmpdir(), 'agent-orchestrator-local');
  const base = resolve(configuredBase);
  const slug = sanitizePathSegment(basename(repoRoot) || 'checkout');
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 12);
  return join(base, `${slug}-${hash}`);
}

function sanitizePathSegment(value) {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.slice(0, 40) || 'checkout';
}
