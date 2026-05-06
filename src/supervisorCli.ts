import { IpcClient, IpcRequestError } from './ipc/client.js';
import { daemonPaths } from './daemon/paths.js';
import { ipcTimeoutForTool } from './toolTimeout.js';
import { resolveStoreRoot } from './runStore.js';
import { readOrchestratorSidecar } from './daemon/orchestratorSidecar.js';
import {
  SupervisorEventSchema,
  type OrchestratorRecord,
  type OrchestratorStatusSnapshot,
  type OrchestratorDisplay,
} from './contract.js';
import {
  isClaudeSupervisorHookEventName,
  supervisorEventForClaudeHookEvent,
} from './claude/permission.js';

export interface SupervisorCliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
  env?: NodeJS.ProcessEnv;
}

// Signal exit codes (Decision 22 / B1). Never 2: Claude treats hook exit code
// 2 on UserPromptSubmit / Stop as a blocking signal that suppresses the
// user's prompt or assistant turn.
export const SUPERVISOR_SIGNAL_EXIT_OK = 0;
export const SUPERVISOR_SIGNAL_EXIT_INVALID_EVENT = 1;

const HELP_TEXT = `agent-orchestrator supervisor

Usage:
  agent-orchestrator supervisor register --label <name> --cwd <path>
  agent-orchestrator supervisor signal <event>
  agent-orchestrator supervisor unregister --orchestrator-id <id>
  agent-orchestrator supervisor status [--orchestrator-id <id>]

Internal-only orchestrator-status surface (issue #40). Drives the daemon's
aggregate orchestrator status; never exposed as MCP tools.

\`signal\` accepts the Claude Code lifecycle event names UserPromptSubmit,
Notification, Stop, SessionStart, SessionEnd. It reads
AGENT_ORCHESTRATOR_ORCH_ID from the environment, never writes to stdout
(Claude treats UserPromptSubmit/SessionStart stdout as additional model
context), and exits 0 on success or transient failure. Exit code 1 is
reserved for invalid event names. Exit code 2 is never returned.

\`status\` writes a single JSON object to stdout matching the v1 hook payload
minus the event/event_id/previous_status/emitted_at fields. Exits 0 on
success, 1 if the orchestrator id is missing or unknown.
`;

export async function runSupervisorCli(
  argv: readonly string[],
  io: SupervisorCliIo = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env },
): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    io.stdout.write(HELP_TEXT);
    return 0;
  }
  switch (subcommand) {
    case 'register':
      return runRegister(rest, io);
    case 'signal':
      return runSignal(rest, io);
    case 'unregister':
      return runUnregister(rest, io);
    case 'status':
      return runStatus(rest, io);
    default:
      io.stderr.write(`Unknown supervisor subcommand: ${subcommand}\nRun agent-orchestrator supervisor --help for usage.\n`);
      return 1;
  }
}

interface RegisterOptions {
  label?: string;
  cwd?: string;
  client?: 'claude';
  orchestratorId?: string;
  display: OrchestratorDisplay;
}

