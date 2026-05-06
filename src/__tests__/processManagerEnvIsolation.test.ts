import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKER_STRIPPED_TERMINAL_ENV_VARS,
  stripTerminalMultiplexerEnv,
} from '../processManager.js';

describe('worker subprocess env isolation (issue #40, T4 / Decision 8)', () => {
  it('removes only the seven terminal-multiplexer / pane-correlation env vars', () => {
    const env: NodeJS.ProcessEnv = {
      TMUX: '/tmp/tmux-1000/default,123,4',
      TMUX_PANE: '%12',
      STY: '12345.pts-0.host',
      WEZTERM_PANE: '7',
      KITTY_WINDOW_ID: '5',
      ITERM_SESSION_ID: 'abc',
      WT_SESSION: 'def',
      // Unrelated env: must be preserved.
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'should-stay',
    };
    const stripped = stripTerminalMultiplexerEnv(env);
    for (const key of WORKER_STRIPPED_TERMINAL_ENV_VARS) {
      assert.equal(stripped[key], undefined, `${key} must be stripped`);
    }
    assert.equal(stripped.PATH, '/usr/bin:/bin');
    assert.equal(stripped.HOME, '/home/user');
    assert.equal(stripped.LANG, 'en_US.UTF-8');
    assert.equal(stripped.OPENAI_API_KEY, 'should-stay');
  });

  it('does not mutate the input env (functional)', () => {
    const env: NodeJS.ProcessEnv = { TMUX: 'x', PATH: '/bin' };
    stripTerminalMultiplexerEnv(env);
    assert.equal(env.TMUX, 'x');
  });
});
