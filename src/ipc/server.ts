import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { FrameReader, rpcErr, rpcOk, validateRpcRequest, writeFrame } from './protocol.js';
import type { RpcMethod } from '../contract.js';

export type RpcHandler = (method: RpcMethod, params: unknown) => Promise<unknown>;

export class IpcServer {
  private server: NetServer | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly handler: RpcHandler,
  ) {}

  async listen(): Promise<void> {
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => error ? reject(error) : resolve());
    });
  }

  private handleSocket(socket: Socket): void {
    const reader = new FrameReader();
    socket.on('data', async (chunk) => {
      let frames: unknown[];
      try {
        frames = reader.push(chunk);
      } catch (error) {
        writeFrame(socket, rpcErr('unknown', 'INTERNAL', error instanceof Error ? error.message : String(error)));
        socket.end();
        return;
      }

      for (const frame of frames) {
        const rec = frame && typeof frame === 'object' ? frame as Record<string, unknown> : {};
        const id = typeof rec.id === 'string' ? rec.id : 'unknown';
        try {
          const request = validateRpcRequest(frame);
          if ('protocolMismatch' in request) {
            writeFrame(socket, rpcErr(request.id ?? id, 'PROTOCOL_VERSION_MISMATCH', 'IPC protocol version mismatch'));
            continue;
          }
          const result = await this.handler(request.method, request.params);
          writeFrame(socket, rpcOk(request.id, result));
        } catch (error) {
          writeFrame(socket, rpcErr(id, 'INTERNAL', error instanceof Error ? error.message : String(error)));
        }
      }
    });
  }
}
