import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverClaudeSurface, summarizeReport } from '../claude/discovery.js';

async function fakeClaudeBinary(helpText: string, version = '99.0.0 (fake)'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-claude-'));
  const path = join(dir, 'claude');
  // Print the version on --version, the help text on --help.
  const script = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "--version" ]; then',
    `  printf '%s\\n' ${JSON.stringify(version)}`,
    '  exit 0',
    'fi',
    'if [ "$1" = "--help" ]; then',
    `  cat <<'__HELP__'`,
    helpText,
    '__HELP__',
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n');
  await writeFile(path, script, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

const FULL_HELP = `Usage: claude [options] [command] [prompt]

Options:
  --add-dir <directories...>                        Additional directories to allow tool access to
  --allowedTools, --allowed-tools <tools...>        Comma or space-separated list of tool names to allow
  --append-system-prompt <prompt>                   Append a system prompt
  --bare                                            Minimal mode
  --dangerously-skip-permissions                    Bypass all permission checks
  --disallowedTools, --disallowed-tools <tools...>  Comma or space-separated list of tool names to deny
  --mcp-config <configs...>                         Load MCP servers from JSON
  --output-format <format>                          Output format
  -p, --print                                       Print response and exit
  --setting-sources <sources>                       Comma-separated list of setting sources to load
  --settings <file-or-json>                         Path to a settings JSON file
  --strict-mcp-config                               Only use MCP servers from --mcp-config
  --system-prompt <prompt>                          System prompt
  --append-system-prompt-file <path>                Append a system prompt from file
  --tools <tools...>                                Specify the list of available tools
  -v, --version                                     Output the version number
`;

describe('Claude surface discovery', () => {
  it('reports recommended_path=isolated_envelope and exposes the tools_flag/append_system_prompt_file_flag surfaces when the binary advertises every required flag', async () => {
    const binary = await fakeClaudeBinary(FULL_HELP);
    const report = await discoverClaudeSurface(binary);
    assert.equal(report.recommended_path, 'isolated_envelope');
    assert.deepStrictEqual(report.errors, []);
    assert.equal(report.surfaces.tools_flag, true, '--tools surface must be detected and required');
    assert.equal(report.surfaces.append_system_prompt_file_flag, true);
    assert.equal(report.surfaces.mcp_config_flag, true);
    assert.equal(report.surfaces.strict_mcp_config_flag, true);
    assert.equal(report.surfaces.settings_flag, true);
    assert.equal(report.surfaces.setting_sources_flag, true);
    assert.equal(report.forbidden_surfaces.includes('--dangerously-skip-permissions'), true, '--dangerously-skip-permissions must be reported as forbidden');
    assert.match(report.version ?? '', /99\.0\.0/);
  });

  it('downgrades recommended_path to unsupported when --tools is missing, even if --allowed-tools / --disallowed-tools are present', async () => {
    const helpWithoutTools = FULL_HELP.replace(/^.*--tools <tools.*$/m, '');
    const binary = await fakeClaudeBinary(helpWithoutTools);
    const report = await discoverClaudeSurface(binary);
    assert.equal(report.surfaces.tools_flag, false);
    assert.equal(report.recommended_path, 'unsupported', '--tools is the load-bearing availability restrictor; missing it must downgrade the report');
    assert.ok(report.errors.some((line) => line.includes('tools_flag')), 'errors must call out tools_flag specifically');
  });

  it('downgrades to unsupported when --append-system-prompt-file is missing (the supervisor system prompt cannot be injected)', async () => {
    const helpWithoutAppendFile = FULL_HELP.replace(/^.*--append-system-prompt-file.*$/m, '');
    const binary = await fakeClaudeBinary(helpWithoutAppendFile);
    const report = await discoverClaudeSurface(binary);
    assert.equal(report.surfaces.append_system_prompt_file_flag, false);
    assert.equal(report.recommended_path, 'unsupported');
  });

  it('keeps recommended_path=isolated_envelope when --allowed-tools is missing, because the security boundary is --tools (allowed-tools/disallowed-tools are reported but optional)', async () => {
    const helpWithoutAllowed = FULL_HELP
      .replace(/^.*--allowedTools.*$/m, '')
      .replace(/^.*--disallowedTools.*$/m, '');
    const binary = await fakeClaudeBinary(helpWithoutAllowed);
    const report = await discoverClaudeSurface(binary);
    assert.equal(report.surfaces.allowed_tools_flag, false);
    assert.equal(report.surfaces.disallowed_tools_flag, false);
    assert.equal(report.recommended_path, 'isolated_envelope', '--allowed-tools/--disallowed-tools are no longer required for isolation');
  });

  it('summarizeReport mentions the new tools_flag and append_system_prompt_file_flag surfaces', async () => {
    const binary = await fakeClaudeBinary(FULL_HELP);
    const report = await discoverClaudeSurface(binary);
    const text = summarizeReport(report);
    assert.match(text, /tools_flag: present/);
    assert.match(text, /append_system_prompt_file_flag: present/);
  });
});
