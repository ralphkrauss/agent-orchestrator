import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { createWorkerCapabilityCatalog, validateWorkerProfiles, type WorkerProfileManifest } from '../opencode/capabilities.js';
import { buildOpenCodeHarnessConfig } from '../opencode/config.js';
import { openCodeLauncherHelp, parseOpenCodeLauncherArgs, runOpenCodeLauncher } from '../opencode/launcher.js';
import { loadProjectSkills } from '../opencode/skills.js';

describe('OpenCode orchestration harness', () => {
  it('loads orchestrate-* skills from the shared project skill root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-opencode-skills-'));
    const projectSkillRoot = join(root, '.agents', 'skills');

    try {
      await mkdir(join(projectSkillRoot, 'orchestrate-review'), { recursive: true });
      await writeFile(join(projectSkillRoot, 'orchestrate-review', 'SKILL.md'), [
        '---',
        'name: orchestrate-review',
        'description: Project-owned review orchestration',
        '---',
        '# Project Review',
      ].join('\n'));
      await mkdir(join(projectSkillRoot, 'create-pr'), { recursive: true });
      await writeFile(join(projectSkillRoot, 'create-pr', 'SKILL.md'), [
        '---',
        'name: create-pr',
        'description: Normal worker skill',
        '---',
        '# Create PR',
      ].join('\n'));
      await mkdir(join(projectSkillRoot, 'orchestrate-empty'), { recursive: true });

      const loaded = await loadProjectSkills(projectSkillRoot);

      assert.equal(loaded.root, projectSkillRoot);
      assert.deepStrictEqual(loaded.roots, [projectSkillRoot]);
      assert.deepStrictEqual(loaded.orchestrationSkills, ['orchestrate-review']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('builds one supervisor config with shared skills and scoped setup writes', () => {
    const profiles = validProfiles();
    const config = buildOpenCodeHarnessConfig({
      targetCwd: '/repo',
      skillRoots: ['/repo/.agents/skills'],
      skillRoot: '/repo/.agents/skills',
      mcpCliPath: '/pkg/dist/cli.js',
      orchestratorModel: 'anthropic/claude-sonnet-4-6',
      orchestratorSmallModel: 'openai/gpt-5.4-mini',
      profiles,
      profileDiagnostics: [],
      orchestrationSkillNames: ['orchestrate-review'],
      catalog: createWorkerCapabilityCatalog(),
      manifestPath: '/repo/.agents/orchestration/profiles.json',
    });

    assert.equal(config.default_agent, 'agent-orchestrator');
    assert.equal(config.model, 'anthropic/claude-sonnet-4-6');
    assert.equal(config.small_model, 'openai/gpt-5.4-mini');
    assert.deepStrictEqual(config.skills.paths, ['/repo/.agents/skills']);
    assert.deepStrictEqual(config.mcp.github, { enabled: false });
    assert.deepStrictEqual(config.mcp.gh, { enabled: false });

    const agent = config.agent['agent-orchestrator'] as { prompt: string; permission: Record<string, unknown> };
    assert.equal(Object.keys(agent.permission)[0], '*');
    assert.deepStrictEqual(Object.keys(agent.permission.skill as Record<string, string>), ['*', 'orchestrate-*']);
    assert.deepStrictEqual(agent.permission.skill, { '*': 'deny', 'orchestrate-*': 'allow' });
    assert.deepStrictEqual(agent.permission.edit, {
      '*': 'deny',
      '/repo/.agents/orchestration/profiles.json': 'allow',
      '.agents/orchestration/profiles.json': 'allow',
      '/repo/.agents/skills/orchestrate-*/SKILL.md': 'allow',
      '.agents/skills/orchestrate-*/SKILL.md': 'allow',
    });
    assert.deepStrictEqual(Object.keys(agent.permission.edit as Record<string, string>), [
      '*',
      '/repo/.agents/orchestration/profiles.json',
      '.agents/orchestration/profiles.json',
      '/repo/.agents/skills/orchestrate-*/SKILL.md',
      '.agents/skills/orchestrate-*/SKILL.md',
    ]);
    assert.deepStrictEqual(agent.permission.external_directory, {
      '*': 'deny',
      '/repo/.agents/orchestration/profiles.json': 'allow',
    });
    assert.equal(agent.permission.bash, 'deny');
    assert.match(agent.prompt, /Target workspace: \/repo/);
    assert.match(agent.prompt, /Shared skill root relative to workspace: \.agents\/skills/);
    assert.match(agent.prompt, /Profiles manifest status:\n- valid/);
    assert.match(agent.prompt, /reviewer: backend=claude, model=claude-opus-4-7/);
    assert.match(agent.prompt, /orchestrate-review/);
    assert.match(agent.prompt, /Writable profiles manifest path: \/repo\/\.agents\/orchestration\/profiles\.json/);
    assert.match(agent.prompt, /start_run with profile plus profiles_file/);
    assert.match(agent.prompt, /must reference profile aliases, not raw model names/);
    assert.match(agent.prompt, /Run supervision decision rules for OpenCode/);
    assert.match(agent.prompt, /OpenCode does not use Bash, Bash run_in_background, or the monitor CLI/);
    assert.match(agent.prompt, /MCP tools are the only supervision path/);
    assert.match(agent.prompt, /mcp__agent-orchestrator__get_run_progress first/);
    assert.match(agent.prompt, /For current-turn waiting, use mcp__agent-orchestrator__wait_for_any_run/);
    assert.match(agent.prompt, /For cross-turn reconciliation, use mcp__agent-orchestrator__list_run_notifications/);
    assert.match(agent.prompt, /wait_for_run only as a compatibility fallback/);
    assert.doesNotMatch(agent.prompt, /monitor <run_id> --json-line/);
    assert.match(agent.prompt, /first check-in around 30 seconds/);
    assert.match(agent.prompt, /Use get_run_events only when raw events are explicitly needed/);
    assert.match(agent.prompt, /latest_error is fatal/);
    assert.match(agent.prompt, /10-15 minute ceiling/);
    assert.match(agent.prompt, /idle_timeout_seconds/);
    assert.match(agent.prompt, /Direct bash\/shell execution is disabled/);
  });

  it('builds a supervisor config that can explain missing profile setup', () => {
    const config = buildOpenCodeHarnessConfig({
      targetCwd: '/repo',
      skillRoots: ['/repo/.agents/skills'],
      skillRoot: '/repo/.agents/skills',
      mcpCliPath: '/pkg/dist/cli.js',
      profileDiagnostics: ['Worker profiles manifest not found: /repo/.agents/orchestration/profiles.json. Provide a valid profiles file or --profiles-json before starting worker runs.'],
      orchestrationSkillNames: [],
      catalog: createWorkerCapabilityCatalog(),
      manifestPath: '/repo/.agents/orchestration/profiles.json',
    });

    const agent = config.agent['agent-orchestrator'] as { prompt: string; permission: Record<string, unknown> };
    assert.match(agent.prompt, /No validated profiles loaded/);
    assert.match(agent.prompt, /Project-owned orchestrate-\* skills currently found:\n- none yet/);
    assert.match(agent.prompt, /You may create or update only the writable profiles manifest path/);
    assert.match(agent.prompt, /Create or update orchestration skills as \.agents\/skills\/orchestrate-\{name\}\/SKILL\.md/);
  });

  it('allows user-level profiles manifest writes by absolute and relative paths', () => {
    const config = buildOpenCodeHarnessConfig({
      targetCwd: '/home/tester/repo',
      skillRoots: ['/home/tester/repo/.agents/skills'],
      skillRoot: '/home/tester/repo/.agents/skills',
      mcpCliPath: '/pkg/dist/cli.js',
      profileDiagnostics: ['missing'],
      orchestrationSkillNames: [],
      catalog: createWorkerCapabilityCatalog(),
      manifestPath: '/home/tester/.config/agent-orchestrator/profiles.json',
    });

    const agent = config.agent['agent-orchestrator'] as { permission: Record<string, unknown> };
    assert.deepStrictEqual(agent.permission.edit, {
      '*': 'deny',
      '/home/tester/.config/agent-orchestrator/profiles.json': 'allow',
      '../.config/agent-orchestrator/profiles.json': 'allow',
      '/home/tester/repo/.agents/skills/orchestrate-*/SKILL.md': 'allow',
      '.agents/skills/orchestrate-*/SKILL.md': 'allow',
    });
    assert.deepStrictEqual(agent.permission.external_directory, {
      '*': 'deny',
      '/home/tester/.config/agent-orchestrator/profiles.json': 'allow',
    });
  });

  it('allows out-of-workspace orchestration skill writes by exact skill pattern only', () => {
    const config = buildOpenCodeHarnessConfig({
      targetCwd: '/home/tester/repo',
      skillRoots: ['/home/tester/shared-skills'],
      skillRoot: '/home/tester/shared-skills',
      mcpCliPath: '/pkg/dist/cli.js',
      profileDiagnostics: ['missing'],
      orchestrationSkillNames: [],
      catalog: createWorkerCapabilityCatalog(),
      manifestPath: '/home/tester/.config/agent-orchestrator/profiles.json',
    });

    const agent = config.agent['agent-orchestrator'] as { permission: Record<string, unknown> };
    assert.deepStrictEqual(agent.permission.edit, {
      '*': 'deny',
      '/home/tester/.config/agent-orchestrator/profiles.json': 'allow',
      '../.config/agent-orchestrator/profiles.json': 'allow',
      '/home/tester/shared-skills/orchestrate-*/SKILL.md': 'allow',
    });
    assert.deepStrictEqual(agent.permission.external_directory, {
      '*': 'deny',
      '/home/tester/.config/agent-orchestrator/profiles.json': 'allow',
      '/home/tester/shared-skills/orchestrate-*/SKILL.md': 'allow',
    });
  });

  it('surfaces unreadable project skill files during discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-opencode-skills-'));
    const projectSkillRoot = join(root, '.agents', 'skills');
    const skillFile = join(projectSkillRoot, 'orchestrate-broken', 'SKILL.md');

    try {
      await mkdir(join(projectSkillRoot, 'orchestrate-broken'), { recursive: true });
      await writeFile(skillFile, '# Broken\n');
      await chmod(skillFile, 0o000);

      await assert.rejects(
        loadProjectSkills(projectSkillRoot),
        /EACCES|permission denied/i,
      );
    } finally {
      await chmod(skillFile, 0o600).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates the shared skill root before launching OpenCode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-opencode-setup-'));
    const stub = join(root, 'opencode-stub.mjs');
    const invocationFile = join(root, 'invocation.json');
    const stdout = captureStream();
    const stderr = captureStream();

    try {
      await writeFile(stub, [
        '#!/usr/bin/env node',
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(invocationFile)}, JSON.stringify({`,
        '  cwd: process.cwd(),',
        '  argv: process.argv.slice(2),',
        '  config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),',
        '}));',
      ].join('\n'));
      await chmod(stub, 0o755);

      const code = await runOpenCodeLauncher([
        '--cwd',
        root,
        '--manifest',
        '.agents/orchestration/profiles.json',
        '--opencode-binary',
        stub,
        '--',
        'run',
        'configure profiles',
      ], {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: process.env,
      });

      assert.equal(code, 0);
      assert.equal(existsSync(join(root, '.agents', 'skills')), true);
      assert.equal(existsSync(join(root, '.agents', 'orchestration')), true);

      const invocation = JSON.parse(await readFile(invocationFile, 'utf8')) as {
        cwd: string;
        argv: string[];
        config: { default_agent: string; agent: Record<string, { prompt: string; permission: Record<string, unknown> }> };
      };
      assert.equal(invocation.cwd, await realpath(root));
      assert.deepStrictEqual(invocation.argv, ['run', '--agent', 'agent-orchestrator', 'configure profiles']);
      assert.equal(invocation.config.default_agent, 'agent-orchestrator');
      assert.match(invocation.config.agent['agent-orchestrator']?.prompt ?? '', /Worker profiles manifest not found/);
      assert.deepStrictEqual(invocation.config.agent['agent-orchestrator']?.permission.edit, {
        '*': 'deny',
        [join(root, '.agents', 'orchestration', 'profiles.json')]: 'allow',
        '.agents/orchestration/profiles.json': 'allow',
        [join(root, '.agents', 'skills', 'orchestrate-*', 'SKILL.md')]: 'allow',
        '.agents/skills/orchestrate-*/SKILL.md': 'allow',
      });
      assert.deepStrictEqual(invocation.config.agent['agent-orchestrator']?.permission.external_directory, {
        '*': 'deny',
        [join(root, '.agents', 'orchestration', 'profiles.json')]: 'allow',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('parses launcher options, setup alias, cwd, and passthrough args', () => {
    const parsed = parseOpenCodeLauncherArgs([
      'setup',
      '--cwd',
      'repo',
      '--manifest',
      'profiles.json',
      '--skills',
      '.agents/skills',
      '--orchestrator-model',
      'openai/gpt-5.5',
      '--',
      'run',
      'configure profiles',
    ], {}, '/tmp');

    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.value.cwd, resolve('/tmp/repo'));
    assert.equal(parsed.ok && parsed.value.profilesFile, resolve('/tmp/repo/profiles.json'));
    assert.equal(parsed.ok && parsed.value.manifestPath, resolve('/tmp/repo/profiles.json'));
    assert.equal(parsed.ok && parsed.value.skillsPath, resolve('/tmp/repo/.agents/skills'));
    assert.equal(parsed.ok && parsed.value.orchestratorModel, 'openai/gpt-5.5');
    assert.deepStrictEqual(parsed.ok && parsed.value.opencodeArgs, ['run', 'configure profiles']);
  });

  it('treats --manifest as a true profiles-file alias', () => {
    const parsed = parseOpenCodeLauncherArgs([
      '--manifest',
      'cli-profiles.json',
    ], {
      AGENT_ORCHESTRATOR_OPENCODE_PROFILES_FILE: '/env/profiles.json',
    }, '/tmp/workspace');

    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.value.profilesFile, '/tmp/workspace/cli-profiles.json');
    assert.equal(parsed.ok && parsed.value.manifestPath, '/tmp/workspace/cli-profiles.json');
  });

  it('defaults profiles to the user config directory', () => {
    const parsed = parseOpenCodeLauncherArgs([], {
      HOME: '/home/tester',
    }, '/repo');

    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.value.profilesFile, '/home/tester/.config/agent-orchestrator/profiles.json');
    assert.equal(parsed.ok && parsed.value.manifestPath, '/home/tester/.config/agent-orchestrator/profiles.json');
    assert.equal(parsed.ok && parsed.value.skillsPath, resolve('/repo/.agents/skills'));
  });

  it('documents the canonical top-level OpenCode command first', () => {
    const help = openCodeLauncherHelp();

    assert.match(help, /^agent-orchestrator opencode/);
    assert.match(help, /agent-orchestrator opencode \[options\]/);
    assert.match(help, /agent-orchestrator-opencode \[options\]/);
  });

  it('rejects malformed inline profile JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-opencode-harness-'));
    const stdout = captureStream();
    const stderr = captureStream();

    try {
      const code = await runOpenCodeLauncher(['--cwd', root, '--profiles-json', '{'], {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: process.env,
      });

      assert.equal(code, 1);
      assert.match(stderr.value(), /Invalid --profiles-json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects inline profile JSON that fails manifest validation (matches the syntax-error fail-fast behavior)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-opencode-harness-bad-schema-'));
    const stdout = captureStream();
    const stderr = captureStream();
    try {
      // Manifest schema is strict; an unknown top-level field triggers
      // parseWorkerProfileManifest to reject the manifest.
      const badManifest = JSON.stringify({ version: 1, profiles: {}, unexpected: true });
      const code = await runOpenCodeLauncher(['--cwd', root, '--profiles-json', badManifest], {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: process.env,
      });
      assert.equal(code, 1, 'inline manifest validation errors must fail fast');
      assert.notEqual(stderr.value(), '', 'expected an error message on stderr');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects inline profile JSON that parses but fails inspectWorkerProfiles (semantic errors must also fail fast)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-opencode-harness-bad-inspect-'));
    const stdout = captureStream();
    const stderr = captureStream();
    try {
      // Schema is satisfied (the manifest parses), but the profile id contains
      // characters that inspectWorkerProfiles rejects, so this manifest fails
      // at semantic inspection rather than at parse time.
      const inspectFailureManifest = JSON.stringify({
        version: 1,
        profiles: {
          'bad id!': { backend: 'opencode', model: 'opencode-default' },
        },
      });
      const code = await runOpenCodeLauncher(['--cwd', root, '--profiles-json', inspectFailureManifest], {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: process.env,
      });
      assert.equal(code, 1, 'inline manifest inspection errors must fail fast');
      assert.notEqual(stderr.value(), '', 'expected an error message on stderr');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unsafe or non-session OpenCode passthrough', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-opencode-passthrough-'));
    const cases: Array<{ args: string[]; pattern: RegExp }> = [
      { args: ['mcp', '--help'], pattern: /rejected subcommand mcp/ },
      { args: ['--agent=build'], pattern: /rejected option --agent=build/ },
      { args: ['run'], pattern: /requires run to be followed by a positional prompt/ },
      { args: ['run', '--attach', 'session-id'], pattern: /rejected option --attach/ },
      { args: ['run', '--dir=/tmp', 'prompt'], pattern: /rejected option --dir=\/tmp/ },
      { args: ['run', '--dangerously-skip-permissions=true', 'prompt'], pattern: /rejected option --dangerously-skip-permissions=true/ },
      { args: ['run', '--share', 'prompt'], pattern: /rejected option --share/ },
      { args: ['run', '--command', 'test'], pattern: /rejected option --command/ },
      { args: ['run', '--session', 'ses_123', 'prompt'], pattern: /rejected option --session/ },
      { args: ['run', '--file', 'secret.txt', 'prompt'], pattern: /rejected option --file/ },
    ];

    try {
      for (const testCase of cases) {
        const stdout = captureStream();
        const stderr = captureStream();
        const code = await runOpenCodeLauncher(['--cwd', root, '--print-config', '--', ...testCase.args], {
          stdout: stdout.stream,
          stderr: stderr.stream,
          env: process.env,
        });

        assert.equal(code, 1, testCase.args.join(' '));
        assert.match(stderr.value(), testCase.pattern);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('points launcher option errors to the canonical top-level help command', async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runOpenCodeLauncher(['--unknown'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: process.env,
    });

    assert.equal(code, 1);
    assert.match(stderr.value(), /Unknown option: --unknown/);
    assert.match(stderr.value(), /Run agent-orchestrator opencode --help/);
  });
});

function validProfiles() {
  const manifest: WorkerProfileManifest = {
    version: 1,
    profiles: {
      implementer: {
        backend: 'codex',
        model: 'gpt-5.5',
        reasoning_effort: 'high',
      },
      reviewer: {
        backend: 'claude',
        model: 'claude-opus-4-7',
        reasoning_effort: 'xhigh',
      },
    },
  };
  const result = validateWorkerProfiles(manifest, createWorkerCapabilityCatalog());
  assert.equal(result.ok, true);
  return result.ok ? result.value : assert.fail('profile validation failed');
}

function captureStream(): { stream: Writable; value: () => string } {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }),
    value: () => chunks.join(''),
  };
}
