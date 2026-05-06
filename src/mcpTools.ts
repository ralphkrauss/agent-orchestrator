export const tools = [
  {
    name: 'start_run',
    description: 'Start a worker run directly with backend/model settings, or by resolving a live profile alias from the profiles file.',
    inputSchema: {
      type: 'object',
      properties: {
        backend: {
          type: 'string',
          enum: ['codex', 'claude', 'cursor'],
          description: 'Direct mode backend. Omit when using profile. The cursor backend uses the @cursor/sdk in-process and runs locally only.',
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
          description: 'Worker model id. For Claude, pass a direct model id such as claude-opus-4-7 or claude-opus-4-7[1m], not aliases like opus or sonnet. For Cursor, pass a Cursor-side model id (e.g. composer-2).',
        },
        reasoning_effort: {
          type: 'string',
          enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
          description: 'Backend-applied reasoning effort. Codex supports none/minimal/low/medium/high/xhigh. Claude supports low/medium/high/xhigh/max on supported direct model ids; xhigh requires Opus 4.7. Cursor rejects reasoning_effort in this release.',
        },
        service_tier: {
          type: 'string',
          enum: ['fast', 'flex', 'normal'],
          description: 'Backend-applied speed tier for Codex. Claude and Cursor do not support this field.',
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
        claude_account: {
          type: 'string',
          description: 'Optional name of a registered Claude account (config_dir or api_env mode). Only valid when backend=claude and profile is omitted. Names match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.',
        },
        claude_accounts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional priority list of registered Claude accounts. Only valid when backend=claude and profile is omitted. When supplied, the daemon picks the first non-cooled-down account, freezes the priority array on the run, and rotates on send_followup when the run terminates with a rate_limit/quota error.',
        },
      },
      required: ['prompt', 'cwd'],
    },
  },
  {
    name: 'list_worker_profiles',
    description: 'List worker profile aliases from the live profiles file. Returns valid profiles plus invalid profile diagnostics so one broken profile does not hide the rest.',
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
    name: 'upsert_worker_profile',
    description: 'Create or replace one worker profile in the live profiles manifest, then validate that profile. Use this to repair profile setup without dispatching a worker to edit config files.',
    inputSchema: {
      type: 'object',
      properties: {
        profiles_file: {
          type: 'string',
          description: 'Profiles manifest to update. Defaults to ~/.config/agent-orchestrator/profiles.json.',
        },
        cwd: {
          type: 'string',
          description: 'Base directory for resolving a relative profiles_file.',
        },
        profile: {
          type: 'string',
          description: 'Profile alias to create or replace.',
        },
        backend: {
          type: 'string',
          enum: ['codex', 'claude', 'cursor'],
        },
        model: {
          type: 'string',
          description: 'Worker model id for this profile.',
        },
        variant: { type: 'string' },
        reasoning_effort: {
          type: 'string',
          enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
        service_tier: {
          type: 'string',
          enum: ['fast', 'flex', 'normal'],
        },
        description: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
        create_if_missing: {
          type: 'boolean',
          description: 'When false, fail if the profile alias does not already exist. Defaults to true.',
        },
        claude_account: {
          type: 'string',
          description: 'Optional default Claude account for runs that resolve this profile. Only valid when backend=claude. Must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ and reference an account registered via `agent-orchestrator auth login claude` or `auth set claude`.',
        },
        claude_account_priority: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional priority list of registered Claude accounts. Only valid when backend=claude. When supplied, runs from this profile rotate to the next healthy account on send_followup if the parent terminated with a rate_limit/quota error. claude_account, when also set, must appear in this array.',
        },
        claude_cooldown_seconds: {
          type: 'number',
          description: 'Optional per-account cooldown TTL in seconds. Only valid when backend=claude. Positive integer ≤ 86400 (24h); defaults to 900 (15m) when omitted.',
        },
      },
      required: ['profile', 'backend'],
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
    name: 'get_run_progress',
    description: 'Get a compact, bounded progress summary for a run. Prefer this for user-facing progress checks instead of reading raw event pages or parsing client tool-result files.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        after_sequence: {
          type: 'number',
          description: 'Optional event cursor. When omitted, returns a compact tail of recent events.',
        },
        limit: {
          type: 'number',
          description: 'Maximum recent events to summarize. Defaults to 5 and is capped at 20.',
        },
        max_text_chars: {
          type: 'number',
          description: 'Maximum characters returned for any extracted text snippet. Defaults to 1200.',
        },
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
          description: 'Worker model id. For Claude, pass a direct model id such as claude-opus-4-7 or claude-opus-4-7[1m], not aliases like opus or sonnet. For Cursor, pass a Cursor-side model id (e.g. composer-2).',
        },
        reasoning_effort: {
          type: 'string',
          enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
          description: 'Backend-applied reasoning effort. Omit to inherit the parent run setting. Claude xhigh requires Opus 4.7. Cursor rejects reasoning_effort in this release.',
        },
        service_tier: {
          type: 'string',
          enum: ['fast', 'flex', 'normal'],
          description: 'Backend-applied speed tier for Codex. Omit to inherit the parent run setting. Claude and Cursor do not support this field.',
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
    description: 'Diagnose local Codex and Claude worker CLI availability and the Cursor SDK module without making model calls.',
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
