import { IpcClient } from '../ipc/client.js';
import { daemonPaths } from '../daemon/paths.js';
import { runClaudeAuthCommand, type ClaudeAuthCliOptions } from './claudeCli.js';
import {
  AUTH_PROVIDERS,
  getProvider,
  type AuthProvider,
} from './providers.js';
import {
  loadUserSecrets,
  resolveSecretsPath,
  saveUserSecret,
  unsetUserSecret,
} from './userSecrets.js';
import { promptSecret, PromptNotInteractiveError } from './prompt.js';

export interface AuthCliOptions {
  /** Override env injection (tests). */
  env?: NodeJS.ProcessEnv;
  /** Override the secrets file path (tests). */
  secretsPath?: string;
  /** Override the daemon-running probe (tests). Returns true if a daemon answers. */
  isDaemonRunning?: () => Promise<boolean>;
  /** Override the secret prompt (tests). */
  promptSecret?: (question: string) => Promise<string>;
  /** Output streams for tests. Defaults to process.stdout/stderr. */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
  /** Override daemon home for tests (used by `auth login/set/list/remove claude`). */
  home?: string;
  /** Override the `claude /login` spawn for tests. */
  spawnLogin?: ClaudeAuthCliOptions['spawnLogin'];
  /** Override `Date.now()` for tests. */
  now?: () => number;
}

export interface AuthStatusJsonProvider {
  id: string;
  label: string;
  status: 'wired' | 'reserved';
  primary_env_var: string;
  env_vars: string[];
  env_set: boolean;
  env_source_var: string | null;
  file_set: boolean;
  effective_status: 'ready' | 'unknown';
  effective_source: 'env' | 'file' | null;
}

export interface AuthStatusJson {
  secrets_path: string;
  secrets_file_present: boolean;
  secrets_file_refusal: { reason: string; hint: string } | null;
  daemon_running: boolean;
  providers: AuthStatusJsonProvider[];
}

export async function runAuthCli(
  argv: readonly string[],
  options: AuthCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    stdout.write(authHelp());
    return command ? 0 : 1;
  }

  switch (command) {
    case 'status':
      return runStatus(argv.slice(1), { ...options, stdout, stderr });
    case 'unset':
      return runUnset(argv.slice(1), { ...options, stdout, stderr });
    case 'login':
    case 'set':
    case 'list':
    case 'remove':
      return runClaudeSubcommand(command, argv.slice(1), { ...options, stdout, stderr });
    default:
      return runProviderCommand(command, argv.slice(1), { ...options, stdout, stderr });
  }
}

function authHelp(): string {
  return [
    'Usage:',
    '  agent-orchestrator auth status [--json]',
    '  agent-orchestrator auth <provider> [--from-env [VAR] | --from-stdin]',
    '  agent-orchestrator auth unset <provider>',
    '  agent-orchestrator auth login claude --account <name> [--refresh]',
    '  agent-orchestrator auth set claude --account <name> [--from-env [VAR] | --from-stdin]',
    '  agent-orchestrator auth list claude [--json]',
    '  agent-orchestrator auth remove claude --account <name> [--delete-config-dir]',
    '',
    'Providers: cursor (wired), claude (wired, multi-account), codex (reserved).',
    'Interactive form requires a TTY. Use --from-env / --from-stdin in scripts.',
    'Value-bearing flags (e.g. --api-key sk-...) are rejected to keep secrets out of shell history.',
    '',
  ].join('\n');
}

async function runClaudeSubcommand(
  verb: 'login' | 'set' | 'list' | 'remove',
  argv: readonly string[],
  options: AuthCliOptions,
): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  const provider = argv[0];
  if (provider !== 'claude') {
    stderr.write(`auth ${verb}: only 'claude' is supported in this release\n`);
    return 1;
  }
  return runClaudeAuthCommand(verb, argv.slice(1), {
    home: options.home,
    env: options.env,
    secretsPath: options.secretsPath,
    stdout: options.stdout,
    stderr: options.stderr,
    stdin: options.stdin,
    spawnLogin: options.spawnLogin,
    now: options.now,
    promptSecret: options.promptSecret,
  });
}

