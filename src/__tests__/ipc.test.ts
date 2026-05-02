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
import { PROTOCOL_VERSION } from '../contract.js';
import { checkDaemonVersion } from '../daemonVersion.js';
import { getPackageVersion } from '../packageMetadata.js';

describe('IPC protocol', () => {
  it('round-trips JSON-RPC requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ipc-'));
    const endpoint = daemonIpcEndpoint(root);
    const server = new IpcServer(endpoint.path, async (method, params, context) => ({ method, params, frontend_version: context.frontend_version }));
    await server.listen();
    const client = new IpcClient(endpoint.path);
    const result = await client.request('ping', { hello: true });
    assert.deepStrictEqual(result, { method: 'ping', params: { hello: true }, frontend_version: getPackageVersion() });
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

  it('allows ping and shutdown during daemon version mismatch for recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ipc-'));
    const endpoint = daemonIpcEndpoint(root);
    const calls: string[] = [];
    const server = new IpcServer(endpoint.path, async (method) => {
      calls.push(method);
      return { method };
    }, '0.0.0-stale');
    await server.listen();

    const raw = connect(endpoint.path);
    await new Promise<void>((resolve) => raw.once('connect', resolve));
    raw.write(encodeFrame({ protocol_version: PROTOCOL_VERSION, frontend_version: getPackageVersion(), id: 'ping', method: 'ping' }));
    raw.write(encodeFrame({ protocol_version: PROTOCOL_VERSION, frontend_version: getPackageVersion(), id: 'shutdown', method: 'shutdown' }));
    const reader = new FrameReader();
    const responses = await new Promise<Record<string, unknown>[]>((resolve) => {
      const frames: Record<string, unknown>[] = [];
      raw.on('data', (chunk) => {
        frames.push(...reader.push(chunk) as Record<string, unknown>[]);
        if (frames.length === 2) resolve(frames);
      });
    });
    assert.deepStrictEqual(responses.map((response) => response.ok), [true, true]);
    assert.deepStrictEqual(calls, ['ping', 'shutdown']);
    raw.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('returns daemon version mismatch when frontend version differs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ipc-'));
    const endpoint = daemonIpcEndpoint(root);
    const server = new IpcServer(endpoint.path, async () => ({ ok: true }));
    await server.listen();

    const raw = connect(endpoint.path);
    await new Promise<void>((resolve) => raw.once('connect', resolve));
    raw.write(encodeFrame({ protocol_version: PROTOCOL_VERSION, frontend_version: '0.0.0-stale', id: 'stale', method: 'list_runs' }));
    const reader = new FrameReader();
    const response = await new Promise<Record<string, unknown>>((resolve) => {
      raw.once('data', (chunk) => resolve(reader.push(chunk)[0] as Record<string, unknown>));
    });
    assert.equal(response.ok, false);
    const error = response.error as { code: string; details: { frontend_version: unknown; daemon_version: unknown } };
    assert.equal(error.code, 'DAEMON_VERSION_MISMATCH');
    assert.equal(error.details.frontend_version, '0.0.0-stale');
    assert.equal(error.details.daemon_version, getPackageVersion());
    raw.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('classifies old-style daemon ping responses as a version mismatch', () => {
    const check = checkDaemonVersion({ ok: true, pong: true, daemon_pid: 12345 });
    assert.equal(check.ok, false);
    assert.equal(check.ok ? null : check.error.code, 'DAEMON_VERSION_MISMATCH');
    assert.equal(check.ok ? undefined : check.error.details?.daemon_version, null);
    assert.equal(check.ok ? undefined : check.error.details?.daemon_pid, 12345);
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
