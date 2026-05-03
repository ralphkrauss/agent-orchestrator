import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ResolvedMonitorPin {
  /** Absolute path to the agent-orchestrator CLI script. */
  bin: string;
  /** Absolute path to the node interpreter that runs the bin. */
  nodePath: string;
  /** Canonical command prefix tokens, e.g. ["/usr/bin/node", "/abs/dist/cli.js"]. */
  command_prefix: string[];
  /** Stringified canonical prefix, used in prompts and the Bash allow pattern. */
  command_prefix_string: string;
  /** Bash allow pattern: `<command_prefix_string> monitor *`. */
  bash_allowlist_pattern: string;
}

export function resolveMonitorPin(env: NodeJS.ProcessEnv = process.env): ResolvedMonitorPin {
  const explicit = env.AGENT_ORCHESTRATOR_BIN;
  const bin = explicit && isAbsolute(explicit) ? explicit : packageCliPath();
  const nodePath = process.execPath;
  const command_prefix = [nodePath, bin];
  const command_prefix_string = `${nodePath} ${bin}`;
  const bash_allowlist_pattern = `${command_prefix_string} monitor *`;
  return { bin, nodePath, command_prefix, command_prefix_string, bash_allowlist_pattern };
}

export function buildMonitorBashCommand(pin: ResolvedMonitorPin, runId: string, jsonLine = true, sinceNotificationId?: string): string {
  const parts = [pin.nodePath, pin.bin, 'monitor', runId];
  if (jsonLine) parts.push('--json-line');
  if (sinceNotificationId) parts.push('--since', sinceNotificationId);
  return parts.join(' ');
}

function packageCliPath(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'cli.js');
}
