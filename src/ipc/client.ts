import { connect } from 'node:net';
import { once } from 'node:events';
import { createRpcRequest, FrameReader, writeFrame } from './protocol.js';
import { orchestratorError, type OrchestratorError, RpcResponseSchema, type RpcMethod } from '../contract.js';

export class IpcClient {
  constructor(private readonly socketPath: string) {}

  async request<T = unknown>(method: RpcMethod, params?: unknown, timeoutMs = 30_000): Promise<T> {
    const socket = connect(this.socketPath);
    try {
      await once(socket, 'connect');
      const request = createRpcRequest(method, params);
      const reader = new FrameReader();
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`IPC request timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const cleanup = () => {
          clearTimeout(timer);
          socket.removeAllListeners('data');
          socket.removeAllListeners('error');
          socket.removeAllListeners('close');
          socket.end();
          socket.destroy();
        };

        socket.on('data', (chunk) => {
          try {
            for (const frame of reader.push(chunk)) {
              const response = RpcResponseSchema.parse(frame);
              if (response.id !== request.id) continue;
              cleanup();
              if (!response.ok) {
                reject(new IpcRequestError(response.error));
                return;
              }
              resolve(response.result as T);
              return;
            }
          } catch (error) {
            cleanup();
            reject(error);
          }
        });

        socket.on('error', (error) => {
          cleanup();
          reject(error);
        });

        socket.on('close', () => {
          cleanup();
          reject(new Error('IPC socket closed before response'));
        });

        writeFrame(socket, request);
      });
    } catch (error) {
      if (error instanceof IpcRequestError) throw error;
      throw new IpcRequestError(orchestratorError(
        'DAEMON_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      ));
    }
  }
}

export class IpcRequestError extends Error {
  constructor(readonly orchestratorError: OrchestratorError) {
    super(orchestratorError.message);
  }
}
