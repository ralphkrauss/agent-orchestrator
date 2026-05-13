import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkerEvent, WorkerPosture } from '../contract.js';
import type { RunStore } from '../runStore.js';
import type { BackendStartInput, ParsedBackendEvent, WorkerInvocation } from './WorkerBackend.js';
import { BaseBackend, classifyBackendError, commandFromToolInput, emptyParsedEvent, errorFromEvent, extractText, getRecord, getString, invocation, matchesClaudeCliBanner, pathFromToolInput } from './common.js';

/**
 * Worker-side Claude settings written per run.
 *
 * Workers are intentionally trusted-local, full-access, non-interactive daemon
 * workers: they run as the same OS user as the daemon harness, in the run
 * cwd, with no human attached to answer permission prompts. This file plus
 * the matching `--permission-mode` CLI flag in `prepareWorkerIsolation()`
 * configure the worker's permission posture so it can complete its run
 * non-interactively. None of this is a tool sandbox.
 *
 * - `permissions.defaultMode: 'bypassPermissions'` (mirrored on the spawn
 *   argv as `--permission-mode bypassPermissions`) matches the user's normal
 *   Claude Code posture and removes Claude Code's interactive approval
 *   prompts so the non-interactive worker can run routine tools (Bash, Edit,
 *   Write, …) without stalling. It does NOT restrict the tool surface.
 * - `skipDangerousModePermissionPrompt: true` is required so the bypass mode
 *   does not surface a dangerous-mode confirmation prompt that the harness
 *   has no human to answer. Empirically validated by issue #47.
 * - `disableAllHooks: true` preserves hook isolation so inherited user
 *   `~/.claude/settings.json` hooks cannot fire under workers (issue #40,
 *   Decisions 9 / 26 / T5 / T13). Hook isolation is independent of the
 *   permission posture and is also NOT a tool sandbox. Pinned under both
 *   trusted and restricted postures (issue #58 Decision 5).
 * - `enableAllProjectMcpServers: true` is added under the `'trusted'`
 *   posture (issue #58 Decision 5). Without it, workers loading
 *   `--setting-sources user,project,local` would stall on the project-MCP
 *   approval prompt that a non-interactive worker cannot answer. Under
 *   `'restricted'` posture this key is omitted to preserve the pre-#58
 *   behavior exactly.
 *
 * The `--permission-mode bypassPermissions` CLI flag is set in addition to
 * the in-file `defaultMode` to mirror the supervisor envelope
 * (`buildClaudeSpawnArgs` in `src/claude/launcher.ts`) and to survive
 * precedence drift across Claude Code versions where the CLI flag may take
 * precedence over file settings.
 *
 * Issue #58: under `worker_posture: 'trusted'` (the new default) the spawn
 * argv pairs `--settings <path>` with `--setting-sources user,project,local`
 * so workers see project / user / local Claude Code scopes — MCP servers,
 * settings, subagents, plugins, CLAUDE.md. Per-run `--settings <path>`
 * precedence over `--setting-sources` merge plus the CLI `--permission-mode`
 * flag preserve the hook-isolation and bypass-permissions contracts even
 * when project `.claude/settings.json` defines hooks or a stricter
 * permission mode. Under `worker_posture: 'restricted'` the v1 envelope
 * (`--setting-sources user`) is preserved verbatim.
 *
 * `CLAUDE_CONFIG_DIR` is intentionally not redirected (Decision 26 of #40).
 * Decision 9b documents the redirected fallback if T13 proves this
 * approach insufficient.
 *
 * `--dangerously-skip-permissions` is forbidden everywhere in this harness
 * per issue #13 Decisions 7 / 21 and is NOT used here. The bypass posture is
 * expressed via the documented `defaultMode` / `--permission-mode` surface
 * only.
 *
 * See issue #47 for the empirical reproduction that motivated adding the
 * permission keys, issue #40 Decisions 9 / 26 for the underlying worker
 * isolation envelope, and issue #58 for the trusted/restricted posture.
 */
export const CLAUDE_WORKER_SETTINGS_FILENAME = 'claude-worker-settings.json';
export const CLAUDE_WORKER_SETTINGS_BODY = {
  disableAllHooks: true,
  permissions: { defaultMode: 'bypassPermissions' },
  skipDangerousModePermissionPrompt: true,
} as const;

