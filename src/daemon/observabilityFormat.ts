import { basename, dirname } from 'node:path';
import type { ObservabilityRun, ObservabilityRunSettings, ObservabilitySession, ObservabilitySnapshot } from '../contract.js';

export interface SnapshotEnvelope {
  running: boolean;
  snapshot: ObservabilitySnapshot;
  error?: string;
}

export interface DashboardState {
  view: 'sessions' | 'prompts' | 'detail';
  selectedSession: number;
  selectedPrompt: number;
}

export function formatSnapshot(envelope: SnapshotEnvelope): string {
  const { snapshot } = envelope;
  const lines = [
    `agent-orchestrator daemon: ${envelope.running ? `running pid=${snapshot.daemon_pid ?? 'unknown'}` : 'stopped'}`,
    `store: ${snapshot.store_root}`,
    `generated: ${snapshot.generated_at}`,
  ];
  if (envelope.error) lines.push(`error: ${envelope.error}`);

  lines.push('', `sessions: ${snapshot.sessions.length} runs: ${snapshot.runs.length}`, '');
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
      lines.push(`  - ${prompt.title} [${prompt.status}] model=${formatModel(prompt.model)} effort=${formatSetting(prompt.settings.reasoning_effort)} tier=${formatTier(prompt.settings)} last=${prompt.last_activity_at ?? 'none'}`);
    }
    for (const warning of session.warnings) lines.push(`  warning: ${warning}`);
  }

  lines.push('', 'Runs');
  for (const run of snapshot.runs) {
    lines.push(formatRunLine(run));
  }

  return `${lines.join('\n')}\n`;
}

export function renderDashboard(envelope: SnapshotEnvelope, state: DashboardState, width: number, height: number): string {
  const snapshot = envelope.snapshot;
  const lines = [
    `${style.bold('agent-orchestrator')} ${style.dim(envelope.running ? `running pid=${snapshot.daemon_pid ?? 'unknown'}` : 'stopped')} | ${snapshot.sessions.length} sessions | ${snapshot.runs.length} runs | ${snapshot.generated_at}`,
    renderViewState(snapshot, state),
    style.dim(renderKeyHint(snapshot, state)),
    '',
  ];
  if (envelope.error) lines.push(`error: ${envelope.error}`, '');

  if (state.view === 'sessions') {
    lines.push(...renderSessionList(snapshot.sessions, state.selectedSession));
  } else if (state.view === 'prompts') {
    lines.push(...renderPromptList(currentSession(snapshot, state), state.selectedPrompt));
  } else {
    lines.push(...renderRunDetail(currentRun(snapshot, state), width));
  }

  return `${lines.slice(0, Math.max(1, height - 1)).map((line) => fit(line, width)).join('\n')}\n`;
}

export function clampDashboardState(state: DashboardState, snapshot: ObservabilitySnapshot): DashboardState {
  const next = { ...state };
  next.selectedSession = clamp(next.selectedSession, 0, Math.max(0, snapshot.sessions.length - 1));
  const session = snapshot.sessions[next.selectedSession] ?? null;
  next.selectedPrompt = clamp(next.selectedPrompt, 0, Math.max(0, (session?.prompts.length ?? 1) - 1));
  if (!session && next.view !== 'sessions') next.view = 'sessions';
  return next;
}

function renderSessionList(sessions: ObservabilitySession[], selected: number): string[] {
  if (sessions.length === 0) return ['No runs recorded.'];
  const lines = [
    sectionTitle('Sessions'),
    style.dim(`  ${pad('AGENT', 7)} ${pad('STATUS', 10)} ${pad('PROMPTS', 7)} ${pad('MODEL', 22)} ${pad('EFFORT', 8)} ${pad('TIER', 8)} ${pad('WORKSPACE', 32)} CHAT`),
    style.dim(`  ${'-'.repeat(7)} ${'-'.repeat(10)} ${'-'.repeat(7)} ${'-'.repeat(22)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(32)} ${'-'.repeat(20)}`),
  ];
  sessions.forEach((session, index) => {
    lines.push(selectLine(index === selected, formatSessionRow(session)));
  });
  return lines;
}

