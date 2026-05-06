#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveLocalOrchestratorHome } from '../local-home-lib.mjs';

const repoRoot = realpathSync(resolve('.'));
const cliPath = join(repoRoot, 'dist', 'cli.js');
const localHome = resolveLocalOrchestratorHome(repoRoot);
const localShimRoot = join(repoRoot, '.agent-orchestrator-local');

if (existsSync(cliPath)) {
  spawnSync(process.execPath, [cliPath, 'stop', '--force'], {
    stdio: 'ignore',
    env: { ...process.env, AGENT_ORCHESTRATOR_HOME: localHome },
    timeout: 10_000,
  });
}

rmSync(localHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
rmSync(localShimRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

process.stdout.write(`removed ${localHome}\n`);
process.stdout.write(`removed ${localShimRoot}\n`);
