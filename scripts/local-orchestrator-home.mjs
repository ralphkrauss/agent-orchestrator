#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLocalOrchestratorHome } from './local-home-lib.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(resolve(scriptDir, '..'));

process.stdout.write(`${resolveLocalOrchestratorHome(repoRoot)}\n`);
