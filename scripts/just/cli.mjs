import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { exitFromChild } from './_exit.mjs';

export default async function runCli({ prefix = [], suffix = [] } = {}) {
  const userArgs = process.argv.slice(2);
  const cliPath = resolve('dist/cli.js');
  const child = spawnSync(process.execPath, [cliPath, ...prefix, ...userArgs, ...suffix], {
    stdio: 'inherit',
  });
  exitFromChild(child);
}
