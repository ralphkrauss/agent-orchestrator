import { orchestratorError, type OrchestratorError, type RpcPolicyContext } from './contract.js';
import { resolveWorkerProfilesFile } from './workerRouting.js';

/**
 * When the MCP frontend is launched by a harness that pins the only writable
 * profiles manifest path (Claude supervisor harness), enforce that
 * upsert_worker_profile cannot write to any other path. This prevents the
 * supervisor from using upsert_worker_profile as a generic file-write
 * primitive against arbitrary locations.
 */
/**
 * Build the per-request IPC policy context the MCP frontend should attach to
 * tool calls. When the harness pins a writable profiles manifest path,
 * upsert_worker_profile carries the resolved pin through IPC so the daemon
 * write primitive enforces it as defense in depth, in addition to the
 * frontend's own pre-IPC check. The pin is resolved against the frontend's cwd
 * here so that frontend and daemon agree on the canonical path even when the
 * env value is a relative path. Tool calls without a relevant pin return
 * undefined so generic local clients keep current behavior.
 */
export function harnessPolicyContext(
  toolName: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): RpcPolicyContext | undefined {
  if (toolName !== 'upsert_worker_profile') return undefined;
  const pinned = env.AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE;
  if (!pinned) return undefined;
  return { writable_profiles_file: resolveWorkerProfilesFile(pinned, cwd, env) };
}

export function enforceWritableProfilesPolicy(
  toolName: string,
  args: unknown,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): OrchestratorError | null {
  if (toolName !== 'upsert_worker_profile') return null;
  const pinned = env.AGENT_ORCHESTRATOR_WRITABLE_PROFILES_FILE;
  if (!pinned) return null;
  const input = (args ?? {}) as { profiles_file?: unknown; cwd?: unknown };
  const requestedFile = typeof input.profiles_file === 'string' ? input.profiles_file : undefined;
  const requestedCwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const resolvedRequested = resolveWorkerProfilesFile(requestedFile, requestedCwd ?? cwd, env);
  const resolvedPinned = resolveWorkerProfilesFile(pinned, cwd, env);
  if (resolvedRequested !== resolvedPinned) {
    return orchestratorError(
      'INVALID_INPUT',
      `upsert_worker_profile is restricted to the harness-pinned profiles manifest (${resolvedPinned}); refusing to write ${resolvedRequested}`,
      { profiles_file: resolvedRequested, allowed_profiles_file: resolvedPinned },
    );
  }
  return null;
}