function parseRegisterArgs(argv: readonly string[]): { ok: true; value: RegisterOptions } | { ok: false; error: string } {
  const display: OrchestratorDisplay = { tmux_pane: null, tmux_window_id: null, base_title: null, host: null };
  const value: RegisterOptions = { display };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const v = argv[++index];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    try {
      if (arg === '--label') value.label = next();
      else if (arg === '--cwd') value.cwd = next();
      else if (arg === '--client') value.client = 'claude';
      else if (arg === '--orchestrator-id') value.orchestratorId = next();
      else if (arg === '--tmux-pane') display.tmux_pane = next();
      else if (arg === '--tmux-window-id') display.tmux_window_id = next();
      else if (arg === '--base-title') display.base_title = next();
      else if (arg === '--host') display.host = next();
      else return { ok: false, error: `Unknown register option: ${arg}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!value.label) return { ok: false, error: 'register requires --label <name>' };
  if (!value.cwd) return { ok: false, error: 'register requires --cwd <path>' };
  return { ok: true, value };
}

async function runRegister(argv: readonly string[], io: SupervisorCliIo): Promise<number> {
  const parsed = parseRegisterArgs(argv);
  if (!parsed.ok) {
    io.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const client = new IpcClient(daemonPaths().ipc.path);
  try {
    const params: Record<string, unknown> = {
      label: parsed.value.label,
      cwd: parsed.value.cwd,
      client: parsed.value.client ?? 'claude',
      display: parsed.value.display,
    };
    if (parsed.value.orchestratorId) params.orchestrator_id = parsed.value.orchestratorId;
    const result = await client.request<{ ok: boolean; orchestrator?: OrchestratorRecord; error?: { message?: string } }>(
      'register_supervisor', params, ipcTimeoutForTool('register_supervisor', params),
    );
    if (!result.ok) {
      io.stderr.write(`register_supervisor failed: ${result.error?.message ?? 'unknown error'}\n`);
      return 1;
    }
    io.stdout.write(`${JSON.stringify({ orchestrator: result.orchestrator }, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${formatIpcError(error)}\n`);
    return 1;
  }
}

async function runSignal(argv: readonly string[], io: SupervisorCliIo): Promise<number> {
  const env = io.env ?? process.env;
  const eventName = argv[0];
  if (!eventName) {
    io.stderr.write('signal requires an event name (UserPromptSubmit | Notification | Stop | SessionStart | SessionEnd)\n');
    return SUPERVISOR_SIGNAL_EXIT_INVALID_EVENT;
  }
  if (!isClaudeSupervisorHookEventName(eventName)) {
    io.stderr.write(`signal: unknown event name ${JSON.stringify(eventName)}\n`);
    return SUPERVISOR_SIGNAL_EXIT_INVALID_EVENT;
  }
  // Drain stdin so Claude does not block on a buffered hook payload. The CLI
  // does not need the JSON content; the daemon owns aggregate state.
  await drainStdin(io.stdin);
  const orchestratorId = env.AGENT_ORCHESTRATOR_ORCH_ID;
  if (!orchestratorId) {
    // No orchestrator pinned (e.g. CLI smoke test); succeed silently so the
    // hook does not surface to the user.
    io.stderr.write('signal: AGENT_ORCHESTRATOR_ORCH_ID not set; nothing to signal\n');
    return SUPERVISOR_SIGNAL_EXIT_OK;
  }
  const supervisorEvent = supervisorEventForClaudeHookEvent(eventName);
  // Validate runtime against the schema as defense-in-depth.
  if (!SupervisorEventSchema.safeParse(supervisorEvent).success) {
    io.stderr.write(`signal: internal mapping produced an unsupported supervisor event ${JSON.stringify(supervisorEvent)}\n`);
    return SUPERVISOR_SIGNAL_EXIT_INVALID_EVENT;
  }
  const client = new IpcClient(daemonPaths().ipc.path);
  const params = { orchestrator_id: orchestratorId, event: supervisorEvent };
  try {
    const result = await client.request<{ ok: boolean; error?: { code?: string; message?: string } }>(
      'signal_supervisor_event', params, ipcTimeoutForTool('signal_supervisor_event', params),
    );
    if (result && result.ok === false && isUnknownOrchestratorWrappedError(result.error)) {
      // Daemon restarted between launch and this signal; transparently
      // re-register from the harness-owned sidecar and retry once
      // (issue #40, F5 / Assumption A7).
      const reregistered = await reregisterFromSidecar(client, orchestratorId, env, io);
      if (reregistered) {
        try {
          await client.request('signal_supervisor_event', params, ipcTimeoutForTool('signal_supervisor_event', params));
        } catch (retryError) {
          io.stderr.write(`signal: ${formatIpcError(retryError)}\n`);
        }
      }
    }
    return SUPERVISOR_SIGNAL_EXIT_OK;
  } catch (error) {
    if (isUnknownOrchestratorError(error)) {
      const reregistered = await reregisterFromSidecar(client, orchestratorId, env, io);
      if (reregistered) {
        try {
          await client.request('signal_supervisor_event', params, ipcTimeoutForTool('signal_supervisor_event', params));
          return SUPERVISOR_SIGNAL_EXIT_OK;
        } catch (retryError) {
          io.stderr.write(`signal: ${formatIpcError(retryError)}\n`);
          return SUPERVISOR_SIGNAL_EXIT_OK;
        }
      }
    }
    // Transient failures (daemon unavailable, unknown orchestrator id with
    // no sidecar to recover from) must not block Claude's turn. Decision 22.
    io.stderr.write(`signal: ${formatIpcError(error)}\n`);
    return SUPERVISOR_SIGNAL_EXIT_OK;
  }
}

function isUnknownOrchestratorError(error: unknown): boolean {
  return error instanceof IpcRequestError
    && error.orchestratorError.code === 'INVALID_INPUT'
    && /Unknown orchestrator id/i.test(error.orchestratorError.message ?? '');
}

function isUnknownOrchestratorWrappedError(error: { code?: string; message?: string } | undefined): boolean {
  return Boolean(error && error.code === 'INVALID_INPUT' && /Unknown orchestrator id/i.test(error.message ?? ''));
}

async function reregisterFromSidecar(
  client: IpcClient,
  orchestratorId: string,
  env: NodeJS.ProcessEnv,
  io: SupervisorCliIo,
): Promise<boolean> {
  const storeRoot = env.AGENT_ORCHESTRATOR_HOME || resolveStoreRoot();
  let record: OrchestratorRecord | null;
  try {
    record = await readOrchestratorSidecar(storeRoot, orchestratorId);
  } catch (error) {
    io.stderr.write(`signal: failed to read orchestrator sidecar: ${error instanceof Error ? error.message : String(error)}\n`);
    return false;
  }
  if (!record) return false;
  try {
    await client.request('register_supervisor', {
      orchestrator_id: record.id,
      client: record.client,
      label: record.label,
      cwd: record.cwd,
      display: record.display,
    }, 5_000);
    return true;
  } catch (error) {
    io.stderr.write(`signal: re-register failed: ${formatIpcError(error)}\n`);
    return false;
  }
}

async function runUnregister(argv: readonly string[], io: SupervisorCliIo): Promise<number> {
  let orchestratorId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--orchestrator-id') {
      orchestratorId = argv[++index];
      if (!orchestratorId) {
        io.stderr.write('unregister: --orchestrator-id requires a value\n');
        return 1;
      }
    } else {
      io.stderr.write(`Unknown unregister option: ${arg}\n`);
      return 1;
    }
  }
  if (!orchestratorId) {
    orchestratorId = (io.env ?? process.env).AGENT_ORCHESTRATOR_ORCH_ID;
  }
  if (!orchestratorId) {
    io.stderr.write('unregister requires --orchestrator-id <id> or AGENT_ORCHESTRATOR_ORCH_ID set in env\n');
    return 1;
  }
  const client = new IpcClient(daemonPaths().ipc.path);
  try {
    const params = { orchestrator_id: orchestratorId };
    await client.request('unregister_supervisor', params, ipcTimeoutForTool('unregister_supervisor', params));
    return 0;
  } catch (error) {
    io.stderr.write(`unregister: ${formatIpcError(error)}\n`);
    return 0;
  }
}

async function runStatus(argv: readonly string[], io: SupervisorCliIo): Promise<number> {
  let orchestratorId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--orchestrator-id') {
      orchestratorId = argv[++index];
      if (!orchestratorId) {
        io.stderr.write('status: --orchestrator-id requires a value\n');
        return 1;
      }
    } else if (arg === '--help' || arg === '-h') {
      io.stdout.write(HELP_TEXT);
      return 0;
    } else {
      io.stderr.write(`Unknown status option: ${arg}\n`);
      return 1;
    }
  }
  if (!orchestratorId) {
    orchestratorId = (io.env ?? process.env).AGENT_ORCHESTRATOR_ORCH_ID;
  }
  if (!orchestratorId) {
    io.stderr.write('status requires --orchestrator-id <id> or AGENT_ORCHESTRATOR_ORCH_ID set in env\n');
    return 1;
  }
  const client = new IpcClient(daemonPaths().ipc.path);
  try {
    const params = { orchestrator_id: orchestratorId };
    const result = await client.request<{
      ok: boolean;
      orchestrator?: OrchestratorRecord;
      status?: OrchestratorStatusSnapshot;
      display?: OrchestratorDisplay;
      error?: { message?: string };
    }>('get_orchestrator_status', params, ipcTimeoutForTool('get_orchestrator_status', params));
    if (!result.ok || !result.orchestrator || !result.status) {
      io.stderr.write(`status: ${result.error?.message ?? 'unknown orchestrator id'}\n`);
      return 1;
    }
    const output = {
      orchestrator: {
        id: result.orchestrator.id,
        client: result.orchestrator.client,
        label: result.orchestrator.label,
        cwd: result.orchestrator.cwd,
      },
      status: result.status,
      display: result.display ?? { tmux_pane: null, tmux_window_id: null, base_title: null, host: null },
    };
    io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof IpcRequestError && error.orchestratorError.code === 'INVALID_INPUT') {
      io.stderr.write(`status: ${error.orchestratorError.message}\n`);
      return 1;
    }
    io.stderr.write(`status: ${formatIpcError(error)}\n`);
    return 1;
  }
}

function formatIpcError(error: unknown): string {
  if (error instanceof IpcRequestError) {
    return `${error.orchestratorError.code}: ${error.orchestratorError.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function drainStdin(stream: NodeJS.ReadableStream | undefined): Promise<void> {
  if (!stream) return;
  if (typeof (stream as { isTTY?: boolean }).isTTY !== 'undefined' && (stream as { isTTY?: boolean }).isTTY) return;
  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        stream.removeAllListeners('data');
        stream.removeAllListeners('end');
        stream.removeAllListeners('error');
        resolve();
      };
      // Race a short read window so we never block the harness if the parent
      // closes stdin without writing.
      const timer = setTimeout(finish, 250);
      if (typeof timer.unref === 'function') timer.unref();
      stream.on('data', () => undefined);
      stream.on('end', finish);
      stream.on('error', finish);
    });
  } catch {
    // best effort
  }
}