async function runStatus(
  argv: readonly string[],
  options: AuthCliOptions,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const json = argv.includes('--json');
  const env = options.env ?? process.env;
  const path = options.secretsPath ?? resolveSecretsPath(env);
  const loaded = loadUserSecrets({ env: { ...env, AGENT_ORCHESTRATOR_SECRETS_FILE: path } });
  const daemonRunning = await (options.isDaemonRunning ?? defaultIsDaemonRunning)();

  const providers: AuthStatusJsonProvider[] = AUTH_PROVIDERS.map((provider) => {
    const envSourceVar = provider.envVars.find((name) => Boolean(env[name])) ?? null;
    const fileSet = Object.prototype.hasOwnProperty.call(loaded.values, provider.primaryEnvVar);
    // The daemon's secrets-file injection is allowlisted to wired providers.
    // For reserved providers we still report `file_set` so a hand-edit shows
    // up as drift, but the entry is *not* effective: the daemon will not
    // inject it into the worker process env until that provider is wired.
    const fileBacksAuth = fileSet && provider.status === 'wired';
    const effectiveSource: 'env' | 'file' | null = envSourceVar
      ? 'env'
      : fileBacksAuth
        ? 'file'
        : null;
    const effectiveStatus: 'ready' | 'unknown' = effectiveSource === null ? 'unknown' : 'ready';
    return {
      id: provider.id,
      label: provider.label,
      status: provider.status,
      primary_env_var: provider.primaryEnvVar,
      env_vars: [...provider.envVars],
      env_set: envSourceVar !== null,
      env_source_var: envSourceVar,
      file_set: fileSet,
      effective_status: effectiveStatus,
      effective_source: effectiveSource,
    };
  });

  const payload: AuthStatusJson = {
    secrets_path: loaded.path,
    secrets_file_present: loaded.exists,
    secrets_file_refusal: loaded.refusal ?? null,
    daemon_running: daemonRunning,
    providers,
  };

  if (json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  stdout.write(formatStatus(payload));
  return 0;
}

function formatStatus(payload: AuthStatusJson): string {
  const lines: string[] = [];
  lines.push(`Secrets file: ${payload.secrets_path}${payload.secrets_file_present ? '' : ' (not present)'}`);
  if (payload.secrets_file_refusal) {
    lines.push(`  refused: ${payload.secrets_file_refusal.reason}`);
    lines.push(`  hint: ${payload.secrets_file_refusal.hint}`);
  }
  lines.push(`Daemon: ${payload.daemon_running ? 'running' : 'stopped'}`);
  lines.push('');
  lines.push('Providers:');
  for (const provider of payload.providers) {
    const sourceLabel = provider.effective_source === 'env'
      ? `env (${provider.env_source_var})`
      : provider.effective_source === 'file'
        ? `file (${provider.primary_env_var})`
        : 'unset';
    lines.push(`- ${provider.id} [${provider.status}]: ${provider.effective_status} via ${sourceLabel}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runUnset(
  argv: readonly string[],
  options: AuthCliOptions,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const providerId = argv[0];
  if (!providerId) {
    stderr.write('Usage: agent-orchestrator auth unset <provider>\n');
    return 1;
  }
  const provider = getProvider(providerId);
  if (!provider) {
    stderr.write(`unknown provider: ${providerId}\n`);
    return 1;
  }
  const env = options.env ?? process.env;
  const path = options.secretsPath ?? resolveSecretsPath(env);
  const result = await unsetUserSecret(provider.primaryEnvVar, { path, env });
  if (result.removed) {
    stdout.write(`Removed ${provider.primaryEnvVar} from ${result.path}.\n`);
  } else {
    stdout.write(`${provider.primaryEnvVar} was not present in ${result.path}.\n`);
  }
  await writeRestartHint(stdout, options);
  return 0;
}

async function runProviderCommand(
  providerId: string,
  argv: readonly string[],
  options: AuthCliOptions,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const provider = getProvider(providerId);
  if (!provider) {
    stderr.write(`unknown command or provider: ${providerId}\nRun 'agent-orchestrator auth --help' for usage.\n`);
    return 1;
  }

  if (provider.status === 'reserved') {
    stderr.write(
      `auth ${provider.id} is not yet supported by agent-orchestrator. ` +
        `Use the ${provider.label} CLI's own auth flow instead.\n`,
    );
    return 2;
  }

  const env = options.env ?? process.env;
  const path = options.secretsPath ?? resolveSecretsPath(env);

  let value: string;
  try {
    value = await readSecretValue(provider, argv, options);
  } catch (error) {
    if (error instanceof PromptNotInteractiveError) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    if (error instanceof AuthCliInputError) {
      stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }

  const trimmed = value.trim();
  const validation = provider.validate(trimmed);
  if (!validation.ok) {
    stderr.write(`refusing to save: ${validation.reason}\n`);
    return 1;
  }

  const saved = await saveUserSecret(provider.primaryEnvVar, trimmed, { path, env });
  stdout.write(`Saved ${provider.primaryEnvVar} to ${saved.path}.\n`);
  await writeRestartHint(stdout, options);
  return 0;
}

class AuthCliInputError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'AuthCliInputError';
    this.exitCode = exitCode;
  }
}

async function readSecretValue(
  provider: AuthProvider,
  argv: readonly string[],
  options: AuthCliOptions,
): Promise<string> {
  const env = options.env ?? process.env;
  const fromEnvIndex = argv.indexOf('--from-env');
  const fromStdinIndex = argv.indexOf('--from-stdin');

  if (fromEnvIndex !== -1 && fromStdinIndex !== -1) {
    throw new AuthCliInputError('--from-env and --from-stdin are mutually exclusive');
  }

  if (fromEnvIndex !== -1) {
    const explicit = argv[fromEnvIndex + 1];
    const isFlag = typeof explicit === 'string' && explicit.startsWith('--');
    const varName = explicit && !isFlag ? explicit : provider.primaryEnvVar;
    const value = env[varName];
    if (typeof value !== 'string' || value === '') {
      throw new AuthCliInputError(
        `environment variable ${varName} is not set; cannot read ${provider.label} key from env`,
      );
    }
    return value;
  }

  if (fromStdinIndex !== -1) {
    const stdin = options.stdin ?? process.stdin;
    return await readSingleLine(stdin);
  }

  // Interactive form requires a TTY.
  const promptFn = options.promptSecret
    ?? (async (question: string) => promptSecret(question, { input: options.stdin, output: options.stdout }));
  return promptFn(`Enter ${provider.label} API key (input hidden): `);
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
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
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

async function writeRestartHint(
  stdout: NodeJS.WritableStream,
  options: AuthCliOptions,
): Promise<void> {
  const running = await (options.isDaemonRunning ?? defaultIsDaemonRunning)();
  if (running) {
    stdout.write('A running daemon is unchanged until restart — run `agent-orchestrator restart` to pick up the new value.\n');
  } else {
    stdout.write('Run `agent-orchestrator start` to use the new credentials.\n');
  }
}

async function defaultIsDaemonRunning(): Promise<boolean> {
  try {
    const paths = daemonPaths();
    const client = new IpcClient(paths.ipc.path);
    await client.request('ping', {}, 1_000);
    return true;
  } catch {
    return false;
  }
}
