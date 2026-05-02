import type { BackendStartInput, ParsedBackendEvent, WorkerInvocation } from './WorkerBackend.js';
import { BaseBackend, commandFromToolInput, emptyParsedEvent, extractText, getRecord, getString, invocation, pathFromToolInput } from './common.js';

export class ClaudeBackend extends BaseBackend {
  readonly name = 'claude' as const;
  readonly binary = 'claude';

  async start(input: BackendStartInput): Promise<WorkerInvocation> {
    return invocation(this.binary, ['-p', '--output-format', 'stream-json', '--verbose', ...modelArgs(input.model), ...modelSettingsArgs(input.modelSettings)], input);
  }

  async resume(sessionId: string, input: BackendStartInput): Promise<WorkerInvocation> {
    return invocation(this.binary, ['-p', '--resume', sessionId, '--output-format', 'stream-json', '--verbose', ...modelArgs(input.model), ...modelSettingsArgs(input.modelSettings)], input);
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