function renderPromptList(session: ObservabilitySession | null, selected: number): string[] {
  if (!session) return ['No session selected.'];
  const shownText = session.prompts.length === session.run_count ? '' : ` shown=${session.prompts.length}`;
  const lines = [
    `Session: ${session.title} [${session.status}] prompts=${session.run_count}${shownText} workspace=${formatWorkspace(session)} updated=${session.updated_at}`,
  ];
  if (session.summary) lines.push(`Summary: ${session.summary}`);
  if (session.session_id) lines.push(`Session ID: ${session.session_id}`);
  for (const warning of session.warnings) lines.push(`Warning: ${warning}`);
  lines.push(
    '',
    sectionTitle('Prompts'),
    style.dim(`  ${pad('STATUS', 10)} ${pad('MODEL', 26)} ${pad('EFFORT', 8)} ${pad('TIER', 8)} ${pad('LAST', 19)} PROMPT`),
    style.dim(`  ${'-'.repeat(10)} ${'-'.repeat(26)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(19)} ${'-'.repeat(20)}`),
  );
  session.prompts.forEach((prompt, index) => {
    lines.push(selectLine(index === selected, `${statusCell(prompt.status, 10)} ${modelCell(formatModelCompact(prompt.model), 26)} ${settingsCell(formatSetting(prompt.settings.reasoning_effort), 8)} ${settingsCell(formatTier(prompt.settings), 8)} ${pad(formatTimestamp(prompt.last_activity_at), 19)} ${prompt.title}`));
  });
  return lines;
}

function formatSessionRow(session: ObservabilitySession): string {
  const warningText = session.warnings.length > 0 ? ` warnings=${session.warnings.length}` : '';
  return `${agentCell(session.backend, 7)} ${statusCell(session.status, 10)} ${pad(String(session.run_count), 7)} ${modelCell(formatLatestModel(session), 22)} ${settingsCell(formatLatestEffort(session), 8)} ${settingsCell(formatLatestTier(session), 8)} ${workspaceCell(formatWorkspace(session), 32)} ${session.title}${warningText}`;
}

