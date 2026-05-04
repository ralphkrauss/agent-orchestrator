import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  daemonVersionMismatchError,
  orchestratorError,
  PROTOCOL_VERSION,
  RpcRequestSchema,
  type OrchestratorError,
  type RpcMethod,
  type RpcPolicyContext,
  type RpcRequest,
  type RpcResponse,
} from '../contract.js';
import { getPackageVersion } from '../packageMetadata.js';

export function createRpcRequest(
  method: RpcMethod,
  params?: unknown,
  frontendVersion = getPackageVersion(),
  policyContext?: RpcPolicyContext,
): RpcRequest {
  const request: RpcRequest = {
    protocol_version: PROTOCOL_VERSION,
    frontend_version: frontendVersion,
    id: randomUUID(),
    method,
    params,
  };
  if (policyContext && Object.keys(policyContext).length > 0) {
    request.policy_context = policyContext;
  }
  return request;
}

export function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export class FrameReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > 10 * 1024 * 1024) {
        throw new Error(`IPC frame too large: ${length}`);
      }
      if (this.buffer.length < 4 + length) break;
      const payload = this.buffer.subarray(4, 4 + length).toString('utf8');
      frames.push(JSON.parse(payload));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return frames;
  }
}

export function writeFrame(socket: Socket, value: unknown): void {
  socket.write(encodeFrame(value));
}

export function validateRpcRequest(
  value: unknown,
  daemonVersion = getPackageVersion(),
): RpcRequest | { protocolMismatch: true; id: string | null } | { daemonVersionMismatch: true; id: string | null; error: OrchestratorError } {
  const rec = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const id = typeof rec.id === 'string' ? rec.id : null;
  if (rec.protocol_version !== PROTOCOL_VERSION) {
    return { protocolMismatch: true, id };
  }
  const request = RpcRequestSchema.parse(value);
  if (request.frontend_version !== daemonVersion && !allowsLifecycleVersionMismatch(request.method)) {
    return {
      daemonVersionMismatch: true,
      id,
      error: daemonVersionMismatchError({
        frontendVersion: request.frontend_version ?? null,
        daemonVersion,
        daemonPid: process.pid,
      }),
    };
  }
  return request;
}

function allowsLifecycleVersionMismatch(method: RpcMethod): boolean {
  return method === 'ping' || method === 'shutdown';
}

export function rpcOk(id: string, result: unknown): RpcResponse {
  return {
    protocol_version: PROTOCOL_VERSION,
    id,
    ok: true,
    result,
  };
}

export function rpcErr(id: string, code: Parameters<typeof orchestratorError>[0], message: string, details?: Record<string, unknown>): RpcResponse {
  return {
    protocol_version: PROTOCOL_VERSION,
    id,
    ok: false,
    error: orchestratorError(code, message, details),
  };
}

export function rpcErrFromError(id: string, error: OrchestratorError): RpcResponse {
  return {
    protocol_version: PROTOCOL_VERSION,
    id,
    ok: false,
    error,
  };
}
