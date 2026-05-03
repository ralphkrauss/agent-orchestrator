#!/usr/bin/env node
import { runClaudeLauncher } from './claude/launcher.js';

process.exitCode = await runClaudeLauncher(process.argv.slice(2));