// Issue #58: trusted-posture worker settings include
// `enableAllProjectMcpServers: true` so the worker auto-approves project
// MCP servers (`.mcp.json`) at MCP init. Without this key, a worker loading
// `--setting-sources user,project,local` would stall on the project-MCP
// approval prompt that a non-interactive worker cannot answer.
export const CLAUDE_TRUSTED_WORKER_SETTINGS_BODY = {
  ...CLAUDE_WORKER_SETTINGS_BODY,
  enableAllProjectMcpServers: true,
} as const;

export class ClaudeBackend extends BaseBackend {
  readonly name = 'claude' as const;
  readonly binary = 'claude';

  constructor(private readonly store?: RunStore) {
    super();
  }

  async start(input: BackendStartInput): Promise<WorkerInvocation> {
    const isolation = await this.prepareWorkerIsolation(input);
    const inv = invocation(this.binary, ['-p', '--output-format', 'stream-json', '--verbose', ...modelArgs(input.model), ...modelSettingsArgs(input.modelSettings), ...isolation.args], input);
    if (isolation.initialEvents.length > 0) {
      inv.initialEvents = isolation.initialEvents;
    }
    return inv;
  }

  async resume(sessionId: string, input: BackendStartInput): Promise<WorkerInvocation> {
    const isolation = await this.prepareWorkerIsolation(input);
    const inv = invocation(this.binary, ['-p', '--resume', sessionId, '--output-format', 'stream-json', '--verbose', ...modelArgs(input.model), ...modelSettingsArgs(input.modelSettings), ...isolation.args], input);
    if (isolation.initialEvents.length > 0) {
      inv.initialEvents = isolation.initialEvents;
    }
    return inv;
  }

  private async prepareWorkerIsolation(input: BackendStartInput): Promise<{ args: string[]; initialEvents: Omit<WorkerEvent, 'seq' | 'ts'>[] }> {
    if (!this.store || !input.runId) {
      // Legacy/direct-caller path: no run id, no per-run settings, no
      // telemetry event. Preserves the existing contract documented by
      // `claudeWorkerIsolation.test.ts` "omits worker isolation flags when
      // no run id is supplied".
      return { args: [], initialEvents: [] };
    }
    // Issue #58: branch on worker_posture. Legacy run records (pre-#58)
    // have `worker_posture: null` in their model_settings; tolerate by
    // defaulting to 'trusted' (the new product default). Operators who
    // need the v1 closed-by-default envelope must opt in with
    // `worker_posture: 'restricted'`.
    const workerPosture: WorkerPosture = input.modelSettings.worker_posture ?? 'trusted';
    const settingsBody = workerPosture === 'trusted'
      ? CLAUDE_TRUSTED_WORKER_SETTINGS_BODY
      : CLAUDE_WORKER_SETTINGS_BODY;
    const settingSources = workerPosture === 'trusted' ? 'user,project,local' : 'user';
    const settingsPath = join(this.store.runDir(input.runId), CLAUDE_WORKER_SETTINGS_FILENAME);
    await writeFile(
      settingsPath,
      `${JSON.stringify(settingsBody, null, 2)}\n`,
      { mode: 0o600 },
    );
    const args = ['--settings', settingsPath, '--setting-sources', settingSources, '--permission-mode', settingsBody.permissions.defaultMode];
    // Issue #58 Decision 11: emit one spawn-time lifecycle event per worker
    // so operators can see which posture and setting-sources value the
    // worker actually used via `get_run_events`. Placed in
    // `WorkerInvocation.initialEvents` so `ProcessManager.start()` flushes
    // it once per actual spawn — `CliRuntime.buildStartInvocation()` strips
    // it on the pre-bake retry path.
    const initialEvents: Omit<WorkerEvent, 'seq' | 'ts'>[] = [{
      type: 'lifecycle',
      payload: {
        state: 'worker_posture',
        backend: 'claude',
        worker_posture: workerPosture,
        claude: {
          setting_sources: settingSources,
          enable_all_project_mcp_servers: workerPosture === 'trusted',
        },
      },
    }];
    return { args, initialEvents };
  }

