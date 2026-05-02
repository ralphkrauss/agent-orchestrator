import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { daemonIpcEndpoint } from '../daemon/paths.js';

describe('daemon IPC endpoint paths', () => {
  it('uses the store-local daemon socket on POSIX platforms', () => {
    const home = '/tmp/agent-orchestrator-home';

    const endpoint = daemonIpcEndpoint(home, 'linux');

    assert.deepStrictEqual(endpoint, {
      transport: 'unix_socket',
      path: join(home, 'daemon.sock'),
      cleanupPath: join(home, 'daemon.sock'),
    });
  });

  it('uses a stable named pipe derived from the store root on Windows', () => {
    const first = daemonIpcEndpoint('C:\\Users\\agent\\.agent-orchestrator', 'win32');
    const second = daemonIpcEndpoint('C:/Users/agent/.agent-orchestrator', 'win32');
    const other = daemonIpcEndpoint('C:\\Users\\agent\\other-store', 'win32');

    assert.equal(first.transport, 'windows_pipe');
    assert.match(first.path, /^\\\\\.\\pipe\\agent-orchestrator-[a-f0-9]{16}$/);
    assert.equal(first.cleanupPath, null);
    assert.equal(second.path, first.path);
    assert.notEqual(other.path, first.path);
  });
});
