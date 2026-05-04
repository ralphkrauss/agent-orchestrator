import { spawn } from 'node:child_process';

export interface ClaudeSurfaceReport {
  binary: string;
  version: string | null;
  help_text: string | null;
  surfaces: {
    mcp_config_flag: boolean;
    strict_mcp_config_flag: boolean;
    settings_flag: boolean;
    setting_sources_flag: boolean;
    /**
     * Reported for diagnostics only. The harness intentionally does not pass
     * this flag because the supervisor should keep normal slash commands such
     * as /exit and /skills available.
     */
    disable_slash_commands_flag: boolean;
    /**
     * `--tools` is the load-bearing built-in availability restriction. The
     * supervisor launch sets `--tools "Read,Glob,Grep,Bash,Skill"` so only
     * read-only inspection, the pinned monitor command surface, and skill
     * loading are available as built-in tools. Required.
     */
    tools_flag: boolean;
    /**
     * `--allowed-tools` pre-approves the pinned Bash monitor and safe
     * agent-orchestrator MCP tools. Required.
     */
    allowed_tools_flag: boolean;
    /**
     * `--disallowed-tools` is reported but not required. It is not used by
     * the harness because the security boundary is `--tools` (availability)
     * + `--allowed-tools`/settings allow + `dontAsk`.
     */
    disallowed_tools_flag: boolean;
    /**
     * `--permission-mode dontAsk` denies non-allowlisted tool calls without
     * surfacing a permission prompt to the supervisor. Required.
     */
    permission_mode_flag: boolean;
    /**
     * `--append-system-prompt-file` is the load-bearing system-prompt
     * injection mechanism (the harness writes the supervisor prompt to an
     * ephemeral file and passes it via this flag). Required.
     */
    append_system_prompt_file_flag: boolean;
    system_prompt_flag: boolean;
    append_system_prompt_flag: boolean;
    bare_flag: boolean;
    print_flag: boolean;
    output_format_flag: boolean;
    dangerously_skip_permissions_flag: boolean;
  };
  forbidden_surfaces: string[];
  recommended_path: 'isolated_envelope' | 'unsupported';
  errors: string[];
}

const EXPECTED_FLAGS: { key: keyof ClaudeSurfaceReport['surfaces']; pattern: RegExp; required: boolean }[] = [
  { key: 'mcp_config_flag', pattern: /--mcp-config\b/, required: true },
  { key: 'strict_mcp_config_flag', pattern: /--strict-mcp-config\b/, required: true },
  { key: 'settings_flag', pattern: /--settings\b/, required: true },
  { key: 'setting_sources_flag', pattern: /--setting-sources\b/, required: true },
  { key: 'disable_slash_commands_flag', pattern: /--disable-slash-commands\b/, required: false },
  // --tools is the actual security boundary for built-in tool availability.
  { key: 'tools_flag', pattern: /(?:^|\s)--tools\b/, required: true },
  // --append-system-prompt-file is how the supervisor system prompt is injected.
  // Some Claude versions list the flag explicitly; others document it only in
  // the --bare description as `--append-system-prompt[-file]`. Both forms
  // indicate the file variant is supported.
  { key: 'append_system_prompt_file_flag', pattern: /--append-system-prompt(?:-file|\[-file\])/, required: true },
  // --allowed-tools pre-approves the agent-orchestrator MCP tools. The harness
  // still relies on --tools for built-in availability and dontAsk for deny-by-
  // default behavior, but this flag is required because it is passed at spawn.
  { key: 'allowed_tools_flag', pattern: /--allowed[Tt]ools\b|--allowed-tools\b/, required: true },
  { key: 'disallowed_tools_flag', pattern: /--disallowed[Tt]ools\b|--disallowed-tools\b/, required: false },
  { key: 'permission_mode_flag', pattern: /--permission-mode\b/, required: true },
  { key: 'system_prompt_flag', pattern: /--system-prompt\b/, required: false },
  { key: 'append_system_prompt_flag', pattern: /--append-system-prompt\b/, required: false },
  { key: 'bare_flag', pattern: /--bare\b/, required: false },
  { key: 'print_flag', pattern: /(?:^|\s)-p\b|--print\b/, required: false },
  { key: 'output_format_flag', pattern: /--output-format\b/, required: false },
  { key: 'dangerously_skip_permissions_flag', pattern: /--dangerously-skip-permissions\b/, required: false },
];

export async function discoverClaudeSurface(binary = 'claude'): Promise<ClaudeSurfaceReport> {
  const errors: string[] = [];
  const version = await runClaudeVersion(binary).catch((error: Error) => {
    errors.push(`failed to run ${binary} --version: ${error.message}`);
    return null;
  });
  const helpText = await runClaudeHelp(binary).catch((error: Error) => {
    errors.push(`failed to run ${binary} --help: ${error.message}`);
    return null;
  });

  const surfaces = {} as ClaudeSurfaceReport['surfaces'];
  for (const flag of EXPECTED_FLAGS) {
    surfaces[flag.key] = helpText !== null ? flag.pattern.test(helpText) : false;
    if (flag.required && !surfaces[flag.key]) {
      errors.push(`required flag missing from claude --help: ${flag.key}`);
    }
  }

  const forbidden_surfaces: string[] = [];
  if (surfaces.dangerously_skip_permissions_flag) {
    forbidden_surfaces.push('--dangerously-skip-permissions');
  }

  const allRequiredPresent = EXPECTED_FLAGS.filter((flag) => flag.required).every((flag) => surfaces[flag.key]);
  const recommended_path: ClaudeSurfaceReport['recommended_path'] = allRequiredPresent && helpText !== null
    ? 'isolated_envelope'
    : 'unsupported';

  return {
    binary,
    version,
    help_text: helpText,
    surfaces,
    forbidden_surfaces,
    recommended_path,
    errors,
  };
}

export function summarizeReport(report: ClaudeSurfaceReport): string {
  const lines: string[] = [];
  lines.push(`Claude binary: ${report.binary}`);
  lines.push(`Claude version: ${report.version ?? 'unknown'}`);
  lines.push(`Recommended path: ${report.recommended_path}`);
  lines.push('Detected surfaces:');
  for (const [key, value] of Object.entries(report.surfaces)) {
    lines.push(`- ${key}: ${value ? 'present' : 'missing'}`);
  }
  if (report.forbidden_surfaces.length > 0) {
    lines.push(`Forbidden surfaces (must never be passed): ${report.forbidden_surfaces.join(', ')}`);
  }
  if (report.errors.length > 0) {
    lines.push('Errors:');
    for (const error of report.errors) lines.push(`- ${error}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runClaudeVersion(binary: string): Promise<string | null> {
  const out = await runOnce(binary, ['--version'], 5_000);
  return out.trim() || null;
}

async function runClaudeHelp(binary: string): Promise<string | null> {
  return runOnce(binary, ['--help'], 5_000);
}

function runOnce(binary: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${binary} ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (stdout.length > 0) {
        resolve(stdout);
        return;
      }
      if (stderr.length > 0) {
        // Some Claude builds write --help / --version output to stderr while
        // exiting non-zero. Treat any non-empty stream as usable output.
        resolve(stderr);
        return;
      }
      reject(new Error(`${binary} ${args.join(' ')} exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}
