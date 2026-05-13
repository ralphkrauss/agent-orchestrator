import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONVENTION_APPEND_PROMPT_RELATIVE_PATH,
  SUPERVISOR_APPEND_PROMPT_BYTE_CAP,
  SUPERVISOR_APPEND_PROMPT_DELIMITER,
  resolveSupervisorAppendPrompt,
} from '../claude/appendPrompt.js';
import { buildClaudeHarnessConfig } from '../claude/config.js';
import {
  buildClaudeEnvelope,
  parseClaudeLauncherArgs,
  runClaudeLauncher,
} from '../claude/launcher.js';
import { resolveMonitorPin } from '../claude/monitorPin.js';
import { createWorkerCapabilityCatalog } from '../harness/capabilities.js';

function captureWritable(): { stream: NodeJS.WritableStream; text: () => string; count: () => number } {
  let acc = '';
  let calls = 0;
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        calls += 1;
        acc += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    text: () => acc,
    count: () => calls,
  };
}

async function makeTargetCwd(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeFakeClaudeBinary(cwd: string): Promise<string> {
  const fakeClaude = join(cwd, 'claude');
  await writeFile(fakeClaude, `#!/usr/bin/env sh
case "$1" in
  --version)
    printf '%s\\n' '99.0.0-test'
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
  *)
    exit 1
    ;;
esac
`, { mode: 0o755 });
  await chmod(fakeClaude, 0o755);
  return fakeClaude;
}

function withFakeClaudeBinary(args: readonly string[], claudeBinary: string): string[] {
  return ['--claude-binary', claudeBinary, ...args];
}

describe('parseClaudeLauncherArgs append-system-prompt parsing', () => {
  it('accepts --append-system-prompt inline text and reports it as cli-inline candidate', async () => {
    const cwd = await makeTargetCwd('agent-claude-append-cli-inline-');
    const parsed = parseClaudeLauncherArgs(
      ['--cwd', cwd, '--append-system-prompt', 'Hello supervisor'],
      {},
      cwd,
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.appendCandidates.cliInline, 'Hello supervisor');
    assert.equal(parsed.value.appendCandidates.cliFile, null);
    assert.equal(parsed.value.disableAppendSystemPrompt, false);
  });

  it('accepts --append-system-prompt-file and resolves the path against the resolved target cwd', async () => {
    const cwd = await makeTargetCwd('agent-claude-append-cli-file-');
    const parsed = parseClaudeLauncherArgs(
      ['--cwd', cwd, '--append-system-prompt-file', 'prompts/extra.md'],
      {},
      cwd,
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.appendCandidates.cliFile, join(cwd, 'prompts/extra.md'));
  });

  it('reads AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT and ..._FILE as env candidates', async () => {
    const cwd = await makeTargetCwd('agent-claude-append-env-');
    const inlineParsed = parseClaudeLauncherArgs(
      ['--cwd', cwd],
      { AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT: 'env text' },
      cwd,
    );
    assert.equal(inlineParsed.ok, true);
    if (!inlineParsed.ok) return;
    assert.equal(inlineParsed.value.appendCandidates.envInline, 'env text');
    assert.equal(inlineParsed.value.appendCandidates.envFile, null);

    const fileParsed = parseClaudeLauncherArgs(
      ['--cwd', cwd],
      { AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE: 'prompts/env.md' },
      cwd,
    );
    assert.equal(fileParsed.ok, true);
    if (!fileParsed.ok) return;
    assert.equal(fileParsed.value.appendCandidates.envInline, null);
    assert.equal(fileParsed.value.appendCandidates.envFile, join(cwd, 'prompts/env.md'));
  });

  it('captures --no-append-system-prompt as disableAppendSystemPrompt: true and overrides every conflict check', async () => {
    const cwd = await makeTargetCwd('agent-claude-append-disable-');
    // Per Decision 9 the escape hatch must override CLI inline+file and env
    // inline+file conflicts; otherwise an operator cannot bypass a
    // misconfigured environment with --no-append-system-prompt alone.
    const parsedCliConflict = parseClaudeLauncherArgs(
      ['--cwd', cwd, '--no-append-system-prompt', '--append-system-prompt', 'ignored', '--append-system-prompt-file', 'ignored.md'],
      {
        AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT: 'envtext',
        AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE: 'envfile.md',
      },
      cwd,
    );
    assert.equal(parsedCliConflict.ok, true);
    if (!parsedCliConflict.ok) return;
    assert.equal(parsedCliConflict.value.disableAppendSystemPrompt, true);
    assert.equal(parsedCliConflict.value.appendCandidates.cliInline, 'ignored');
    assert.equal(parsedCliConflict.value.appendCandidates.cliFile, join(cwd, 'ignored.md'));
    assert.equal(parsedCliConflict.value.appendCandidates.envInline, 'envtext');
    assert.equal(parsedCliConflict.value.appendCandidates.envFile, join(cwd, 'envfile.md'));

    // Without --no-append-system-prompt the CLI inline+file conflict still fails.
    const parsedConflictNoEscape = parseClaudeLauncherArgs(
      ['--cwd', cwd, '--append-system-prompt', 'a', '--append-system-prompt-file', 'b'],
      {},
      cwd,
    );
    assert.equal(parsedConflictNoEscape.ok, false);
  });

  it('rejects --append-system-prompt + --append-system-prompt-file with the exact contract message', async () => {
    const cwd = await makeTargetCwd('agent-claude-append-cli-conflict-');
    const parsed = parseClaudeLauncherArgs(
      ['--cwd', cwd, '--append-system-prompt', 'x', '--append-system-prompt-file', 'y'],
      {},
      cwd,
    );
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(
      parsed.error,
      'Cannot combine --append-system-prompt and --append-system-prompt-file. Choose one or use --no-append-system-prompt to disable both.',
    );
  });

  it('rejects AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT + ..._FILE with the exact symmetric contract message', async () => {
    const cwd = await makeTargetCwd('agent-claude-append-env-conflict-');
    const parsed = parseClaudeLauncherArgs(
      ['--cwd', cwd],
      {
        AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT: 'x',
        AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE: 'y',
      },
      cwd,
    );
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(
      parsed.error,
      'Cannot combine AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT and AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE. Set one or use --no-append-system-prompt to disable both.',
    );
  });

  it('treats empty env-var values as unset and falls through to the next precedence step', async () => {
    const cwd = await makeTargetCwd('agent-claude-empty-env-');
    const parsed = parseClaudeLauncherArgs(
      ['--cwd', cwd],
      {
        AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT: '',
        AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE: '',
      },
      cwd,
    );
    // Both env vars set but empty → both treated as unset, no conflict error.
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.appendCandidates.envInline, null);
    assert.equal(parsed.value.appendCandidates.envFile, null);
  });

  it('resolves --append-system-prompt-file and env-file paths against the resolved target cwd, not defaultCwd/process.cwd', async () => {
    const targetCwd = await makeTargetCwd('agent-claude-cwd-target-');
    const launcherCwd = await makeTargetCwd('agent-claude-cwd-launcher-');
    const parsed = parseClaudeLauncherArgs(
      ['--cwd', targetCwd, '--append-system-prompt-file', 'prompts/cli.md'],
      { AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE: 'prompts/env.md' },
      launcherCwd,
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.cwd, targetCwd);
    assert.equal(parsed.value.appendCandidates.cliFile, join(targetCwd, 'prompts/cli.md'));
    assert.equal(parsed.value.appendCandidates.envFile, join(targetCwd, 'prompts/env.md'));
    assert.equal(parsed.value.appendCandidates.cliFile?.startsWith(launcherCwd), false);
    assert.equal(parsed.value.appendCandidates.envFile?.startsWith(launcherCwd), false);
  });
});

