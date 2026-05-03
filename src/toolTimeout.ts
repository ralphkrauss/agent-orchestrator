import { WaitForAnyRunInputSchema, WaitForRunInputSchema, type RpcMethod } from './contract.js';

export const defaultIpcTimeoutMs = 30_000;
export const waitForRunIpcTimeoutMarginMs = 5_000;

export function ipcTimeoutForTool(method: RpcMethod, params: unknown): number {
  if (method === 'wait_for_run') {
    const parsed = WaitForRunInputSchema.safeParse(params);
    if (!parsed.success) return defaultIpcTimeoutMs;
    return (parsed.data.wait_seconds * 1000) + waitForRunIpcTimeoutMarginMs;
  }

  if (method === 'wait_for_any_run') {
    const parsed = WaitForAnyRunInputSchema.safeParse(params);
    if (!parsed.success) return defaultIpcTimeoutMs;
    return (parsed.data.wait_seconds * 1000) + waitForRunIpcTimeoutMarginMs;
  }

  return defaultIpcTimeoutMs;
}
