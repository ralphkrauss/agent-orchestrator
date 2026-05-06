import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolveStoreRoot } from '../runStore.js';
import {
  accountRegistryPaths,
  defaultClaudeCooldownSeconds,
  deleteAccountConfigDir,
  describeAccounts,
  ensureAccountConfigDir,
  loadAccountRegistry,
  removeAccount,
  upsertAccount,
  type AccountStatusEntry,
} from '../claude/accountRegistry.js';
import { accountSecretKey, AccountNameError, isValidAccountName } from '../claude/accountValidation.js';
import { promptSecret, PromptNotInteractiveError } from './prompt.js';
import { resolveSecretsPath, saveUserSecret, unsetUserSecret } from './userSecrets.js';

export interface ClaudeAuthCliOptions {
  /** Override the daemon home root for tests. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  secretsPath?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
  /**
   * Override for the interactive Claude spawn. Defaults to launching the
   * `claude` binary with stdio inherited from the parent process so the user
   * can complete the OAuth flow interactively. When `refresh` is true the
   * default uses `claude /login` against the existing config_dir; when
   * `refresh` is false the default launches `claude` with no args so the
   * fresh-`CLAUDE_CONFIG_DIR` first-run setup (theme → security notice →
   * login) drives the flow exactly once.
   */
  spawnLogin?: (
    configDir: string,
    options: { stdio?: 'inherit'; refresh: boolean },
  ) => ChildProcess;
  /** Override for `Date.now()` when stamping `registered_at`. */
  now?: () => number;
  /** Override the secret prompt (tests). */
  promptSecret?: (question: string) => Promise<string>;
}

const RESERVED_FLAGS = new Set([
  '--api-key',
  '--token',
  '--secret',
  '--key',
  '--password',
  '--anthropic-api-key',
]);

/**
 * Route an `auth login claude … / auth set claude … / auth list claude … /
 * auth remove claude …` command. Returns an exit code. The router in
 * `authCli.ts` is responsible for `argv[0]` (the verb) — this entry point
 * receives the arguments AFTER the verb and after `claude`.
 */
export async function runClaudeAuthCommand(
  verb: 'login' | 'set' | 'list' | 'remove',
  argv: readonly string[],
  options: ClaudeAuthCliOptions,
): Promise<number> {
  switch (verb) {
    case 'login':
      return runLogin(argv, options);
    case 'set':
      return runSet(argv, options);
    case 'list':
      return runList(argv, options);
    case 'remove':
      return runRemove(argv, options);
  }
}

async function runLogin(argv: readonly string[], options: ClaudeAuthCliOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const accountName = takeAccountFlag(argv, stderr);
  if (!accountName) return 1;
  const refresh = argv.includes('--refresh');
  if (rejectValueBearingSecretFlags(argv, stderr)) return 1;

  if (!isValidAccountName(accountName)) {
    stderr.write(formatInvalidAccountName(accountName));
    return 1;
  }

  const stdin = options.stdin ?? process.stdin;
  const stdoutForTty = options.stdout ?? process.stdout;
  if (!(stdin as NodeJS.ReadStream).isTTY || !(stdoutForTty as NodeJS.WriteStream).isTTY) {
    stderr.write('auth login claude requires an interactive TTY for the OAuth flow; for headless setup use `auth set claude --account <name> --from-env <VAR>` or `--from-stdin`.\n');
    return 1;
  }

  const home = options.home ?? resolveStoreRoot();
  const paths = accountRegistryPaths(home);
  await mkdir(paths.accountsRoot, { recursive: true, mode: 0o700 });
  const loaded = await loadAccountRegistry(paths);
  if (!loaded.ok) {
    stderr.write(`claude account registry version mismatch (observed: ${String(loaded.observed_version)}); resolve manually before retrying.\n`);
    return 1;
  }
  const existing = loaded.file.accounts.find((entry) => entry.name === accountName);
  if (existing && !refresh) {
    stderr.write(`claude account ${accountName} is already registered; pass --refresh to re-run /login against the existing config_dir.\n`);
    return 1;
  }

  let configDir: string;
  try {
    configDir = await ensureAccountConfigDir(paths, accountName);
  } catch (error) {
    stderr.write(`failed to create config_dir for ${accountName}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const isRefresh = Boolean(existing && refresh);
  if (isRefresh) {
    stdout.write(`Launching \`claude /login\` against ${configDir}. Complete the OAuth flow in this terminal.\n`);
  } else {
    stdout.write(`Launching Claude's first-run setup against ${configDir}. Complete the OAuth flow, then type /exit to finish registering the account.\n`);
  }
  const child = (options.spawnLogin ?? defaultSpawnLogin)(configDir, { stdio: 'inherit', refresh: isRefresh });
  const exitCode = await waitForExit(child);
  if (exitCode !== 0) {
    const command = isRefresh ? 'claude /login' : 'claude first-run setup';
    stderr.write(`${command} exited with code ${exitCode}; account ${accountName} not registered.\n`);
    return exitCode === null ? 1 : exitCode;
  }

  await upsertAccount(paths, {
    name: accountName,
    mode: 'config_dir',
    configDirPath: configDir,
    now: options.now?.(),
  });
  stdout.write(`Registered claude account ${accountName} (config_dir mode) at ${configDir}.\n`);
  return 0;
}

