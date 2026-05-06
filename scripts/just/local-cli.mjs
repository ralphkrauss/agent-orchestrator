import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveLocalOrchestratorHome } from '../local-home-lib.mjs';
import { exitFromChild } from './_exit.mjs';

export default async function runLocalCli() {
  const args = process.argv.slice(2);
  const remaining = args[0] === '--' ? args.slice(1) : args;
  const repoRoot = realpathSync(resolve('.'));
  const cliPath = resolve('dist/cli.js');
  const localHome = resolveLocalOrchestratorHome(repoRoot);
  const child = spawnSync(process.execPath, [cliPath, ...remaining], {
    stdio: 'inherit',
    env: { ...process.env, AGENT_ORCHESTRATOR_HOME: localHome },
  });
  exitFromChild(child);
}
