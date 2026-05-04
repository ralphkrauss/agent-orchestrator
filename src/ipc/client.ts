import { connect } from 'node:net';
import { once } from 'node:events';
import { createRpcRequest, FrameReader, writeFrame } from './protocol.js';
import { orchestratorError, type OrchestratorError, type RpcPolicyContext, RpcResponseSchema, type RpcMethod } from '../contract.js';
import { getPackageVersion } from '../packageMetadata.js';

export interface IpcRequestOptions {
  timeoutMs?: number;
  policyContext?: RpcPolicyContext;
}

export class IpcClient {
  constructor(
    private readonly socketPath: string,
    private readonly frontendVersion = getPackageVersion(),
  ) {}

  async request<T = unknown>(
    method: RpcMethod,
    params?: unknown,
    optionsOrTimeoutMs: IpcRequestOptions | number = 30_000,
  ): Promise<T> {
    const options: IpcRequestOptions = typeof optionsOrTimeoutMs === 'number'
      ? { timeoutMs: optionsOrTimeoutMs }
      : optionsOrTimeoutMs;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const socket = connect(this.socketPath);
    try {
      await once(socket, 'connect');
      const request = createRpcRequest(method, params, this.frontendVersion, options.policyContext);
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