async function runSet(argv: readonly string[], options: ClaudeAuthCliOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const accountName = takeAccountFlag(argv, stderr);
  if (!accountName) return 1;
  if (rejectValueBearingSecretFlags(argv, stderr)) return 1;
  if (!isValidAccountName(accountName)) {
    stderr.write(formatInvalidAccountName(accountName));
    return 1;
  }

  const fromEnvIndex = argv.indexOf('--from-env');
  const fromStdinIndex = argv.indexOf('--from-stdin');
  if (fromEnvIndex !== -1 && fromStdinIndex !== -1) {
    stderr.write('--from-env and --from-stdin are mutually exclusive\n');
    return 1;
  }

  let value: string;
  try {
    if (fromEnvIndex !== -1) {
      const explicit = argv[fromEnvIndex + 1];
      const isFlag = typeof explicit === 'string' && explicit.startsWith('--');
      const varName = explicit && !isFlag ? explicit : 'ANTHROPIC_API_KEY';
      const env = options.env ?? process.env;
      const candidate = env[varName];
      if (typeof candidate !== 'string' || candidate === '') {
        stderr.write(`environment variable ${varName} is not set; cannot read Claude API key from env\n`);
        return 1;
      }
      value = candidate;
    } else if (fromStdinIndex !== -1) {
      const stdin = options.stdin ?? process.stdin;
      value = await readSingleLine(stdin);
    } else {
      const promptFn = options.promptSecret
        ?? (async (question: string) => promptSecret(question, { input: options.stdin, output: options.stdout }));
      value = await promptFn(`Enter Claude API key for account ${accountName} (input hidden): `);
    }
  } catch (error) {
    if (error instanceof PromptNotInteractiveError) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    stderr.write('refusing to save: value is empty\n');
    return 1;
  }
  if (trimmed.includes('\n') || trimmed.includes('\r')) {
    stderr.write('refusing to save: secret values must not contain newlines\n');
    return 1;
  }

  const home = options.home ?? resolveStoreRoot();
  const paths = accountRegistryPaths(home);
  const env = options.env ?? process.env;
  const secretsPath = options.secretsPath ?? resolveSecretsPath(env);
  const secretKey = accountSecretKey(accountName);
  await saveUserSecret(secretKey, trimmed, { path: secretsPath, env });

  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await upsertAccount(paths, {
    name: accountName,
    mode: 'api_env',
    secretKey,
    now: options.now?.(),
  });

  stdout.write(`Saved Claude API key for account ${accountName} (api_env mode); secret stored under key ${secretKey} in ${secretsPath}.\n`);
  return 0;
}

