import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunStore } from '../runStore.js';
import type { BackendStartInput, ParsedBackendEvent, WorkerInvocation } from './WorkerBackend.js';
import { BaseBackend, commandFromToolInput, emptyParsedEvent, errorFromEvent, extractText, getRecord, getString, invocation, pathFromToolInput } from './common.js';

/**
 * Worker-side Claude settings written per run. `disableAllHooks: true` blocks
 * inherited user `~/.claude/settings.json` hooks from firing under workers,
 * so workers cannot rename the supervisor's tmux/status display through the
 * user's hook scripts (issue #40, Decision 9 / 26 / T5).
 *
 * `--setting-sources user` plus `--settings <path>` is the chosen v1 method;
 * `CLAUDE_CONFIG_DIR` is intentionally not redirected (Decision 26). Decision
 * 9b documents the redirected fallback if T13 proves this approach
 * insufficient.
 */
export const CLAUDE_WORKER_SETTINGS_FILENAME = 'claude-worker-settings.json';
export const CLAUDE_WORKER_SETTINGS_BODY = { disableAllHooks: true } as const;

export class ClaudeBackend extends BaseBackend {
  readonly name = 'claude' as const;
  readonly binary = 'claude';

  constructor(private readonly store?: RunStore) {
    super();
  }

  async start(input: BackendStartInput): Promise<WorkerInvocation> {
    const isolation = await this.prepareWorkerIsolation(input);
    return invocation(this.binary, ['-p', '--output-format', 'stream-json', '--verbose', ...modelArgs(input.model), ...modelSettingsArgs(input.modelSettings), ...isolation], input);
  }

  async resume(sessionId: string, input: BackendStartInput): Promise<WorkerInvocation> {
    const isolation = await this.prepareWorkerIsolation(input);
    return invocation(this.binary, ['-p', '--resume', sessionId, '--output-format', 'stream-json', '--verbose', ...modelArgs(input.model), ...modelSettingsArgs(input.modelSettings), ...isolation], input);
  }

  private async prepareWorkerIsolation(input: BackendStartInput): Promise<string[]> {
    if (!this.store || !input.runId) return [];
    const settingsPath = join(this.store.runDir(input.runId), CLAUDE_WORKER_SETTINGS_FILENAME);
    await writeFile(
      settingsPath,
      `${JSON.stringify(CLAUDE_WORKER_SETTINGS_BODY, null, 2)}\n`,
      { mode: 0o600 },
    );
    return ['--settings', settingsPath, '--setting-sources', 'user'];
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
      parsed.resultEvent = {
        summary: getString(rec.result) ?? getString(rec.summary) ?? '',
        stopReason: getString(rec.stop_reason) ?? getString(rec.stopReason) ?? getString(rec.subtype) ?? 'complete',
        raw,
      };
      parsed.events.push({ type: 'lifecycle', payload: { state: 'result_event', raw } });
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
