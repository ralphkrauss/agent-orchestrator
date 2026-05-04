// Thin shim around the optional `@cursor/sdk` dependency.
//
// Production code never imports `@cursor/sdk` statically. Instead the runtime
// resolves it lazily through `defaultCursorSdkAdapter()` so the daemon keeps
// running for Codex/Claude users when the SDK is absent. Tests inject a fake
// adapter via `CursorSdkRuntime` to avoid touching the real SDK or the
// network.

import { createRequire } from 'node:module';
import type { Backend } from '../../contract.js';

export const CURSOR_SDK_PACKAGE = '@cursor/sdk' as const;
export const CURSOR_BACKEND_NAME: Backend = 'cursor';

export type CursorRunStatus = 'running' | 'finished' | 'error' | 'cancelled';

export interface CursorTextBlock {
  type: 'text';
  text: string;
}

export interface CursorToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface CursorAssistantContent {
  role?: 'assistant';
  content: Array<CursorTextBlock | CursorToolUseBlock>;
}

export interface CursorSystemMessage {
  type: 'system';
  agent_id?: string;
  run_id?: string;
  model?: { id?: string };
}

export interface CursorAssistantMessage {
  type: 'assistant';
  agent_id?: string;
  run_id?: string;
  message: CursorAssistantContent;
}

export interface CursorToolUseMessage {
  type: 'tool_call';
  agent_id?: string;
  run_id?: string;
  call_id?: string;
  name?: string;
  status?: 'running' | 'completed' | 'error';
  args?: unknown;
  result?: unknown;
}

export interface CursorThinkingMessage {
  type: 'thinking';
  text?: string;
  thinking_duration_ms?: number;
}

export interface CursorStatusMessage {
  type: 'status';
  status?: 'CREATING' | 'RUNNING' | 'FINISHED' | 'ERROR' | 'CANCELLED' | 'EXPIRED';
  message?: string;
}

export interface CursorTaskMessage {
  type: 'task';
  status?: string;
  text?: string;
}

export interface CursorRequestMessage {
  type: 'request';
  request_id?: string;
}

export interface CursorUserMessage {
  type: 'user';
  message?: { role?: 'user'; content?: CursorTextBlock[] };
}

export type CursorSdkMessage =
  | CursorSystemMessage
  | CursorAssistantMessage
  | CursorToolUseMessage
  | CursorThinkingMessage
  | CursorStatusMessage
  | CursorTaskMessage
  | CursorRequestMessage
  | CursorUserMessage
  | { type: string; [key: string]: unknown };

export interface CursorRunResult {
  id?: string;
  status: CursorRunStatus;
  result?: string;
  durationMs?: number;
}

export interface CursorRun {
  readonly id: string;
  readonly agentId: string;
  readonly status: CursorRunStatus;
  readonly result?: string;
  stream(): AsyncGenerator<CursorSdkMessage, void> | AsyncIterable<CursorSdkMessage>;
  wait(): Promise<CursorRunResult>;
  cancel(): Promise<void>;
}

export interface CursorAgentSendOptions {
  model?: { id: string; params?: { id: string; value: string }[] };
}

export interface CursorAgent {
  readonly agentId: string;
  send(message: string, options?: CursorAgentSendOptions): Promise<CursorRun>;
  close?(): void;
  [Symbol.asyncDispose]?: () => Promise<void>;
}

export interface CursorAgentCreateOptions {
  apiKey?: string;
  model?: { id: string; params?: { id: string; value: string }[] };
  local?: { cwd?: string };
  agentId?: string;
  name?: string;
}

export interface CursorAgentResumeOptions {
  apiKey?: string;
  model?: { id: string; params?: { id: string; value: string }[] };
  local?: { cwd?: string };
}

export interface CursorAgentApi {
  create(options: CursorAgentCreateOptions): Promise<CursorAgent>;
  resume(agentId: string, options?: CursorAgentResumeOptions): Promise<CursorAgent>;
}

export interface CursorSdkAdapter {
  /** Probe whether the SDK is importable. Cheap and idempotent. */
  available(): Promise<
    | { ok: true; modulePath: string | null }
    | { ok: false; reason: string; modulePath?: string | null }
  >;
  /** Resolve the live SDK Agent API. Throws if `available()` returns `ok: false`. */
  loadAgentApi(): Promise<CursorAgentApi>;
}

interface CachedAdapterState {
  available?: Awaited<ReturnType<CursorSdkAdapter['available']>>;
  agentApi?: CursorAgentApi;
}

export interface CursorSdkAdapterOptions {
  /** Test seam: provide an alternative loader instead of `await import('@cursor/sdk')`. */
  importer?: () => Promise<Record<string, unknown>>;
  /** Test seam: provide an alternative module path resolver. */
  resolveModulePath?: () => string | null;
}

export function defaultCursorSdkAdapter(options: CursorSdkAdapterOptions = {}): CursorSdkAdapter {
  const state: CachedAdapterState = {};

  const loadModule = options.importer
    ?? (async () => (await import(/* @vite-ignore */ CURSOR_SDK_PACKAGE)) as Record<string, unknown>);
  const pathResolver = options.resolveModulePath ?? resolveModulePath;

  const importSdk = async (): Promise<
    | { ok: true; module: Record<string, unknown>; path: string | null }
    | { ok: false; reason: string; resolvedPath: string | null }
  > => {
    // Probe resolution before import so a resolvable-but-broken SDK (e.g. native
    // `sqlite3` binding missing for the current Node) is distinguishable from a
    // missing package. The runtime uses `resolvedPath` to pick the right hint.
    const path = pathResolver();
    try {
      const mod = await loadModule();
      return { ok: true, module: mod, path };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason, resolvedPath: path };
    }
  };

  return {
    async available() {
      if (state.available) return state.available;
      const result = await importSdk();
      if (!result.ok) {
        state.available = { ok: false, reason: result.reason, modulePath: result.resolvedPath };
        return state.available;
      }
      try {
        state.agentApi = extractAgentApi(result.module);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        state.available = { ok: false, reason, modulePath: result.path };
        return state.available;
      }
      state.available = { ok: true, modulePath: result.path };
      return state.available;
    },
    async loadAgentApi() {
      if (state.agentApi) return state.agentApi;
      const result = await importSdk();
      if (!result.ok) {
        state.available = { ok: false, reason: result.reason, modulePath: result.resolvedPath };
        throw new Error(`@cursor/sdk is not installed: ${result.reason}`);
      }
      let api: CursorAgentApi;
      try {
        api = extractAgentApi(result.module);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        state.available = { ok: false, reason, modulePath: result.path };
        throw error;
      }
      state.available = { ok: true, modulePath: result.path };
      state.agentApi = api;
      return api;
    },
  };
}

function extractAgentApi(mod: Record<string, unknown>): CursorAgentApi {
  const candidate = mod.Agent as
    | { create?: unknown; resume?: unknown }
    | undefined;
  if (!candidate || typeof candidate.create !== 'function' || typeof candidate.resume !== 'function') {
    throw new Error('@cursor/sdk did not export the Agent factory expected by this version of agent-orchestrator');
  }
  return candidate as unknown as CursorAgentApi;
}

function resolveModulePath(): string | null {
  try {
    const requireFromHere = createRequire(import.meta.url);
    return requireFromHere.resolve(CURSOR_SDK_PACKAGE);
  } catch {
    return null;
  }
}
