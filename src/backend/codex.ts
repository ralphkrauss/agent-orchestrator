import type { BackendStartInput, ParsedBackendEvent, WorkerInvocation } from './WorkerBackend.js';
import { BaseBackend, commandFromToolInput, emptyParsedEvent, extractText, getRecord, getString, invocation, pathFromToolInput } from './common.js';

export class CodexBackend extends BaseBackend {
  readonly name = 'codex' as const;
  readonly binary = 'codex';

  async start(input: BackendStartInput): Promise<WorkerInvocation> {
    return invocation(this.binary, [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--cd',
      input.cwd,
      ...modelArgs(input.model),
      '-',
    ], input);
  }

  async resume(sessionId: string, input: BackendStartInput): Promise<WorkerInvocation> {
    return invocation(this.binary, [
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      ...modelArgs(input.model),
      sessionId,
      '-',
    ], input);
  }

  parseEvent(raw: unknown): ParsedBackendEvent {
    const rec = getRecord(raw);
    if (!rec) return emptyParsedEvent();

    const type = getString(rec.type) ?? getString(rec.event) ?? '';
    const lowerType = type.toLowerCase();
    const sessionId =
      getString(rec.session_id)
      ?? getString(rec.sessionId)
      ?? getString(rec.conversation_id)
      ?? getString(rec.thread_id)
      ?? getString(rec.threadId);
    const parsed = emptyParsedEvent();

    if (sessionId) parsed.sessionId = sessionId;
    if (lowerType === 'thread.started' || lowerType === 'turn.started') {
      parsed.events.push({ type: 'lifecycle', payload: rec });
    }

    const item = getRecord(rec.item);
    if (item && lowerType === 'item.completed') {
      const itemType = getString(item.type);
      if (itemType === 'command_execution') {
        parsed.events.push({ type: 'tool_use', payload: item });
        const command = getString(item.command);
        if (command) parsed.commandsRun.push(command);
      }

      if (itemType === 'file_change') {
        parsed.events.push({ type: 'tool_use', payload: item });
        const changes = Array.isArray(item.changes) ? item.changes : [];
        for (const change of changes) {
          const path = getString(getRecord(change)?.path);
          if (path) parsed.filesChanged.push(path);
        }
      }

      if (itemType === 'agent_message') {
        const text = getString(item.text);
        if (text) parsed.events.push({ type: 'assistant_message', payload: { text, raw } });
      }
    }

    const toolName = getString(rec.tool_name) ?? getString(rec.toolName) ?? getString(rec.name);
    const input = rec.input ?? rec.arguments ?? rec.args;
    if (toolName || lowerType.includes('tool')) {
      const normalizedTool = (toolName ?? getString(rec.tool) ?? '').toLowerCase();
      parsed.events.push({ type: 'tool_use', payload: rec });
      if (normalizedTool === 'bash' || normalizedTool === 'shell' || normalizedTool === 'exec_command') {
        parsed.commandsRun.push(...commandFromToolInput(input));
      }
      if (normalizedTool === 'edit' || normalizedTool === 'write' || normalizedTool === 'file_write') {
        parsed.filesChanged.push(...pathFromToolInput(input));
      }
    }

    if (lowerType.includes('assistant') || lowerType === 'message') {
      const message = getRecord(rec.message);
      const content = message?.content ?? rec.content;
      const text = extractText(rec.message) ?? extractText(rec.content) ?? getString(rec.text);
      if (text) {
        parsed.events.push({ type: 'assistant_message', payload: { text, raw } });
      }
      if (Array.isArray(content)) {
        for (const item of content) {
          const contentItem = getRecord(item);
          if (!contentItem || getString(contentItem.type) !== 'tool_use') continue;
          const name = getString(contentItem.name) ?? '';
          parsed.events.push({ type: 'tool_use', payload: contentItem });
          if (name === 'Bash' || name === 'Shell') {
            parsed.commandsRun.push(...commandFromToolInput(contentItem.input));
          }
          if (name === 'Edit' || name === 'Write') {
            parsed.filesChanged.push(...pathFromToolInput(contentItem.input));
          }
        }
      }
    }

    if (lowerType === 'error') {
      parsed.events.push({ type: 'error', payload: rec });
    }

    if (lowerType === 'result' || lowerType.endsWith('_result') || lowerType === 'final' || lowerType === 'turn.completed') {
      const summary =
        getString(rec.summary)
        ?? getString(rec.result)
        ?? getString(rec.output)
        ?? extractText(rec.message)
        ?? '';
      parsed.resultEvent = {
        summary,
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
