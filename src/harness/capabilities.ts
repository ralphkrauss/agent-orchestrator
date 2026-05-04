import { z } from 'zod';
import { validateClaudeModelAndEffort } from '../backend/claudeValidation.js';
import type { BackendStatusReport } from '../contract.js';

export interface WorkerBackendCapability {
  backend: string;
  display_name: string;
  available: boolean;
  availability_status: string;
  supports_start: boolean;
  supports_resume: boolean;
  requires_model: boolean;
  settings: {
    reasoning_efforts: string[];
    service_tiers: string[];
    variants: string[];
  };
  notes: string[];
}

export interface WorkerCapabilityCatalog {
  generated_at: string;
  backends: WorkerBackendCapability[];
}

export const WorkerProfileSchema = z.object({
  backend: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  variant: z.string().trim().min(1).optional(),
  reasoning_effort: z.string().trim().min(1).optional(),
  service_tier: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>;

export const WorkerProfileManifestSchema = z.object({
  version: z.literal(1).optional().default(1),
  profiles: z.record(WorkerProfileSchema),
}).strict();
export type WorkerProfileManifest = z.output<typeof WorkerProfileManifestSchema>;

export interface ValidatedWorkerProfile extends WorkerProfile {
  id: string;
  capability: WorkerBackendCapability;
}

export interface ValidatedWorkerProfiles {
  manifest: WorkerProfileManifest;
  profiles: Record<string, ValidatedWorkerProfile>;
}

export interface InvalidWorkerProfile {
  id: string;
  backend: string | null;
  description: string | null;
  errors: string[];
}

export interface InspectedWorkerProfiles extends ValidatedWorkerProfiles {
  invalid_profiles: Record<string, InvalidWorkerProfile>;
  errors: string[];
}

export function createWorkerCapabilityCatalog(statusReport?: BackendStatusReport | null): WorkerCapabilityCatalog {
  const diagnostics = new Map((statusReport?.backends ?? []).map((backend) => [backend.name, backend]));
  const generatedAt = new Date().toISOString();
  return {
    generated_at: generatedAt,
    backends: [
      {
        backend: 'codex',
        display_name: 'Codex CLI',
        ...availabilityFor('codex', diagnostics.get('codex')?.status),
        supports_start: true,
        supports_resume: true,
        requires_model: true,
        settings: {
          reasoning_efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
          service_tiers: ['fast', 'flex', 'normal'],
          variants: [],
        },
        notes: ['Models are user-defined; the backend validates CLI availability and supported settings.'],
      },
      {
        backend: 'claude',
        display_name: 'Claude CLI',
        ...availabilityFor('claude', diagnostics.get('claude')?.status),
        supports_start: true,
        supports_resume: true,
        requires_model: true,
        settings: {
          reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          service_tiers: [],
          variants: [],
        },
        notes: ['Use direct Claude model ids; aliases such as opus or sonnet can drift.'],
      },
      {
        backend: 'cursor',
        display_name: 'Cursor SDK',
        ...availabilityFor('cursor', diagnostics.get('cursor')?.status),
        supports_start: true,
        supports_resume: true,
        requires_model: true,
        settings: {
          reasoning_efforts: [],
          service_tiers: [],
          variants: [],
        },
        notes: [
          'Uses the @cursor/sdk module in-process (local runtime only); cloud and self-hosted runtimes are out of scope for this release.',
          'Sessions persist as Cursor agent ids; follow-ups call Agent.resume(agentId).',
          'Tokens are billed to your Cursor account.',
          'reasoning_effort and service_tier are rejected for cursor in this release.',
        ],
      },
    ],
  };
}

export function parseWorkerProfileManifest(value: unknown): { ok: true; value: WorkerProfileManifest } | { ok: false; errors: string[] } {
  const parsed = WorkerProfileManifestSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`) };
  }
  return { ok: true, value: parsed.data };
}

export function validateWorkerProfiles(
  manifest: WorkerProfileManifest,
  catalog: WorkerCapabilityCatalog,
): { ok: true; value: ValidatedWorkerProfiles } | { ok: false; errors: string[] } {
  const inspected = inspectWorkerProfiles(manifest, catalog);
  return inspected.errors.length > 0
    ? { ok: false, errors: inspected.errors }
    : { ok: true, value: { manifest: inspected.manifest, profiles: inspected.profiles } };
}

export function inspectWorkerProfiles(
  manifest: WorkerProfileManifest,
  catalog: WorkerCapabilityCatalog,
): InspectedWorkerProfiles {
  const errors: string[] = [];
  const capabilities = new Map(catalog.backends.map((capability) => [capability.backend, capability]));
  const profiles: Record<string, ValidatedWorkerProfile> = {};
  const invalid_profiles: Record<string, InvalidWorkerProfile> = {};

  if (Object.keys(manifest.profiles).length === 0) {
    errors.push('profiles must contain at least one worker profile');
  }

  for (const [profileId, profile] of Object.entries(manifest.profiles)) {
    if (!isSafeId(profileId)) {
      const message = `profile id ${JSON.stringify(profileId)} must use letters, numbers, dots, underscores, or hyphens`;
      errors.push(message);
      invalid_profiles[profileId] = invalidProfile(profileId, profile, [message]);
      continue;
    }
    const capability = capabilities.get(profile.backend);
    if (!capability) {
      const message = `profile ${profileId} references unknown backend ${profile.backend}`;
      errors.push(message);
      invalid_profiles[profileId] = invalidProfile(profileId, profile, [message]);
      continue;
    }
    const profileErrors = validateProfile(profileId, profile, capability);
    errors.push(...profileErrors);
    if (profileErrors.length === 0) {
      profiles[profileId] = { id: profileId, ...profile, capability };
    } else {
      invalid_profiles[profileId] = invalidProfile(profileId, profile, profileErrors);
    }
  }

  return { manifest, profiles, invalid_profiles, errors };
}

function availabilityFor(backend: string, status: string | undefined): Pick<WorkerBackendCapability, 'available' | 'availability_status'> {
  const availability = status ?? 'not_checked';
  return {
    available: availability === 'available' || availability === 'auth_unknown' || availability === 'not_checked',
    availability_status: availability,
  };
}

function validateProfile(profileId: string, profile: WorkerProfile, capability: WorkerBackendCapability): string[] {
  const errors: string[] = [];
  if (!capability.available) {
    errors.push(`profile ${profileId} uses unavailable backend ${profile.backend} (${capability.availability_status})`);
  }
  if (capability.requires_model && !profile.model) {
    errors.push(`profile ${profileId} requires an explicit model`);
  }
  if (profile.reasoning_effort && !capability.settings.reasoning_efforts.includes(profile.reasoning_effort)) {
    errors.push(`profile ${profileId} uses unsupported reasoning_effort ${profile.reasoning_effort} for backend ${profile.backend}`);
  }
  if (profile.service_tier && !capability.settings.service_tiers.includes(profile.service_tier)) {
    errors.push(`profile ${profileId} uses unsupported service_tier ${profile.service_tier} for backend ${profile.backend}`);
  }
  if (profile.variant && !capability.settings.variants.includes(profile.variant)) {
    errors.push(`profile ${profileId} uses unsupported variant ${profile.variant} for backend ${profile.backend}`);
  }
  errors.push(...validateBackendSpecificProfile(profileId, profile));
  return errors;
}

function validateBackendSpecificProfile(profileId: string, profile: WorkerProfile): string[] {
  if (profile.backend === 'codex') return validateCodexProfile(profileId, profile);
  if (profile.backend === 'cursor') return validateCursorProfile(profileId, profile);
  if (profile.backend !== 'claude') return [];

  const error = validateClaudeModelAndEffort(profile.model, profile.reasoning_effort);
  return error ? [`profile ${profileId}: ${error}`] : [];
}

function validateCursorProfile(profileId: string, profile: WorkerProfile): string[] {
  const errors: string[] = [];
  if (profile.reasoning_effort) {
    errors.push(`profile ${profileId} sets reasoning_effort which the cursor backend rejects in this release`);
  }
  if (profile.service_tier) {
    errors.push(`profile ${profileId} sets service_tier which the cursor backend rejects`);
  }
  return errors;
}

function validateCodexProfile(profileId: string, profile: WorkerProfile): string[] {
  if (profile.model?.includes('/')) {
    return [`profile ${profileId} must use a Codex CLI model id, not provider-prefixed model ${profile.model}`];
  }
  return [];
}

function invalidProfile(profileId: string, profile: WorkerProfile, errors: string[]): InvalidWorkerProfile {
  return {
    id: profileId,
    backend: profile.backend || null,
    description: profile.description ?? null,
    errors,
  };
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}
