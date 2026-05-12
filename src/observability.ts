import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  isTerminalStatus,
  ObservabilitySnapshotSchema,
  type BackendStatusReport,
  type ObservabilityActivity,
  type ObservabilityArtifact,
  type ObservabilityModel,
  type ObservabilityOrchestratorGroup,
  type ObservabilityOrchestratorWorker,
  type ObservabilityPrompt,
  type ObservabilityResponse,
  type ObservabilityRun,
  type ObservabilityRunSettings,
  type ObservabilitySession,
  type ObservabilitySessionAudit,
  type ObservabilitySessionPrompt,
  type ObservabilityWorkspace,
  type RunMeta,
  type RunStatus,
  type OrchestratorRecord,
  type OrchestratorStatusSnapshot,
} from './contract.js';
import type { RunStore } from './runStore.js';

interface EventSummary {
  event_count: number;
  last_event: ObservabilityActivity['recent_events'][number] | null;
  recent_events: ObservabilityActivity['recent_events'];
}

export interface BuildObservabilitySnapshotOptions {
  limit: number;
  includePrompts: boolean;
  recentEventLimit: number;
  daemonPid?: number | null;
  backendStatus?: BackendStatusReport | null;
  liveOrchestrators?: readonly LiveOrchestratorSnapshot[];
}

export interface LiveOrchestratorSnapshot {
  record: OrchestratorRecord;
  status: OrchestratorStatusSnapshot;
}

export async function buildObservabilitySnapshot(
  store: RunStore,
  options: BuildObservabilitySnapshotOptions,
) {
  const allMetas = await store.listRuns();
  const metas = allMetas.slice(0, options.limit);
  const runs: ObservabilityRun[] = [];
  for (const meta of metas) {
    const eventSummary = await store.readEventSummary(meta.run_id, Math.max(options.recentEventLimit, 20));
    const promptText = await store.readPrompt(meta.run_id);
    runs.push({
      run: meta,
      prompt: await buildPrompt(store, meta, promptText, options.includePrompts),
      response: await buildResponse(store, meta.run_id, eventSummary),
      model: buildModel(meta),
      settings: buildSettings(meta),
      session: buildSessionAudit(meta),
      activity: buildActivity(meta, eventSummary, options.recentEventLimit),
      artifacts: await buildArtifacts(store, meta.run_id),
      duration_seconds: durationSeconds(meta),
    });
  }

  const sessions = buildSessions(runs, allMetas);
  const orchestrators = buildOrchestratorGroups(runs, allMetas, options.liveOrchestrators ?? []);
  return ObservabilitySnapshotSchema.parse({
    generated_at: new Date().toISOString(),
    daemon_pid: options.daemonPid ?? null,
    store_root: store.root,
    sessions,
    runs,
    orchestrators,
    backend_status: options.backendStatus ?? null,
  });
}

async function buildPrompt(
  store: RunStore,
  meta: RunMeta,
  promptText: string | null,
  includePrompt: boolean,
): Promise<ObservabilityPrompt> {
  const path = store.promptPath(meta.run_id);
  const promptInfo = await fileInfo(path);
  const preview = promptPreview(promptText);
  const title = meta.display.prompt_title ?? previewOrRunId(preview, meta.run_id);
  return {
    title,
    summary: meta.display.prompt_summary,
    preview,
    text: includePrompt ? promptText : null,
    path: promptInfo.exists ? path : null,
    bytes: promptInfo.bytes,
  };
}

async function buildResponse(store: RunStore, runId: string, events: EventSummary): Promise<ObservabilityResponse> {
  const result = await store.loadResult(runId);
  const path = store.resultPath(runId);
  const info = await fileInfo(path);
  const resultSummary = result?.summary.trim() ? result.summary : null;
  return {
    status: result?.status ?? null,
    summary: resultSummary ?? lastAssistantMessage(events.recent_events),
    path: info.exists ? path : null,
    bytes: info.bytes,
  };
}

function buildModel(meta: RunMeta): ObservabilityModel {
  const requestedName = meta.model;
  const observedName = meta.observed_model;
  return {
    name: observedName ?? requestedName,
    source: meta.model_source,
    requested_name: requestedName,
    observed_name: observedName,
  };
}

function buildSettings(meta: RunMeta): ObservabilityRunSettings {
  return meta.model_settings;
}

