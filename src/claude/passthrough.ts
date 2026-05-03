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
  '--disable-slash-commands',
  // --bare disables CLAUDE.md auto-discovery and skill discovery, which would
  // hide the curated <envelope>/.claude/skills/orchestrate-* surface that the
  // supervisor depends on. Treat it like --disable-slash-commands.
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
  '--debug-file',
  '--name',
  '-n',
  '--exclude-dynamic-system-prompt-sections',
  '--no-session-persistence',
]);

export function validateClaudePassthroughArgs(args: readonly string[]): PassthroughValidation {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('-')) continue;
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (FORBIDDEN_FLAGS.has(flag)) {
      return { ok: false, error: `Claude orchestration mode rejects ${flag}: the harness owns this surface.` };
    }
    if (!ALLOWED_FLAG_TOKENS.has(flag)) {
      return { ok: false, error: `Claude orchestration mode rejects unknown flag ${flag}. Allowed flags: ${[...ALLOWED_FLAG_TOKENS].sort().join(', ')}` };
    }
  }
  return { ok: true };
}
