#!/usr/bin/env node
import { runOpenCodeLauncher } from './opencode/launcher.js';

process.exitCode = await runOpenCodeLauncher(process.argv.slice(2));
