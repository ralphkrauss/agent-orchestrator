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
import { ipcTimeoutForTool } from './toolTimeout.js';

const paths = daemonPaths();
const client = new IpcClient(paths.ipc.path);

const tools = [
  {
    name: 'start_run',
    description: 'Start a Codex or Claude worker run.',
    inputSchema: {
      type: 'object',
      properties: {
        backend: { type: 'string', enum: ['codex', 'claude'] },
        prompt: { type: 'string' },
        cwd: { type: 'string' },
        model: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
        execution_timeout_seconds: { type: 'number' },
      },
      required: ['backend', 'prompt', 'cwd'],
    },
  },
  {
    name: 'list_runs',
    description: 'List known worker runs in descending creation order.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_run_status',
    description: 'Get the current lifecycle status for a run.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
    },
  },
  {
    name: 'get_run_events',
    description: 'Read worker events with cursor pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        after_sequence: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'wait_for_run',
    description: 'Wait for a run to reach a terminal status, bounded by wait_seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        wait_seconds: { type: 'number' },
      },
      required: ['run_id', 'wait_seconds'],
    },
  },
  {
    name: 'get_run_result',
    description: 'Get the normalized worker result for a run, or null while it is running.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
    },
  },
  {
    name: 'send_followup',
    description: 'Start a follow-up run by resuming the parent run backend session.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        prompt: { type: 'string' },
        model: { type: 'string' },
        execution_timeout_seconds: { type: 'number' },
      },
      required: ['run_id', 'prompt'],
    },
  },
  {
    name: 'cancel_run',
    description: 'Cancel a running worker process group.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
    },
  },
  {
    name: 'get_backend_status',
    description: 'Diagnose local Codex and Claude worker CLI availability without making model calls.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

const server = new Server(
  { name: 'agent-orchestrator-mcp', version: '0.1.0' },
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

async function ensureDaemon(): Promise<void> {
  try {
    await client.request('ping', {}, 500);
    return;
  } catch {
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
      await client.request('ping', {}, 500);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new IpcRequestError(orchestratorError('DAEMON_UNAVAILABLE', `Daemon did not start; inspect ${paths.log}`));
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const transport = new StdioServerTransport();
await ensureDaemon();
await server.connect(transport);
