import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { daemonIpcEndpoint } from '../daemon/paths.js';
import { IpcClient, IpcRequestError } from '../ipc/client.js';
import { IpcServer } from '../ipc/server.js';
import { encodeFrame, FrameReader, writeFrame } from '../ipc/protocol.js';

describe('IPC protocol', () => {
  it('round-trips JSON-RPC requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ipc-'));
    const endpoint = daemonIpcEndpoint(root);
    const server = new IpcServer(endpoint.path, async (method, params) => ({ method, params }));
    await server.listen();
    const client = new IpcClient(endpoint.path);
    const result = await client.request('ping', { hello: true });
    assert.deepStrictEqual(result, { method: 'ping', params: { hello: true } });
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('returns protocol mismatch as an orchestrator error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ipc-'));
    const endpoint = daemonIpcEndpoint(root);
    const server = new IpcServer(endpoint.path, async () => ({ ok: true }));
    await server.listen();

    const raw = connect(endpoint.path);
    await new Promise<void>((resolve) => raw.once('connect', resolve));
    raw.write(encodeFrame({ protocol_version: 999, id: 'bad', method: 'ping' }));
    const reader = new FrameReader();
    const response = await new Promise<Record<string, unknown>>((resolve) => {
      raw.once('data', (chunk) => resolve(reader.push(chunk)[0] as Record<string, unknown>));
    });
    assert.equal(response.ok, false);
    assert.deepStrictEqual((response.error as { code: string }).code, 'PROTOCOL_VERSION_MISMATCH');
    raw.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('wraps unavailable daemon as DAEMON_UNAVAILABLE', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ipc-missing-'));
    const endpoint = daemonIpcEndpoint(root);
    const client = new IpcClient(endpoint.path);
    await assert.rejects(
      () => client.request('ping', {}, 50),
      (error) => error instanceof IpcRequestError && error.orchestratorError.code === 'DAEMON_UNAVAILABLE',
    );
    await rm(root, { recursive: true, force: true });
  });
});
