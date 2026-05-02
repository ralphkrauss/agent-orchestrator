import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..', '..');

describe('workspace scripts', () => {
  it('lets an exported GITHUB_TOKEN satisfy the github profile when the secrets file has a blank template value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-mcp-secret-'));
    const secretsFile = join(root, 'mcp-secrets.env');
    await writeFile(secretsFile, 'GITHUB_TOKEN=\n', 'utf8');

    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, 'scripts', 'mcp-secret-bridge.mjs'),
        'github',
        '--',
        process.execPath,
        '-e',
        [
          "if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN !== 'dummy-exported-token') process.exit(3);",
          "if (process.env.GITHUB_TOKEN !== 'dummy-exported-token') process.exit(4);",
        ].join(''),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENT_ORCHESTRATOR_MCP_SECRETS_FILE: secretsFile,
          GITHUB_TOKEN: 'dummy-exported-token',
          GH_TOKEN: '',
          GITHUB_PERSONAL_ACCESS_TOKEN: '',
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });

  it('reports stale generated AI workspace projections without deleting them in check mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ai-workspace-'));
    await copyWorkspaceSyncScript(root);
    await writeCanonicalWorkspace(root);
    await writeStaleProjectionFiles(root);

    const result = spawnSync(process.execPath, [join(root, 'scripts', 'sync-ai-workspace.mjs'), '--check'], {
      encoding: 'utf8',
      cwd: root,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /AI workspace projections are out of sync:/);
    for (const stalePath of [
      '.claude/skills/removed-skill/SKILL.md',
      '.claude/rules/removed-rule.md',
      '.claude/agents/removed-agent.md',
      '.cursor/rules/removed-rule.mdc',
    ]) {
      assert.match(result.stderr, new RegExp(escapeRegExp(stalePath)));
      assert.equal(existsSync(join(root, stalePath)), true, `${stalePath} should not be deleted by --check`);
    }
  });
});

async function copyWorkspaceSyncScript(root: string): Promise<void> {
  await mkdir(join(root, 'scripts'), { recursive: true });
  await copyFile(join(repoRoot, 'scripts', 'sync-ai-workspace.mjs'), join(root, 'scripts', 'sync-ai-workspace.mjs'));
}

async function writeCanonicalWorkspace(root: string): Promise<void> {
  await mkdir(join(root, '.agents', 'skills', 'kept-skill'), { recursive: true });
  await mkdir(join(root, '.agents', 'rules'), { recursive: true });
  await mkdir(join(root, '.agents', 'agents'), { recursive: true });
  await writeFile(join(root, '.agents', 'skills', 'kept-skill', 'SKILL.md'), '# Kept Skill\n', 'utf8');
  await writeFile(join(root, '.agents', 'rules', 'kept-rule.md'), '# Kept Rule\n', 'utf8');
  await writeFile(join(root, '.agents', 'agents', 'kept-agent.md'), '# Kept Agent\n', 'utf8');

  const sync = spawnSync(process.execPath, [join(root, 'scripts', 'sync-ai-workspace.mjs')], {
    encoding: 'utf8',
    cwd: root,
  });
  assert.equal(sync.status, 0, sync.stderr);
}

async function writeStaleProjectionFiles(root: string): Promise<void> {
  const files = [
    join(root, '.claude', 'skills', 'removed-skill', 'SKILL.md'),
    join(root, '.claude', 'rules', 'removed-rule.md'),
    join(root, '.claude', 'agents', 'removed-agent.md'),
    join(root, '.cursor', 'rules', 'removed-rule.mdc'),
  ];
  for (const file of files) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'stale\n', 'utf8');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
