import type {
  Backend,
  RunError,
  RunModelSettings,
  RunStatus,
  WorkerEvent,
  WorkerResult,
} from '../contract.js';

export interface WorkerInvocation {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdinPayload: string;
}

export interface BackendStartInput {
  prompt: string;
  cwd: string;
  model?: string | null;
  modelSettings: RunModelSettings;
}

export interface ParsedBackendEvent {
  events: Omit<WorkerEvent, 'seq' | 'ts'>[];
  sessionId?: string;
  resultEvent?: BackendResultEvent;
  filesChanged: string[];
  commandsRun: string[];
  errors: RunError[];
}

export interface BackendResultEvent {
  summary: string;
  stopReason: string | null;
  raw: unknown;
}

export interface FinalizeContext {
  runStatusOverride?: Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out' | 'orphaned'>;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  resultEvent: BackendResultEvent | null;
  filesChangedFromEvents: string[];
  filesChangedFromGit: string[];
  commandsRun: string[];
  artifacts: { name: string; path: string }[];
  errors: RunError[];
  lastAssistantMessage?: string;
}

export interface FinalizedWorkerResult {
  runStatus: RunStatus;
  result: WorkerResult;
}

export interface WorkerBackend {
  readonly name: Backend;
  readonly binary: string;
  start(input: BackendStartInput): Promise<WorkerInvocation>;
  resume(sessionId: string, input: BackendStartInput): Promise<WorkerInvocation>;
  parseEvent(raw: unknown): ParsedBackendEvent;
  finalizeResult(context: FinalizeContext): FinalizedWorkerResult;
}
