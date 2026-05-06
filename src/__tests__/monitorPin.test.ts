import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMonitorPathIsSupported, resolveMonitorPin } from '../claude/monitorPin.js';

const WINDOWS_REPORTED_BIN =
  'C:\\Users\\ralph\\AppData\\Roaming\\npm\\node_modules\\@ralphkrauss\\agent-orchestrator\\dist\\cli.js';
const WINDOWS_NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';

describe('resolveMonitorPin platform-aware behavior', () => {
  it('honors a Windows-shaped AGENT_ORCHESTRATOR_BIN under platform: "win32" on a non-Windows host', () => {
    // Regression for the platform-aware isAbsolute selection: without
    // path.win32.isAbsolute the host node:path on Linux would not treat the
    // env value as absolute and would silently fall back to packageCliPath(),
    // which would mask the real production behavior on Windows.
    const pin = resolveMonitorPin(
      { AGENT_ORCHESTRATOR_BIN: WINDOWS_REPORTED_BIN },
      { platform: 'win32', nodePath: WINDOWS_NODE_EXE },
    );
    assert.equal(
      pin.bin,
      'C:/Users/ralph/AppData/Roaming/npm/node_modules/@ralphkrauss/agent-orchestrator/dist/cli.js',
    );
    assert.equal(pin.nodePath, 'C:/Program Files/nodejs/node.exe');
  });

  it('emits forward-slash, deny-list-safe Bash allow patterns for the issue-reported Windows install layout', () => {
    const pin = resolveMonitorPin(
      { AGENT_ORCHESTRATOR_BIN: WINDOWS_REPORTED_BIN },
      { platform: 'win32', nodePath: WINDOWS_NODE_EXE },
    );
    const expectedBin =
      'C:/Users/ralph/AppData/Roaming/npm/node_modules/@ralphkrauss/agent-orchestrator/dist/cli.js';
    assert.equal(
      pin.command_prefix_string,
      `'C:/Program Files/nodejs/node.exe' ${expectedBin}`,
    );
    assert.deepStrictEqual(pin.monitor_bash_allow_patterns, [
      `Bash('C:/Program Files/nodejs/node.exe' ${expectedBin} monitor * --json-line)`,
      `Bash('C:/Program Files/nodejs/node.exe' ${expectedBin} monitor * --json-line --since *)`,
    ]);
    for (const pattern of pin.monitor_bash_allow_patterns) {
      assert.equal(pattern.includes('\\'), false, `pattern must not contain backslash: ${pattern}`);
    }
    assert.equal(pin.command_prefix_string.includes('\\'), false);
  });

  it('rejects UNC AGENT_ORCHESTRATOR_BIN with a dedicated error distinct from the forbidden-character error', () => {
    assert.throws(
      () =>
        resolveMonitorPin(
          { AGENT_ORCHESTRATOR_BIN: '\\\\server\\share\\agent-orchestrator\\dist\\cli.js' },
          { platform: 'win32', nodePath: WINDOWS_NODE_EXE },
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /UNC path, which is not supported/);
        assert.equal(/Bash deny list would shadow/.test(error.message), false);
        return true;
      },
    );
  });

  it('rejects UNC nodePath under platform: "win32" with the dedicated UNC error', () => {
    assert.throws(
      () =>
        resolveMonitorPin(
          { AGENT_ORCHESTRATOR_BIN: WINDOWS_REPORTED_BIN },
          { platform: 'win32', nodePath: '\\\\server\\share\\node.exe' },
        ),
      /UNC path, which is not supported/,
    );
  });

  it('rejects mixed-separator UNC AGENT_ORCHESTRATOR_BIN that becomes `//...` only after normalization', () => {
    // `\/server/share/...` and `/\server/share/...` both pass a naive
    // pre-normalization startsWith('\\\\') / startsWith('//') check but, after
    // win32 backslash → forward-slash normalization, become `//server/share/...`.
    // Plan decision #5 requires these to be rejected with the dedicated UNC error.
    for (const unsafeBin of [
      '\\/server/share/agent-orchestrator/dist/cli.js',
      '/\\server/share/agent-orchestrator/dist/cli.js',
    ]) {
      assert.throws(
        () =>
          resolveMonitorPin(
            { AGENT_ORCHESTRATOR_BIN: unsafeBin },
            { platform: 'win32', nodePath: WINDOWS_NODE_EXE },
          ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /UNC path, which is not supported/);
          assert.equal(/Bash deny list would shadow/.test(error.message), false);
          return true;
        },
        `expected mixed-separator UNC bin ${JSON.stringify(unsafeBin)} to be rejected as UNC`,
      );
    }
  });

  it('rejects mixed-separator UNC nodePath that becomes `//...` only after normalization', () => {
    for (const unsafeNodePath of [
      '\\/server/share/node.exe',
      '/\\server/share/node.exe',
    ]) {
      assert.throws(
        () =>
          resolveMonitorPin(
            { AGENT_ORCHESTRATOR_BIN: WINDOWS_REPORTED_BIN },
            { platform: 'win32', nodePath: unsafeNodePath },
          ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /UNC path, which is not supported/);
          assert.equal(/Bash deny list would shadow/.test(error.message), false);
          return true;
        },
        `expected mixed-separator UNC nodePath ${JSON.stringify(unsafeNodePath)} to be rejected as UNC`,
      );
    }
  });

  it('rejects a Windows path containing a forbidden character with the Windows-aware addendum', () => {
    assert.throws(
      () =>
        resolveMonitorPin(
          {
            AGENT_ORCHESTRATOR_BIN:
              'C:\\Users\\Ralph;Foo\\AppData\\Roaming\\npm\\node_modules\\@ralphkrauss\\agent-orchestrator\\dist\\cli.js',
          },
          { platform: 'win32', nodePath: WINDOWS_NODE_EXE },
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Bash deny list would shadow/);
        assert.match(error.message, /backslashes in this path are auto-normalized/);
        return true;
      },
    );
  });

  it('continues to accept POSIX absolute paths and produces unchanged Bash allow patterns under platform: "linux"', () => {
    const pin = resolveMonitorPin(
      { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator/cli.js' },
      { platform: 'linux', nodePath: '/usr/bin/node' },
    );
    assert.equal(pin.bin, '/opt/agent-orchestrator/cli.js');
    assert.equal(pin.nodePath, '/usr/bin/node');
    assert.deepStrictEqual(pin.monitor_bash_allow_patterns, [
      'Bash(/usr/bin/node /opt/agent-orchestrator/cli.js monitor * --json-line)',
      'Bash(/usr/bin/node /opt/agent-orchestrator/cli.js monitor * --json-line --since *)',
    ]);
  });

  it('continues to reject backslashes in POSIX paths with the original POSIX error message verbatim', () => {
    const POSIX_VERBATIM =
      'AGENT_ORCHESTRATOR_BIN contains a character that the Claude supervisor\'s Bash deny list ' +
      'would shadow even after POSIX quoting (forbidden: single quote, ;, &, |, <, >, $, `, \\, CR, LF). ' +
      'Reinstall agent-orchestrator (and node, if needed) at a path that uses only spaces, ' +
      'parentheses, or other shell-safe characters. Got: "/opt/a\\\\b/cli.js"';
    assert.throws(
      () =>
        resolveMonitorPin(
          { AGENT_ORCHESTRATOR_BIN: '/opt/a\\b/cli.js' },
          { platform: 'linux', nodePath: '/usr/bin/node' },
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, POSIX_VERBATIM);
        return true;
      },
    );
  });

  it('assertMonitorPathIsSupported preserves the POSIX message byte-for-byte under platform: "linux"', () => {
    // The non-win32 platform branch must not introduce the Windows-only
    // addendum. This test pins the byte-exact POSIX message under an explicit
    // `{ platform: 'linux' }` override so a Linux runner can lock the
    // POSIX-host (and any non-win32 caller) error shape deterministically.
    const POSIX_VERBATIM =
      'AGENT_ORCHESTRATOR_BIN contains a character that the Claude supervisor\'s Bash deny list ' +
      'would shadow even after POSIX quoting (forbidden: single quote, ;, &, |, <, >, $, `, \\, CR, LF). ' +
      'Reinstall agent-orchestrator (and node, if needed) at a path that uses only spaces, ' +
      'parentheses, or other shell-safe characters. Got: "/opt/a;b/cli.js"';
    assert.throws(
      () => assertMonitorPathIsSupported('AGENT_ORCHESTRATOR_BIN', '/opt/a;b/cli.js', { platform: 'linux' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, POSIX_VERBATIM);
        return true;
      },
    );
  });
});
