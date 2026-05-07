import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HELP_TEXT, decideRootMode } from '../cliRoot.js';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(testDir, '..', 'cli.js');
const daemonCliPath = join(testDir, '..', 'daemonCli.js');

describe('cliRoot', () => {
  it('decideRootMode returns help only for an interactive TTY stdin', () => {
    assert.equal(decideRootMode(true), 'help');
    assert.equal(decideRootMode(false), 'server');
    assert.equal(decideRootMode(undefined), 'server');
  });

  it('HELP_TEXT documents both the bare and explicit-server invocations', () => {
    assert.match(
      HELP_TEXT,
      /agent-orchestrator {14}Show this help in a terminal; start the MCP server for piped stdio/,
    );
    assert.match(HELP_TEXT, /agent-orchestrator server {7}Start the stdio MCP server/);
  });

  it('dist/cli.js --help still prints the help text', async () => {
    const result = await execFileAsync(process.execPath, [cliPath, '--help'], { timeout: 5_000 });
    assert.match(result.stdout, /agent-orchestrator server {7}Start the stdio MCP server/);
    assert.match(
      result.stdout,
      /agent-orchestrator {14}Show this help in a terminal; start the MCP server for piped stdio/,
    );
  });

  it('answers an MCP initialize request when stdin is piped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-cli-root-'));
    const home = join(root, 'home');
    const env = { ...process.env, AGENT_ORCHESTRATOR_HOME: home };

    const child = spawn(process.execPath, [cliPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolveResponse!: (message: Record<string, unknown>) => void;
    let rejectResponse!: (reason: unknown) => void;
    const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let resolved = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIdx = stdoutBuffer.indexOf('\n');
      while (newlineIdx >= 0) {
        const rawLine = stdoutBuffer.slice(0, newlineIdx);
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line.length > 0 && !resolved) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (parsed.id === 1) {
              resolved = true;
              resolveResponse(parsed);
              return;
            }
          } catch (error) {
            resolved = true;
            rejectResponse(new Error(`failed to parse stdout line as JSON: ${line} (${(error as Error).message})`));
            return;
          }
        }
        newlineIdx = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk;
    });

    child.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        rejectResponse(error);
      }
    });
    child.on('exit', (code, signal) => {
      if (!resolved) {
        resolved = true;
        rejectResponse(new Error(`child exited before responding: code=${code} signal=${signal} stderr=${stderrBuffer}`));
      }
    });

    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cliRoot.test', version: '0.0.0' },
      },
    };
    child.stdin.write(`${JSON.stringify(initRequest)}\n`);

    const timeoutHandle = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        rejectResponse(new Error(`timed out waiting for MCP initialize response. stderr=${stderrBuffer}`));
      }
    }, 20_000);

    try {
      const response = await responsePromise;
      assert.equal(response.jsonrpc, '2.0');
      assert.equal(response.id, 1);
      assert.equal(response.error, undefined, `expected no error, got ${JSON.stringify(response.error)}`);
      const result = response.result as
        | { protocolVersion?: unknown; serverInfo?: { name?: unknown } }
        | undefined;
      assert.ok(result, 'expected result on initialize response');
      assert.equal(typeof result.protocolVersion, 'string');
      assert.equal(result.serverInfo?.name, 'agent-orchestrator');
    } finally {
      clearTimeout(timeoutHandle);
      child.stdin.end();
      try {
        child.kill('SIGTERM');
      } catch {
        // best effort
      }
      await execFileAsync(process.execPath, [cliPath, 'stop', '--force'], {
        env,
        timeout: 10_000,
      }).catch(() => undefined);
      await waitForStopped(env);
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitForStopped(env: NodeJS.ProcessEnv): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await execFileAsync(process.execPath, [daemonCliPath, 'status'], { env, timeout: 2_000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      return;
    }
  }
  throw new Error('daemon did not stop before timeout');
}
