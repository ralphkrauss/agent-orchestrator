import { constants } from 'node:fs';
import { access, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface ProjectSkills {
  root: string;
  roots: string[];
  orchestrationSkills: string[];
}

export async function loadProjectSkills(projectSkillRoot: string, options: {
  ensureRoot?: boolean;
} = {}): Promise<ProjectSkills> {
  if (options.ensureRoot) {
    await ensureProjectSkillRoot(projectSkillRoot);
  }
  const projectSkills = await readProjectSkillNames(projectSkillRoot);
  return {
    root: projectSkillRoot,
    roots: [projectSkillRoot],
    orchestrationSkills: projectSkills.filter((name) => name.startsWith('orchestrate-')),
  };
}

export async function ensureProjectSkillRoot(projectSkillRoot: string): Promise<void> {
  await mkdir(projectSkillRoot, { recursive: true });
}

async function readProjectSkillNames(projectSkillRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(projectSkillRoot, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(projectSkillRoot, entry.name, 'SKILL.md');
      try {
        await access(skillFile, constants.R_OK);
        names.push(entry.name);
      } catch (error) {
        const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
        if (code !== 'ENOENT') throw error;
      }
    }
    return names.sort();
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') return [];
    throw error;
  }
}
