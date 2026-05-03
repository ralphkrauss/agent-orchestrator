import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tools as mcpTools } from '../mcpTools.js';
import {
  buildClaudeSupervisorSettings,
  CLAUDE_MCP_SERVER_NAME,
  orchestratorMcpToolAllowList,
  stringifyClaudeSupervisorSettings,
} from '../claude/permission.js';
import { resolveMonitorPin } from '../claude/monitorPin.js';
import { validateClaudePassthroughArgs } from '../claude/passthrough.js';
import { curateOrchestrateSkills, listOrchestrationSkills } from '../claude/skills.js';
import {
  buildClaudeHarnessConfig,
  stringifyClaudeMcpConfig,
} from '../claude/config.js';
import { buildClaudeEnvelope, buildClaudeSpawnArgs, parseClaudeLauncherArgs } from '../claude/launcher.js';
import { createWorkerCapabilityCatalog } from '../harness/capabilities.js';

describe('Claude harness permission and allowlist', () => {
  it('orchestratorMcpToolAllowList matches every registered MCP tool exactly', () => {
    const expected = mcpTools.map((tool) => `mcp__${CLAUDE_MCP_SERVER_NAME}__${tool.name}`).sort();
    assert.deepStrictEqual(orchestratorMcpToolAllowList(), expected);
  });

  it('builds settings that allow Read/Glob/Grep + agent-orchestrator MCP tools and deny Bash/Edit/Write/WebFetch/WebSearch/Task/NotebookEdit/TodoWrite', () => {
    const settings = buildClaudeSupervisorSettings();
    assert.deepStrictEqual(
      [...settings.permissions.allow].sort(),
      ['Glob', 'Grep', 'Read', ...orchestratorMcpToolAllowList()].sort(),
    );
    for (const denied of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite']) {
      assert.ok(settings.permissions.deny.includes(denied), `${denied} must be denied`);
    }
    // The pinned monitor Bash pattern is intentionally NOT in allow: Bash is
    // not exposed inside the supervisor envelope at all (built-in availability
    // is restricted via --tools at spawn time, and bare Bash is in deny for
    // defense in depth). The agent-orchestrator monitor CLI is documented for
    // the user's own shell only.
    assert.equal(settings.permissions.allow.some((rule) => rule.startsWith('Bash(')), false, 'no Bash pattern is allowed inside the envelope');
    assert.equal(settings.enableAllProjectMcpServers, false);
    const json = stringifyClaudeSupervisorSettings(settings);
    JSON.parse(json);
  });
});

describe('Claude monitor pin (used in the system prompt as informational pointer to the standalone CLI)', () => {
  it('uses the AGENT_ORCHESTRATOR_BIN override when absolute and exposes a canonical command prefix', () => {
    const pin = resolveMonitorPin({ AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' });
    assert.equal(pin.bin, '/opt/agent-orchestrator');
    assert.equal(pin.command_prefix_string, `${process.execPath} /opt/agent-orchestrator`);
    assert.deepStrictEqual(pin.command_prefix, [process.execPath, '/opt/agent-orchestrator']);
  });

  it('falls back to the package CLI script when the env override is missing or relative', () => {
    const pin = resolveMonitorPin({ AGENT_ORCHESTRATOR_BIN: 'relative-path' });
    assert.match(pin.bin, /[/\\]dist[/\\]cli\.js$/);
    assert.equal(pin.nodePath, process.execPath);
  });
});

describe('Claude passthrough hardening', () => {
  it('rejects forbidden harness-owned flags', () => {
    for (const flag of [
      '--dangerously-skip-permissions',
      '--mcp-config',
      '--strict-mcp-config',
      '--allowed-tools',
      '--disallowed-tools',
      '--add-dir',
      '--settings',
      '--setting-sources',
      '--system-prompt',
      '--append-system-prompt',
      '--plugin-dir',
      '--agents',
      '--agent',
      '--permission-mode',
      '--tools',
      '--disable-slash-commands',
      // --bare disables skill / CLAUDE.md / plugin / MCP auto-discovery,
      // which would hide the curated <envelope>/.claude/skills/orchestrate-*
      // surface the supervisor depends on. Forbidden for the same reason as
      // --disable-slash-commands.
      '--bare',
    ]) {
      const result = validateClaudePassthroughArgs([flag]);
      assert.equal(result.ok, false, `expected ${flag} to be rejected`);
    }
  });

  it('accepts allowed read-only Claude flags', () => {
    const result = validateClaudePassthroughArgs(['--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']);
    assert.equal(result.ok, true);
  });

  it('rejects unknown flags', () => {
    assert.equal(validateClaudePassthroughArgs(['--invented-flag']).ok, false);
  });
});

describe('Claude skill curation', () => {
  it('lists and copies orchestrate-* skills into an ephemeral root, ignoring non-orchestrate skills', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'agent-claude-skills-'));
    await mkdir(join(sourceRoot, 'orchestrate-implement-plan'), { recursive: true });
    await writeFile(join(sourceRoot, 'orchestrate-implement-plan', 'SKILL.md'), '---\nname: orchestrate-implement-plan\n---\nbody');
    await mkdir(join(sourceRoot, 'review'), { recursive: true });
    await writeFile(join(sourceRoot, 'review', 'SKILL.md'), '---\nname: review\n---\nbody');
    await mkdir(join(sourceRoot, 'orchestrate-create-plan'), { recursive: true });
    await writeFile(join(sourceRoot, 'orchestrate-create-plan', 'SKILL.md'), '---\nname: orchestrate-create-plan\n---\nbody');

    const listed = await listOrchestrationSkills(sourceRoot);
    assert.deepStrictEqual(listed, ['orchestrate-create-plan', 'orchestrate-implement-plan']);

    const ephemeral = await mkdtemp(join(tmpdir(), 'agent-claude-skills-out-'));
    const result = await curateOrchestrateSkills({ sourceSkillRoot: sourceRoot, ephemeralSkillRoot: ephemeral });
    assert.deepStrictEqual(result.orchestrationSkillNames, ['orchestrate-create-plan', 'orchestrate-implement-plan']);
    const body = await readFile(join(ephemeral, 'orchestrate-implement-plan', 'SKILL.md'), 'utf8');
    assert.match(body, /orchestrate-implement-plan/);
    await assert.rejects(() => readFile(join(ephemeral, 'review', 'SKILL.md'), 'utf8'));
  });
});

