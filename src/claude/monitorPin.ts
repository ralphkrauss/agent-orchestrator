import { dirname, join, posix as posixPath, win32 as win32Path } from 'node:path';
import { fileURLToPath } from 'node:url';

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const notificationIdPattern = /^\d{20}-[0-9A-HJKMNP-TV-Z]{26}$/;

export interface ResolvedMonitorPin {
  /** Absolute path to the agent-orchestrator CLI script. */
  bin: string;
  /** Absolute path to the node interpreter that runs the bin. */
  nodePath: string;
  /** Canonical command prefix tokens, e.g. ["/usr/bin/node", "/abs/dist/cli.js"]. */
  command_prefix: string[];
  /**
   * POSIX-quoted command prefix string used in prompts and Bash allow patterns.
   * Each token is single-quoted when it contains characters outside the
   * unquoted-safe set, so install paths with spaces or parentheses (the common
   * cases on macOS and bundled Node distributions) embed safely both in shell
   * command lines and in `Bash(...)` Claude permission entries. See
   * `assertMonitorPathIsSupported()` for the characters that are explicitly
   * **unsupported** here because they would survive single-quoting and then be
   * shadowed by the supervisor's defense-in-depth Bash deny list.
   */
  command_prefix_string: string;
  /**
   * Explicit Bash allow patterns generated from the quoted command prefix.
   * Includes only the two argv shapes that `buildMonitorBashCommand()` produces:
   * a no-cursor monitor and a cursored monitor. Used to derive `Bash(<pattern>)`
   * entries via `monitor_bash_allow_patterns` below.
   */
  monitor_command_patterns: string[];
  /**
   * `Bash(<pattern>)` permission entries that map 1:1 to `monitor_command_patterns`.
   */
  monitor_bash_allow_patterns: string[];
}

export interface ResolveMonitorPinOptions {
  /**
   * Override `process.platform`. Used by tests so a Linux runner can exercise
   * the `win32` branch deterministically. Production callers omit it.
   */
  platform?: NodeJS.Platform;
  /**
   * Override `process.execPath`. Used by tests to drive Windows-shaped node
   * locations (e.g. `C:\\Program Files\\nodejs\\node.exe`) from a Linux runner.
   * Production callers omit it.
   */
  nodePath?: string;
}

export function resolveMonitorPin(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveMonitorPinOptions = {},
): ResolvedMonitorPin {
  const platform = options.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const isAbsoluteForPlatform = isWindows ? win32Path.isAbsolute : posixPath.isAbsolute;
  const explicit = env.AGENT_ORCHESTRATOR_BIN;
  const rawBin = explicit && isAbsoluteForPlatform(explicit) ? explicit : packageCliPath();
  const rawNodePath = options.nodePath ?? process.execPath;
  const bin = isWindows ? rawBin.replaceAll('\\', '/') : rawBin;
  const nodePath = isWindows ? rawNodePath.replaceAll('\\', '/') : rawNodePath;
  if (isWindows) {
    // Run UNC rejection after slash normalization so mixed-separator UNC
    // inputs (e.g. `\/server/share/...` or `/\server/share/...`) are caught
    // alongside the canonical `\\server\share\...` and `//server/share/...`
    // forms. Per plan decision #5 these all map to the dedicated UNC error,
    // not the forbidden-character error.
    assertMonitorPathIsNotUnc('AGENT_ORCHESTRATOR_BIN', bin);
    assertMonitorPathIsNotUnc('process.execPath', nodePath);
  }
  assertMonitorPathIsSupported('AGENT_ORCHESTRATOR_BIN', bin, { platform });
  assertMonitorPathIsSupported('process.execPath', nodePath, { platform });
  const command_prefix = [nodePath, bin];
  const command_prefix_string = quoteCommandTokens(command_prefix);
  const monitor_command_patterns = [
    `${command_prefix_string} monitor * --json-line`,
    `${command_prefix_string} monitor * --json-line --since *`,
  ];
  const monitor_bash_allow_patterns = monitor_command_patterns.map((pattern) => `Bash(${pattern})`);
  return {
    bin,
    nodePath,
    command_prefix,
    command_prefix_string,
    monitor_command_patterns,
    monitor_bash_allow_patterns,
  };
}

