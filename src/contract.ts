import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

export const RunStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'orphaned',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TerminalRunStatusSchema = z.enum([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'orphaned',
]);
export type TerminalRunStatus = z.infer<typeof TerminalRunStatusSchema>;

export const WorkerResultStatusSchema = z.enum([
  'completed',
  'failed',
  'blocked',
  'needs_input',
]);
export type WorkerResultStatus = z.infer<typeof WorkerResultStatusSchema>;

export const BackendSchema = z.enum(['codex', 'claude']);
export type Backend = z.infer<typeof BackendSchema>;

export const BackendAvailabilityStatusSchema = z.enum([
  'available',
  'missing',
  'unsupported',
  'auth_unknown',
  'auth_failed',
]);
export type BackendAvailabilityStatus = z.infer<typeof BackendAvailabilityStatusSchema>;

export const BackendDiagnosticSchema = z.object({
  name: BackendSchema,
  binary: z.string(),
  status: BackendAvailabilityStatusSchema,
  path: z.string().nullable(),
  version: z.string().nullable(),
  auth: z.object({
    status: z.enum(['ready', 'unknown', 'failed']),
    source: z.string().optional(),
    hint: z.string().optional(),
  }),
  checks: z.array(z.object({
    name: z.string(),
    ok: z.boolean(),
    message: z.string().optional(),
  })),
  hints: z.array(z.string()),
});
export type BackendDiagnostic = z.infer<typeof BackendDiagnosticSchema>;

export const BackendStatusReportSchema = z.object({
  frontend_version: z.string(),
  daemon_version: z.string().nullable(),
  version_match: z.boolean(),
  daemon_pid: z.number().int().nullable(),
  platform: z.string(),
  node_version: z.string(),
  posix_supported: z.boolean(),
  run_store: z.object({
    path: z.string(),
    accessible: z.boolean(),
    message: z.string().optional(),
  }),
  backends: z.array(BackendDiagnosticSchema),
});
export type BackendStatusReport = z.infer<typeof BackendStatusReportSchema>;

export const GitSnapshotStatusSchema = z.enum([
  'captured',
  'not_a_repo',
  'empty_repo',
  'detached_head_no_base',
  'git_unavailable',
  'too_large',
]);
export type GitSnapshotStatus = z.infer<typeof GitSnapshotStatusSchema>;

export const GitSnapshotSchema = z.object({
  sha: z.string(),
  dirty_count: z.number().int().nonnegative(),
  dirty: z.array(z.string()).optional(),
  dirty_fingerprints: z.record(z.string()).optional(),
});
export type GitSnapshot = z.infer<typeof GitSnapshotSchema>;

export const OrchestratorErrorCodeSchema = z.enum([
  'DAEMON_UNAVAILABLE',
  'DAEMON_VERSION_MISMATCH',
  'UNKNOWN_RUN',
  'INVALID_INPUT',
  'BACKEND_NOT_FOUND',
  'WORKER_BINARY_MISSING',
  'PROTOCOL_VERSION_MISMATCH',
  'INVALID_STATE',
  'INTERNAL',
]);
export type OrchestratorErrorCode = z.infer<typeof OrchestratorErrorCodeSchema>;

