export interface PassthroughValidation {
  ok: boolean;
  error?: string;
}

const FORBIDDEN_FLAGS = new Set<string>([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--mcp-config',
  '--strict-mcp-config',
  '--tools',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--add-dir',
  '--settings',
  '--setting-sources',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--plugin-dir',
  '--agents',
  '--agent',
  '--permission-mode',
  // The harness keeps slash commands enabled so /exit and /skills continue to
  // work from the target workspace.
  '--disable-slash-commands',
  // --bare also changes Claude's memory, plugin, auth/keychain, and built-in
  // discovery behavior. The harness owns those through its restricted launch.
  '--bare',
]);

const ALLOWED_FLAG_TOKENS = new Set<string>([
  '--print',
  '-p',
  '--output-format',
  '--input-format',
  '--include-partial-messages',
  '--include-hook-events',
  '--verbose',
  '--debug',
  '-d',
  '--name',
  '-n',
  '--exclude-dynamic-system-prompt-sections',
  '--no-session-persistence',
  // Issue #40, Decision 12: opt-in Remote Control passthrough.
  '--remote-control-session-name-prefix',
]);

export function validateClaudePassthroughArgs(args: readonly string[]): PassthroughValidation {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('-')) continue;
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (FORBIDDEN_FLAGS.has(flag)) {
      if (flag === '--append-system-prompt' || flag === '--append-system-prompt-file') {
        return {
          ok: false,
          error: `Claude orchestration mode rejects ${flag} after --: the harness owns this surface. Use the launcher flag \`agent-orchestrator claude ${flag} ...\` (before --) or the AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT[_FILE] env var instead.`,
        };
      }
      return { ok: false, error: `Claude orchestration mode rejects ${flag}: the harness owns this surface.` };
    }
    if (!ALLOWED_FLAG_TOKENS.has(flag)) {
      return { ok: false, error: `Claude orchestration mode rejects unknown flag ${flag}. Allowed flags: ${[...ALLOWED_FLAG_TOKENS].sort().join(', ')}` };
    }
  }
  return { ok: true };
}
