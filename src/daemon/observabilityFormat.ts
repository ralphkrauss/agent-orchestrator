import { basename, dirname } from 'node:path';
import type {
  ObservabilityOrchestratorGroup,
  ObservabilityRun,
  ObservabilityRunSettings,
  ObservabilitySession,
  ObservabilitySnapshot,
} from '../contract.js';

export interface SnapshotEnvelope {
  running: boolean;
  snapshot: ObservabilitySnapshot;
  error?: string;
}

export function formatSnapshot(envelope: SnapshotEnvelope): string {
  const { snapshot } = envelope;
  const live = liveOrchestrators(snapshot);
  const archive = archiveOrchestrators(snapshot);
  const lines = [
    `agent-orchestrator daemon: ${envelope.running ? `running pid=${snapshot.daemon_pid ?? 'unknown'}` : 'stopped'}`,
    `store: ${snapshot.store_root}`,
    `generated: ${snapshot.generated_at}`,
  ];
  if (envelope.error) lines.push(`error: ${envelope.error}`);

  lines.push('', `live_orchestrators: ${live.length} archived_orchestrators: ${archive.length} sessions: ${snapshot.sessions.length} runs: ${snapshot.runs.length}`, '');
  if (live.length > 0) {
    lines.push('Live orchestrators');
    for (const group of live) lines.push(...formatOrchestratorSummary(group));
    lines.push('');
  }
  if (archive.length > 0) {
    lines.push('Archived orchestrators');
    for (const group of archive.slice(0, 10)) lines.push(...formatOrchestratorSummary(group));
    lines.push('');
  }
  if (snapshot.sessions.length === 0) {
    lines.push('No runs recorded.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('Sessions');
  for (const session of snapshot.sessions) {
    lines.push(`- ${session.title} [${session.status}] agent=${session.backend} model=${formatLatestModel(session)} effort=${formatLatestEffort(session)} tier=${formatLatestTier(session)} prompts=${session.run_count} workspace=${formatWorkspace(session)} updated=${session.updated_at}`);
    if (session.summary) lines.push(`  ${session.summary}`);
    if (session.session_id) lines.push(`  session=${session.session_id}`);
    for (const prompt of session.prompts.slice(-5)) {
      lines.push(`  - ${prompt.title} [${prompt.status}] model=${formatModel(prompt.model)} effort=${formatSetting(prompt.settings.reasoning_effort)} tier=${formatTier(prompt.settings)} last=${formatTimestamp(prompt.last_activity_at)}`);
    }
    for (const warning of session.warnings) lines.push(`  warning: ${warning}`);
  }

  lines.push('', 'Runs');
  for (const run of snapshot.runs) lines.push(formatRunLine(run));
  return `${lines.join('\n')}\n`;
}

function formatOrchestratorSummary(group: ObservabilityOrchestratorGroup): string[] {
  const status = group.status?.state ?? (group.live ? 'live' : 'archived');
  const lines = [
    `- ${group.label} [${status}] id=${group.orchestrator_id} workers=${group.worker_count} running=${group.running_count} cwd=${compactPath(group.cwd)} updated=${group.updated_at}`,
  ];
  if (group.display?.tmux_pane || group.display?.tmux_window_id) {
    lines.push(`  display=${[group.display.tmux_pane, group.display.tmux_window_id].filter(Boolean).join(' ')}`);
  }
  for (const worker of group.workers.slice(-5)) {
    lines.push(`  - ${worker.title} [${worker.status}] ${worker.run_id} last=${formatTimestamp(worker.last_activity_at)}`);
  }
  return lines;
}

function liveOrchestrators(snapshot: ObservabilitySnapshot): ObservabilityOrchestratorGroup[] {
  return snapshot.orchestrators.filter((group) => group.live && group.status?.state !== 'stale');
}

function archiveOrchestrators(snapshot: ObservabilitySnapshot): ObservabilityOrchestratorGroup[] {
  return snapshot.orchestrators.filter((group) => !group.live || group.status?.state === 'stale');
}

function formatRunLine(run: ObservabilityRun): string {
  const latestError = run.activity.latest_error ? ` latest_error=${run.activity.latest_error.category}:${run.activity.latest_error.message}` : '';
  return `- ${run.prompt.title} [${run.run.status}] ${run.run.run_id} model=${formatModel(run.model)} effort=${formatSetting(run.settings.reasoning_effort)} tier=${formatTier(run.settings)} invocation=${formatInvocation(run)} session=${run.session.effective_session_id ?? 'none'} idle=${run.activity.idle_seconds === null ? 'n/a' : `${run.activity.idle_seconds}s`} events=${run.activity.event_count} response=${run.response.status ?? (run.run.status === 'running' ? 'pending' : 'missing')} size=${formatBytes(run.artifacts.reduce((sum, artifact) => sum + (artifact.bytes ?? 0), 0))}${latestError}`;
}

function formatModel(model: { name: string | null; source: string; requested_name?: string | null; observed_name?: string | null }): string {
  const name = model.name ?? 'default';
  if (model.requested_name && model.observed_name && model.requested_name !== model.observed_name) {
    return `${name} (${model.source}, requested ${model.requested_name})`;
  }
  return `${name} (${model.source})`;
}

function formatLatestModel(session: ObservabilitySession): string {
  return formatModel(session.models.at(-1) ?? { name: null, source: 'legacy_unknown' });
}

function formatLatestEffort(session: ObservabilitySession): string {
  return formatSetting(session.settings.at(-1)?.reasoning_effort ?? null);
}

function formatLatestTier(session: ObservabilitySession): string {
  return formatTier(session.settings.at(-1));
}

function formatSetting(value: string | null): string {
  return value ?? 'default';
}

function formatTier(settings: ObservabilityRunSettings | null | undefined): string {
  return settings?.service_tier ?? 'default';
}

function formatWorkspace(session: ObservabilitySession): string {
  const workspace = session.workspace;
  if (workspace.label) return workspace.label;
  if (workspace.repository_name && workspace.branch) return `${workspace.repository_name}:${workspace.branch}`;
  if (workspace.repository_name) return workspace.repository_name;
  return compactFolder(workspace.cwd);
}

function compactPath(path: string): string {
  return compactFolder(path);
}

function compactFolder(cwd: string): string {
  const leaf = basename(cwd);
  const parent = basename(dirname(cwd));
  if (parent && leaf && parent !== leaf) return `${parent}/${leaf}`;
  return leaf || cwd;
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'none';
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatInvocation(run: ObservabilityRun): string {
  const invocation = run.run.worker_invocation;
  if (!invocation) return 'unknown';
  return [invocation.command, ...invocation.args.map(shellQuote)].join(' ');
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
