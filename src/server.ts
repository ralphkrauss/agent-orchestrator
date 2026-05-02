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
import { orchestratorError, wrapErr } from './contract.js';
import { checkDaemonVersion } from './daemonVersion.js';
import { getPackageVersion } from './packageMetadata.js';
import { ipcTimeoutForTool } from './toolTimeout.js';
import { tools } from './mcpTools.js';

const paths = daemonPaths();
const client = new IpcClient(paths.ipc.path);

const server = new Server(
  { name: 'agent-orchestrator-mcp', version: getPackageVersion() },
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
