import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaudeLauncher } from '../claude/launcher.js';

// Issue #40, T14 — offline RC config smoke. Runs the launcher with
// --print-config and asserts the generated supervisor settings contain the
// documented Remote Control keys, the harness-generated nested hooks block
// from T2, the pinned absolute supervisor-CLI path, and the chosen
// orchestrator label. Does NOT start Claude or enter Remote Control.
//
// The test records the Claude version observed by --print-discovery in plan
// evidence (Decision 12, R7); see plans/.../40-orchestrator-status-hooks.md
// "Execution Log → T14".

class MemStream implements NodeJS.WritableStream {
  data = '';
  writable = true;
  write(chunk: string | Uint8Array, _enc?: BufferEncoding | ((error?: Error | null) => void), cb?: (error?: Error | null) => void): boolean {
    this.data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (typeof cb === 'function') cb();
    return true;
  }
  end(): this { this.writable = false; return this; }
  on(): this { return this; }
  once(): this { return this; }
  emit(): boolean { return true; }
  removeListener(): this { return this; }
  removeAllListeners(): this { return this; }
  setMaxListeners(): this { return this; }
  getMaxListeners(): number { return 10; }
  listeners(): never[] { return []; }
  rawListeners(): never[] { return []; }
  listenerCount(): number { return 0; }
  prependListener(): this { return this; }
  prependOnceListener(): this { return this; }
  eventNames(): never[] { return []; }
  off(): this { return this; }
  addListener(): this { return this; }
  pipe<T extends NodeJS.WritableStream>(destination: T): T { return destination; }
  cork(): void { /* no-op */ }
  uncork(): void { /* no-op */ }
  destroy(): this { return this; }
  setDefaultEncoding(): this { return this; }
}

describe('Claude --remote-control offline config smoke (T14)', () => {
  it('--print-config with --remote-control --orchestrator-label demo emits documented RC keys, the harness hooks block, the pinned CLI path, and the chosen label', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'rc-smoke-'));
    try {
      const fakeClaude = join(cwd, 'claude');
      await writeFile(fakeClaude, `#!/usr/bin/env sh
case "$1" in
  --version)
    printf '%s\\n' '2.1.129'
    ;;
  --help)
    cat <<'EOF'
Usage: claude [options]
  --mcp-config <path>
  --strict-mcp-config
  --settings <path>
  --setting-sources <sources>
  --tools <tools>
  --append-system-prompt-file <path>
  --allowed-tools <tools>
  --permission-mode <mode>
EOF
    ;;
esac
`, { mode: 0o700 });
      await chmod(fakeClaude, 0o700);

      const stateDir = join(cwd, 'state');
      const stdout = new MemStream();
      const stderr = new MemStream();
      const exit = await runClaudeLauncher(
        ['--cwd', cwd, '--state-dir', stateDir, '--claude-binary', fakeClaude, '--remote-control', '--orchestrator-label', 'demo', '--print-config'],
        { stdout, stderr, env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator', AGENT_ORCHESTRATOR_HOME: join(cwd, 'home') } },
      );
      assert.equal(exit, 0, `--print-config exit=${exit}\nstderr=${stderr.data}`);
      const out = stdout.data;
      // RC settings keys (Decision 12).
      assert.match(out, /"remoteControlAtStartup":\s*true/);
      assert.match(out, /"agentPushNotifEnabled":\s*true/);
      // Harness-generated nested hooks block (T2).
      for (const eventName of ['UserPromptSubmit', 'Notification', 'Stop', 'SessionStart', 'SessionEnd']) {
        assert.match(out, new RegExp(`"${eventName}"`), `${eventName} hooks block must be present`);
      }
      // Pinned absolute supervisor-CLI path appears in hook command strings (Decision 21).
      assert.match(out, /\/opt\/agent-orchestrator/);
      assert.match(out, /supervisor signal UserPromptSubmit/);
      // Orchestrator label propagated.
      assert.match(out, /# orchestrator label\ndemo/);
      // Remote control marker.
      assert.match(out, /# remote control\nenabled/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
