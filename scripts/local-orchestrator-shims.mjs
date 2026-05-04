#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(resolve(scriptDir, '..'));
const binDir = join(repoRoot, '.agent-orchestrator-local', 'bin');
const localHome = resolveLocalHome(repoRoot);
const nodePath = process.execPath;
const args = new Set(process.argv.slice(2));

const bins = {
  'agent-orchestrator': 'dist/cli.js',
  'agent-orchestrator-daemon': 'dist/daemonCli.js',
  'agent-orchestrator-opencode': 'dist/opencodeCli.js',
  'agent-orchestrator-claude': 'dist/claudeCli.js',
};

mkdirSync(binDir, { recursive: true });

for (const [name, relativeTarget] of Object.entries(bins)) {
  const target = join(repoRoot, relativeTarget);
  const posixPath = join(binDir, name);
  writeFileSync(posixPath, posixShim(nodePath, target, localHome));
  chmodSync(posixPath, 0o755);
  writeFileSync(`${posixPath}.cmd`, windowsShim(nodePath, target, localHome));
}

if (args.has('--print-env')) {
  process.stdout.write(`export PATH=${quoteShell(binDir)}:"$PATH"\n`);
} else if (args.has('--print-bin')) {
  process.stdout.write(`${binDir}\n`);
} else {
  process.stdout.write(`wrote local agent-orchestrator shims to ${binDir}\n`);
  process.stdout.write(`run: export PATH=${quoteShell(binDir)}:"$PATH"\n`);
}

function resolveLocalHome(root) {
  const base = process.env.AGENT_ORCHESTRATOR_LOCAL_BASE || join(tmpdir(), 'agent-orchestrator-local');
  const slug = sanitizePathSegment(basename(root) || 'checkout');
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
  return join(base, `${slug}-${hash}`);
}

function sanitizePathSegment(value) {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.slice(0, 40) || 'checkout';
}

function posixShim(node, target, home) {
  return [
    '#!/usr/bin/env sh',
    `export AGENT_ORCHESTRATOR_HOME=${quoteShell(home)}`,
    `exec ${quoteShell(node)} ${quoteShell(target)} "$@"`,
    '',
  ].join('\n');
}

function windowsShim(node, target, home) {
  return [
    '@echo off',
    `set "AGENT_ORCHESTRATOR_HOME=${home}"`,
    `"${node}" "${target}" %*`,
    '',
  ].join('\r\n');
}

function quoteShell(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
