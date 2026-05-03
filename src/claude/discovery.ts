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
     * `--tools` is the load-bearing built-in availability restriction. The
     * supervisor envelope sets `--tools "Read,Glob,Grep"` so Bash/Edit/Write/
     * etc. are unavailable as built-ins. Required.
     */
    tools_flag: boolean;
    /**
     * `--allowed-tools` only pre-approves matching patterns; it is no longer
     * the security boundary and is therefore reported but not required.
     */
    allowed_tools_flag: boolean;
    /**
     * `--disallowed-tools` is reported but not required. It is not used by
     * the harness because the security boundary is `--tools` (availability)
     * + `settings.permissions.deny` (pattern denial as defense in depth).
     */
    disallowed_tools_flag: boolean;
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
  // --tools is the actual security boundary for built-in tool availability.
  { key: 'tools_flag', pattern: /(?:^|\s)--tools\b/, required: true },
  // --append-system-prompt-file is how the supervisor system prompt is injected.
  // Some Claude versions list the flag explicitly; others document it only in
  // the --bare description as `--append-system-prompt[-file]`. Both forms
  // indicate the file variant is supported.
  { key: 'append_system_prompt_file_flag', pattern: /--append-system-prompt(?:-file|\[-file\])/, required: true },
  // --allowed-tools / --disallowed-tools are reported only; they are not part
  // of the security boundary because --allowed-tools only pre-approves and
  // --disallowed-tools cannot express the inverse-of-pinned pattern we would
  // need. Kept in the report so an operator can see what the binary advertises.
  { key: 'allowed_tools_flag', pattern: /--allowed[Tt]ools\b|--allowed-tools\b/, required: false },
  { key: 'disallowed_tools_flag', pattern: /--disallowed[Tt]ools\b|--disallowed-tools\b/, required: false },
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
      if (code !== 0 && stdoutChunks.length === 0) {
        reject(new Error(`${binary} ${args.join(' ')} exited with code ${code}: ${Buffer.concat(stderrChunks).toString('utf8').trim()}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString('utf8'));
    });
  });
}