export function buildMonitorBashCommand(pin: ResolvedMonitorPin, runId: string, jsonLine = true, sinceNotificationId?: string): string {
  if (!jsonLine) {
    // The Claude supervisor only allowlists `--json-line` monitor invocations
    // (see `monitor_command_patterns`). Producing the bare form here would
    // generate a command the harness itself would reject and silently mislead
    // future call sites or tests, so refuse it at the builder.
    throw new Error('Claude supervisor monitor commands must use --json-line');
  }
  if (!ulidPattern.test(runId)) throw new Error(`Unsafe run id for monitor command: ${runId}`);
  if (sinceNotificationId && !notificationIdPattern.test(sinceNotificationId)) {
    throw new Error(`Unsafe notification id for monitor command: ${sinceNotificationId}`);
  }
  const tokens = [...pin.command_prefix, 'monitor', runId, '--json-line'];
  if (sinceNotificationId) tokens.push('--since', sinceNotificationId);
  return quoteCommandTokens(tokens);
}

/**
 * POSIX-quote each token with single quotes, escaping any embedded single quote
 * via the standard `'\''` sequence, then space-join. Tokens without any
 * shell-significant character are emitted unquoted to keep the common case
 * (alphanumeric paths) readable. Run-id and notification-id tokens are pre-validated
 * by `buildMonitorBashCommand()`; bin/nodePath tokens are pre-validated by
 * `assertMonitorPathIsSupported()` so the produced quoted form cannot contain a
 * character that the supervisor's Bash deny list would shadow.
 */
export function quoteCommandTokens(tokens: readonly string[]): string {
  return tokens.map(quoteToken).join(' ');
}

function quoteToken(token: string): string {
  if (token === '') return `''`;
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Characters that the supervisor's Bash deny list rejects regardless of context
 * (`Bash(*;*)`, `Bash(*&*)`, `Bash(*|*)`, `Bash(*<*)`, `Bash(*>*)`, `Bash(*$*)`,
 * `` `Bash(*`*)` ``, `Bash(*\\*)`, `Bash(*\n*)`). Single quotes are also forbidden
 * because the standard POSIX quoting transformation `'\''` introduces a backslash
 * that then matches `Bash(*\\*)` and shadows the explicit monitor allow rule.
 *
 * Real-world install paths for `node` and the agent-orchestrator CLI almost never
 * contain these characters; spaces and parentheses (common on macOS and bundled
 * Node distributions) remain supported because none of the deny patterns reject
 * them.
 */
const FORBIDDEN_MONITOR_PATH_CHARACTERS = /[;&|<>$`\\\r\n']/;

export interface AssertMonitorPathOptions {
  platform?: NodeJS.Platform;
}

export function assertMonitorPathIsSupported(
  role: string,
  value: string,
  options: AssertMonitorPathOptions = {},
): void {
  if (!FORBIDDEN_MONITOR_PATH_CHARACTERS.test(value)) return;
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    throw new Error(
      `${role} contains a character that the Claude supervisor's Bash deny list ` +
        `would shadow even after POSIX quoting (forbidden: single quote, ;, &, |, <, >, $, \`, \\, CR, LF). ` +
        `On Windows, backslashes in this path are auto-normalized to forward slashes before this check; the remaining forbidden characters still apply. ` +
        `Reinstall agent-orchestrator (and node, if needed) at a path that uses only spaces, ` +
        `parentheses, or other shell-safe characters. Got: ${JSON.stringify(value)}`,
    );
  }
  throw new Error(
    `${role} contains a character that the Claude supervisor's Bash deny list ` +
      `would shadow even after POSIX quoting (forbidden: single quote, ;, &, |, <, >, $, \`, \\, CR, LF). ` +
      `Reinstall agent-orchestrator (and node, if needed) at a path that uses only spaces, ` +
      `parentheses, or other shell-safe characters. Got: ${JSON.stringify(value)}`,
  );
}

function assertMonitorPathIsNotUnc(role: string, value: string): void {
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    throw new Error(
      `${role} is a UNC path, which is not supported by the Claude supervisor monitor pin. ` +
        `Reinstall agent-orchestrator (and node, if needed) on a local drive (for example C:\\) ` +
        `or via a mapped drive letter. Got: ${JSON.stringify(value)}`,
    );
  }
}

function packageCliPath(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'cli.js');
}
