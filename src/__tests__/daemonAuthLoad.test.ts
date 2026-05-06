import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { bootDaemon } from '../daemon/bootDaemon.js';
import { daemonIpcEndpoint } from '../daemon/paths.js';
import type {
  CursorAgent,
  CursorAgentApi,
  CursorAgentCreateOptions,
  CursorAgentResumeOptions,
  CursorRun,
  CursorRunResult,
  CursorSdkAdapter,
  CursorSdkMessage,
} from '../backend/cursor/sdk.js';
import type { OrchestratorService } from '../orchestratorService.js';

const VALID_KEY_FILE = 'A'.repeat(48);
const VALID_KEY_ENV = 'B'.repeat(48);

interface RecordingAdapter {
  adapter: CursorSdkAdapter;
  capturedApiKeys: string[];
  finishRun: () => void;
}

function createRecordingCursorAdapter(): RecordingAdapter {
  const captured: string[] = [];
  const finishers: Array<() => void> = [];
  const finishRun = () => {
    for (const f of finishers) f();
    finishers.length = 0;
  };

  const fakeRun = (): CursorRun => {
    const events = new EventEmitter();
    let finished = false;
    let resolveWait!: (value: CursorRunResult) => void;
    const waitPromise = new Promise<CursorRunResult>((resolve) => { resolveWait = resolve; });
    finishers.push(() => {
      if (finished) return;
      finished = true;
      events.emit('end');
      resolveWait({ id: 'run-1', status: 'finished', result: 'ok' });
    });

    async function* stream(): AsyncGenerator<CursorSdkMessage, void> {
      // Emit one assistant message to advance state, then end when finishRun is called.
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } } as CursorSdkMessage;
      if (finished) return;
      await new Promise<void>((resolve) => events.once('end', resolve));
    }

    return {
      id: 'run-1',
      agentId: 'agent-1',
      status: 'running',
      stream,
      wait: () => waitPromise,
      cancel: async () => { finishRun(); },
    };
  };

  const fakeAgent = (): CursorAgent => ({
    agentId: 'agent-1',
    send: async () => fakeRun(),
    close: () => undefined,
  });

  const agentApi: CursorAgentApi = {
    create: async (options: CursorAgentCreateOptions) => {
      captured.push(options.apiKey ?? '');
      return fakeAgent();
    },
    resume: async (_id: string, options?: CursorAgentResumeOptions) => {
      captured.push(options?.apiKey ?? '');
      return fakeAgent();
    },
  };

  const adapter: CursorSdkAdapter = {
    available: async () => ({ ok: true, modulePath: '/fake/cursor-sdk' }),
    loadAgentApi: async () => agentApi,
  };

  return { adapter, capturedApiKeys: captured, finishRun };
}

let originalCursorKey: string | undefined;
let originalSecretsFile: string | undefined;
let originalAnthropicKey: string | undefined;
let originalNodeOptions: string | undefined;
let booted: { shutdown: () => Promise<void>; service: OrchestratorService } | null = null;

beforeEach(() => {
  originalCursorKey = process.env.CURSOR_API_KEY;
  originalSecretsFile = process.env.AGENT_ORCHESTRATOR_SECRETS_FILE;
  originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  originalNodeOptions = process.env.NODE_OPTIONS;
  delete process.env.CURSOR_API_KEY;
  delete process.env.AGENT_ORCHESTRATOR_SECRETS_FILE;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.NODE_OPTIONS;
});