describe('Claude harness config builder', () => {
  it('builds a system prompt that uses MCP polling for run supervision, references only the agent-orchestrator MCP server, and lists curated orchestrate-* skill names', () => {
    const monitorPin = resolveMonitorPin({ AGENT_ORCHESTRATOR_BIN: '/opt/agent-orchestrator' });
    const catalog = createWorkerCapabilityCatalog(null);
    const config = buildClaudeHarnessConfig({
      targetCwd: '/tmp/work',
      manifestPath: '/tmp/work/profiles.json',
      ephemeralSkillRoot: '/tmp/skills',
      orchestrationSkillNames: ['orchestrate-create-plan', 'orchestrate-implement-plan'],
      catalog,
      profileDiagnostics: [],
      mcpCliPath: '/opt/agent-orchestrator/dist/cli.js',
      monitorPin,
    });
    assert.match(config.systemPrompt, /agent-orchestrator/);
    assert.match(config.systemPrompt, /orchestrate-create-plan/);
    assert.match(config.systemPrompt, /wait_for_any_run/);
    // Bash-background-monitor is intentionally NOT taught in the prompt because
    // Bash is not exposed inside the envelope. The standalone CLI prefix is
    // mentioned only as an "out-of-envelope" pointer.
    assert.match(config.systemPrompt, /standalone CLI is:.*\/opt\/agent-orchestrator monitor <run_id>/);
    assert.match(config.systemPrompt, /Bash is not available inside the envelope/);
    assert.equal(/Bash run_in_background/i.test(config.systemPrompt), false, 'system prompt must not instruct supervisor to use Bash run_in_background');
    assert.deepStrictEqual(Object.keys(config.mcpConfig.mcpServers), [CLAUDE_MCP_SERVER_NAME]);
    const mcpJson = stringifyClaudeMcpConfig(config.mcpConfig);
    JSON.parse(mcpJson);
  });
});