describe('resolveSupervisorAppendPrompt precedence and decoding', () => {
  const conventionPath = '/tmp/work/.agents/orchestrator/system-prompt.md';

  it('cli-inline wins over every lower-precedence source', () => {
    const result = resolveSupervisorAppendPrompt({
      cliInlineText: 'cli text',
      cliFilePath: '/tmp/cli.md',
      envInlineText: 'env text',
      envFilePath: '/tmp/env.md',
      conventionFilePath: conventionPath,
      conventionFilePresent: true,
      disable: false,
      loaded: {
        cliFile: { bytes: Buffer.from('cli file body'), path: '/tmp/cli.md' },
        envFile: { bytes: Buffer.from('env file body'), path: '/tmp/env.md' },
        convention: { bytes: Buffer.from('convention body'), path: conventionPath },
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.source, 'cli-inline');
    assert.equal(result.value.text, 'cli text');
    assert.equal(result.value.path, null);
    assert.match(result.value.conventionSkipNotice ?? '', /preempted by --append-system-prompt/);
  });

  it('cli-file preempts env-inline, env-file, and convention', () => {
    const result = resolveSupervisorAppendPrompt({
      cliInlineText: null,
      cliFilePath: '/tmp/cli.md',
      envInlineText: 'env',
      envFilePath: '/tmp/env.md',
      conventionFilePath: conventionPath,
      conventionFilePresent: true,
      disable: false,
      loaded: {
        cliFile: { bytes: Buffer.from('cli file body'), path: '/tmp/cli.md' },
        envFile: { bytes: Buffer.from('env body'), path: '/tmp/env.md' },
        convention: { bytes: Buffer.from('convention'), path: conventionPath },
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.source, 'cli-file');
    assert.equal(result.value.text, 'cli file body');
    assert.equal(result.value.path, '/tmp/cli.md');
    assert.match(result.value.conventionSkipNotice ?? '', /preempted by --append-system-prompt-file/);
  });

  it('env-inline preempts env-file and convention but not CLI', () => {
    const result = resolveSupervisorAppendPrompt({
      cliInlineText: null,
      cliFilePath: null,
      envInlineText: 'env inline',
      envFilePath: '/tmp/env.md',
      conventionFilePath: conventionPath,
      conventionFilePresent: true,
      disable: false,
      loaded: {
        envFile: { bytes: Buffer.from('env file'), path: '/tmp/env.md' },
        convention: { bytes: Buffer.from('convention'), path: conventionPath },
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.source, 'env-inline');
    assert.equal(result.value.text, 'env inline');
    assert.match(result.value.conventionSkipNotice ?? '', /preempted by AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT$/);
  });

  it('env-file preempts convention', () => {
    const result = resolveSupervisorAppendPrompt({
      cliInlineText: null,
      cliFilePath: null,
      envInlineText: null,
      envFilePath: '/tmp/env.md',
      conventionFilePath: conventionPath,
      conventionFilePresent: true,
      disable: false,
      loaded: {
        envFile: { bytes: Buffer.from('env file body'), path: '/tmp/env.md' },
        convention: { bytes: Buffer.from('convention body'), path: conventionPath },
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.source, 'env-file');
    assert.equal(result.value.text, 'env file body');
    assert.match(result.value.conventionSkipNotice ?? '', /preempted by AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE/);
  });

  it('convention selected when no higher-precedence source is set and emits no skip notice', () => {
    const result = resolveSupervisorAppendPrompt({
      cliInlineText: null,
      cliFilePath: null,
      envInlineText: null,
      envFilePath: null,
      conventionFilePath: conventionPath,
      conventionFilePresent: true,
      disable: false,
      loaded: {
        convention: { bytes: Buffer.from('convention body\n'), path: conventionPath },
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.source, 'convention-file');
    assert.equal(result.value.text, 'convention body');
    assert.equal(result.value.conventionSkipNotice, null);
  });

  it('returns source none when nothing is set', () => {
    const result = resolveSupervisorAppendPrompt({
      cliInlineText: null,
      cliFilePath: null,
      envInlineText: null,
      envFilePath: null,
      conventionFilePath: conventionPath,
      conventionFilePresent: false,
      disable: false,
      loaded: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.source, 'none');
    assert.equal(result.value.text, null);
    assert.equal(result.value.path, null);
    assert.equal(result.value.conventionSkipNotice, null);
  });

  it('disable=true short-circuits every source and clears the convention notice', () => {
    const result = resolveSupervisorAppendPrompt({
      cliInlineText: 'cli',
      cliFilePath: null,
      envInlineText: 'env',
      envFilePath: null,
      conventionFilePath: conventionPath,
      conventionFilePresent: true,
      disable: true,
      loaded: {
        convention: { bytes: Buffer.from('convention'), path: conventionPath },
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.source, 'none');
    assert.equal(result.value.text, null);
    assert.equal(result.value.conventionSkipNotice, null);
  });

  it('strips a UTF-8 BOM, trimEnd trailing whitespace, preserves CRLF and leading Markdown', () => {
    const body = '# Heading\r\n- item one\r\n- item two\r\n   \n\n';
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
    const result = resolveSupervisorAppendPrompt({
      cliInlineText: null,
      cliFilePath: '/tmp/cli.md',
      envInlineText: null,
      envFilePath: null,
      conventionFilePath: conventionPath,
      conventionFilePresent: false,
      disable: false,
      loaded: { cliFile: { bytes, path: '/tmp/cli.md' } },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.source, 'cli-file');
    assert.equal(result.value.text, '# Heading\r\n- item one\r\n- item two');
  });

  it('accepts exactly 65 536 bytes and rejects 65 537 bytes (byte-based cap) with the exact contract error', () => {
    const accepted = Buffer.alloc(SUPERVISOR_APPEND_PROMPT_BYTE_CAP, 0x61);
    const rejected = Buffer.alloc(SUPERVISOR_APPEND_PROMPT_BYTE_CAP + 1, 0x61);
    const okResult = resolveSupervisorAppendPrompt({
      cliInlineText: null,
      cliFilePath: '/tmp/c.md',
      envInlineText: null,
      envFilePath: null,
      conventionFilePath: '/tmp/work/.agents/orchestrator/system-prompt.md',
      conventionFilePresent: false,
      disable: false,
      loaded: { cliFile: { bytes: accepted, path: '/tmp/c.md' } },
    });
    assert.equal(okResult.ok, true);

    const errResult = resolveSupervisorAppendPrompt({
      cliInlineText: null,
      cliFilePath: '/tmp/c.md',
      envInlineText: null,
      envFilePath: null,
      conventionFilePath: '/tmp/work/.agents/orchestrator/system-prompt.md',
      conventionFilePresent: false,
      disable: false,
      loaded: { cliFile: { bytes: rejected, path: '/tmp/c.md' } },
    });
    assert.equal(errResult.ok, false);
    if (errResult.ok) return;
    assert.equal(errResult.error.code, 'oversize');
    assert.equal(
      errResult.error.message,
      `Supervisor append prompt exceeds the ${SUPERVISOR_APPEND_PROMPT_BYTE_CAP}-byte cap (got ${SUPERVISOR_APPEND_PROMPT_BYTE_CAP + 1} bytes) from source cli-file at /tmp/c.md.`,
    );
  });

  it('byte cap is enforced on UTF-8 byte length, not codepoint count (multibyte boundary)', () => {
    // Build a 65 536-byte buffer whose final codepoint is the 3-byte UTF-8
    // character U+2026 (HORIZONTAL ELLIPSIS, EF 80 A6 ... actually E2 80 A6).
    // Filling the prefix with ASCII makes the multibyte boundary exact.
    const ellipsis = Buffer.from('…', 'utf8');
    assert.equal(ellipsis.length, 3);
    const prefixLen = SUPERVISOR_APPEND_PROMPT_BYTE_CAP - ellipsis.length;
    const accepted = Buffer.concat([Buffer.alloc(prefixLen, 0x61), ellipsis]);
    assert.equal(accepted.length, SUPERVISOR_APPEND_PROMPT_BYTE_CAP);

    const okResult = resolveSupervisorAppendPrompt({
      cliInlineText: null,
      cliFilePath: '/tmp/c.md',
      envInlineText: null,
      envFilePath: null,
      conventionFilePath: '/tmp/work/.agents/orchestrator/system-prompt.md',
      conventionFilePresent: false,
      disable: false,
      loaded: { cliFile: { bytes: accepted, path: '/tmp/c.md' } },
    });
    assert.equal(okResult.ok, true);
    if (!okResult.ok) return;
    // The trailing ellipsis must survive (no trim-end of legitimate content).
    assert.equal(okResult.value.text?.endsWith('…'), true);

    const rejected = Buffer.concat([accepted, Buffer.from('a', 'utf8')]);
    assert.equal(rejected.length, SUPERVISOR_APPEND_PROMPT_BYTE_CAP + 1);
    const errResult = resolveSupervisorAppendPrompt({
      cliInlineText: null,
      cliFilePath: '/tmp/c.md',
      envInlineText: null,
      envFilePath: null,
      conventionFilePath: '/tmp/work/.agents/orchestrator/system-prompt.md',
      conventionFilePresent: false,
      disable: false,
      loaded: { cliFile: { bytes: rejected, path: '/tmp/c.md' } },
    });
    assert.equal(errResult.ok, false);
    if (errResult.ok) return;
    assert.equal(errResult.error.code, 'oversize');
  });

  it('returns text=null when content is whitespace-only but preserves source and path', () => {
    const bytes = Buffer.from('   \n\t  \n', 'utf8');
    const result = resolveSupervisorAppendPrompt({
      cliInlineText: null,
      cliFilePath: '/tmp/c.md',
      envInlineText: null,
      envFilePath: null,
      conventionFilePath: '/tmp/work/.agents/orchestrator/system-prompt.md',
      conventionFilePresent: false,
      disable: false,
      loaded: { cliFile: { bytes, path: '/tmp/c.md' } },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.source, 'cli-file');
    assert.equal(result.value.path, '/tmp/c.md');
    assert.equal(result.value.text, null);
  });
});

describe('buildSupervisorSystemPrompt user-append integration', () => {
  it('appends the literal delimiter + user text when text is non-empty', () => {
    const monitorPin = resolveMonitorPin({ AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' });
    const catalog = createWorkerCapabilityCatalog(null);
    const baseline = buildClaudeHarnessConfig({
      targetCwd: '/tmp/work',
      manifestPath: '/tmp/work/profiles.json',
      ephemeralSkillRoot: '/tmp/skills',
      orchestrationSkillNames: [],
      orchestrationSkills: [],
      runtimeSkillRoot: '/tmp/home/.claude/skills',
      runtimeSkillNames: [],
      catalog,
      profileDiagnostics: [],
      mcpCliPath: '/opt/agent-orchestrator/dist/cli.js',
      monitorPin,
    });
    const withAppend = buildClaudeHarnessConfig({
      targetCwd: '/tmp/work',
      manifestPath: '/tmp/work/profiles.json',
      ephemeralSkillRoot: '/tmp/skills',
      orchestrationSkillNames: [],
      orchestrationSkills: [],
      runtimeSkillRoot: '/tmp/home/.claude/skills',
      runtimeSkillNames: [],
      catalog,
      profileDiagnostics: [],
      mcpCliPath: '/opt/agent-orchestrator/dist/cli.js',
      monitorPin,
      userAppendSystemPrompt: {
        source: 'cli-inline',
        path: null,
        text: 'Please keep responses concise.',
      },
    });
    assert.equal(withAppend.systemPrompt.endsWith(`${SUPERVISOR_APPEND_PROMPT_DELIMITER}Please keep responses concise.`), true);
    assert.equal(withAppend.systemPrompt.startsWith(baseline.systemPrompt), true);
    assert.equal(withAppend.userSystemPromptSource, 'cli-inline');
    assert.equal(withAppend.userSystemPromptAppend, 'Please keep responses concise.');
  });

  it('produces a byte-identical baseline when text is null or absent', () => {
    const monitorPin = resolveMonitorPin({ AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' });
    const catalog = createWorkerCapabilityCatalog(null);
    const baseline = buildClaudeHarnessConfig({
      targetCwd: '/tmp/work',
      manifestPath: '/tmp/work/profiles.json',
      ephemeralSkillRoot: '/tmp/skills',
      orchestrationSkillNames: [],
      orchestrationSkills: [],
      runtimeSkillRoot: '/tmp/home/.claude/skills',
      runtimeSkillNames: [],
      catalog,
      profileDiagnostics: [],
      mcpCliPath: '/opt/agent-orchestrator/dist/cli.js',
      monitorPin,
    });
    const emptyText = buildClaudeHarnessConfig({
      targetCwd: '/tmp/work',
      manifestPath: '/tmp/work/profiles.json',
      ephemeralSkillRoot: '/tmp/skills',
      orchestrationSkillNames: [],
      orchestrationSkills: [],
      runtimeSkillRoot: '/tmp/home/.claude/skills',
      runtimeSkillNames: [],
      catalog,
      profileDiagnostics: [],
      mcpCliPath: '/opt/agent-orchestrator/dist/cli.js',
      monitorPin,
      userAppendSystemPrompt: { source: 'cli-file', path: '/tmp/x.md', text: null },
    });
    assert.equal(emptyText.systemPrompt, baseline.systemPrompt);
  });
});

describe('buildClaudeEnvelope append-prompt wiring', () => {
  async function makeBaseCwd(prefix: string): Promise<{ cwd: string; skillsPath: string; stateDir: string; claudeBinary: string }> {
    const cwd = await makeTargetCwd(prefix);
    const skillsPath = join(cwd, '.agents', 'skills');
    await mkdir(join(skillsPath, 'orchestrate-foo'), { recursive: true });
    await writeFile(join(skillsPath, 'orchestrate-foo', 'SKILL.md'), '---\nname: orchestrate-foo\n---\nbody');
    const stateDir = join(cwd, 'claude-state');
    const claudeBinary = await writeFakeClaudeBinary(cwd);
    return { cwd, skillsPath, stateDir, claudeBinary };
  }

  it('writes one concatenated system-prompt.md and keeps spawn args at a single --append-system-prompt-file', async () => {
    const { cwd, skillsPath, stateDir } = await makeBaseCwd('agent-claude-envelope-append-');
    const parsed = parseClaudeLauncherArgs(
      ['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--append-system-prompt', 'Custom rule.'],
      { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' },
      cwd,
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const built = await buildClaudeEnvelope({
      options: parsed.value,
      env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' },
      catalog: createWorkerCapabilityCatalog(null),
      profilesResult: { profiles: undefined, diagnostics: [] },
    });
    try {
      const written = await readFile(built.systemPromptPath, 'utf8');
      assert.equal(written, built.systemPrompt);
      assert.equal(written.endsWith(`${SUPERVISOR_APPEND_PROMPT_DELIMITER}Custom rule.`), true);
      assert.equal(built.userSystemPromptSource, 'cli-inline');
      assert.equal(built.userSystemPromptAppend, 'Custom rule.');
      assert.equal(built.userSystemPromptPath, null);
      // Single spawn arg pair: exactly one --append-system-prompt-file pointing at the envelope file.
      const flagIndexes = built.spawnArgs.reduce<number[]>((acc, arg, idx) => {
        if (arg === '--append-system-prompt-file') acc.push(idx);
        return acc;
      }, []);
      assert.deepStrictEqual(flagIndexes.length, 1);
      assert.equal(built.spawnArgs[flagIndexes[0]! + 1], built.systemPromptPath);
      // No second instance, no new Claude flag surface.
      assert.equal(built.spawnArgs.includes('--system-prompt-file'), false);
      assert.equal(built.spawnArgs.includes('--system-prompt'), false);
      assert.equal(built.spawnArgs.includes('--append-system-prompt'), false);
    } finally {
      await built.cleanup();
    }
  });

  it('hooks/settings.json content is byte-identical to the no-append baseline when an append is present', async () => {
    const baseline = await makeBaseCwd('agent-claude-hooks-baseline-');
    const parsedBaseline = parseClaudeLauncherArgs(
      ['--cwd', baseline.cwd, '--skills', baseline.skillsPath, '--state-dir', baseline.stateDir],
      { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' },
      baseline.cwd,
    );
    assert.equal(parsedBaseline.ok, true);
    if (!parsedBaseline.ok) return;
    const builtBaseline = await buildClaudeEnvelope({
      options: parsedBaseline.value,
      env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' },
      catalog: createWorkerCapabilityCatalog(null),
      profilesResult: { profiles: undefined, diagnostics: [] },
    });

    const withAppend = await makeBaseCwd('agent-claude-hooks-append-');
    const parsedAppend = parseClaudeLauncherArgs(
      ['--cwd', withAppend.cwd, '--skills', withAppend.skillsPath, '--state-dir', withAppend.stateDir, '--append-system-prompt', 'Extra'],
      { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' },
      withAppend.cwd,
    );
    assert.equal(parsedAppend.ok, true);
    if (!parsedAppend.ok) return;
    const builtAppend = await buildClaudeEnvelope({
      options: parsedAppend.value,
      env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' },
      catalog: createWorkerCapabilityCatalog(null),
      profilesResult: { profiles: undefined, diagnostics: [] },
    });

    try {
      assert.equal(builtAppend.settingsContent, builtBaseline.settingsContent);
    } finally {
      await builtBaseline.cleanup();
      await builtAppend.cleanup();
    }
  });

  it('loads a present convention file when no higher-precedence source is set and emits no skip notice', async () => {
    const { cwd, skillsPath, stateDir } = await makeBaseCwd('agent-claude-convention-load-');
    await mkdir(join(cwd, '.agents', 'orchestrator'), { recursive: true });
    await writeFile(join(cwd, CONVENTION_APPEND_PROMPT_RELATIVE_PATH), 'Convention guidance.\n');
    const parsed = parseClaudeLauncherArgs(
      ['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir],
      { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' },
      cwd,
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const built = await buildClaudeEnvelope({
      options: parsed.value,
      env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' },
      catalog: createWorkerCapabilityCatalog(null),
      profilesResult: { profiles: undefined, diagnostics: [] },
    });
    try {
      assert.equal(built.userSystemPromptSource, 'convention-file');
      assert.equal(built.userSystemPromptPath, join(cwd, CONVENTION_APPEND_PROMPT_RELATIVE_PATH));
      assert.equal(built.userSystemPromptAppend, 'Convention guidance.');
      assert.equal(built.conventionSkipNotice, null);
      assert.match(built.systemPrompt, /Convention guidance\.$/);
    } finally {
      await built.cleanup();
    }
  });

  it('absent convention file is silent (no error, no notice)', async () => {
    const { cwd, skillsPath, stateDir } = await makeBaseCwd('agent-claude-convention-absent-');
    const parsed = parseClaudeLauncherArgs(
      ['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir],
      { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' },
      cwd,
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const built = await buildClaudeEnvelope({
      options: parsed.value,
      env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' },
      catalog: createWorkerCapabilityCatalog(null),
      profilesResult: { profiles: undefined, diagnostics: [] },
    });
    try {
      assert.equal(built.userSystemPromptSource, 'none');
      assert.equal(built.userSystemPromptPath, null);
      assert.equal(built.userSystemPromptAppend, null);
      assert.equal(built.conventionSkipNotice, null);
    } finally {
      await built.cleanup();
    }
  });

  it('precedence-skip emits a single stderr notice via runClaudeLauncher and --print-config records the cli-inline source', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-precedence-skip-');
    await mkdir(join(cwd, '.agents', 'orchestrator'), { recursive: true });
    await writeFile(join(cwd, CONVENTION_APPEND_PROMPT_RELATIVE_PATH), 'project default\n');
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--append-system-prompt', 'override', '--print-config'], claudeBinary),
      { stdout: stdout.stream, stderr: stderr.stream, env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator', AGENT_ORCHESTRATOR_HOME: join(cwd, 'home') } },
    );
    assert.equal(code, 0);
    // Stderr was written exactly once with the skip notice.
    assert.equal(stderr.count(), 1);
    assert.match(stderr.text(), /skipping convention system-prompt file/);
    assert.match(stderr.text(), /preempted by --append-system-prompt/);
    const out = stdout.text();
    assert.match(out, /# user system prompt source\ncli-inline\n/);
    assert.match(out, /# user system prompt \(append\)\noverride\n/);
  });

  it('missing CLI file fails the launch with a typed error and exit code 1', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-missing-cli-file-');
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--append-system-prompt-file', 'nonexistent.md', '--print-config'], claudeBinary),
      { stdout: stdout.stream, stderr: stderr.stream, env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator', AGENT_ORCHESTRATOR_HOME: join(cwd, 'home') } },
    );
    assert.equal(code, 1);
    assert.match(stderr.text(), /append-prompt file not found/);
    assert.match(stderr.text(), /cli-file/);
  });

  it('missing env file fails the launch with a typed error and exit code 1', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-missing-env-file-');
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--print-config'], claudeBinary),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {
          AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator',
          AGENT_ORCHESTRATOR_HOME: join(cwd, 'home'),
          AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE: 'nonexistent.md',
        },
      },
    );
    assert.equal(code, 1);
    assert.match(stderr.text(), /append-prompt file not found/);
    assert.match(stderr.text(), /env-file/);
  });

  it('--no-append-system-prompt short-circuits CLI, env, and convention sources to "none"', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-no-append-');
    await mkdir(join(cwd, '.agents', 'orchestrator'), { recursive: true });
    await writeFile(join(cwd, CONVENTION_APPEND_PROMPT_RELATIVE_PATH), 'project default\n');
    const cliFile = join(cwd, 'cli.md');
    await writeFile(cliFile, 'CLI file body');
    const envFile = join(cwd, 'env.md');
    await writeFile(envFile, 'env file body');
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--no-append-system-prompt', '--append-system-prompt', 'cli inline', '--print-config'], claudeBinary),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {
          AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator',
          AGENT_ORCHESTRATOR_HOME: join(cwd, 'home'),
          AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT: 'env inline',
        },
      },
    );
    assert.equal(code, 0);
    const out = stdout.text();
    assert.match(out, /# user system prompt source\nnone\n/);
    assert.equal(out.includes('# user system prompt (append)'), false);
    // Stderr stays silent when --no-append-system-prompt suppresses every source, including the convention file.
    assert.equal(stderr.count(), 0);
  });

  it('non-regular convention file (symlink) is refused and surfaces the lstat skip notice exactly once via runClaudeLauncher', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-convention-symlink-');
    const sensitive = join(cwd, 'sensitive.txt');
    await writeFile(sensitive, 'do-not-load');
    await mkdir(join(cwd, '.agents', 'orchestrator'), { recursive: true });
    await symlink(sensitive, join(cwd, CONVENTION_APPEND_PROMPT_RELATIVE_PATH));
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--print-config'], claudeBinary),
      { stdout: stdout.stream, stderr: stderr.stream, env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator', AGENT_ORCHESTRATOR_HOME: join(cwd, 'home') } },
    );
    assert.equal(code, 0);
    assert.equal(stderr.count(), 1);
    assert.match(stderr.text(), /not a regular file \(symlink\)/);
    const out = stdout.text();
    assert.match(out, /# user system prompt source\nnone\n/);
    assert.equal(out.includes('do-not-load'), false);
  });

  it('non-regular convention file (directory) is refused and surfaces the lstat skip notice exactly once', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-convention-dir-');
    await mkdir(join(cwd, CONVENTION_APPEND_PROMPT_RELATIVE_PATH), { recursive: true });
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--print-config'], claudeBinary),
      { stdout: stdout.stream, stderr: stderr.stream, env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator', AGENT_ORCHESTRATOR_HOME: join(cwd, 'home') } },
    );
    assert.equal(code, 0);
    assert.equal(stderr.count(), 1);
    assert.match(stderr.text(), /not a regular file \(directory\)/);
  });

  it('CLI-named symlink is read as-is (not refused by the lstat guard, which is convention-only)', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-cli-symlink-');
    const target = join(cwd, 'prompt-target.md');
    await writeFile(target, 'linked supervisor text\n');
    const linkPath = join(cwd, 'prompt-link.md');
    await symlink(target, linkPath);
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--append-system-prompt-file', 'prompt-link.md', '--print-config'], claudeBinary),
      { stdout: stdout.stream, stderr: stderr.stream, env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator', AGENT_ORCHESTRATOR_HOME: join(cwd, 'home') } },
    );
    assert.equal(code, 0);
    // No stderr notice — only convention-file paths are refused by lstat.
    assert.equal(stderr.count(), 0);
    const out = stdout.text();
    assert.match(out, /# user system prompt source\ncli-file\n/);
    assert.match(out, /# user system prompt \(append\)\nlinked supervisor text\n/);
  });

  it('--print-config emits the source line with an (empty) annotation when text is whitespace-only', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-empty-text-');
    const emptyFile = join(cwd, 'empty.md');
    await writeFile(emptyFile, '   \n\t  \n');
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--append-system-prompt-file', 'empty.md', '--print-config'], claudeBinary),
      { stdout: stdout.stream, stderr: stderr.stream, env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator', AGENT_ORCHESTRATOR_HOME: join(cwd, 'home') } },
    );
    assert.equal(code, 0);
    const out = stdout.text();
    assert.match(out, /# user system prompt source\ncli-file \(empty\)\n/);
    assert.match(out, /# user system prompt path\n.*empty\.md/);
    assert.equal(out.includes('# user system prompt (append)'), false);
    assert.equal(stderr.count(), 0);
  });

  it('oversize CLI file fails the launch with the byte-cap message naming the source and path', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-oversize-');
    const big = join(cwd, 'big.md');
    await writeFile(big, Buffer.alloc(SUPERVISOR_APPEND_PROMPT_BYTE_CAP + 1, 0x61));
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--append-system-prompt-file', 'big.md', '--print-config'], claudeBinary),
      { stdout: stdout.stream, stderr: stderr.stream, env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator', AGENT_ORCHESTRATOR_HOME: join(cwd, 'home') } },
    );
    assert.equal(code, 1);
    assert.match(stderr.text(), /65536-byte cap/);
    assert.match(stderr.text(), /65537 bytes/);
    assert.match(stderr.text(), /cli-file/);
    assert.match(stderr.text(), /big\.md/);
  });

  it('no append source emits the # user system prompt source line with the none sentinel in --print-config', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-print-none-');
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--print-config'], claudeBinary),
      { stdout: stdout.stream, stderr: stderr.stream, env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator', AGENT_ORCHESTRATOR_HOME: join(cwd, 'home') } },
    );
    assert.equal(code, 0);
    assert.match(stdout.text(), /# user system prompt source\nnone\n/);
    assert.equal(stdout.text().includes('# user system prompt path'), false);
    assert.equal(stdout.text().includes('# user system prompt (append)'), false);
    assert.equal(stderr.count(), 0);
  });

  it('cli-inline wins over a missing AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE: preempted file is never read', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-preempt-missing-env-file-');
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--append-system-prompt', 'cli wins', '--print-config'], claudeBinary),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {
          AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator',
          AGENT_ORCHESTRATOR_HOME: join(cwd, 'home'),
          AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE: '/does/not/exist/anywhere.md',
        },
      },
    );
    assert.equal(code, 0);
    assert.match(stdout.text(), /# user system prompt source\ncli-inline\n/);
    assert.match(stdout.text(), /# user system prompt \(append\)\ncli wins\n/);
    // Stderr stays silent: the env file is never read because cli-inline wins.
    assert.equal(stderr.count(), 0);
  });

  it('cli-inline wins over an oversize AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE: preempted file is never read', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-preempt-oversize-env-file-');
    const oversize = join(cwd, 'oversize.md');
    await writeFile(oversize, Buffer.alloc(SUPERVISOR_APPEND_PROMPT_BYTE_CAP + 4096, 0x61));
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--append-system-prompt', 'cli wins', '--print-config'], claudeBinary),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {
          AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator',
          AGENT_ORCHESTRATOR_HOME: join(cwd, 'home'),
          AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE: 'oversize.md',
        },
      },
    );
    assert.equal(code, 0, 'higher-precedence cli-inline must succeed even when a lower-precedence env file would have been oversize');
    assert.match(stdout.text(), /# user system prompt source\ncli-inline\n/);
  });

  it('cli-inline wins over an unreadable convention file: convention body is never read (precedence-skip notice fires, the bad bytes do not)', async () => {
    if (process.getuid?.() === 0) return; // root bypasses permission bits; skip
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-preempt-unreadable-convention-');
    await mkdir(join(cwd, '.agents', 'orchestrator'), { recursive: true });
    const conventionPath = join(cwd, CONVENTION_APPEND_PROMPT_RELATIVE_PATH);
    await writeFile(conventionPath, 'convention body');
    const { chmod } = await import('node:fs/promises');
    await chmod(conventionPath, 0o000);
    try {
      const stdout = captureWritable();
      const stderr = captureWritable();
      const code = await runClaudeLauncher(
        withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--append-system-prompt', 'cli wins', '--print-config'], claudeBinary),
        { stdout: stdout.stream, stderr: stderr.stream, env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator', AGENT_ORCHESTRATOR_HOME: join(cwd, 'home') } },
      );
      assert.equal(code, 0, 'cli-inline wins; the preempted convention file must not be read');
      assert.equal(stderr.count(), 1, 'only the precedence-skip notice should fire');
      assert.match(stderr.text(), /skipping convention system-prompt file/);
      assert.match(stdout.text(), /# user system prompt source\ncli-inline\n/);
    } finally {
      await chmod(conventionPath, 0o600);
    }
  });

  it('--no-append-system-prompt suppresses cli-file only (no parse error, source=none)', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-no-suppress-cli-file-');
    const cliFile = join(cwd, 'cli.md');
    await writeFile(cliFile, 'cli file body');
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--no-append-system-prompt', '--append-system-prompt-file', 'cli.md', '--print-config'], claudeBinary),
      { stdout: stdout.stream, stderr: stderr.stream, env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator', AGENT_ORCHESTRATOR_HOME: join(cwd, 'home') } },
    );
    assert.equal(code, 0);
    assert.match(stdout.text(), /# user system prompt source\nnone\n/);
    assert.equal(stderr.count(), 0);
  });

  it('--no-append-system-prompt suppresses env-inline only', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-no-suppress-env-inline-');
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--no-append-system-prompt', '--print-config'], claudeBinary),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {
          AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator',
          AGENT_ORCHESTRATOR_HOME: join(cwd, 'home'),
          AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT: 'env inline',
        },
      },
    );
    assert.equal(code, 0);
    assert.match(stdout.text(), /# user system prompt source\nnone\n/);
    assert.equal(stderr.count(), 0);
  });

  it('--no-append-system-prompt suppresses env-file only', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-no-suppress-env-file-');
    const envFile = join(cwd, 'env.md');
    await writeFile(envFile, 'env file body');
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--no-append-system-prompt', '--print-config'], claudeBinary),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {
          AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator',
          AGENT_ORCHESTRATOR_HOME: join(cwd, 'home'),
          AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE: 'env.md',
        },
      },
    );
    assert.equal(code, 0);
    assert.match(stdout.text(), /# user system prompt source\nnone\n/);
    assert.equal(stderr.count(), 0);
  });

  it('--no-append-system-prompt suppresses a present convention file (no stderr, source=none, body not read)', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-no-suppress-convention-');
    await mkdir(join(cwd, '.agents', 'orchestrator'), { recursive: true });
    await writeFile(join(cwd, CONVENTION_APPEND_PROMPT_RELATIVE_PATH), 'convention body');
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--no-append-system-prompt', '--print-config'], claudeBinary),
      { stdout: stdout.stream, stderr: stderr.stream, env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator', AGENT_ORCHESTRATOR_HOME: join(cwd, 'home') } },
    );
    assert.equal(code, 0);
    assert.match(stdout.text(), /# user system prompt source\nnone\n/);
    // --no-append-system-prompt skips the lstat probe too — no skip notice fires.
    assert.equal(stderr.count(), 0);
  });

  it('--no-append-system-prompt overrides the CLI inline+file conflict (escape hatch wins)', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-no-escape-cli-conflict-');
    const cliFile = join(cwd, 'cli.md');
    await writeFile(cliFile, 'cli file body');
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--no-append-system-prompt', '--append-system-prompt', 'inline', '--append-system-prompt-file', 'cli.md', '--print-config'], claudeBinary),
      { stdout: stdout.stream, stderr: stderr.stream, env: { AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator', AGENT_ORCHESTRATOR_HOME: join(cwd, 'home') } },
    );
    assert.equal(code, 0);
    assert.match(stdout.text(), /# user system prompt source\nnone\n/);
  });

  it('--no-append-system-prompt overrides the env inline+file conflict (escape hatch wins)', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-no-escape-env-conflict-');
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--no-append-system-prompt', '--print-config'], claudeBinary),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {
          AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator',
          AGENT_ORCHESTRATOR_HOME: join(cwd, 'home'),
          AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT: 'env inline',
          AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE: '/does/not/exist.md',
        },
      },
    );
    assert.equal(code, 0);
    assert.match(stdout.text(), /# user system prompt source\nnone\n/);
  });

  it('env-named symlink is read as-is (lstat guard is convention-only)', async () => {
    const { cwd, skillsPath, stateDir, claudeBinary } = await makeBaseCwd('agent-claude-env-symlink-');
    const target = join(cwd, 'env-target.md');
    await writeFile(target, 'env-supervisor text via symlink\n');
    const linkPath = join(cwd, 'env-link.md');
    await symlink(target, linkPath);
    const stdout = captureWritable();
    const stderr = captureWritable();
    const code = await runClaudeLauncher(
      withFakeClaudeBinary(['--cwd', cwd, '--skills', skillsPath, '--state-dir', stateDir, '--print-config'], claudeBinary),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {
          AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator',
          AGENT_ORCHESTRATOR_HOME: join(cwd, 'home'),
          AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE: 'env-link.md',
        },
      },
    );
    assert.equal(code, 0);
    assert.equal(stderr.count(), 0);
    const out = stdout.text();
    assert.match(out, /# user system prompt source\nenv-file\n/);
    assert.match(out, /# user system prompt \(append\)\nenv-supervisor text via symlink\n/);
  });
});

describe('claudeLauncherHelp append-prompt surface', () => {
  it('documents the three flags, both env vars, the convention path, precedence, and the 64 KiB cap', async () => {
    const stdout = captureWritable();
    const code = await runClaudeLauncher(
      ['--help'],
      { stdout: stdout.stream, stderr: captureWritable().stream, env: {} },
    );
    assert.equal(code, 0);
    const text = stdout.text();
    assert.match(text, /--append-system-prompt <text>/);
    assert.match(text, /--append-system-prompt-file <path>/);
    assert.match(text, /--no-append-system-prompt/);
    assert.match(text, /AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT\b/);
    assert.match(text, /AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT_FILE\b/);
    assert.match(text, /\.agents\/orchestrator\/system-prompt\.md/);
    assert.match(text, /Precedence/);
    assert.match(text, /64 KB/);
    assert.match(text, /forbidden by the passthrough\s+validator/);
  });
});

describe('passthrough validator append-system-prompt rejection wording', () => {
  it('points users at the launcher flag when --append-system-prompt is rejected after --', async () => {
    const { validateClaudePassthroughArgs } = await import('../claude/passthrough.js');
    const result = validateClaudePassthroughArgs(['--append-system-prompt', 'evil']);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error!, /agent-orchestrator claude --append-system-prompt/);
    assert.match(result.error!, /AGENT_ORCHESTRATOR_CLAUDE_APPEND_SYSTEM_PROMPT/);
  });

  it('points users at the launcher flag when --append-system-prompt-file is rejected after --', async () => {
    const { validateClaudePassthroughArgs } = await import('../claude/passthrough.js');
    const result = validateClaudePassthroughArgs(['--append-system-prompt-file', '/tmp/x.md']);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error!, /agent-orchestrator claude --append-system-prompt-file/);
  });
});

// Defense in depth: make sure rm comes from somewhere so it doesn't get tree-shaken
void rm;