async function runList(argv: readonly string[], options: ClaudeAuthCliOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const json = argv.includes('--json');
  const home = options.home ?? resolveStoreRoot();
  const paths = accountRegistryPaths(home);
  const entries = await describeAccounts(paths);
  const cooldownDefault = defaultClaudeCooldownSeconds();
  if (json) {
    stdout.write(`${JSON.stringify({
      accounts: entries.map(serializeAccountForJson),
      default_cooldown_seconds: cooldownDefault,
    }, null, 2)}\n`);
    return 0;
  }
  if (entries.length === 0) {
    stdout.write('No claude accounts registered. Use `agent-orchestrator auth login claude --account <name>` to add one.\n');
    return 0;
  }
  const lines: string[] = ['Claude accounts:'];
  for (const entry of entries) {
    lines.push(`- ${entry.account.name} (${entry.account.mode}): ${entry.status}${entry.message ? ` — ${entry.message}` : ''}`);
  }
  stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function runRemove(argv: readonly string[], options: ClaudeAuthCliOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const accountName = takeAccountFlag(argv, stderr);
  if (!accountName) return 1;
  if (!isValidAccountName(accountName)) {
    stderr.write(formatInvalidAccountName(accountName));
    return 1;
  }
  const deleteConfigDir = argv.includes('--delete-config-dir');
  const home = options.home ?? resolveStoreRoot();
  const paths = accountRegistryPaths(home);
  const result = await removeAccount(paths, accountName);
  if (!result.removed) {
    stdout.write(`No claude account named ${accountName} was registered.\n`);
    return 0;
  }
  if (result.previous?.mode === 'api_env' && result.previous.secret_key) {
    const env = options.env ?? process.env;
    const secretsPath = options.secretsPath ?? resolveSecretsPath(env);
    try {
      await unsetUserSecret(result.previous.secret_key, { path: secretsPath, env });
    } catch (error) {
      stderr.write(`warning: failed to remove secret ${result.previous.secret_key}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (result.previous?.mode === 'config_dir') {
    if (deleteConfigDir) {
      try {
        await deleteAccountConfigDir(paths, accountName);
        stdout.write(`Removed claude account ${accountName} and deleted its config_dir.\n`);
      } catch (error) {
        stderr.write(`warning: failed to delete config_dir for ${accountName}: ${error instanceof Error ? error.message : String(error)}\n`);
        stdout.write(`Removed claude account ${accountName}; config_dir at ${result.previous.config_dir_path ?? 'unknown'} was not deleted.\n`);
      }
    } else {
      stdout.write(`Removed claude account ${accountName}; config_dir preserved at ${result.previous.config_dir_path ?? 'unknown'} (pass --delete-config-dir to also delete it).\n`);
    }
  } else {
    stdout.write(`Removed claude account ${accountName}.\n`);
  }
  return 0;
}

function takeAccountFlag(argv: readonly string[], stderr: NodeJS.WritableStream): string | null {
  const index = argv.indexOf('--account');
  if (index === -1) {
    stderr.write('missing required --account <name> flag\n');
    return null;
  }
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.startsWith('--')) {
    stderr.write('--account requires a value\n');
    return null;
  }
  return value;
}

function rejectValueBearingSecretFlags(argv: readonly string[], stderr: NodeJS.WritableStream): boolean {
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    const [head] = arg.split('=', 1);
    if (RESERVED_FLAGS.has(head!)) {
      stderr.write(`refusing ${head}: secrets must not be passed on the command line. Use --from-env <VAR>, --from-stdin, or the interactive prompt.\n`);
      return true;
    }
  }
  return false;
}

function formatInvalidAccountName(value: string): string {
  return `invalid account name ${JSON.stringify(value)}: must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, no leading dot/dash, no \"..\".\n`;
}

async function readSingleLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      chunks.push(buffer);
      const combined = Buffer.concat(chunks);
      const newlineIndex = combined.indexOf(0x0a);
      if (newlineIndex !== -1) {
        cleanup();
        resolve(combined.slice(0, newlineIndex).toString('utf8').replace(/\r$/, ''));
      }
    };
    const onEnd = () => {
      cleanup();
      const combined = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
      resolve(combined);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

function defaultSpawnLogin(
  configDir: string,
  options: { stdio?: 'inherit'; refresh: boolean },
): ChildProcess {
  const args = options.refresh ? ['/login'] : [];
  return spawn('claude', args, {
    stdio: options.stdio ?? 'inherit',
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
}

function serializeAccountForJson(entry: AccountStatusEntry): Record<string, unknown> {
  return {
    name: entry.account.name,
    mode: entry.account.mode,
    config_dir_path: entry.account.config_dir_path ?? null,
    secret_key: entry.account.secret_key ?? null,
    registered_at: entry.account.registered_at,
    last_error_category: entry.last_error_category ?? null,
    cooldown_until_ms: entry.cooldown_until_ms ?? null,
    status: entry.status,
    message: entry.message,
  };
}

export type { AccountNameError };