describe('Claude launcher envelope', () => {
  it('builds an isolated envelope: --strict-mcp-config + --tools "Read,Glob,Grep" (no Bash), no --add-dir, no --dangerously-skip-permissions, no --disable-slash-commands, no --allowed-tools', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-claude-launch-'));
    const skillsPath = join(cwd, '.agents', 'skills');
    await mkdir(join(skillsPath, 'orchestrate-foo'), { recursive: true });
    await writeFile(join(skillsPath, 'orchestrate-foo', 'SKILL.md'), '---\nname: orchestrate-foo\n---\nbody');
    const profilesPath = join(cwd, 'profiles.json');
    await writeFile(profilesPath, JSON.stringify({ version: 1, profiles: { 'p1': { backend: 'claude', model: 'claude-opus-4-7' } } }));

    const parsed = parseClaudeLauncherArgs(
      ['--cwd', cwd, '--profiles-file', profilesPath, '--skills', skillsPath],
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
      const settings = JSON.parse(built.settingsContent);
      assert.equal(settings.enableAllProjectMcpServers, false);
      assert.ok(Array.isArray(settings.permissions.allow));
      assert.ok(settings.permissions.deny.includes('Bash'), 'settings.deny must include Bash for defense in depth');
      const mcp = JSON.parse(built.mcpConfigContent);
      assert.deepStrictEqual(Object.keys(mcp.mcpServers), [CLAUDE_MCP_SERVER_NAME]);
      assert.ok(built.spawnArgs.includes('--strict-mcp-config'), 'spawn args must include --strict-mcp-config');
      assert.ok(!built.spawnArgs.includes('--dangerously-skip-permissions'), 'spawn args must never include --dangerously-skip-permissions');
      assert.ok(!built.spawnArgs.includes('--disable-slash-commands'), 'spawn args must not include --disable-slash-commands (would also disable orchestrate-* skills)');
      assert.ok(!built.spawnArgs.includes('--add-dir'), 'spawn args must NOT include --add-dir: Claude scans add-dir paths for project skills/commands/agents/hooks/CLAUDE.md, which would re-introduce target workspace .claude/* leakage');
      assert.ok(!built.spawnArgs.includes('--allowed-tools'), 'spawn args must NOT include --allowed-tools: it only pre-approves, it does not restrict availability — built-in availability is constrained via --tools instead');
      assert.ok(built.spawnArgs.includes('--tools'), 'spawn args must restrict built-in tool availability via --tools');
      const toolsValue = built.spawnArgs[built.spawnArgs.indexOf('--tools') + 1] ?? '';
      assert.equal(toolsValue, 'Read,Glob,Grep', '--tools must contain only Read,Glob,Grep (no Bash, Edit, Write, etc.)');
      assert.equal(built.spawnEnv.HOME, join(built.envelopeDir, 'home'));
      assert.equal(built.spawnEnv.XDG_CONFIG_HOME, join(built.envelopeDir, 'xdg-config'));
      assert.equal(built.spawnEnv.CLAUDE_CONFIG_DIR, join(built.envelopeDir, 'claude-config'));
      // Skill curation: orchestrate-* lives at <envelope>/.claude/skills/<name>/SKILL.md so
      // Claude's cwd-rooted skill discovery can find them when the spawn cwd = envelopeDir.
      assert.equal(built.skillsRoot, join(built.envelopeDir, '.claude', 'skills'));
      const curated = await readFile(join(built.skillsRoot, 'orchestrate-foo', 'SKILL.md'), 'utf8');
      assert.match(curated, /orchestrate-foo/);
    } finally {
      await built.cleanup();
    }
    await assert.rejects(() => readFile(join(built.envelopeDir, 'settings.json'), 'utf8'));
  });

  it('buildClaudeSpawnArgs sets the canonical isolation flags and excludes any leak-prone or pre-approval flags', () => {
    const args = buildClaudeSpawnArgs({
      settingsPath: '/x/settings.json',
      mcpConfigPath: '/x/mcp.json',
      systemPromptPath: '/x/system.md',
      builtinTools: ['Read', 'Glob', 'Grep'],
      passthrough: ['--print', '--output-format', 'json'],
    });
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--mcp-config'));
    assert.ok(args.includes('--settings'));
    assert.ok(args.includes('--setting-sources'));
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    assert.ok(args.includes('--append-system-prompt-file'));
    assert.ok(args.includes('--tools'));
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.ok(!args.includes('--disable-slash-commands'), '--disable-slash-commands would also disable skills; harness must not set it');
    assert.ok(!args.includes('--add-dir'), '--add-dir would scan target workspace for project skills/commands/agents/hooks; harness must not set it');
    assert.ok(!args.includes('--allowed-tools'), '--allowed-tools only pre-approves; it must not be the restriction surface');
    assert.deepStrictEqual(args.slice(-3), ['--print', '--output-format', 'json'], 'passthrough args appended last');
  });
});

