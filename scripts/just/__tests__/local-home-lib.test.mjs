import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalOrchestratorHome } from '../../local-home-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

test('resolveLocalOrchestratorHome is deterministic for a given repo root', () => {
  const a = resolveLocalOrchestratorHome('/tmp/example-repo');
  const b = resolveLocalOrchestratorHome('/tmp/example-repo');
  assert.equal(a, b);
});

test('resolveLocalOrchestratorHome differs for different repo roots', () => {
  const a = resolveLocalOrchestratorHome('/tmp/repo-one');
  const b = resolveLocalOrchestratorHome('/tmp/repo-two');
  assert.notEqual(a, b);
});

test('resolveLocalOrchestratorHome honors AGENT_ORCHESTRATOR_LOCAL_BASE', () => {
  const previous = process.env.AGENT_ORCHESTRATOR_LOCAL_BASE;
  try {
    process.env.AGENT_ORCHESTRATOR_LOCAL_BASE = '/tmp/explicit-base';
    const home = resolveLocalOrchestratorHome('/tmp/some-repo');
    assert.ok(home.startsWith(`/tmp/explicit-base${sep}`) || home.startsWith('/tmp/explicit-base/'));
  } finally {
    if (previous === undefined) delete process.env.AGENT_ORCHESTRATOR_LOCAL_BASE;
    else process.env.AGENT_ORCHESTRATOR_LOCAL_BASE = previous;
  }
});

test('local-orchestrator-home.mjs prints a path matching resolveLocalOrchestratorHome(repoRoot)', () => {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'local-orchestrator-home.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const expected = `${resolveLocalOrchestratorHome(realpathSync(repoRoot))}\n`;
  assert.equal(result.stdout, expected);
});

test('local-orchestrator-shims.mjs --print-bin emits expected bin dir', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'shims-bin-'));
  try {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'local-orchestrator-shims.mjs'), '--print-bin'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const expected = `${join(realpathSync(repoRoot), '.agent-orchestrator-local', 'bin')}\n`;
    assert.equal(result.stdout, expected);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('local-orchestrator-shims.mjs writes both posix and windows shims', () => {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'local-orchestrator-shims.mjs'), '--print-bin'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const binDir = result.stdout.trim();
  for (const name of ['agent-orchestrator', 'agent-orchestrator-daemon', 'agent-orchestrator-opencode', 'agent-orchestrator-claude']) {
    const posix = readFileSync(join(binDir, name), 'utf8');
    assert.match(posix, /^#!\/usr\/bin\/env sh/);
    assert.match(posix, /AGENT_ORCHESTRATOR_HOME=/);
    const windows = readFileSync(join(binDir, `${name}.cmd`), 'utf8');
    assert.match(windows, /^@echo off/);
    assert.match(windows, /AGENT_ORCHESTRATOR_HOME=/);
  }
});
