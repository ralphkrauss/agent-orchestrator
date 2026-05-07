import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fallbackName = '@ralphkrauss/agent-orchestrator';
const fallbackVersion = 'unknown';

export interface PackageMetadata {
  name: string;
  version: string;
}

let cached: PackageMetadata | null = null;

export function getPackageMetadata(): PackageMetadata {
  cached ??= readPackageMetadata();
  return cached;
}

export function getPackageVersion(): string {
  return getPackageMetadata().version;
}

export function formatVersionOutput(binName: string, json: boolean): string {
  const meta = getPackageMetadata();
  if (json) {
    return `${JSON.stringify({ name: meta.name, version: meta.version })}\n`;
  }
  return `${binName} ${meta.version}\n`;
}

function readPackageMetadata(): PackageMetadata {
  const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
    return {
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : fallbackName,
      version: typeof parsed.version === 'string' && parsed.version ? parsed.version : fallbackVersion,
    };
  } catch {
    return { name: fallbackName, version: fallbackVersion };
  }
}
