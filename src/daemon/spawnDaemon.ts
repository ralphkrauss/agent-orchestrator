import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import type { DaemonPaths } from './paths.js';

const supervisorEnvKeys = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
  'CLAUDE_PROJECT_DIR',
  'PWD',
  'INIT_CWD',
];

export function spawnDaemonProcess(paths: DaemonPaths, daemonMain: string, env: NodeJS.ProcessEnv = process.env): ChildProcess {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const logFd = openSync(paths.log, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [daemonMain], {
      cwd: daemonCwd(paths.home, env),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: daemonSpawnEnv(paths.home, env),
    });
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

export function daemonSpawnEnv(storeRoot: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of supervisorEnvKeys) delete next[key];
  next.AGENT_ORCHESTRATOR_HOME = storeRoot;
  next.HOME = daemonHome(storeRoot, env);
  return next;
}

function daemonCwd(storeRoot: string, env: NodeJS.ProcessEnv): string {
  return daemonHome(storeRoot, env) || storeRoot || homedir();
}

function daemonHome(storeRoot: string, env: NodeJS.ProcessEnv): string {
  if (basename(storeRoot) === '.agent-orchestrator') return dirname(storeRoot);
  return env.HOME && !env.HOME.includes('/.agent-orchestrator/claude-supervisor/home')
    ? env.HOME
    : homedir();
}