  parseEvent(raw: unknown): ParsedBackendEvent {
    const rec = getRecord(raw);
    if (!rec) return emptyParsedEvent();

    const parsed = emptyParsedEvent();
    const type = getString(rec.type) ?? '';
    const lowerType = type.toLowerCase();
    const sessionId = getString(rec.session_id) ?? getString(rec.sessionId);
    if (sessionId) parsed.sessionId = sessionId;

    if (lowerType === 'system') {
      parsed.events.push({ type: 'lifecycle', payload: rec });
      return parsed;
    }

    if (lowerType === 'assistant') {
      const message = getRecord(rec.message);
      const content = message?.content ?? rec.content;
      const text = extractText(content);
      if (text) {
        parsed.events.push({ type: 'assistant_message', payload: { text, raw } });
      }

      if (Array.isArray(content)) {
        for (const item of content) {
          const contentItem = getRecord(item);
          if (!contentItem || getString(contentItem.type) !== 'tool_use') continue;
          const name = getString(contentItem.name) ?? '';
          parsed.events.push({ type: 'tool_use', payload: contentItem });
          if (name === 'Bash') {
            parsed.commandsRun.push(...commandFromToolInput(contentItem.input));
          }
          if (name === 'Edit' || name === 'Write') {
            parsed.filesChanged.push(...pathFromToolInput(contentItem.input));
          }
        }
      }
    }

    if (lowerType === 'user' && getRecord(rec.message)) {
      parsed.events.push({ type: 'tool_result', payload: rec });
    }

    if (lowerType === 'error') {
      parsed.events.push({ type: 'error', payload: rec });
      const error = errorFromEvent(rec, this.name);
      if (error) parsed.errors.push(error);
    }

    if (lowerType === 'result') {
      const summary = getString(rec.result) ?? getString(rec.summary) ?? '';
      parsed.resultEvent = {
        summary,
        stopReason: getString(rec.stop_reason) ?? getString(rec.stopReason) ?? getString(rec.subtype) ?? 'complete',
        raw,
      };
      parsed.events.push({ type: 'lifecycle', payload: { state: 'result_event', raw } });

      // Issue #55: Claude CLI subscription-cap banner detection. Two
      // conditions must both hold before we synthesise a fatal rate_limit
      // error:
      //   (1) The event carries at least one structured-failure signal
      //       (`is_error === true`, `subtype === 'error'`, or normalized
      //       `stop_reason`/`stopReason === 'rate_limit_error'`) — mirrors
      //       the existing snake_case + camelCase tolerance at the
      //       resultEvent.stopReason extraction above.
      //   (2) The tail-anchored banner regex (Decision 3, F1 fix) matches
      //       the trimmed result text.
      // We gate directly on the banner regex via `matchesClaudeCliBanner`,
      // NOT on `classifyBackendError(...).category === 'rate_limit'` —
      // the classifier's rate-limit branch also catches generic phrasing
      // like `too many requests` / `429` / `rate_limit_error`, none of
      // which is the subscription-cap banner. Using the classifier as the
      // gate would mis-tag those with `context.subkind:
      // 'claude_cli_banner'`. Synthesised fatal errors route through
      // `recordObservedError` and trigger `cancel('failed', { reason:
      // 'backend_fatal_error', ... })`, so the run's terminal_reason
      // matches the structured rate_limit path.
      const normalizedStopReason = (getString(rec.stop_reason) ?? getString(rec.stopReason))?.toLowerCase();
      const subtypeLower = getString(rec.subtype)?.toLowerCase();
      const structuredFailure = rec.is_error === true
        || subtypeLower === 'error'
        || normalizedStopReason === 'rate_limit_error';
      const trimmed = summary.trim();
      if (structuredFailure && trimmed && matchesClaudeCliBanner(trimmed)) {
        const error = classifyBackendError({
          backend: this.name,
          source: 'backend_event',
          message: trimmed,
          context: { banner: trimmed, subkind: 'claude_cli_banner' },
        });
        parsed.errors.push(error);
      }
    }

    return parsed;
  }
}

function modelArgs(model: string | null | undefined): string[] {
  return model ? ['--model', model] : [];
}

function modelSettingsArgs(settings: BackendStartInput['modelSettings']): string[] {
  return settings.reasoning_effort ? ['--effort', settings.reasoning_effort] : [];
}
