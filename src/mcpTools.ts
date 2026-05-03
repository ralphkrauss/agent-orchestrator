export const tools = [
  {
    name: 'start_run',
    description: 'Start a worker run directly with backend/model settings, or by resolving a live profile alias from the profiles file.',
    inputSchema: {
      type: 'object',
      properties: {
        backend: {
          type: 'string',
          enum: ['codex', 'claude'],
          description: 'Direct mode backend. Omit when using profile.',
        },
        profile: {
          type: 'string',
          description: 'Live profile alias to resolve from profiles_file.',
        },
        profiles_file: {
          type: 'string',
          description: 'Profiles manifest to read at worker start time. Defaults to ~/.config/agent-orchestrator/profiles.json.',
        },
        prompt: { type: 'string' },
        cwd: { type: 'string' },
        model: {
          type: 'string',
          description: 'Worker model id. For Claude, pass a direct model id such as claude-opus-4-7 or claude-opus-4-7[1m], not aliases like opus or sonnet.',
        },
        reasoning_effort: {
          type: 'string',
          enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
          description: 'Backend-applied reasoning effort. Codex supports none/minimal/low/medium/high/xhigh. Claude supports low/medium/high/xhigh/max on supported direct model ids; xhigh requires Opus 4.7.',
        },
        service_tier: {
          type: 'string',
          enum: ['fast', 'flex', 'normal'],
          description: 'Backend-applied speed tier for Codex. Claude does not support this field.',
        },
        metadata: { type: 'object', additionalProperties: true },
        idle_timeout_seconds: {
          type: 'number',
          description: 'Idle-progress timeout. The daemon cancels the run only after this many seconds without worker output or backend events.',
        },
        execution_timeout_seconds: {
          type: 'number',
          description: 'Optional hard wall-clock cap. Omit to use idle-progress supervision without a hard elapsed-time limit.',
        },
      },
      required: ['prompt', 'cwd'],
    },
  },
  {
    name: 'list_worker_profiles',
    description: 'List validated worker profile aliases from the live profiles file.',
    inputSchema: {
      type: 'object',
      properties: {
        profiles_file: {
          type: 'string',
          description: 'Profiles manifest to read. Defaults to ~/.config/agent-orchestrator/profiles.json.',
        },
        cwd: {
          type: 'string',
          description: 'Base directory for resolving a relative profiles_file.',
        },
      },
    },
  },
  {
    name: 'list_runs',
    description: 'List known worker runs in descending creation order.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_run_status',
    description: 'Get the current lifecycle status for a run.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
    },
  },
  {
    name: 'get_run_events',
    description: 'Read worker events with cursor pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        after_sequence: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'wait_for_run',
    description: 'Wait for a run to reach a terminal status, bounded by wait_seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        wait_seconds: { type: 'number' },
      },
      required: ['run_id', 'wait_seconds'],
    },
  },
  {
    name: 'wait_for_any_run',
    description: 'Block until any of the listed run_ids has a new terminal or fatal_error notification, bounded by wait_seconds (1-300). Push notifications/run/changed are advisory hints; durable notification records remain the authoritative source.',
    inputSchema: {
      type: 'object',
      properties: {
        run_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Run ids to subscribe to. At least one, at most 64.',
        },
        wait_seconds: { type: 'number', description: 'Maximum block duration in seconds (1-300).' },
        after_notification_id: {
          type: 'string',
          description: 'Cursor: only return notifications strictly greater than this id.',
        },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['terminal', 'fatal_error'] },
          description: 'Optional notification kinds filter. Defaults to both terminal and fatal_error.',
        },
      },
      required: ['run_ids', 'wait_seconds'],
    },
  },
  {
    name: 'list_run_notifications',
    description: 'List durable run notifications since an optional cursor. Use to reconcile run state after disconnect or after a wait_for_any_run.',
    inputSchema: {
      type: 'object',
      properties: {
        run_ids: { type: 'array', items: { type: 'string' } },
        since_notification_id: { type: 'string' },
        kinds: { type: 'array', items: { type: 'string', enum: ['terminal', 'fatal_error'] } },
        include_acked: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'ack_run_notification',
    description: 'Mark a notification as acknowledged. Idempotent; the original notification record is not mutated.',
    inputSchema: {
      type: 'object',
      properties: {
        notification_id: { type: 'string' },
      },
      required: ['notification_id'],
    },
  },
  {
    name: 'get_run_result',
    description: 'Get the normalized worker result for a run, or null while it is running.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
    },
  },
  {
    name: 'send_followup',
    description: 'Start a follow-up run by resuming the parent run backend session.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        prompt: { type: 'string' },
        model: {
          type: 'string',
          description: 'Worker model id. For Claude, pass a direct model id such as claude-opus-4-7 or claude-opus-4-7[1m], not aliases like opus or sonnet.',
        },
        reasoning_effort: {
          type: 'string',
          enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
          description: 'Backend-applied reasoning effort. Omit to inherit the parent run setting. Claude xhigh requires Opus 4.7.',
        },
        service_tier: {
          type: 'string',
          enum: ['fast', 'flex', 'normal'],
          description: 'Backend-applied speed tier for Codex. Omit to inherit the parent run setting.',
        },
        metadata: { type: 'object', additionalProperties: true },
        idle_timeout_seconds: {
          type: 'number',
          description: 'Idle-progress timeout for the follow-up run. Activity resets the idle deadline.',
        },
        execution_timeout_seconds: {
          type: 'number',
          description: 'Optional hard wall-clock cap for the follow-up run.',
        },
      },
      required: ['run_id', 'prompt'],
    },
  },
  {
    name: 'cancel_run',
    description: 'Cancel a running worker process group.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
    },
  },
  {
    name: 'get_backend_status',
    description: 'Diagnose local Codex and Claude worker CLI availability without making model calls.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_observability_snapshot',
    description: 'Get a dashboard-ready snapshot of daemon, session, run, prompt, model, and recent activity state.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        include_prompts: { type: 'boolean' },
        recent_event_limit: { type: 'number' },
        diagnostics: { type: 'boolean' },
      },
    },
  },
] as const;
