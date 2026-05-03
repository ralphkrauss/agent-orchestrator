import type { RunStatus, WorkerResultStatus } from '../contract.js';

export interface ObservedResultInput {
  exitCode: number | null;
  resultEventPresent: boolean;
  resultEventValid: boolean;
  stopReason: string | null;
  runStatusOverride?: Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out' | 'orphaned'>;
}

export interface ObservedResult {
  runStatus: RunStatus;
  workerStatus: WorkerResultStatus;
}

const completedStopReasons = new Set(['end_turn', 'stop', 'complete', 'completed', 'success', 'successfully']);
const needsInputStopReasons = new Set(['tool_use_required', 'awaiting_input', 'needs_input']);
const blockedStopReasons = new Set(['refusal', 'permission_denied', 'policy_block', 'blocked']);

export function deriveObservedResult(input: ObservedResultInput): ObservedResult {
  if (input.runStatusOverride) {
    return { runStatus: input.runStatusOverride, workerStatus: 'failed' };
  }

  if (input.exitCode !== 0 || !input.resultEventPresent || !input.resultEventValid) {
    return { runStatus: 'failed', workerStatus: 'failed' };
  }

  const stopReason = normalizeStopReason(input.stopReason);
  if (needsInputStopReasons.has(stopReason)) {
    return { runStatus: 'completed', workerStatus: 'needs_input' };
  }

  if (blockedStopReasons.has(stopReason)) {
    return { runStatus: 'completed', workerStatus: 'blocked' };
  }

  if (stopReason === '' || completedStopReasons.has(stopReason)) {
    return { runStatus: 'completed', workerStatus: 'completed' };
  }

  return { runStatus: 'completed', workerStatus: 'completed' };
}

export function normalizeStopReason(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}
