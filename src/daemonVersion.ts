import { daemonVersionMismatchError, type OrchestratorError } from './contract.js';
import { getPackageVersion } from './packageMetadata.js';

export type DaemonVersionCheck =
  | { ok: true; daemon_version: string; daemon_pid: number | null }
  | { ok: false; error: OrchestratorError };

export function checkDaemonVersion(value: unknown, frontendVersion = getPackageVersion()): DaemonVersionCheck {
  const rec = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const daemonVersion = typeof rec.daemon_version === 'string' ? rec.daemon_version : null;
  const daemonPid = typeof rec.daemon_pid === 'number' ? rec.daemon_pid : null;
  if (daemonVersion !== frontendVersion) {
    return {
      ok: false,
      error: daemonVersionMismatchError({
        frontendVersion,
        daemonVersion,
        daemonPid,
      }),
    };
  }
  return { ok: true, daemon_version: daemonVersion, daemon_pid: daemonPid };
}
