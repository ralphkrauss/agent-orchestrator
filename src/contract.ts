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

export const ModelSourceSchema = z.enum([
  'explicit',
  'inherited',
  'backend_default',
  'legacy_unknown',
]);
export type ModelSource = z.infer<typeof ModelSourceSchema>;

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
  root: z.string().nullable().optional().default(null),
  branch: z.string().nullable().optional().default(null),
  dirty_count: z.number().int().nonnegative(),
  dirty: z.array(z.string()).optional(),
  dirty_fingerprints: z.record(z.string()).optional(),
});
export type GitSnapshot = z.infer<typeof GitSnapshotSchema>;

export const OrchestratorErrorCodeSchema = z.enum([
  'DAEMON_UNAVAILABLE',
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

export const WorkerEventTypeSchema = z.enum(['assistant_message', 'tool_use', 'tool_result', 'error', 'lifecycle']);
export type WorkerEventType = z.infer<typeof WorkerEventTypeSchema>;

export const WorkerEventSchema = z.object({
  seq: z.number().int().positive(),
  ts: z.string(),
  type: WorkerEventTypeSchema,
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

const defaultRunDisplayMetadata = {
  session_title: null,
  session_summary: null,
  prompt_title: null,
  prompt_summary: null,
};

export const RunDisplayMetadataSchema = z.object({
  session_title: z.string().nullable().optional().default(null),
  session_summary: z.string().nullable().optional().default(null),
  prompt_title: z.string().nullable().optional().default(null),
  prompt_summary: z.string().nullable().optional().default(null),
}).default(defaultRunDisplayMetadata);
export type RunDisplayMetadata = z.infer<typeof RunDisplayMetadataSchema>;

export const ReasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ServiceTierSchema = z.enum([
  'fast',
  'flex',
  'normal',
]);
export type ServiceTier = z.infer<typeof ServiceTierSchema>;

const defaultRunModelSettings = {
  reasoning_effort: null,
  service_tier: null,
  mode: null,
};

export const RunModelSettingsSchema = z.object({
  reasoning_effort: z.string().nullable().optional().default(null),
  service_tier: z.string().nullable().optional().default(null),
  mode: z.string().nullable().optional().default(null),
}).default(defaultRunModelSettings);
export type RunModelSettings = z.infer<typeof RunModelSettingsSchema>;

export const RunWorkerInvocationSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
}).nullable().default(null);
export type RunWorkerInvocation = z.infer<typeof RunWorkerInvocationSchema>;

export const RunSummarySchema = z.object({
  run_id: z.string(),
  backend: BackendSchema,
  status: RunStatusSchema,
  parent_run_id: z.string().nullable(),
  session_id: z.string().nullable(),
  model: z.string().nullable().optional().default(null),
  model_source: ModelSourceSchema.optional().default('legacy_unknown'),
  model_settings: RunModelSettingsSchema.optional().default(defaultRunModelSettings),
  requested_session_id: z.string().nullable().optional().default(null),
  observed_session_id: z.string().nullable().optional().default(null),
  observed_model: z.string().nullable().optional().default(null),
  display: RunDisplayMetadataSchema.optional().default(defaultRunDisplayMetadata),
  cwd: z.string(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  worker_pid: z.number().int().nullable(),
  worker_pgid: z.number().int().nullable(),
  daemon_pid_at_spawn: z.number().int().nullable(),
  worker_invocation: RunWorkerInvocationSchema.optional().default(null),
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
  reasoning_effort: ReasoningEffortSchema.optional(),
  service_tier: ServiceTierSchema.optional(),
  metadata: z.record(z.unknown()).optional().default({}),
  execution_timeout_seconds: z.number().int().positive().optional(),
});
export type StartRunInput = z.input<typeof StartRunInputSchema>;
export type StartRun = z.output<typeof StartRunInputSchema>;

export const SendFollowupInputSchema = z.object({
  run_id: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().trim().min(1).optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  service_tier: ServiceTierSchema.optional(),
  metadata: z.record(z.unknown()).optional().default({}),
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

export const GetObservabilitySnapshotInputSchema = z.object({
  limit: z.number().int().positive().max(500).optional().default(50),
  include_prompts: z.boolean().optional().default(false),
  recent_event_limit: z.number().int().nonnegative().max(50).optional().default(5),
  diagnostics: z.boolean().optional().default(false),
});
export type GetObservabilitySnapshotInput = z.input<typeof GetObservabilitySnapshotInputSchema>;
export type GetObservabilitySnapshot = z.output<typeof GetObservabilitySnapshotInputSchema>;

export const ObservabilityArtifactSchema = z.object({
  name: z.string(),
  path: z.string(),
  exists: z.boolean(),
  bytes: z.number().int().nonnegative().nullable(),
});
export type ObservabilityArtifact = z.infer<typeof ObservabilityArtifactSchema>;

export const ObservabilityPromptSchema = z.object({
  title: z.string(),
  summary: z.string().nullable(),
  preview: z.string(),
  text: z.string().nullable(),
  path: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
});
export type ObservabilityPrompt = z.infer<typeof ObservabilityPromptSchema>;

export const ObservabilityResponseSchema = z.object({
  status: WorkerResultStatusSchema.nullable(),
  summary: z.string().nullable(),
  path: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
});
export type ObservabilityResponse = z.infer<typeof ObservabilityResponseSchema>;

export const ObservabilityActivitySchema = z.object({
  last_event_sequence: z.number().int().nonnegative(),
  last_event_at: z.string().nullable(),
  last_event_type: WorkerEventTypeSchema.nullable(),
  last_interaction_preview: z.string().nullable(),
  event_count: z.number().int().nonnegative(),
  recent_errors: z.array(z.string()),
  recent_events: z.array(WorkerEventSchema),
});
export type ObservabilityActivity = z.infer<typeof ObservabilityActivitySchema>;

export const ObservabilitySessionAuditStatusSchema = z.enum([
  'new_session',
  'pending',
  'resumed',
  'mismatch',
  'unknown',
]);
export type ObservabilitySessionAuditStatus = z.infer<typeof ObservabilitySessionAuditStatusSchema>;

export const ObservabilitySessionAuditSchema = z.object({
  requested_session_id: z.string().nullable(),
  observed_session_id: z.string().nullable(),
  effective_session_id: z.string().nullable(),
  status: ObservabilitySessionAuditStatusSchema,
  warnings: z.array(z.string()),
});
export type ObservabilitySessionAudit = z.infer<typeof ObservabilitySessionAuditSchema>;

export const ObservabilityModelSchema = z.object({
  name: z.string().nullable(),
  source: ModelSourceSchema,
  requested_name: z.string().nullable().optional().default(null),
  observed_name: z.string().nullable().optional().default(null),
});
export type ObservabilityModel = z.infer<typeof ObservabilityModelSchema>;

export const ObservabilityRunSettingsSchema = RunModelSettingsSchema;
export type ObservabilityRunSettings = z.infer<typeof ObservabilityRunSettingsSchema>;

export const ObservabilityRunSchema = z.object({
  run: RunSummarySchema,
  prompt: ObservabilityPromptSchema,
  response: ObservabilityResponseSchema,
  model: ObservabilityModelSchema,
  settings: ObservabilityRunSettingsSchema,
  session: ObservabilitySessionAuditSchema,
  activity: ObservabilityActivitySchema,
  artifacts: z.array(ObservabilityArtifactSchema),
  duration_seconds: z.number().int().nonnegative().nullable(),
});
export type ObservabilityRun = z.infer<typeof ObservabilityRunSchema>;

export const ObservabilitySessionPromptSchema = z.object({
  run_id: z.string(),
  status: RunStatusSchema,
  title: z.string(),
  summary: z.string().nullable(),
  preview: z.string(),
  model: ObservabilityModelSchema,
  settings: ObservabilityRunSettingsSchema,
  created_at: z.string(),
  last_activity_at: z.string().nullable(),
});
export type ObservabilitySessionPrompt = z.infer<typeof ObservabilitySessionPromptSchema>;

export const ObservabilityWorkspaceSchema = z.object({
  cwd: z.string(),
  repository_root: z.string().nullable(),
  repository_name: z.string().nullable(),
  branch: z.string().nullable(),
  dirty_count: z.number().int().nonnegative().nullable(),
  label: z.string(),
});
export type ObservabilityWorkspace = z.infer<typeof ObservabilityWorkspaceSchema>;

export const ObservabilitySessionSchema = z.object({
  session_key: z.string(),
  session_id: z.string().nullable(),
  root_run_id: z.string(),
  backend: BackendSchema,
  cwd: z.string(),
  workspace: ObservabilityWorkspaceSchema,
  title: z.string(),
  summary: z.string().nullable(),
  status: RunStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
  run_count: z.number().int().nonnegative(),
  running_count: z.number().int().nonnegative(),
  models: z.array(ObservabilityModelSchema),
  settings: z.array(ObservabilityRunSettingsSchema),
  warnings: z.array(z.string()),
  prompts: z.array(ObservabilitySessionPromptSchema),
});
export type ObservabilitySession = z.infer<typeof ObservabilitySessionSchema>;

export const ObservabilitySnapshotSchema = z.object({
  generated_at: z.string(),
  daemon_pid: z.number().int().nullable(),
  store_root: z.string(),
  sessions: z.array(ObservabilitySessionSchema),
  runs: z.array(ObservabilityRunSchema),
  backend_status: BackendStatusReportSchema.nullable().optional().default(null),
});
export type ObservabilitySnapshot = z.infer<typeof ObservabilitySnapshotSchema>;

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
  'get_observability_snapshot',
]);
export type RpcMethod = z.infer<typeof RpcMethodSchema>;

export const RpcRequestSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
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