afterEach(async () => {
  if (booted) {
    try { await booted.shutdown(); } catch { /* ignore */ }
    booted = null;
  }
  if (originalCursorKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = originalCursorKey;
  if (originalSecretsFile === undefined) delete process.env.AGENT_ORCHESTRATOR_SECRETS_FILE;
  else process.env.AGENT_ORCHESTRATOR_SECRETS_FILE = originalSecretsFile;
  if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = originalNodeOptions;
});

async function makePaths(): Promise<{ home: string; pid: string; log: string; ipc: ReturnType<typeof daemonIpcEndpoint> }> {
  const home = await mkdtemp(join(tmpdir(), 'agent-daemon-boot-'));
  return {
    home,
    pid: join(home, 'daemon.pid'),
    log: join(home, 'daemon.log'),
    ipc: daemonIpcEndpoint(home),
  };
}

describe('daemon auth load via bootDaemon', () => {
  it('loads CURSOR_API_KEY from the secrets file when env is unset and the runtime sees the file value', async () => {
    const paths = await makePaths();
    const secretsPath = join(paths.home, 'secrets.env');
    await writeFile(secretsPath, `CURSOR_API_KEY=${VALID_KEY_FILE}\n`, { mode: 0o600 });
    process.env.AGENT_ORCHESTRATOR_SECRETS_FILE = secretsPath;
    const cursor = createRecordingCursorAdapter();
    const cwd = await mkdtemp(join(tmpdir(), 'agent-cursor-cwd-'));

    booted = await bootDaemon({
      paths,
      log: () => undefined,
      registryOptions: { cursorAdapter: cursor.adapter },
    });

    assert.equal(process.env.CURSOR_API_KEY, VALID_KEY_FILE, 'bootDaemon should load file value into env');

    const startResult = await booted.service.startRun({ backend: 'cursor', prompt: 'hello', cwd, model: 'cursor-default' }) as { ok: boolean; error?: unknown };
    assert.equal(startResult.ok, true, `startRun should succeed (got ${JSON.stringify(startResult)})`);

    cursor.finishRun();
    await waitForCondition(() => cursor.capturedApiKeys.length > 0, 2_000);
    assert.deepStrictEqual(cursor.capturedApiKeys, [VALID_KEY_FILE]);
  });

  it('refuses to inject non-wired-provider keys (e.g. NODE_OPTIONS, OPENAI_API_KEY) from the secrets file', async () => {
    const paths = await makePaths();
    const secretsPath = join(paths.home, 'secrets.env');
    await writeFile(
      secretsPath,
      `CURSOR_API_KEY=${VALID_KEY_FILE}\nNODE_OPTIONS=--inspect\nOPENAI_API_KEY=should-not-leak\n`,
      { mode: 0o600 },
    );
    process.env.AGENT_ORCHESTRATOR_SECRETS_FILE = secretsPath;
    const cursor = createRecordingCursorAdapter();

    booted = await bootDaemon({
      paths,
      log: () => undefined,
      registryOptions: { cursorAdapter: cursor.adapter },
    });

    assert.equal(process.env.CURSOR_API_KEY, VALID_KEY_FILE);
    assert.equal(process.env.NODE_OPTIONS, undefined, 'NODE_OPTIONS must not leak from the secrets file');
    // Codex stays reserved in this slice; OPENAI_API_KEY must not be injected.
    assert.equal(process.env.OPENAI_API_KEY, undefined, 'reserved provider keys must not be injected by the daemon');
  });

  it('keeps env precedence: env value reaches the runtime, not the file value', async () => {
    const paths = await makePaths();
    const secretsPath = join(paths.home, 'secrets.env');
    await writeFile(secretsPath, `CURSOR_API_KEY=${VALID_KEY_FILE}\n`, { mode: 0o600 });
    process.env.AGENT_ORCHESTRATOR_SECRETS_FILE = secretsPath;
    process.env.CURSOR_API_KEY = VALID_KEY_ENV;
    const cursor = createRecordingCursorAdapter();
    const cwd = await mkdtemp(join(tmpdir(), 'agent-cursor-cwd-'));

    booted = await bootDaemon({
      paths,
      log: () => undefined,
      registryOptions: { cursorAdapter: cursor.adapter },
    });

    assert.equal(process.env.CURSOR_API_KEY, VALID_KEY_ENV, 'env should win over the file');

    const startResult = await booted.service.startRun({ backend: 'cursor', prompt: 'hello', cwd, model: 'cursor-default' }) as { ok: boolean; error?: unknown };
    assert.equal(startResult.ok, true, `startRun should succeed (got ${JSON.stringify(startResult)})`);

    cursor.finishRun();
    await waitForCondition(() => cursor.capturedApiKeys.length > 0, 2_000);
    assert.deepStrictEqual(cursor.capturedApiKeys, [VALID_KEY_ENV]);
  });
});

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for condition');
}