export const OrchestratorErrorSchema = z.object({
  code: OrchestratorErrorCodeSchema,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type OrchestratorError = z.infer<typeof OrchestratorErrorSchema>;

export const WorkerEventSchema = z.object({
  seq: z.number().int().positive(),
  ts: z.string(),
  type: z.enum(['assistant_message', 'tool_use', 'tool_result', 'error', 'lifecycle']),
  payload: z.record(z.unknown()),
});
export type WorkerEvent = z.infer<typeof WorkerEventSchema>;

export const WorkerResultSchema = z.object({
  status: WorkerResultStatusSchema,
  summary: z.string(),
  files_changed: z.array(z.string()),
  commands_run: z.array(z.string()),
  artifacts: z.array(z.object({ name: z.string(), path: z.string() })),
  errors: z.array(z.object({
    message: z.string(),
    context: z.record(z.unknown()).optional(),
  })),
});
export type WorkerResult = z.infer<typeof WorkerResultSchema>;

export const RunSummarySchema = z.object({
  run_id: z.string(),
  backend: BackendSchema,
  status: RunStatusSchema,
  parent_run_id: z.string().nullable(),
  session_id: z.string().nullable(),
  model: z.string().nullable().optional().default(null),
  cwd: z.string(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  worker_pid: z.number().int().nullable(),
  worker_pgid: z.number().int().nullable(),
  daemon_pid_at_spawn: z.number().int().nullable(),
  git_snapshot_status: GitSnapshotStatusSchema,
  git_snapshot: GitSnapshotSchema.nullable(),
  metadata: z.record(z.unknown()),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunMetaSchema = RunSummarySchema.extend({
  git_snapshot_at_start: GitSnapshotSchema.nullable().optional(),
  execution_timeout_seconds: z.number().int().positive().nullable().optional(),
});
export type RunMeta = z.infer<typeof RunMetaSchema>;

export const ToolResponseSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.union([
    z.object({ ok: z.literal(true) }).and(payload),
    z.object({ ok: z.literal(false), error: OrchestratorErrorSchema }),
  ]);

export type ToolResponse<TPayload extends object> =
  | ({ ok: true } & TPayload)
  | { ok: false; error: OrchestratorError };

export function wrapOk<TPayload extends object>(payload: TPayload): ToolResponse<TPayload> {
  return { ok: true, ...payload };
}

export function wrapErr<TPayload extends object = Record<string, never>>(
  error: OrchestratorError,
): ToolResponse<TPayload> {
  return { ok: false, error };
}

export const StartRunInputSchema = z.object({
  backend: BackendSchema,
  prompt: z.string().min(1),
  cwd: z.string().min(1),
  model: z.string().trim().min(1).optional(),
  metadata: z.record(z.unknown()).optional().default({}),
  execution_timeout_seconds: z.number().int().positive().optional(),
});
export type StartRunInput = z.input<typeof StartRunInputSchema>;
export type StartRun = z.output<typeof StartRunInputSchema>;

export const SendFollowupInputSchema = z.object({
  run_id: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().trim().min(1).optional(),
  execution_timeout_seconds: z.number().int().positive().optional(),
});
export type SendFollowupInput = z.input<typeof SendFollowupInputSchema>;
export type SendFollowup = z.output<typeof SendFollowupInputSchema>;

export const RunIdInputSchema = z.object({ run_id: z.string().min(1) });
export type RunIdInput = z.infer<typeof RunIdInputSchema>;

export const GetRunEventsInputSchema = z.object({
  run_id: z.string().min(1),
  after_sequence: z.number().int().nonnegative().optional().default(0),
  limit: z.number().int().positive().max(1000).optional().default(200),
});
export type GetRunEventsInput = z.input<typeof GetRunEventsInputSchema>;
export type GetRunEvents = z.output<typeof GetRunEventsInputSchema>;

export const WaitForRunInputSchema = z.object({
  run_id: z.string().min(1),
  wait_seconds: z.number().int().min(1).max(300),
});
export type WaitForRunInput = z.infer<typeof WaitForRunInputSchema>;

export const CancelRunInputSchema = RunIdInputSchema;

export const ShutdownInputSchema = z.object({
  force: z.boolean().optional().default(false),
});
export type ShutdownInput = z.input<typeof ShutdownInputSchema>;

export const PruneRunsInputSchema = z.object({
  older_than_days: z.number().int().positive(),
  dry_run: z.boolean().optional().default(false),
});
export type PruneRunsInput = z.input<typeof PruneRunsInputSchema>;

export const RpcMethodSchema = z.enum([
  'ping',
  'shutdown',
  'prune_runs',
  'start_run',
  'list_runs',
  'get_run_status',
  'get_run_events',
  'wait_for_run',
  'get_run_result',
  'send_followup',
  'cancel_run',
  'get_backend_status',
]);
export type RpcMethod = z.infer<typeof RpcMethodSchema>;

export const RpcRequestSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  frontend_version: z.string().min(1).optional(),
  id: z.string(),
  method: RpcMethodSchema,
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    protocol_version: z.literal(PROTOCOL_VERSION),
    id: z.string(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    protocol_version: z.literal(PROTOCOL_VERSION),
    id: z.string(),
    ok: z.literal(false),
    error: OrchestratorErrorSchema,
  }),
]);
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

export function isTerminalStatus(status: RunStatus): status is TerminalRunStatus {
  return status !== 'running';
}

export function orchestratorError(
  code: OrchestratorErrorCode,
  message: string,
  details?: Record<string, unknown>,
): OrchestratorError {
  return details ? { code, message, details } : { code, message };
}

export const DAEMON_VERSION_MISMATCH_RECOVERY_HINT =
  'Restart the daemon so it picks up the current package build: agent-orchestrator-mcp-daemon restart';

export function daemonVersionMismatchError(input: {
  frontendVersion: string | null;
  daemonVersion: string | null;
  daemonPid?: number | null;
}): OrchestratorError {
  const frontendVersion = input.frontendVersion ?? 'unknown';
  const daemonVersion = input.daemonVersion ?? 'unknown';
  const details: Record<string, unknown> = {
    frontend_version: input.frontendVersion,
    daemon_version: input.daemonVersion,
    recovery_hint: DAEMON_VERSION_MISMATCH_RECOVERY_HINT,
  };
  if (input.daemonPid !== undefined) {
    details.daemon_pid = input.daemonPid;
  }

  return orchestratorError(
    'DAEMON_VERSION_MISMATCH',
    `Frontend package version ${frontendVersion} does not match daemon package version ${daemonVersion}. Restart the daemon so it picks up the current package build.`,
    details,
  );
}
