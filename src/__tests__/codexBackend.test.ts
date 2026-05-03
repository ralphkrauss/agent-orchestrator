import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodexBackend } from '../backend/codex.js';
import type { BackendResultEvent } from '../backend/WorkerBackend.js';

const codexCli01280SuccessJsonl = `
{"type":"thread.started","thread_id":"019de3ee-7ba2-7560-9aad-9e8343cc713d"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll write only \`codex-real.txt\` in the current directory with the requested content."}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc 'test -e codex-real.txt && printf exists || printf missing'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc 'test -e codex-real.txt && printf exists || printf missing'","aggregated_output":"missing","exit_code":0,"status":"completed"}}
{"type":"item.started","item":{"id":"item_2","type":"file_change","changes":[{"path":"/tmp/agent-orchestrator-fix-real-1e6VoB/repo/codex-real.txt","kind":"add"}],"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"/tmp/agent-orchestrator-fix-real-1e6VoB/repo/codex-real.txt","kind":"add"}],"status":"completed"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Done."}}
{"type":"turn.completed","usage":{"input_tokens":41199,"cached_input_tokens":39040,"output_tokens":464,"reasoning_output_tokens":330}}
`.trim();

describe('CodexBackend', () => {
  it('parses raw codex-cli 0.128.0 JSONL events from a real successful run', () => {
    const backend = new CodexBackend();
    let sessionId: string | undefined;
    let resultEvent: BackendResultEvent | undefined;
    const commandsRun: string[] = [];
    const filesChanged: string[] = [];
    const assistantMessages: string[] = [];

    for (const line of codexCli01280SuccessJsonl.split('\n')) {
      const parsed = backend.parseEvent(JSON.parse(line) as unknown);
      sessionId ??= parsed.sessionId;
      resultEvent ??= parsed.resultEvent;
      commandsRun.push(...parsed.commandsRun);
      filesChanged.push(...parsed.filesChanged);
      for (const event of parsed.events) {
        if (event.type === 'assistant_message') {
          assistantMessages.push(String(event.payload.text ?? ''));
        }
      }
    }

    assert.equal(sessionId, '019de3ee-7ba2-7560-9aad-9e8343cc713d');
    assert.equal(resultEvent?.stopReason, 'complete');
    assert.equal(resultEvent?.summary, '');
    assert.deepStrictEqual(commandsRun, ["/bin/bash -lc 'test -e codex-real.txt && printf exists || printf missing'"]);
    assert.deepStrictEqual(filesChanged, ['/tmp/agent-orchestrator-fix-real-1e6VoB/repo/codex-real.txt']);
    assert.deepStrictEqual(assistantMessages, [
      'I’ll write only `codex-real.txt` in the current directory with the requested content.',
      'Done.',
    ]);
  });

  it('extracts structured Codex error events', () => {
    const backend = new CodexBackend();
    const parsed = backend.parseEvent({
      type: 'error',
      status: 400,
      error: {
        type: 'invalid_request_error',
        message: "The 'openai/gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
      },
    });

    assert.equal(parsed.events.length, 1);
    assert.deepStrictEqual(parsed.errors, [{
      message: "The 'openai/gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
      category: 'invalid_model',
      source: 'backend_event',
      backend: 'codex',
      retryable: false,
      fatal: true,
      context: { status: 400, type: 'invalid_request_error' },
    }]);
  });
});
