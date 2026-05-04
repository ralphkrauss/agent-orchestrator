export type AuthProviderId = 'cursor' | 'claude' | 'codex';
export type AuthProviderStatus = 'wired' | 'reserved';

export interface AuthValidation {
  ok: true;
}

export interface AuthValidationFailure {
  ok: false;
  reason: string;
}

export type AuthValidateResult = AuthValidation | AuthValidationFailure;

export interface AuthProvider {
  id: AuthProviderId;
  label: string;
  /** All env-var names the runtime accepts for this provider. */
  envVars: string[];
  /** The env-var name written/read by the auth CLI. */
  primaryEnvVar: string;
  helpUrl: string;
  status: AuthProviderStatus;
  /** Format-only validation; no network probes. */
  validate: (value: string) => AuthValidateResult;
}

const CURSOR_KEY_PATTERN = /^[A-Za-z0-9_\-:.]+$/;

function validateCursorKey(value: string): AuthValidateResult {
  const trimmed = value.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'value is empty' };
  }
  if (trimmed !== value) {
    return { ok: false, reason: 'value contains leading or trailing whitespace' };
  }
  if (/\s/.test(value)) {
    return { ok: false, reason: 'value contains whitespace' };
  }
  if (value.length < 16) {
    return { ok: false, reason: 'value is shorter than 16 characters; double-check the API key' };
  }
  if (value.length > 512) {
    return { ok: false, reason: 'value is longer than 512 characters; double-check the API key' };
  }
  if (!CURSOR_KEY_PATTERN.test(value)) {
    return { ok: false, reason: 'value contains characters outside [A-Za-z0-9_\\-:.]' };
  }
  return { ok: true };
}

function validateNonEmpty(value: string): AuthValidateResult {
  return value.trim() === '' ? { ok: false, reason: 'value is empty' } : { ok: true };
}

export const AUTH_PROVIDERS: readonly AuthProvider[] = [
  {
    id: 'cursor',
    label: 'Cursor',
    envVars: ['CURSOR_API_KEY'],
    primaryEnvVar: 'CURSOR_API_KEY',
    helpUrl: 'https://cursor.com/dashboard',
    status: 'wired',
    validate: validateCursorKey,
  },
  {
    id: 'claude',
    label: 'Claude',
    envVars: ['ANTHROPIC_API_KEY'],
    primaryEnvVar: 'ANTHROPIC_API_KEY',
    helpUrl: 'https://console.anthropic.com/',
    status: 'reserved',
    validate: validateNonEmpty,
  },
  {
    id: 'codex',
    label: 'Codex',
    envVars: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    primaryEnvVar: 'OPENAI_API_KEY',
    helpUrl: 'https://platform.openai.com/',
    status: 'reserved',
    validate: validateNonEmpty,
  },
] as const;

export function getProvider(id: string): AuthProvider | undefined {
  return AUTH_PROVIDERS.find((provider) => provider.id === id);
}

export function listProviderIds(): AuthProviderId[] {
  return AUTH_PROVIDERS.map((provider) => provider.id);
}
