import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OrchestratorRecordSchema, type OrchestratorRecord } from '../contract.js';

/**
 * Strict ULID grammar — Crockford base32, 26 chars, excludes I/L/O/U.
 * Mirrors the path-component sanitization used by the hook log path so a
 * malformed orchestrator id cannot escape `<store_root>/orchestrators/` via
 * `..` or absolute-path segments.
 */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function assertOrchestratorIdIsUlid(orchestratorId: string): void {
  if (!ULID_PATTERN.test(orchestratorId)) {
    throw new Error(`Invalid orchestrator id (expected ULID): ${JSON.stringify(orchestratorId)}`);
  }
}

/**
 * Sidecar files (issue #40, F5 / Assumption A7) let the supervisor's signal
 * CLI transparently re-register with the daemon after a daemon restart.
 *
 * Contents are the harness-owned `OrchestratorRecord` (id, client, label,
 * cwd, display). They live under `<store_root>/orchestrators/<id>.json` with
 * mode 0o600. Volatile fields (`registered_at`, `last_supervisor_event_at`)
 * are stored alongside the rest but are intentionally treated as best-effort
 * state, not durable identity.
 *
 * Threat model: the daemon and the supervisor CLI both run under the same
 * uid; sidecar files are not exposed to the model and cannot be authored
 * remotely. The supervisor CLI reads them only to re-register an id the
 * launcher already pinned via env, so a forged sidecar without a matching
 * `AGENT_ORCHESTRATOR_ORCH_ID` env is never read.
 */

export function orchestratorSidecarDir(storeRoot: string): string {
  return join(storeRoot, 'orchestrators');
}

export function orchestratorSidecarPath(storeRoot: string, orchestratorId: string): string {
  assertOrchestratorIdIsUlid(orchestratorId);
  return join(orchestratorSidecarDir(storeRoot), `${orchestratorId}.json`);
}

export async function writeOrchestratorSidecar(storeRoot: string, record: OrchestratorRecord): Promise<void> {
  assertOrchestratorIdIsUlid(record.id);
  await mkdir(orchestratorSidecarDir(storeRoot), { recursive: true, mode: 0o700 });
  const path = orchestratorSidecarPath(storeRoot, record.id);
  const body = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(path, body, { mode: 0o600 });
}

export async function readOrchestratorSidecar(storeRoot: string, orchestratorId: string): Promise<OrchestratorRecord | null> {
  // Refuse to read non-ULID ids rather than throw, so the signal CLI's
  // re-register fallback degrades to "no sidecar found" on corrupt env.
  if (!ULID_PATTERN.test(orchestratorId)) return null;
  const path = orchestratorSidecarPath(storeRoot, orchestratorId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = OrchestratorRecordSchema.safeParse(parsedJson);
  if (!parsed.success) return null;
  if (parsed.data.id !== orchestratorId) return null;
  return parsed.data;
}

export async function removeOrchestratorSidecar(storeRoot: string, orchestratorId: string): Promise<void> {
  if (!ULID_PATTERN.test(orchestratorId)) return;
  await rm(orchestratorSidecarPath(storeRoot, orchestratorId), { force: true });
}
