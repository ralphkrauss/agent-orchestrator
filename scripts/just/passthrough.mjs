import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { exitFromChild } from './_exit.mjs';

export default async function runPassthrough({ script, prefix = [], suffix = [] }) {
  const userArgs = process.argv.slice(2);
  const target = resolve(script);
  const child = spawnSync(process.execPath, [target, ...prefix, ...userArgs, ...suffix], {
    stdio: 'inherit',
  });
  exitFromChild(child);
}