function buildSessionAudit(meta: RunMeta): ObservabilitySessionAudit {
  const requested = meta.requested_session_id;
  const observed = meta.observed_session_id;
  const effective = observed ?? meta.session_id;
  const warnings: string[] = [];
  let status: ObservabilitySessionAudit['status'];

  if (requested && observed && requested !== observed) {
    status = 'mismatch';
    warnings.push(`requested session ${requested} but backend reported ${observed}`);
  } else if (requested && observed === requested) {
    status = 'resumed';
  } else if (requested && !observed) {
    status = 'pending';
    if (isTerminalStatus(meta.status)) {
      warnings.push(`backend did not report resumed session ${requested}`);
    }
  } else if (observed || meta.session_id) {
    status = 'new_session';
  } else {
    status = 'pending';
  }

  if (meta.model && meta.observed_model && meta.model !== meta.observed_model) {
    warnings.push(`requested model ${meta.model} but backend reported ${meta.observed_model}`);
  }

  return {
    requested_session_id: requested,
    observed_session_id: observed,
    effective_session_id: effective,
    status,
    warnings,
  };
}

function buildActivity(meta: RunMeta, summary: EventSummary, recentEventLimit: number): ObservabilityActivity {
  const recentEvents = recentEventLimit === 0 ? [] : summary.recent_events.slice(-recentEventLimit);
  return {
    last_event_sequence: summary.last_event?.seq ?? summary.event_count,
    last_event_at: summary.last_event?.ts ?? null,
    last_event_type: summary.last_event?.type ?? null,
    last_activity_at: meta.last_activity_at,
    last_activity_source: meta.last_activity_source,
    idle_seconds: idleSeconds(meta),
    last_interaction_preview: lastInteractionPreview(summary.recent_events),
    event_count: summary.event_count,
    recent_errors: recentErrors(summary.recent_events),
    recent_events: recentEvents,
    latest_error: meta.latest_error,
  };
}

async function buildArtifacts(store: RunStore, runId: string): Promise<ObservabilityArtifact[]> {
  return Promise.all(store.defaultArtifacts(runId).map(async (artifact) => {
    const info = await fileInfo(artifact.path);
    return {
      name: artifact.name,
      path: artifact.path,
      exists: info.exists,
      bytes: info.bytes,
    };
  }));
}

interface SessionStats {
  session_id: string | null;
  run_count: number;
  running_count: number;
}