function renderRunDetail(run: ObservabilityRun | null, width: number): string[] {
  if (!run) return ['No run selected.'];
  const lines = [
    sectionTitle('Prompt Detail'),
    detailLine('Run', run.run.run_id),
    detailLine('Title', run.prompt.title),
    `${style.bold('Status')}: ${colorStatus(run.run.status)}`,
    detailLine('Agent', run.run.backend),
    detailLine('Model', formatModel(run.model)),
    detailLine('Reasoning', formatSetting(run.settings.reasoning_effort)),
    detailLine('Service Tier', formatTier(run.settings)),
    detailLine('Invocation', formatInvocation(run)),
    detailLine('Cwd', run.run.cwd),
    detailLine('Git', formatRunGit(run)),
    detailLine('Session', `requested=${run.session.requested_session_id ?? 'none'} observed=${run.session.observed_session_id ?? 'none'} effective=${run.session.effective_session_id ?? 'none'} audit=${run.session.status}`),
    detailLine('Duration', `${run.duration_seconds === null ? 'unknown' : `${run.duration_seconds}s`} events=${run.activity.event_count}`),
  ];
  for (const warning of run.session.warnings) lines.push(`Warning: ${warning}`);
  if (run.prompt.summary) lines.push(`Summary: ${run.prompt.summary}`);
  lines.push('', sectionTitle('User Prompt'));
  lines.push(...wrap((run.prompt.text ?? run.prompt.preview) || '(prompt not included)', Math.max(40, width - 2)).map((line) => `  ${line}`));
  lines.push('', `${sectionTitle('Final Response')} ${colorResponseStatus(run.response.status ?? responseStateLabel(run))}`);
  lines.push(...wrap(run.response.summary ?? responsePlaceholder(run), Math.max(40, width - 2)).map((line) => `  ${line}`));
  lines.push('', sectionTitle('Recent Activity'));
  if (run.activity.recent_events.length === 0) lines.push('  none');
  for (const event of run.activity.recent_events) {
    lines.push(`  ${style.dim(`#${event.seq}`)} ${formatTimestamp(event.ts)} ${event.type}`);
  }
  if (run.activity.recent_errors.length > 0) {
    lines.push('', sectionTitle('Recent Errors'));
    for (const error of run.activity.recent_errors) lines.push(`  ${error}`);
  }
  lines.push('', sectionTitle('Artifacts'));
  for (const artifact of run.artifacts) {
    lines.push(`  ${artifact.name} ${artifact.exists ? formatBytes(artifact.bytes ?? 0) : 'missing'} ${artifact.path}`);
  }
  return lines;
}

function responseStateLabel(run: ObservabilityRun): string {
  return run.run.status === 'running' ? 'pending' : 'missing';
}

function responsePlaceholder(run: ObservabilityRun): string {
  return run.run.status === 'running' ? '(response pending)' : '(no final response recorded)';
}

function currentSession(snapshot: ObservabilitySnapshot, state: DashboardState): ObservabilitySession | null {
  return snapshot.sessions[state.selectedSession] ?? null;
}

function currentRun(snapshot: ObservabilitySnapshot, state: DashboardState): ObservabilityRun | null {
  const session = currentSession(snapshot, state);
  const prompt = session?.prompts[state.selectedPrompt];
  if (!prompt) return null;
  return snapshot.runs.find((run) => run.run.run_id === prompt.run_id) ?? null;
}

function renderViewState(snapshot: ObservabilitySnapshot, state: DashboardState): string {
  const session = currentSession(snapshot, state);
  const prompt = session?.prompts[state.selectedPrompt] ?? null;
  if (state.view === 'sessions') {
    return `${style.bold('View')}: Sessions ${position(state.selectedSession, snapshot.sessions.length)}`;
  }
  if (state.view === 'prompts') {
    return `${style.bold('View')}: Sessions > ${session?.title ?? 'none'} | Prompt ${position(state.selectedPrompt, session?.prompts.length ?? 0)}`;
  }
  return `${style.bold('View')}: Detail > ${session?.title ?? 'none'} > ${prompt?.title ?? 'none'} | Prompt ${position(state.selectedPrompt, session?.prompts.length ?? 0)}`;
}

function renderKeyHint(snapshot: ObservabilitySnapshot, state: DashboardState): string {
  const session = currentSession(snapshot, state);
  if (state.view === 'sessions') return 'Keys: Up/Down choose chat, Enter opens prompts, q exits | PROMPTS=history length';
  if (state.view === 'prompts') return 'Keys: Up/Down choose prompt, Enter opens detail, Esc/Backspace returns to chats, q exits';
  return `Keys: Up/Down switches prompt in ${session?.title ?? 'this chat'}, Esc/Backspace returns to prompts, q exits`;
}

function position(index: number, count: number): string {
  return count > 0 ? `${clamp(index, 0, count - 1) + 1}/${count}` : '0/0';
}

function formatRunLine(run: ObservabilityRun): string {
  return `- ${run.prompt.title} [${run.run.status}] ${run.run.run_id} model=${formatModel(run.model)} effort=${formatSetting(run.settings.reasoning_effort)} tier=${formatTier(run.settings)} invocation=${formatInvocation(run)} session=${run.session.effective_session_id ?? 'none'} events=${run.activity.event_count} size=${formatBytes(run.artifacts.reduce((sum, artifact) => sum + (artifact.bytes ?? 0), 0))}`;
}

function formatModel(model: { name: string | null; source: string; requested_name?: string | null; observed_name?: string | null }): string {
  const name = model.name ?? 'default';
  if (model.requested_name && model.observed_name && model.requested_name !== model.observed_name) {
    return `${name} (${model.source}, requested ${model.requested_name})`;
  }
  return `${name} (${model.source})`;
}

function formatModelCompact(model: { name: string | null; source: string }): string {
  return model.name ?? `default/${model.source}`;
}

function formatSessionModels(session: ObservabilitySession): string {
  if (session.models.length === 0) return 'unknown';
  const labels = session.models.map(formatModelCompact);
  const [first, ...rest] = labels;
  return rest.length === 0 ? first ?? 'unknown' : `${first ?? 'unknown'} +${rest.length}`;
}

function formatSessionEfforts(session: ObservabilitySession): string {
  return formatUniqueSettings(session.settings.map((settings) => formatSetting(settings.reasoning_effort)));
}

function formatSessionTiers(session: ObservabilitySession): string {
  return formatUniqueSettings(session.settings.map(formatTier));
}

function formatLatestModel(session: ObservabilitySession): string {
  const prompt = latestPrompt(session);
  return prompt ? formatModelCompact(prompt.model) : formatSessionModels(session);
}

function formatLatestEffort(session: ObservabilitySession): string {
  const prompt = latestPrompt(session);
  return prompt ? formatSetting(prompt.settings.reasoning_effort) : formatSessionEfforts(session);
}

function formatLatestTier(session: ObservabilitySession): string {
  const prompt = latestPrompt(session);
  return prompt ? formatTier(prompt.settings) : formatSessionTiers(session);
}

function latestPrompt(session: ObservabilitySession) {
  return session.prompts[session.prompts.length - 1] ?? null;
}

function formatWorkspace(session: ObservabilitySession): string {
  const workspace = session.workspace;
  if (!workspace) return compactFolder(session.cwd);
  const dirty = workspace.dirty_count !== null && workspace.dirty_count > 0 ? '*' : '';
  if (workspace.repository_name && workspace.branch) {
    const repo = compactRepositoryName(workspace.repository_name);
    return `${repo}:${compactBranchName(workspace.branch, Math.max(8, 31 - repo.length - dirty.length))}${dirty}`;
  }
  if (workspace.repository_name) {
    return workspace.label.replace(workspace.repository_name, compactRepositoryName(workspace.repository_name));
  }
  return compactFolder(workspace.cwd);
}

function formatRunGit(run: ObservabilityRun): string {
  const snapshot = run.run.git_snapshot;
  if (!snapshot) return run.run.git_snapshot_status;
  const repo = snapshot.root ? basename(snapshot.root) : null;
  const target = repo && snapshot.branch
    ? `${repo}:${snapshot.branch}`
    : repo
      ? `${repo}@${snapshot.sha.slice(0, 7)}`
      : snapshot.sha.slice(0, 7);
  const dirty = snapshot.dirty_count > 0 ? `dirty=${snapshot.dirty_count}` : 'clean';
  return `${target} ${dirty}`;
}

function compactFolder(cwd: string): string {
  const leaf = basename(cwd);
  const rawParent = basename(dirname(cwd));
  const parent = rawParent.startsWith('worktrees-') ? rawParent.slice('worktrees-'.length) : rawParent;
  const compactParent = compactRepositoryName(parent);
  if (parent && leaf && parent !== leaf && `${parent}/${leaf}`.length <= 32) return `${parent}/${leaf}`;
  if (compactParent && leaf && compactParent !== leaf) return `${compactParent}/${leaf}`;
  return leaf || cwd;
}

function compactRepositoryName(name: string): string {
  if (name.length <= 14) return name;
  const parts = name.split('-').filter(Boolean);
  if (parts.length <= 1) return name.slice(0, 14);
  const head = parts.slice(0, -1).map((part) => part[0]).join('');
  return `${head}-${parts[parts.length - 1] ?? ''}`;
}

function compactBranchName(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  const parts = name.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (last && last.length <= maxLength) return last;
  if (maxLength <= 1) return name.slice(0, maxLength);
  return `${name.slice(0, maxLength - 1)}.`;
}

function formatUniqueSettings(values: string[]): string {
  const unique = Array.from(new Set(values));
  const [first, ...rest] = unique;
  return rest.length === 0 ? first ?? 'default' : `${first ?? 'default'} +${rest.length}`;
}

function formatSetting(value: string | null): string {
  return value ?? 'default';
}

function formatTier(settings: ObservabilityRunSettings): string {
  return settings.service_tier ?? settings.mode ?? 'default';
}

function formatInvocation(run: ObservabilityRun): string {
  const invocation = run.run.worker_invocation;
  if (!invocation) return 'not recorded';
  return [invocation.command, ...invocation.args.map(shellQuote)].join(' ');
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatTimestamp(value: string | null): string {
  return value ? value.replace('T', ' ').slice(0, 19) : 'none';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

function detailLine(label: string, value: string): string {
  return `${style.bold(label)}: ${value}`;
}

function sectionTitle(value: string): string {
  return `\x1b[1;36m${value}\x1b[0m`;
}

function agentCell(value: string, width: number): string {
  return style.magenta(pad(value, width));
}

function statusCell(value: string, width: number): string {
  return colorStatus(pad(value, width), value);
}

function modelCell(value: string, width: number): string {
  return style.cyan(pad(value, width));
}

function workspaceCell(value: string, width: number): string {
  return style.dim(pad(value, width));
}

function settingsCell(value: string, width: number): string {
  return value === 'default' ? style.dim(pad(value, width)) : style.yellow(pad(value, width));
}

function colorStatus(value: string, status = value): string {
  if (status === 'running') return style.yellow(value);
  if (status === 'completed') return style.green(value);
  if (status === 'cancelled' || status === 'timed_out' || status === 'failed' || status === 'orphaned') return style.red(value);
  return value;
}

function colorResponseStatus(status: string): string {
  if (status === 'completed') return style.green(`[${status}]`);
  if (status === 'pending' || status === 'needs_input') return style.yellow(`[${status}]`);
  if (status === 'failed' || status === 'blocked' || status === 'missing') return style.red(`[${status}]`);
  return `[${status}]`;
}

function pad(value: string, width: number): string {
  if (value.length === width) return value;
  if (value.length > width) return `${value.slice(0, Math.max(0, width - 1))}.`;
  return `${value}${' '.repeat(width - value.length)}`;
}

function selectLine(selected: boolean, text: string): string {
  return selected ? `\x1b[7m> ${text}\x1b[0m` : `  ${text}`;
}

function fit(line: string, width: number): string {
  if (visibleLength(line) <= width) return line;
  return `${stripAnsi(line).slice(0, Math.max(0, width - 3))}...`;
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

const style = {
  bold: (value: string) => `\x1b[1m${value}\x1b[0m`,
  dim: (value: string) => `\x1b[2m${value}\x1b[0m`,
  cyan: (value: string) => `\x1b[36m${value}\x1b[0m`,
  green: (value: string) => `\x1b[32m${value}\x1b[0m`,
  yellow: (value: string) => `\x1b[33m${value}\x1b[0m`,
  red: (value: string) => `\x1b[31m${value}\x1b[0m`,
  magenta: (value: string) => `\x1b[35m${value}\x1b[0m`,
};