describe('Claude launcher leak-proof tests', () => {
  it('does not load poisoned project-level .claude/* or .mcp.json from the target workspace and exposes only orchestrate-* skills', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-claude-leak-'));
    await writeFile(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { evil: { command: 'evil' } } }));
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['*'] } }));
    await mkdir(join(cwd, '.claude', 'skills', 'evil-skill'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'skills', 'evil-skill', 'SKILL.md'), '---\nname: evil\n---\n');
    await mkdir(join(cwd, '.claude', 'commands'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'commands', 'evil.md'), 'evil');
    await mkdir(join(cwd, '.claude', 'agents'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'agents', 'evil-agent.md'), 'evil');
    await mkdir(join(cwd, '.claude', 'hooks'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'hooks', 'evil.sh'), '#!/bin/sh\n');
    const skillsPath = join(cwd, '.agents', 'skills');
    await mkdir(join(skillsPath, 'orchestrate-good'), { recursive: true });
    await writeFile(join(skillsPath, 'orchestrate-good', 'SKILL.md'), '---\nname: orchestrate-good\n---\n');
    // Pre-existing non-orchestrate skill in the same source root must not leak.
    await mkdir(join(skillsPath, 'review'), { recursive: true });
    await writeFile(join(skillsPath, 'review', 'SKILL.md'), '---\nname: review\n---\n');

    const parsed = parseClaudeLauncherArgs(['--cwd', cwd, '--skills', skillsPath], {}, cwd);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const built = await buildClaudeEnvelope({
      options: parsed.value,
      env: {},
      catalog: createWorkerCapabilityCatalog(null),
      profilesResult: { profiles: undefined, diagnostics: [] },
    });
    try {
      // MCP server allowlist is exactly the agent-orchestrator server.
      const mcp = JSON.parse(built.mcpConfigContent);
      assert.deepStrictEqual(Object.keys(mcp.mcpServers), [CLAUDE_MCP_SERVER_NAME]);
      assert.ok(!('evil' in mcp.mcpServers));
      const settings = JSON.parse(built.settingsContent);
      assert.equal(settings.enableAllProjectMcpServers, false);
      // Setting sources is empty so user/project/local settings.json files are not loaded.
      assert.ok(built.spawnArgs.includes('--setting-sources'));
      const settingSourcesValue = built.spawnArgs[built.spawnArgs.indexOf('--setting-sources') + 1];
      assert.equal(settingSourcesValue, '');
      // Curated skills root contains orchestrate-good only.
      const curated = await readFile(join(built.skillsRoot, 'orchestrate-good', 'SKILL.md'), 'utf8');
      assert.match(curated, /orchestrate-good/);
      await assert.rejects(() => readFile(join(built.skillsRoot, 'evil-skill', 'SKILL.md'), 'utf8'));
      await assert.rejects(() => readFile(join(built.skillsRoot, 'review', 'SKILL.md'), 'utf8'));
      // The envelope's .claude/ contains only the curated skills directory; no commands, agents, or hooks.
      const projectClaude = join(built.envelopeDir, '.claude');
      const entries = (await readFile(join(projectClaude, 'skills', 'orchestrate-good', 'SKILL.md'), 'utf8'));
      assert.match(entries, /orchestrate-good/);
      await assert.rejects(() => readFile(join(projectClaude, 'commands', 'evil.md'), 'utf8'));
      await assert.rejects(() => readFile(join(projectClaude, 'agents', 'evil-agent.md'), 'utf8'));
      await assert.rejects(() => readFile(join(projectClaude, 'hooks', 'evil.sh'), 'utf8'));
      await assert.rejects(() => readFile(join(projectClaude, 'settings.json'), 'utf8'));
      await assert.rejects(() => readFile(join(built.envelopeDir, '.mcp.json'), 'utf8'));
      // No --add-dir: Claude Code scans add-dir paths for project .claude/skills,
      // .claude/commands, .claude/agents, .claude/hooks and CLAUDE.md, so passing
      // --add-dir <target> would re-introduce the leak this test is guarding
      // against. The supervisor reads the target workspace only indirectly, by
      // dispatching worker runs with cwd = target via mcp__agent-orchestrator__start_run.
      assert.ok(!built.spawnArgs.includes('--add-dir'), 'harness must not pass --add-dir; would leak target .claude/* into discovery');
      // No --allowed-tools (it only pre-approves; doesn't restrict availability).
      assert.ok(!built.spawnArgs.includes('--allowed-tools'), 'harness must not rely on --allowed-tools to restrict availability');
      // --tools restricts built-in availability to read-only tools.
      assert.equal(built.spawnArgs[built.spawnArgs.indexOf('--tools') + 1], 'Read,Glob,Grep');
      // settings.deny includes Bash (defense in depth, in case --tools semantics ever loosen).
      assert.ok(settings.permissions.deny.includes('Bash'), 'settings.deny must include Bash');
      // HOME, XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR are redirected so user-level state is unreachable.
      assert.notEqual(built.spawnEnv.HOME, process.env.HOME);
      assert.equal(built.spawnEnv.HOME, join(built.envelopeDir, 'home'));
      assert.equal(built.spawnEnv.CLAUDE_CONFIG_DIR, join(built.envelopeDir, 'claude-config'));
      // System prompt clarifies that Bash is unavailable and points to the standalone monitor CLI for user shells.
      const promptText = built.systemPrompt;
      assert.match(promptText, /Bash is not available inside the envelope/);
      assert.match(promptText, /standalone CLI is:.* monitor <run_id>/);
      assert.equal(/Bash run_in_background/i.test(promptText), false, 'prompt must not instruct supervisor to use Bash run_in_background');
    } finally {
      await built.cleanup();
    }
  });
});
