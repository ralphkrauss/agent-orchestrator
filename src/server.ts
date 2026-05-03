#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { IpcClient, IpcRequestError } from './ipc/client.js';
import { daemonPaths } from './daemon/paths.js';
import { orchestratorError, RunNotificationPushPayloadSchema, RunNotificationSchema, wrapErr } from './contract.js';
import { checkDaemonVersion } from './daemonVersion.js';
import { getPackageVersion } from './packageMetadata.js';
import { ipcTimeoutForTool } from './toolTimeout.js';
import { tools } from './mcpTools.js';

const paths = daemonPaths();
const client = new IpcClient(paths.ipc.path);

const server = new Server(
  { name: 'agent-orchestrator', version: getPackageVersion() },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((tool) => ({ ...tool, inputSchema: tool.inputSchema as object })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find((item) => item.name === request.params.name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: JSON.stringify(wrapErr(orchestratorError('INVALID_INPUT', `Unknown tool: ${request.params.name}`)), null, 2) }],
    };
  }

  try {
    await ensureDaemon();
    const args = request.params.arguments ?? {};
    const result = await client.request(tool.name, args, ipcTimeoutForTool(tool.name, args));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    if (error instanceof IpcRequestError) {
      return {
        content: [{ type: 'text', text: JSON.stringify(wrapErr(error.orchestratorError), null, 2) }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(wrapErr(orchestratorError('INTERNAL', error instanceof Error ? error.message : String(error))), null, 2),
      }],
      isError: true,
    };
  }
});

async function ensureDaemon(options: { allowVersionMismatch?: boolean } = {}): Promise<void> {
  try {
    assertMatchingDaemon(await client.request('ping', {}, 500));
    return;
  } catch (error) {
    if (isDaemonVersionMismatch(error)) {
      if (options.allowVersionMismatch) return;
      throw error;
    }
    // Auto-start below.
  }

  const daemonMain = resolve(dirname(fileURLToPath(import.meta.url)), 'daemon/daemonMain.js');
  const child = spawn(process.execPath, [daemonMain], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      assertMatchingDaemon(await client.request('ping', {}, 500));
      return;
    } catch (error) {
      if (isDaemonVersionMismatch(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new IpcRequestError(orchestratorError('DAEMON_UNAVAILABLE', `Daemon did not start; inspect ${paths.log}`));
}

function assertMatchingDaemon(value: unknown): void {
  const check = checkDaemonVersion(value);
  if (!check.ok) throw new IpcRequestError(check.error);
}

function isDaemonVersionMismatch(error: unknown): boolean {
  return error instanceof IpcRequestError && error.orchestratorError.code === 'DAEMON_VERSION_MISMATCH';
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const transport = new StdioServerTransport();
await ensureDaemon({ allowVersionMismatch: true });
await server.connect(transport);
startNotificationPushPoller();

function startNotificationPushPoller(): void {
  const intervalMs = Number.parseInt(process.env.AGENT_ORCHESTRATOR_NOTIFICATION_POLL_MS ?? '500', 10) || 500;
  let lastSeen: string | undefined;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await client.request<{ ok: boolean; notifications?: unknown[] } & Record<string, unknown>>(
        'list_run_notifications',
        lastSeen ? { since_notification_id: lastSeen, limit: 50 } : { limit: 50 },
        1_500,
      );
      if (!result.ok || !Array.isArray(result.notifications)) return;
      for (const raw of result.notifications) {
        const parsed = RunNotificationSchema.safeParse(raw);
        if (!parsed.success) continue;
        const record = parsed.data;
        if (lastSeen === undefined || record.notification_id > lastSeen) lastSeen = record.notification_id;
        const payload = RunNotificationPushPayloadSchema.parse({
          run_id: record.run_id,
          notification_id: record.notification_id,
          kind: record.kind,
          status: record.status,
        });
        try {
          await server.notification({ method: 'notifications/run/changed', params: payload });
        } catch {
          // Push is advisory; durable journal remains authoritative.
        }
      }
    } catch {
      // Tolerate transient IPC errors; durable journal remains authoritative.
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}