function buildSessions(runs: ObservabilityRun[], allMetas: RunMeta[]): ObservabilitySession[] {
  const byRunId = new Map(runs.map((run) => [run.run.run_id, run]));
  const metaByRunId = new Map(allMetas.map((meta) => [meta.run_id, meta]));
  const stats = buildSessionStats(allMetas, metaByRunId);
  const groups = new Map<string, ObservabilityRun[]>();
  for (const run of runs) {
    const key = sessionKey(run.run, metaByRunId);
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }

  const sessions = Array.from(groups.entries()).map(([sessionKeyValue, group]) => {
    const chronological = group.slice().sort((a, b) => a.run.created_at.localeCompare(b.run.created_at));
    const root = rootRun(chronological[0]!, byRunId);
    const sessionStats = stats.get(sessionKeyValue);
    const updatedAt = maxIso(group.map(latestObservedAt));
    const runningCount = sessionStats?.running_count ?? group.filter((run) => run.run.status === 'running').length;
    const status = sessionStatus(group);
    const latestSessionSummary = lastNonNull(chronological.map((run) => run.run.display.session_summary));
    const title = root.run.display.session_title ?? root.prompt.title;
    const prompts = chronological.map(sessionPrompt);
    return {
      session_key: sessionKeyValue,
      session_id: sessionStats?.session_id ?? firstNonNull(group.map((run) => run.session.effective_session_id)),
      root_run_id: root.run.run_id,
      backend: root.run.backend,
      cwd: root.run.cwd,
      workspace: buildWorkspace(root),
      title,
      summary: latestSessionSummary,
      status,
      created_at: chronological[0]!.run.created_at,
      updated_at: updatedAt,
      run_count: sessionStats?.run_count ?? group.length,
      running_count: runningCount,
      models: uniqueModels(group.map((run) => run.model)),
      settings: uniqueSettings(group.map((run) => run.settings)),
      warnings: Array.from(new Set(group.flatMap((run) => run.session.warnings))),
      prompts,
    };
  });

  return sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function buildSessionStats(allMetas: RunMeta[], metaByRunId: Map<string, RunMeta>): Map<string, SessionStats> {
  const groups = new Map<string, RunMeta[]>();
  for (const meta of allMetas) {
    const key = sessionKey(meta, metaByRunId);
    const group = groups.get(key) ?? [];
    group.push(meta);
    groups.set(key, group);
  }

  const stats = new Map<string, SessionStats>();
  for (const [key, group] of groups) {
    stats.set(key, {
      session_id: firstNonNull(group.map((meta) => buildSessionAudit(meta).effective_session_id)),
      run_count: group.length,
      running_count: group.filter((meta) => meta.status === 'running').length,
    });
  }
  return stats;
}

function buildWorkspace(root: ObservabilityRun): ObservabilityWorkspace {
  const snapshot = root.run.git_snapshot;
  const repositoryRoot = snapshot?.root ?? null;
  const branch = snapshot?.branch ?? null;
  const repositoryName = repositoryRoot ? repositoryNameFromRoot(repositoryRoot, branch) : null;
  const dirtyCount = snapshot?.dirty_count ?? null;
  const dirtySuffix = dirtyCount !== null && dirtyCount > 0 ? '*' : '';
  let label: string;

  if (repositoryName && branch) {
    label = `${repositoryName}:${branch}${dirtySuffix}`;
  } else if (repositoryName && snapshot?.sha) {
    label = `${repositoryName}@${snapshot.sha.slice(0, 7)}${dirtySuffix}`;
  } else if (repositoryName) {
    label = `${repositoryName}${dirtySuffix}`;
  } else {
    label = compactFolder(root.run.cwd);
  }

  return {
    cwd: root.run.cwd,
    repository_root: repositoryRoot,
    repository_name: repositoryName,
    branch,
    dirty_count: dirtyCount,
    label,
  };
}

function buildOrchestratorGroups(
  runs: ObservabilityRun[],
  allMetas: RunMeta[],
  liveOrchestrators: readonly LiveOrchestratorSnapshot[],
): ObservabilityOrchestratorGroup[] {
  const detailedRunsByOrchestrator = new Map<string, ObservabilityRun[]>();
  for (const run of runs) {
    const orchestratorId = orchestratorIdFromMetadata(run.run.metadata);
    if (!orchestratorId) continue;
    const group = detailedRunsByOrchestrator.get(orchestratorId) ?? [];
    group.push(run);
    detailedRunsByOrchestrator.set(orchestratorId, group);
  }

  const metasByOrchestrator = new Map<string, RunMeta[]>();
  for (const meta of allMetas) {
    const orchestratorId = orchestratorIdFromMetadata(meta.metadata);
    if (!orchestratorId) continue;
    const group = metasByOrchestrator.get(orchestratorId) ?? [];
    group.push(meta);
    metasByOrchestrator.set(orchestratorId, group);
  }

  const liveIds = new Set(liveOrchestrators.map((orchestrator) => orchestrator.record.id));
  const liveGroups = liveOrchestrators.map((orchestrator) => {
    const detailedRuns = sortRunsChronologically(detailedRunsByOrchestrator.get(orchestrator.record.id) ?? []);
    const metas = metasByOrchestrator.get(orchestrator.record.id) ?? [];
    const updatedAt = maxIso([
      orchestrator.record.last_supervisor_event_at,
      ...detailedRuns.map(latestObservedAt),
      ...metas.map(latestMetaObservedAt),
      orchestrator.record.registered_at,
    ].filter((value): value is string => typeof value === 'string'));
    return {
      orchestrator_id: orchestrator.record.id,
      live: true,
      client: orchestrator.record.client,
      label: orchestrator.record.label,
      cwd: orchestrator.record.cwd,
      display: orchestrator.record.display,
      status: orchestrator.status,
      registered_at: orchestrator.record.registered_at,
      last_supervisor_event_at: orchestrator.record.last_supervisor_event_at,
      created_at: orchestrator.record.registered_at,
      updated_at: updatedAt,
      worker_count: metas.length,
      running_count: orchestrator.status.running_child_count,
      workers: detailedRuns.map(orchestratorWorker),
    } satisfies ObservabilityOrchestratorGroup;
  });

  const archiveGroups: ObservabilityOrchestratorGroup[] = [];
  for (const [orchestratorId, metas] of metasByOrchestrator) {
    if (liveIds.has(orchestratorId)) continue;
    const detailedRuns = sortRunsChronologically(detailedRunsByOrchestrator.get(orchestratorId) ?? []);
    if (detailedRuns.length === 0) continue;
    archiveGroups.push({
      orchestrator_id: orchestratorId,
      live: false,
      client: null,
      label: archivedOrchestratorLabel(detailedRuns, orchestratorId),
      cwd: detailedRuns[0]?.run.cwd ?? metas[0]?.cwd ?? '',
      display: null,
      status: null,
      registered_at: null,
      last_supervisor_event_at: null,
      created_at: minIso(metas.map((meta) => meta.created_at)),
      updated_at: maxIso(metas.map(latestMetaObservedAt)),
      worker_count: metas.length,
      running_count: metas.filter((meta) => !isTerminalStatus(meta.status)).length,
      workers: detailedRuns.map(orchestratorWorker),
    });
  }

  return [
    ...liveGroups.sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    ...archiveGroups.sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
  ];
}

function orchestratorWorker(run: ObservabilityRun): ObservabilityOrchestratorWorker {
  return {
    run_id: run.run.run_id,
    parent_run_id: run.run.parent_run_id,
    backend: run.run.backend,
    status: run.run.status,
    title: run.prompt.title,
    summary: run.prompt.summary,
    preview: run.prompt.preview,
    model: run.model,
    settings: run.settings,
    created_at: run.run.created_at,
    last_activity_at: latestObservedAt(run),
  };
}

function sortRunsChronologically(runs: ObservabilityRun[]): ObservabilityRun[] {
  return runs.slice().sort((a, b) => a.run.created_at.localeCompare(b.run.created_at));
}

function archivedOrchestratorLabel(runs: ObservabilityRun[], orchestratorId: string): string {
  const titles = runs.map((run) => run.run.display.session_title ?? run.prompt.title).filter((title) => title.trim());
  const title = lastNonNull(titles);
  return title ?? `orchestrator ${orchestratorId.slice(0, 8)}`;
}

function orchestratorIdFromMetadata(metadata: Record<string, unknown> | undefined): string | null {
  const value = metadata?.orchestrator_id;
  return typeof value === 'string' && value.trim() ? value : null;
}

function latestMetaObservedAt(meta: RunMeta): string {
  return maxIso([
    meta.last_activity_at,
    meta.finished_at,
    meta.started_at,
    meta.created_at,
  ].filter((value): value is string => typeof value === 'string'));
}

function compactFolder(cwd: string): string {
  const leaf = basename(cwd);
  const parent = basename(dirname(cwd));
  if (parent && leaf && parent !== leaf) return `${parent}/${leaf}`;
  return leaf || cwd;
}

function repositoryNameFromRoot(root: string, branch: string | null): string {
  const rootName = basename(root);
  const parent = basename(dirname(root));
  if (branch && rootName === branch && parent.startsWith('worktrees-')) {
    return parent.slice('worktrees-'.length);
  }
  return rootName;
}

function sessionPrompt(run: ObservabilityRun): ObservabilitySessionPrompt {
  return {
    run_id: run.run.run_id,
    status: run.run.status,
    title: run.prompt.title,
    summary: run.prompt.summary,
    preview: run.prompt.preview,
    model: run.model,
    settings: run.settings,
    created_at: run.run.created_at,
    last_activity_at: latestObservedAt(run),
  };
}

function latestObservedAt(run: ObservabilityRun): string {
  return maxIso([
    run.activity.last_activity_at,
    run.activity.last_event_at,
    run.run.finished_at,
    run.run.started_at,
    run.run.created_at,
  ].filter((value): value is string => typeof value === 'string'));
}

function sessionKey(meta: RunMeta, byRunId: Map<string, RunMeta>): string {
  const session = buildSessionAudit(meta);
  if (session.effective_session_id) return `${meta.backend}:${session.effective_session_id}`;
  return `${meta.backend}:root:${rootMeta(meta, byRunId).run_id}`;
}

function rootRun(run: ObservabilityRun, byRunId: Map<string, ObservabilityRun>): ObservabilityRun {
  let current = run;
  const seen = new Set<string>();
  while (current.run.parent_run_id && !seen.has(current.run.run_id)) {
    seen.add(current.run.run_id);
    const parent = byRunId.get(current.run.parent_run_id);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function rootMeta(meta: RunMeta, byRunId: Map<string, RunMeta>): RunMeta {
  let current = meta;
  const seen = new Set<string>();
  while (current.parent_run_id && !seen.has(current.run_id)) {
    seen.add(current.run_id);
    const parent = byRunId.get(current.parent_run_id);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function sessionStatus(group: ObservabilityRun[]): RunStatus {
  if (group.some((run) => run.run.status === 'running')) return 'running';
  const latest = group.slice().sort((a, b) =>
    (b.run.finished_at ?? b.run.started_at ?? b.run.created_at).localeCompare(a.run.finished_at ?? a.run.started_at ?? a.run.created_at))[0];
  return latest?.run.status ?? 'completed';
}

function uniqueModels(models: ObservabilityModel[]): ObservabilityModel[] {
  const seen = new Set<string>();
  const result: ObservabilityModel[] = [];
  for (const model of models) {
    const key = `${model.name ?? ''}:${model.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}

function uniqueSettings(settings: ObservabilityRunSettings[]): ObservabilityRunSettings[] {
  const seen = new Set<string>();
  const result: ObservabilityRunSettings[] = [];
  for (const item of settings) {
    const key = `${item.reasoning_effort ?? ''}:${item.service_tier ?? ''}:${item.mode ?? ''}:${item.codex_network ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function durationSeconds(meta: RunMeta): number | null {
  const start = Date.parse(meta.started_at ?? meta.created_at);
  if (!Number.isFinite(start)) return null;
  const end = meta.finished_at ? Date.parse(meta.finished_at) : Date.now();
  if (!Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function idleSeconds(meta: RunMeta): number | null {
  if (meta.status !== 'running' || !meta.last_activity_at) return null;
  const lastActivity = Date.parse(meta.last_activity_at);
  if (!Number.isFinite(lastActivity)) return null;
  return Math.max(0, Math.round((Date.now() - lastActivity) / 1000));
}

async function fileInfo(path: string): Promise<{ exists: boolean; bytes: number | null }> {
  try {
    const info = await stat(path);
    return { exists: true, bytes: info.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, bytes: null };
    }
    throw error;
  }
}

function promptPreview(promptText: string | null): string {
  if (!promptText) return '';
  return compactText(promptText, 160);
}

function previewOrRunId(preview: string, runId: string): string {
  return preview || runId;
}

function lastInteractionPreview(events: ObservabilityActivity['recent_events']): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const preview = eventPreview(events[index]!);
    if (preview) return preview;
  }
  return null;
}

function lastAssistantMessage(events: ObservabilityActivity['recent_events']): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== 'assistant_message') continue;
    const text = stringFromRecord(event.payload, 'text') ?? stringFromRecord(event.payload, 'message') ?? '';
    if (text) return text;
  }
  return null;
}

function recentErrors(events: ObservabilityActivity['recent_events']): string[] {
  const errors: string[] = [];
  for (let index = events.length - 1; index >= 0 && errors.length < 5; index -= 1) {
    const event = events[index]!;
    if (event.type === 'error') {
      errors.push(eventPreview(event) ?? 'worker error');
      continue;
    }
    const payloadErrors = Array.isArray(event.payload.errors) ? event.payload.errors : [];
    for (const item of payloadErrors) {
      const message = stringFromRecord(item, 'message');
      if (message) errors.push(message);
      if (errors.length >= 5) break;
    }
  }
  return errors.reverse();
}

function eventPreview(event: ObservabilityActivity['recent_events'][number]): string | null {
  if (event.type === 'assistant_message') {
    return compactText(stringFromRecord(event.payload, 'text') ?? stringFromRecord(event.payload, 'message') ?? '', 160) || null;
  }
  if (event.type === 'tool_use') {
    const name = stringFromRecord(event.payload, 'name') ?? stringFromRecord(event.payload, 'tool_name') ?? stringFromRecord(event.payload, 'type') ?? 'tool';
    const command = stringFromRecord(event.payload, 'command') ?? commandFromInput(event.payload.input);
    return command ? `${name}: ${compactText(command, 120)}` : name;
  }
  if (event.type === 'error') {
    return compactText(stringFromRecord(event.payload, 'text') ?? stringFromRecord(event.payload, 'message') ?? JSON.stringify(event.payload), 160);
  }
  if (event.type === 'lifecycle') {
    const status = stringFromRecord(event.payload, 'status') ?? stringFromRecord(event.payload, 'state') ?? stringFromRecord(event.payload, 'subtype');
    return status ? `lifecycle: ${status}` : null;
  }
  return null;
}

function commandFromInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  return stringFromRecord(input as Record<string, unknown>, 'command');
}

function stringFromRecord(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const raw = rec[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function firstNonNull<T>(values: (T | null | undefined)[]): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function lastNonNull<T>(values: (T | null | undefined)[]): T | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function maxIso(values: string[]): string {
  return values.reduce((current, value) => value.localeCompare(current) > 0 ? value : current, values[0] ?? new Date(0).toISOString());
}

function minIso(values: string[]): string {
  return values.reduce((current, value) => value.localeCompare(current) < 0 ? value : current, values[0] ?? new Date(0).toISOString());
}
