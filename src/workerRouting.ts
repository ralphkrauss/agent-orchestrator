import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  inspectWorkerProfiles,
  parseWorkerProfileManifest,
  type InspectedWorkerProfiles,
  type InspectWorkerProfilesOptions,
  type ValidatedWorkerProfiles,
  type WorkerCapabilityCatalog,
} from './opencode/capabilities.js';

export function defaultWorkerProfilesFile(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME
    ? resolve(env.XDG_CONFIG_HOME)
    : join(env.HOME || homedir(), '.config');
  return join(configHome, 'agent-orchestrator', 'profiles.json');
}

export function resolveWorkerProfilesFile(
  profilesFile: string | undefined | null,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!profilesFile) return defaultWorkerProfilesFile(env);
  const expanded = profilesFile === '~' || profilesFile.startsWith('~/')
    ? join(env.HOME || homedir(), profilesFile.slice(2))
    : profilesFile;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export async function loadValidatedWorkerProfilesFromFile(
  profilesFile: string,
  catalog: WorkerCapabilityCatalog,
  options: InspectWorkerProfilesOptions = {},
): Promise<{ ok: true; profiles: ValidatedWorkerProfiles } | { ok: false; errors: string[] }> {
  const inspected = await loadInspectedWorkerProfilesFromFile(profilesFile, catalog, options);
  if (!inspected.ok) return inspected;
  if (inspected.profiles.errors.length > 0) return { ok: false, errors: inspected.profiles.errors };
  return {
    ok: true,
    profiles: {
      manifest: inspected.profiles.manifest,
      profiles: inspected.profiles.profiles,
    },
  };
}

export async function loadInspectedWorkerProfilesFromFile(
  profilesFile: string,
  catalog: WorkerCapabilityCatalog,
  options: InspectWorkerProfilesOptions = {},
): Promise<{ ok: true; profiles: InspectedWorkerProfiles } | { ok: false; errors: string[] }> {
  let raw: string;
  try {
    raw = await readFile(profilesFile, 'utf8');
  } catch (error) {
    return { ok: false, errors: [`Worker profiles manifest not found or unreadable: ${profilesFile}: ${error instanceof Error ? error.message : String(error)}`] };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    return { ok: false, errors: [`Worker profiles manifest is not valid JSON: ${profilesFile}: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const parsed = parseWorkerProfileManifest(value);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return { ok: true, profiles: inspectWorkerProfiles(parsed.value, catalog, options) };
}
