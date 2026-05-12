import { Marked, type MarkedOptions } from 'marked';
import TerminalRenderer from 'marked-terminal';
import type {
  ObservabilityOrchestratorGroup,
  ObservabilityOrchestratorWorker,
  ObservabilityRun,
  ObservabilityRunSettings,
  ObservabilitySnapshot,
  RunStatus,
  WorkerEvent,
} from '../contract.js';
import type { SnapshotEnvelope } from './observabilityFormat.js';

export interface WatchViewModel {
  running: boolean;
  error?: string;
  live: WatchOrchestrator[];
  archive: WatchOrchestrator[];
}

export interface WatchOrchestrator {
  id: string;
  live: boolean;
  label: string;
  cwd: string;
  status: string;
  workerCount: number;
  runningCount: number;
  createdAt: string;
  updatedAt: string;
  generatedAt: string;
  conversations: WatchConversation[];
}

export interface WatchConversation {
  id: string;
  orchestratorId: string;
  rootRunId: string;
  runIds: string[];
  workerName: string;
  workerOrdinal: number;
  backend: string;
  status: RunStatus;
  title: string;
  purpose: string;
  summary: string | null;
  model: string;
  settings: ObservabilityRunSettings;
  createdAt: string;
  updatedAt: string;
  latestRunStartedAt: string;
  latestRunEndedAt: string | null;
  turns: WatchTranscriptEvent[];
}

export type WatchTranscriptEventKind =
  | 'run_start'
  | 'run_end'
  | 'prompt'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'status'
  | 'error'
  | 'final';

export interface WatchTranscriptEvent {
  id: string;
  runId: string;
  seq: number | null;
  ts: string | null;
  kind: WatchTranscriptEventKind;
  title: string;
  body: string;
  status?: string | null;
  accent?: 'supervisor' | 'assistant' | 'tool' | 'error' | 'status';
  round: number;
}

export type WatchTranscriptActor =
  | 'run'
  | 'supervisor'
  | 'worker'
  | 'tool'
  | 'status'
  | 'result'
  | 'error'
  | 'system';

export type WatchTranscriptTone =
  | 'supervisor'
  | 'worker'
  | 'tool'
  | 'success'
  | 'running'
  | 'error'
  | 'status'
  | 'result';

export interface WatchTranscriptBlock {
  id: string;
  actor: WatchTranscriptActor;
  label: string;
  title: string;
  timestamp: string | null;
  status: string | null;
  body: string;
  round: number | null;
  tone: WatchTranscriptTone;
  subtle: boolean;
  metadata: string[];
}

export interface WatchDashboardState {
  mode: 'live' | 'archive';
  selectedId: string | null;
  expanded: Record<string, boolean>;
  follow: boolean;
  scrollOffset: number;
}

export interface WatchSidebarItem {
  id: string;
  kind: 'orchestrator' | 'conversation';
  orchestrator: WatchOrchestrator;
  conversation?: WatchConversation;
}

export interface WatchInputKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  tab?: boolean;
  backspace?: boolean;
}

export interface WatchInputResult {
  state: WatchDashboardState;
  quit: boolean;
  toggleMouseCapture?: boolean;
}

interface WatchInputEvent {
  input: string;
  key: WatchInputKey;
}

interface ConversationDraft {
  id: string;
  orchestratorId: string;
  rootRunId: string;
  runs: ObservabilityRun[];
  placeholderWorkers: ObservabilityOrchestratorWorker[];
}

interface RunDurationWindow {
  status: string;
  startedAt: string;
  endedAt: string | null;
}

export function buildWatchViewModel(envelope: SnapshotEnvelope): WatchViewModel {
  const snapshot = envelope.snapshot;
  const groups = snapshot.orchestrators;
  return {
    running: envelope.running,
    error: envelope.error,
    live: groups.filter(isLiveOrchestrator).map((group) => buildWatchOrchestrator(snapshot, group)),
    archive: groups.filter((group) => !isLiveOrchestrator(group)).map((group) => buildWatchOrchestrator(snapshot, group)),
  };
}

export function createWatchDashboardState(): WatchDashboardState {
  return {
    mode: 'live',
    selectedId: null,
    expanded: {},
    follow: true,
    scrollOffset: 0,
  };
}

export function clampWatchDashboardState(state: WatchDashboardState, model: WatchViewModel): WatchDashboardState {
  const items = watchSidebarItems(model, state);
  const selectedStillExists = state.selectedId !== null && items.some((item) => item.id === state.selectedId);
  return {
    ...state,
    selectedId: selectedStillExists ? state.selectedId : items[0]?.id ?? null,
    scrollOffset: Math.max(0, state.scrollOffset),
    follow: selectedStillExists ? state.follow : true,
  };
}

export function selectWatchSidebarItem(state: WatchDashboardState, model: WatchViewModel, delta: number): WatchDashboardState {
  const clamped = clampWatchDashboardState(state, model);
  const items = watchSidebarItems(model, clamped);
  if (items.length === 0) return clamped;
  const currentIndex = Math.max(0, items.findIndex((item) => item.id === clamped.selectedId));
  const next = items[clamp(currentIndex + delta, 0, items.length - 1)]!;
  if (next.id === clamped.selectedId) return clamped;
  return { ...clamped, selectedId: next.id, follow: true, scrollOffset: 0 };
}

export function toggleWatchMode(state: WatchDashboardState, model: WatchViewModel): WatchDashboardState {
  return clampWatchDashboardState({
    ...state,
    mode: state.mode === 'live' ? 'archive' : 'live',
    selectedId: null,
    follow: true,
    scrollOffset: 0,
  }, model);
}

export function toggleWatchExpanded(state: WatchDashboardState, model: WatchViewModel, expanded?: boolean): WatchDashboardState {
  const item = selectedWatchSidebarItem(model, state);
  if (!item || item.kind !== 'orchestrator') return state;
  return {
    ...state,
    expanded: {
      ...state.expanded,
      [item.orchestrator.id]: expanded ?? !isExpanded(item.orchestrator, state),
    },
  };
}

export function followWatchTranscript(state: WatchDashboardState, model: WatchViewModel): WatchDashboardState {
  return { ...clampWatchDashboardState(state, model), follow: true, scrollOffset: 0 };
}

export function scrollWatchTranscript(
  state: WatchDashboardState,
  model: WatchViewModel,
  width: number,
  height: number,
  delta: number,
  maxScrollOverride?: number,
): WatchDashboardState {
  const clamped = clampWatchDashboardState(state, model);
  const maxScroll = maxScrollOverride ?? maxWatchTranscriptScroll(model, clamped, width, height);
  const topAnchored = isOverviewSelected(model, clamped);
  const nextOffset = topAnchored
    ? clamp(clamped.scrollOffset - delta, 0, maxScroll)
    : clamp(clamped.scrollOffset + delta, 0, maxScroll);
  return {
    ...clamped,
    follow: nextOffset === 0,
    scrollOffset: nextOffset,
  };
}

export function scrollWatchTranscriptToTop(
  state: WatchDashboardState,
  model: WatchViewModel,
  width: number,
  height: number,
  maxScrollOverride?: number,
): WatchDashboardState {
  const clamped = clampWatchDashboardState(state, model);
  const maxScroll = maxScrollOverride ?? maxWatchTranscriptScroll(model, clamped, width, height);
  if (isOverviewSelected(model, clamped)) {
    return {
      ...clamped,
      follow: true,
      scrollOffset: 0,
    };
  }
  return {
    ...clamped,
    follow: maxScroll === 0,
    scrollOffset: maxScroll,
  };
}

function isOverviewSelected(model: WatchViewModel, state: WatchDashboardState): boolean {
  return selectedWatchSidebarItem(model, state)?.kind !== 'conversation';
}

export function watchMouseScrollDelta(input: string, pageSize: number): number | null {
  void pageSize;
  const step = 1;
  let delta = 0;

  for (const match of input.matchAll(/\x1b\[<(\d+);\d+;\d+([mM])/g)) {
    if (match[2] === 'm') continue;
    delta += mouseButtonScrollDelta(Number(match[1]), step);
  }

  for (const match of input.matchAll(/\x1b\[(\d+);\d+;\d+M/g)) {
    delta += mouseButtonScrollDelta(Number(match[1]), step);
  }

  for (const match of input.matchAll(/\x1b\[M([\s\S]{3})/g)) {
    const button = match[1]!.charCodeAt(0) - 32;
    delta += mouseButtonScrollDelta(button, step);
  }

  return delta === 0 ? null : delta;
}

export function applyWatchRawInput(
  state: WatchDashboardState,
  model: WatchViewModel,
  rawInput: string,
  width: number,
  height: number,
  maxScrollOverride?: number,
): WatchInputResult {
  const pageSize = Math.max(1, height);
  let nextState = state;
  let toggleMouseCapture = false;
  const mouseDelta = watchMouseScrollDelta(rawInput, pageSize);
  if (mouseDelta !== null) {
    nextState = scrollWatchTranscript(nextState, model, width, height, mouseDelta, maxScrollOverride);
  }

  for (const event of rawWatchInputEvents(rawInput)) {
    const result = applyWatchInput(nextState, model, event.input, event.key, width, height, maxScrollOverride);
    nextState = result.state;
    toggleMouseCapture = toggleMouseCapture || Boolean(result.toggleMouseCapture);
    if (result.quit) return { state: nextState, quit: true, toggleMouseCapture };
  }

  return { state: nextState, quit: false, toggleMouseCapture };
}

export function applyWatchInput(
  state: WatchDashboardState,
  model: WatchViewModel,
  input: string,
  key: WatchInputKey,
  width: number,
  height: number,
  maxScrollOverride?: number,
): WatchInputResult {
  if ((key.ctrl && input === 'c') || input === 'q') return { state, quit: true };
  if (input === 'm') return { state, quit: false, toggleMouseCapture: true };

  const pageSize = Math.max(1, height);
  const halfPage = Math.max(1, Math.ceil(pageSize / 2));
  const mouseDelta = watchMouseScrollDelta(input, pageSize);
  if (mouseDelta !== null) return { state: scrollWatchTranscript(state, model, width, height, mouseDelta, maxScrollOverride), quit: false };

  if (key.upArrow) return { state: selectWatchSidebarItem(state, model, -1), quit: false };
  if (key.downArrow) return { state: selectWatchSidebarItem(state, model, 1), quit: false };
  if (input === 'k') return { state: selectWatchSidebarItem(state, model, -1), quit: false };
  if (input === 'j') return { state: selectWatchSidebarItem(state, model, 1), quit: false };
  if (input === ' ') return { state: toggleWatchExpanded(state, model), quit: false };
  if (key.rightArrow || input === 'l') return { state: toggleWatchExpanded(state, model, true), quit: false };
  if (key.leftArrow || input === 'h') return { state: toggleWatchExpanded(state, model, false), quit: false };
  if (key.tab || input === 'a') return { state: toggleWatchMode(state, model), quit: false };

  if (key.pageUp || (input === 'b' && key.ctrl) || input === '\u0002') {
    return { state: scrollWatchTranscript(state, model, width, height, pageSize, maxScrollOverride), quit: false };
  }
  if (key.pageDown || (input === 'f' && key.ctrl) || input === '\u0006') {
    return { state: scrollWatchTranscript(state, model, width, height, -pageSize, maxScrollOverride), quit: false };
  }
  if (input === 'u' || (input === 'u' && key.ctrl) || input === '\u0015') {
    return { state: scrollWatchTranscript(state, model, width, height, halfPage, maxScrollOverride), quit: false };
  }
  if (input === 'd' || (input === 'd' && key.ctrl) || input === '\u0004') {
    return { state: scrollWatchTranscript(state, model, width, height, -halfPage, maxScrollOverride), quit: false };
  }
  if (key.home || input === 'g') return { state: scrollWatchTranscriptToTop(state, model, width, height, maxScrollOverride), quit: false };
  if (key.return || key.end || input === 'G' || (input === 'e' && key.ctrl) || input === '\u0005') {
    return { state: followWatchTranscript(state, model), quit: false };
  }
  if (key.escape || key.backspace) {
    return { state: state.mode === 'archive' ? toggleWatchMode(state, model) : state, quit: false };
  }

  return { state, quit: false };
}

function rawWatchInputEvents(rawInput: string): WatchInputEvent[] {
  const input = stripMouseSequences(rawInput);
  const events: WatchInputEvent[] = [];
  let index = 0;
  while (index < input.length) {
    const remaining = input.slice(index);
    const csiArrow = /^\x1b\[(?:\d+(?:;[2-8])?)?([ABCDHF])/.exec(remaining);
    if (csiArrow) {
      events.push(rawArrowEvent(csiArrow[1]!));
      index += csiArrow[0].length;
      continue;
    }

    const appArrow = /^\x1bO([ABCDHF])/.exec(remaining);
    if (appArrow) {
      events.push(rawArrowEvent(appArrow[1]!));
      index += appArrow[0].length;
      continue;
    }

    const csiTilde = /^\x1b\[(\d+)~/.exec(remaining);
    if (csiTilde) {
      const event = rawTildeEvent(csiTilde[1]!);
      if (event) events.push(event);
      index += csiTilde[0].length;
      continue;
    }

    const char = input[index]!;
    const event = rawCharEvent(char);
    if (event) events.push(event);
    index += 1;
  }
  return events;
}

function stripMouseSequences(input: string): string {
  return input
    .replaceAll(/\x1b\[<\d+;\d+;\d+[mM]/g, '')
    .replaceAll(/\x1b\[\d+;\d+;\d+M/g, '')
    .replaceAll(/\x1b\[M[\s\S]{3}/g, '');
}

function rawArrowEvent(code: string): WatchInputEvent {
  if (code === 'A') return { input: '', key: { upArrow: true } };
  if (code === 'B') return { input: '', key: { downArrow: true } };
  if (code === 'C') return { input: '', key: { rightArrow: true } };
  if (code === 'D') return { input: '', key: { leftArrow: true } };
  if (code === 'H') return { input: '', key: { home: true } };
  return { input: '', key: { end: true } };
}

function rawTildeEvent(code: string): WatchInputEvent | null {
  if (code === '1' || code === '7') return { input: '', key: { home: true } };
  if (code === '4' || code === '8') return { input: '', key: { end: true } };
  if (code === '5') return { input: '', key: { pageUp: true } };
  if (code === '6') return { input: '', key: { pageDown: true } };
  return null;
}

function rawCharEvent(char: string): WatchInputEvent | null {
  if (char === '\u0003') return { input: 'c', key: { ctrl: true } };
  if (char === '\u0002') return { input: '\u0002', key: { ctrl: true } };
  if (char === '\u0004') return { input: '\u0004', key: { ctrl: true } };
  if (char === '\u0005') return { input: '\u0005', key: { ctrl: true } };
  if (char === '\u0006') return { input: '\u0006', key: { ctrl: true } };
  if (char === '\u0015') return { input: '\u0015', key: { ctrl: true } };
  if (char === '\t') return { input: '', key: { tab: true } };
  if (char === '\r' || char === '\n') return { input: '', key: { return: true } };
  if (char === '\u001b') return { input: '', key: { escape: true } };
  if (char === '\u007f' || char === '\b') return { input: '', key: { backspace: true } };
  if (char >= ' ') return { input: char, key: {} };
  return null;
}

export function watchSidebarItems(model: WatchViewModel, state: WatchDashboardState): WatchSidebarItem[] {
  const groups = state.mode === 'live' ? model.live : model.archive;
  const items: WatchSidebarItem[] = [];
  for (const orchestrator of groups) {
    items.push({ id: orchestratorItemId(orchestrator), kind: 'orchestrator', orchestrator });
    if (!isExpanded(orchestrator, state)) continue;
    for (const conversation of orchestrator.conversations) {
      items.push({ id: conversationItemId(conversation), kind: 'conversation', orchestrator, conversation });
    }
  }
  return items;
}

export function selectedWatchSidebarItem(model: WatchViewModel, state: WatchDashboardState): WatchSidebarItem | null {
  const clamped = clampWatchDashboardState(state, model);
  return watchSidebarItems(model, clamped).find((item) => item.id === clamped.selectedId) ?? null;
}

export function selectedWatchTranscriptLines(model: WatchViewModel, state: WatchDashboardState, width: number): string[] {
  const item = selectedWatchSidebarItem(model, state);
  if (!item) return renderTranscriptBlocks([emptyTranscriptBlock()], width);
  return renderTranscriptBlocks(selectedWatchTranscriptBlocks(model, state), width);
}

export function selectedWatchTranscriptBlocks(model: WatchViewModel, state: WatchDashboardState): WatchTranscriptBlock[] {
  const item = selectedWatchSidebarItem(model, state);
  if (!item) return [emptyTranscriptBlock()];
  if (item.kind === 'orchestrator') return renderOrchestratorOverviewBlocks(item.orchestrator);
  return renderConversationTranscriptBlocks(item.conversation!);
}

export function renderMarkdownToAnsi(markdown: string, width: number): string[] {
  const text = markdown.trim();
  if (!text) return [];
  const parser = new Marked();
  parser.setOptions({
    gfm: true,
    breaks: true,
    renderer: new TerminalRenderer({
      width: Math.max(20, width),
      reflowText: true,
      showSectionPrefix: false,
    }) as unknown as MarkedOptions['renderer'],
  });
  const rendered = parser.parse(text, { async: false }) as string;
  return rendered.replace(/\n+$/g, '').split('\n');
}

export function normalizeWatchEvent(run: ObservabilityRun, event: WorkerEvent, round = 1): WatchTranscriptEvent | null {
  const base = {
    id: `${run.run.run_id}:${event.seq}`,
    runId: run.run.run_id,
    seq: event.seq,
    ts: event.ts,
    round,
  };

  if (event.type === 'assistant_message') {
    const text = stringFromRecord(event.payload, 'text') ?? stringFromRecord(event.payload, 'message') ?? '';
    if (!text) return null;
    return {
      ...base,
      kind: 'assistant',
      title: 'Assistant',
      body: text,
      accent: 'assistant',
    };
  }

  if (event.type === 'tool_use') {
    const summary = summarizeToolUse(event.payload);
    return {
      ...base,
      kind: 'tool_call',
      title: summary.title,
      body: summary.body,
      accent: 'tool',
    };
  }

  if (event.type === 'tool_result') {
    const summary = summarizeToolResult(event.payload);
    return {
      ...base,
      kind: 'tool_result',
      title: summary.title,
      body: summary.body,
      status: summary.status,
      accent: summary.status === 'failed' || summary.status === 'error' ? 'error' : 'tool',
    };
  }

  if (event.type === 'error') {
    const message = stringFromRecord(event.payload, 'message') ?? stringFromRecord(event.payload, 'text') ?? compactJson(event.payload, 500);
    return {
      ...base,
      kind: 'error',
      title: 'Error',
      body: message || 'Worker error',
      status: 'error',
      accent: 'error',
    };
  }

  const status = lifecycleStatus(event.payload);
  const body = lifecycleBody(event.payload);
  if (!status) {
    const summary = compactLifecyclePayload(event.payload);
    if (!summary) return null;
    return {
      ...base,
      kind: 'status',
      title: event.payload.state === 'result_event' ? 'Result event' : 'Event',
      body: summary,
      status: null,
      accent: 'status',
    };
  }
  if (!isUsefulLifecycleStatus(status, body)) return null;
  return {
    ...base,
    kind: 'status',
    title: 'Status',
    body,
    status,
    accent: 'status',
  };
}

function buildWatchOrchestrator(snapshot: ObservabilitySnapshot, group: ObservabilityOrchestratorGroup): WatchOrchestrator {
  const conversations = buildConversations(snapshot, group);
  return {
    id: group.orchestrator_id,
    live: isLiveOrchestrator(group),
    label: group.label,
    cwd: group.cwd,
    status: group.status?.state ?? (group.live ? 'live' : 'archived'),
    workerCount: conversations.length,
    runningCount: conversations.filter((conversation) => conversation.status === 'running').length,
    createdAt: group.created_at,
    updatedAt: maxIso([group.updated_at, ...conversations.map((conversation) => conversation.updatedAt)]),
    generatedAt: snapshot.generated_at,
    conversations,
  };
}

function buildConversations(snapshot: ObservabilitySnapshot, group: ObservabilityOrchestratorGroup): WatchConversation[] {
  const runs = snapshot.runs
    .filter((run) => orchestratorIdFromMetadata(run.run.metadata) === group.orchestrator_id)
    .sort(compareRunCreatedAt);
  const runsById = new Map(runs.map((run) => [run.run.run_id, run]));
  const drafts = new Map<string, ConversationDraft>();

  for (const run of runs) {
    const key = conversationKey(run, runsById);
    const draft = drafts.get(key) ?? {
      id: key,
      orchestratorId: group.orchestrator_id,
      rootRunId: rootRun(run, runsById).run.run_id,
      runs: [],
      placeholderWorkers: [],
    };
    draft.runs.push(run);
    drafts.set(key, draft);
  }

  for (const worker of group.workers) {
    if (Array.from(drafts.values()).some((draft) => draft.runs.some((run) => run.run.run_id === worker.run_id))) continue;
    const key = `conversation:${group.orchestrator_id}:${worker.parent_run_id ?? worker.run_id}`;
    const draft = drafts.get(key) ?? {
      id: key,
      orchestratorId: group.orchestrator_id,
      rootRunId: worker.parent_run_id ?? worker.run_id,
      runs: [],
      placeholderWorkers: [],
    };
    draft.placeholderWorkers.push(worker);
    drafts.set(key, draft);
  }

  return Array.from(drafts.values())
    .map(conversationFromDraft)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(withWorkerIdentity)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function conversationFromDraft(draft: ConversationDraft): WatchConversation {
  const runs = draft.runs.sort(compareRunCreatedAt);
  const root = runs.find((run) => run.run.run_id === draft.rootRunId) ?? runs[0] ?? null;
  const latest = runs.slice().sort((a, b) => latestObservedAt(b).localeCompare(latestObservedAt(a)))[0] ?? null;
  const placeholder = draft.placeholderWorkers[0] ?? null;
  const turns = runs.flatMap((run, index) => turnsForRun(run, index > 0 || run.run.parent_run_id !== null, index + 1));

  for (const [index, worker] of draft.placeholderWorkers.entries()) {
    turns.push({
      id: `${worker.run_id}:prompt`,
      runId: worker.run_id,
      seq: null,
      ts: worker.created_at,
      kind: 'prompt',
      title: worker.parent_run_id ? 'Supervisor follow-up' : 'Supervisor prompt',
      body: worker.preview || worker.title,
      status: worker.status,
      accent: 'supervisor',
      round: runs.length + index + 1,
    });
  }

  const status = runs.some((run) => run.run.status === 'running')
    ? 'running'
    : latest?.run.status ?? placeholder?.status ?? 'completed';
  const durationWindow = latestRunDurationWindow(runs, draft.placeholderWorkers, status);

  return {
    id: draft.id,
    orchestratorId: draft.orchestratorId,
    rootRunId: draft.rootRunId,
    runIds: [...runs.map((run) => run.run.run_id), ...draft.placeholderWorkers.map((worker) => worker.run_id)],
    workerName: 'Worker',
    workerOrdinal: 0,
    backend: root?.run.backend ?? placeholder?.backend ?? 'codex',
    status,
    title: root?.prompt.title ?? placeholder?.title ?? draft.rootRunId,
    purpose: compactText(root?.prompt.summary ?? placeholder?.summary ?? root?.prompt.preview ?? placeholder?.preview ?? draft.rootRunId, 140),
    summary: root?.prompt.summary ?? placeholder?.summary ?? null,
    model: root ? formatModelName(root) : formatModelLike(placeholder?.model.name ?? null),
    settings: root?.settings ?? placeholder?.settings ?? { reasoning_effort: null, service_tier: null, mode: null, codex_network: null },
    createdAt: root?.run.created_at ?? placeholder?.created_at ?? '',
    updatedAt: maxIso([
      ...runs.map(latestObservedAt),
      ...draft.placeholderWorkers.map((worker) => worker.last_activity_at ?? worker.created_at),
    ]),
    latestRunStartedAt: durationWindow.startedAt,
    latestRunEndedAt: durationWindow.endedAt,
    turns,
  };
}

function withWorkerIdentity(conversation: WatchConversation, index: number): WatchConversation {
  return {
    ...conversation,
    workerName: `Worker ${index + 1}`,
    workerOrdinal: index + 1,
    purpose: conversation.purpose || conversation.title,
  };
}

function latestRunDurationWindow(
  runs: ObservabilityRun[],
  placeholderWorkers: ObservabilityOrchestratorWorker[],
  status: RunStatus,
): RunDurationWindow {
  const windows = [
    ...runs.map(runDurationWindow),
    ...placeholderWorkers.map(workerDurationWindow),
  ].filter((window) => window.startedAt);
  if (windows.length === 0) return { status, startedAt: '', endedAt: null };

  const candidates = status === 'running'
    ? windows.filter((window) => window.status === 'running')
    : windows;
  return (candidates.length > 0 ? candidates : windows)
    .slice()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1)!;
}

function runDurationWindow(run: ObservabilityRun): RunDurationWindow {
  return {
    status: run.run.status,
    startedAt: run.run.started_at ?? run.run.created_at,
    endedAt: isTerminalRunStatus(run.run.status)
      ? run.run.finished_at ?? run.activity.last_event_at ?? run.activity.last_activity_at ?? latestObservedAt(run)
      : null,
  };
}

function workerDurationWindow(worker: ObservabilityOrchestratorWorker): RunDurationWindow {
  return {
    status: worker.status,
    startedAt: worker.created_at,
    endedAt: isTerminalRunStatus(worker.status) ? worker.last_activity_at ?? worker.created_at : null,
  };
}

function turnsForRun(run: ObservabilityRun, followUp: boolean, round: number): WatchTranscriptEvent[] {
  const turns: WatchTranscriptEvent[] = [{
    id: `${run.run.run_id}:run-start`,
    runId: run.run.run_id,
    seq: null,
    ts: run.run.started_at ?? run.run.created_at,
    kind: 'run_start',
    title: `Run ${round} started`,
    body: `Worker run ${run.run.run_id}`,
    status: null,
    accent: 'status',
    round,
  }, {
    id: `${run.run.run_id}:prompt`,
    runId: run.run.run_id,
    seq: null,
    ts: run.run.created_at,
    kind: 'prompt',
    title: followUp ? 'Supervisor follow-up' : 'Supervisor prompt',
    body: run.prompt.text ?? run.prompt.preview,
    status: null,
    accent: 'supervisor',
    round,
  }];

  const events = run.activity.recent_events.slice().sort((a, b) => a.seq - b.seq);
  for (const event of events) {
    const normalized = normalizeWatchEvent(run, event, round);
    if (normalized) turns.push(normalized);
  }

  if (run.response.summary) {
    const duplicateAssistantIndex = duplicateLastAssistantIndex(turns, run.response.summary);
    if (duplicateAssistantIndex !== -1) turns.splice(duplicateAssistantIndex, 1);
    turns.push({
      id: `${run.run.run_id}:final`,
      runId: run.run.run_id,
      seq: null,
      ts: run.run.finished_at ?? run.activity.last_event_at ?? run.activity.last_activity_at,
      kind: 'final',
      title: 'Worker final message',
      body: run.response.summary,
      status: null,
      accent: 'assistant',
      round,
    });
  }

  if (isTerminalRunStatus(run.run.status)) {
    turns.push({
      id: `${run.run.run_id}:run-end`,
      runId: run.run.run_id,
      seq: null,
      ts: run.run.finished_at ?? run.activity.last_event_at ?? run.activity.last_activity_at,
      kind: 'run_end',
      title: `Run ${round} ended`,
      body: run.run.terminal_reason ? `Reason: ${run.run.terminal_reason}` : '',
      status: run.run.status,
      accent: run.run.status === 'completed' ? 'status' : 'error',
      round,
    });
  }

  return turns;
}

function renderConversationTranscriptBlocks(conversation: WatchConversation): WatchTranscriptBlock[] {
  const blocks: WatchTranscriptBlock[] = [{
    id: `${conversation.id}:summary`,
    actor: 'system',
    label: 'Worker Chat',
    title: `${conversation.workerName} timeline`,
    timestamp: conversation.updatedAt || null,
    status: conversation.status,
    body: `Runs: ${conversation.runIds.length}\nTurns: ${conversation.turns.length}`,
    round: null,
    tone: transcriptToneForStatus(conversation.status),
    subtle: true,
    metadata: [conversation.backend, conversation.model],
  }];
  blocks.push(...conversation.turns.map(transcriptBlockFromTurn));
  return blocks;
}

function renderOrchestratorOverviewBlocks(orchestrator: WatchOrchestrator): WatchTranscriptBlock[] {
  const generatedAt = maxIso([orchestrator.generatedAt, orchestrator.updatedAt]);
  const blocks: WatchTranscriptBlock[] = [{
    id: `${orchestrator.id}:overview`,
    actor: 'system',
    label: 'Session',
    title: orchestrator.label,
    timestamp: orchestrator.updatedAt || null,
    status: orchestrator.status,
    body: [
      `Workers: ${orchestrator.runningCount} running / ${orchestrator.conversations.length} total`,
      `Open: ${formatDurationBetween(orchestrator.createdAt, generatedAt)}`,
      `Last update: ${formatRelativeTime(orchestrator.updatedAt, generatedAt)}`,
      `Workspace: ${orchestrator.cwd}`,
    ].join('\n'),
    round: null,
    tone: transcriptToneForStatus(orchestrator.status),
    subtle: true,
    metadata: [],
  }];

  if (orchestrator.conversations.length === 0) {
    blocks.push({
      id: `${orchestrator.id}:empty`,
      actor: 'system',
      label: 'Workers',
      title: 'No worker conversations yet',
      timestamp: null,
      status: null,
      body: 'No worker conversations are recorded for this orchestrator yet.',
      round: null,
      tone: 'status',
      subtle: true,
      metadata: [],
    });
    return blocks;
  }

  for (const conversation of orchestrator.conversations) {
    const task = overviewDigestText(conversation.purpose || conversation.title, 110);
    const latestText = overviewLatestText(conversation);
    const durationEnd = isTerminalRunStatus(conversation.status)
      ? conversation.latestRunEndedAt ?? conversation.updatedAt
      : generatedAt;
    const duration = formatDurationBetween(conversation.latestRunStartedAt || conversation.createdAt, durationEnd);
    blocks.push({
      id: `${conversation.id}:overview`,
      actor: conversation.status === 'running' ? 'worker' : 'result',
      label: conversation.workerName,
      title: overviewStatusTitle(conversation.status, duration),
      timestamp: conversation.updatedAt || null,
      status: null,
      body: [
        `Task: ${task}`,
        latestText ? `Latest: ${latestText}` : null,
        `Runs: ${conversation.runIds.length}`,
      ].filter((value): value is string => Boolean(value)).join('\n'),
      round: null,
      tone: transcriptToneForStatus(conversation.status),
      subtle: false,
      metadata: [`last ${formatRelativeTime(conversation.updatedAt, generatedAt)}`, conversation.backend, conversation.model],
    });
  }

  return blocks;
}

function latestMeaningfulTurn(conversation: WatchConversation): WatchTranscriptEvent | null {
  return conversation.turns.slice().reverse().find((turn) => {
    if (turn.kind === 'run_start' || turn.kind === 'run_end') return false;
    return Boolean((turn.body || turn.title).trim());
  }) ?? null;
}

function overviewLatestText(conversation: WatchConversation): string {
  const preferred = conversation.turns.slice().reverse().find((turn) => {
    if (turn.kind === 'run_start' || turn.kind === 'run_end' || turn.kind === 'status') return false;
    return Boolean((turn.body || turn.title).trim());
  });
  if (preferred) return overviewDigestText(preferred.body || preferred.title, 130);

  const latest = latestMeaningfulTurn(conversation);
  if (!latest) return '';
  if (latest.kind === 'status') {
    const status = latest.status ? titleCaseStatus(latest.status) : latest.title;
    const body = latest.body.trim();
    if (!body || body.startsWith('{') || body.startsWith('[')) return status;
    return overviewDigestText(`${status}: ${body}`, 130);
  }
  return overviewDigestText(latest.body || latest.title, 130);
}

function overviewStatusLabel(status: string): string {
  if (status === 'running' || status === 'in_progress') return 'running';
  if (status === 'completed' || status === 'idle') return 'done';
  if (status === 'waiting_for_user') return 'waiting';
  if (status === 'failed' || status === 'timed_out' || status === 'cancelled' || status === 'orphaned') return status.replaceAll('_', ' ');
  return status;
}

function overviewStatusTitle(status: string, duration: string): string {
  const label = overviewStatusLabel(status);
  if (status === 'running' || status === 'in_progress' || status === 'waiting_for_user') return `${label} for ${duration}`;
  if (isTerminalRunStatus(status) || status === 'idle' || status === 'completed') return `${label} after ${duration}`;
  return `${label} for ${duration}`;
}

function plainOverviewText(value: string): string {
  return value
    .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replaceAll(/`([^`]*)`/g, '$1')
    .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
    .replaceAll(/\*([^*]+)\*/g, '$1')
    .replaceAll(/__([^_]+)__/g, '$1')
    .replaceAll(/_([^_]+)_/g, '$1')
    .replaceAll(/^\s{0,3}#{1,6}\s+/gm, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function overviewDigestText(value: string, limit: number): string {
  let text = plainOverviewText(value)
    .replace(/\s+Move history:.*$/i, '')
    .replace(/\s+I am the game master\b.*$/i, '')
    .replace(/\s+Your move as\b.*$/i, '')
    .trim();
  if (!text) text = plainOverviewText(value);
  return compactText(text, limit);
}

function formatDurationBetween(start: string | null, end: string | null): string {
  const startMs = start ? Date.parse(start) : Number.NaN;
  const endMs = end ? Date.parse(end) : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 'unknown';
  return formatDurationMs(endMs - startMs);
}

function formatRelativeTime(value: string | null, reference: string | null): string {
  const valueMs = value ? Date.parse(value) : Number.NaN;
  const referenceMs = reference ? Date.parse(reference) : Number.NaN;
  if (!Number.isFinite(valueMs) || !Number.isFinite(referenceMs)) return 'unknown';
  const delta = Math.max(0, referenceMs - valueMs);
  if (delta < 5_000) return 'now';
  return `${formatDurationMs(delta)} ago`;
}

function formatDurationMs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

function transcriptBlockFromTurn(turn: WatchTranscriptEvent): WatchTranscriptBlock {
  const base = {
    id: turn.id,
    title: turn.title,
    timestamp: turn.ts ? formatTimestamp(turn.ts) : null,
    status: turn.status ?? null,
    body: turn.body,
    round: turn.round,
    subtle: false,
    metadata: [],
  };

  if (turn.kind === 'run_start') {
    return { ...base, actor: 'run', label: `Run ${turn.round}`, title: 'Started', tone: 'running', subtle: true };
  }
  if (turn.kind === 'run_end') {
    return { ...base, actor: 'run', label: `Run ${turn.round}`, title: 'Ended', tone: transcriptToneForStatus(turn.status ?? 'status'), subtle: true };
  }
  if (turn.kind === 'prompt') {
    return { ...base, actor: 'supervisor', label: 'Supervisor -> Worker', tone: 'supervisor' };
  }
  if (turn.kind === 'assistant') {
    return { ...base, actor: 'worker', label: 'Worker message', title: 'Assistant message', tone: 'worker' };
  }
  if (turn.kind === 'tool_call') {
    return { ...base, actor: 'tool', label: 'Tool call', tone: 'tool' };
  }
  if (turn.kind === 'tool_result') {
    return {
      ...base,
      actor: 'tool',
      label: 'Tool result',
      tone: turn.status === 'failed' || turn.status === 'error' ? 'error' : 'success',
    };
  }
  if (turn.kind === 'error') {
    return { ...base, actor: 'error', label: 'Error', tone: 'error' };
  }
  if (turn.kind === 'final') {
    return { ...base, actor: 'result', label: 'Final response', tone: 'result' };
  }
  return {
    ...base,
    actor: 'status',
    label: 'Worker activity',
    title: turn.status ? titleCaseStatus(turn.status) : turn.title,
    status: null,
    tone: transcriptToneForStatus(turn.status ?? 'status'),
    subtle: true,
  };
}

function renderTranscriptBlocks(blocks: WatchTranscriptBlock[], width: number): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    if (lines.length > 0) lines.push('');
    const title = block.title && block.title !== block.label ? ` ${block.title}` : '';
    const status = block.status ? ` [${block.status}]` : '';
    const timestamp = block.timestamp ? ` @ ${block.timestamp}` : '';
    const metadata = block.metadata.length > 0 ? ` (${block.metadata.join(' | ')})` : '';
    lines.push(`${block.label}${title}${status}${timestamp}${metadata}`);
    const bodyLines = renderMarkdownToAnsi(block.body, Math.max(20, width - 4));
    for (const line of bodyLines) lines.push(`  ${line}`);
  }
  return lines.length > 0 ? lines : [''];
}

function emptyTranscriptBlock(): WatchTranscriptBlock {
  return {
    id: 'empty',
    actor: 'system',
    label: 'Watch',
    title: 'No sessions',
    timestamp: null,
    status: null,
    body: 'No orchestrator sessions are available.',
    round: null,
    tone: 'status',
    subtle: true,
    metadata: [],
  };
}

function maxWatchTranscriptScroll(model: WatchViewModel, state: WatchDashboardState, width: number, height: number): number {
  return Math.max(0, selectedWatchTranscriptLines(model, state, width).length - Math.max(1, height));
}

function duplicateLastAssistantIndex(turns: WatchTranscriptEvent[], summary: string): number {
  const normalizedSummary = normalizeComparableText(summary);
  if (!normalizedSummary) return -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.kind !== 'assistant') continue;
    return normalizeComparableText(turn.body) === normalizedSummary ? index : -1;
  }
  return -1;
}

function transcriptToneForStatus(status: string): WatchTranscriptTone {
  const normalized = status.toLowerCase();
  if (['failed', 'error', 'timed_out', 'cancelled', 'orphaned', 'attention', 'stale'].includes(normalized)) return 'error';
  if (['running', 'in_progress', 'waiting_for_user', 'reasoning', 'queued'].includes(normalized)) return 'running';
  if (['completed', 'complete', 'success', 'succeeded', 'done', 'idle'].includes(normalized)) return 'success';
  return 'status';
}

function titleCaseStatus(status: string): string {
  return status
    .replaceAll('_', ' ')
    .replaceAll(/\b\w/g, (char) => char.toUpperCase());
}

function isTerminalRunStatus(status: string): boolean {
  return ['completed', 'failed', 'timed_out', 'cancelled', 'orphaned'].includes(status);
}

function mouseButtonScrollDelta(button: number, step: number): number {
  if ((button & 64) !== 64) return 0;
  const direction = button & 3;
  if (direction === 0) return step;
  if (direction === 1) return -step;
  return 0;
}

function summarizeToolUse(payload: Record<string, unknown>): { title: string; body: string } {
  const name = toolName(payload);
  const action = toolAction(payload);
  const target = toolTarget(payload);
  const duration = durationText(payload);
  return {
    title: `${name}${action ? `: ${action}` : ''}${duration ? ` (${duration})` : ''}`,
    body: target || compactJson(payload.input ?? payload, 500) || '(tool call)',
  };
}

function summarizeToolResult(payload: Record<string, unknown>): { title: string; body: string; status: string | null } {
  const name = toolName(payload);
  const status = toolStatus(payload);
  const duration = durationText(payload);
  const errors = errorsFromPayload(payload);
  const text = errors[0]
    ?? stringFromRecord(payload, 'text')
    ?? stringFromRecord(payload, 'message')
    ?? stringFromRecord(payload, 'output')
    ?? stringFromRecord(payload, 'result')
    ?? textFromContent(payload.content)
    ?? textFromContent(getRecord(payload.message)?.content)
    ?? compactJson(payload, 500);
  return {
    title: `${name} result${status ? ` [${status}]` : ''}${duration ? ` (${duration})` : ''}`,
    body: compactText(text || '(no output)', 1000),
    status,
  };
}

function toolName(payload: Record<string, unknown>): string {
  return stringFromRecord(payload, 'name')
    ?? stringFromRecord(payload, 'tool_name')
    ?? stringFromRecord(payload, 'toolName')
    ?? stringFromRecord(payload, 'tool')
    ?? stringFromRecord(payload, 'type')
    ?? 'tool';
}

function toolAction(payload: Record<string, unknown>): string | null {
  const input = getRecord(payload.input) ?? getRecord(payload.arguments) ?? getRecord(payload.args);
  return stringFromRecord(payload, 'command')
    ?? stringFromRecord(input, 'command')
    ?? stringFromRecord(input, 'cmd')
    ?? stringFromRecord(input, 'file_path')
    ?? stringFromRecord(input, 'path')
    ?? stringFromRecord(payload, 'command')
    ?? null;
}

function toolTarget(payload: Record<string, unknown>): string | null {
  const input = getRecord(payload.input) ?? getRecord(payload.arguments) ?? getRecord(payload.args);
  const command = stringFromRecord(input, 'command') ?? stringFromRecord(payload, 'command');
  if (command) return command;
  const path = stringFromRecord(input, 'file_path') ?? stringFromRecord(input, 'path') ?? stringFromRecord(payload, 'path');
  if (path) return path;
  return stringFromRecord(input, 'description') ?? stringFromRecord(payload, 'description');
}

function toolStatus(payload: Record<string, unknown>): string | null {
  if (payload.is_error === true || payload.error === true) return 'error';
  return stringFromRecord(payload, 'status') ?? stringFromRecord(payload, 'state') ?? stringFromRecord(payload, 'outcome');
}

function durationText(payload: Record<string, unknown>): string | null {
  const raw = numberFromRecord(payload, 'duration_ms') ?? numberFromRecord(payload, 'durationMs') ?? numberFromRecord(payload, 'elapsed_ms');
  if (raw === null) return null;
  return raw >= 1000 ? `${(raw / 1000).toFixed(1)}s` : `${raw}ms`;
}

function lifecycleStatus(payload: Record<string, unknown>): string | null {
  const raw = stringFromRecord(payload, 'status')
    ?? stringFromRecord(payload, 'state')
    ?? stringFromRecord(payload, 'subtype')
    ?? stringFromRecord(payload, 'type');
  if (!raw || raw === 'result_event') return null;
  if (raw === 'thinking' || raw === 'reasoning') return 'reasoning';
  return raw;
}

function lifecycleBody(payload: Record<string, unknown>): string {
  const resultEvent = resultEventLifecycleBody(payload);
  if (resultEvent) return resultEvent;
  const message = stringFromRecord(payload, 'message') ?? stringFromRecord(payload, 'summary') ?? stringFromRecord(payload, 'warning');
  if (message) return message;
  const usage = getRecord(payload.usage) ?? getRecord(payload.modelUsage);
  if (usage) return compactJson(usage, 500);
  return '';
}

function compactLifecyclePayload(payload: Record<string, unknown>): string {
  const resultEvent = resultEventLifecycleBody(payload);
  if (resultEvent) return resultEvent;
  const summary = compactJson(payload, 300);
  return summary === '{}' ? '' : summary;
}

function resultEventLifecycleBody(payload: Record<string, unknown>): string | null {
  if (payload.state !== 'result_event') return null;
  const raw = getRecord(payload.raw);
  if (!raw) return null;
  const subtype = stringFromRecord(raw, 'subtype') ?? stringFromRecord(raw, 'type');
  const duration = durationText(raw);
  const turns = numberFromRecord(raw, 'num_turns');
  const stop = stringFromRecord(raw, 'stop_reason') ?? stringFromRecord(raw, 'stopReason');
  const status = raw.is_error === true ? 'error' : subtype;
  return [
    status ? `status ${status}` : null,
    duration ? `duration ${duration}` : null,
    turns !== null ? `${turns} ${turns === 1 ? 'turn' : 'turns'}` : null,
    stop ? `stop ${stop}` : null,
  ].filter((value): value is string => Boolean(value)).join(' · ') || null;
}

function isUsefulLifecycleStatus(status: string, body: string): boolean {
  if (body.trim()) return true;
  const noisy = new Set(['started', 'running', 'completed', 'complete', 'initialized', 'init', 'result_event']);
  return !noisy.has(status.toLowerCase());
}

function conversationKey(run: ObservabilityRun, runsById: Map<string, ObservabilityRun>): string {
  const orchestratorId = orchestratorIdFromMetadata(run.run.metadata) ?? 'none';
  const root = rootRun(run, runsById);
  if (root.run.run_id !== run.run.run_id || !run.run.parent_run_id) return `conversation:${orchestratorId}:${root.run.run_id}`;
  const session = run.session.effective_session_id ?? run.run.observed_session_id ?? run.run.requested_session_id ?? run.run.session_id;
  if (session) return `conversation:${orchestratorId}:${run.run.backend}:session:${session}`;
  if (run.run.parent_run_id) return `conversation:${orchestratorId}:${run.run.parent_run_id}`;
  return `conversation:${orchestratorId}:${run.run.run_id}`;
}

function rootRun(run: ObservabilityRun, runsById: Map<string, ObservabilityRun>): ObservabilityRun {
  let current = run;
  const seen = new Set<string>();
  while (current.run.parent_run_id && !seen.has(current.run.run_id)) {
    seen.add(current.run.run_id);
    const parent = runsById.get(current.run.parent_run_id);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function isLiveOrchestrator(group: ObservabilityOrchestratorGroup): boolean {
  return group.live && group.status?.state !== 'stale';
}

function isExpanded(orchestrator: WatchOrchestrator, state: WatchDashboardState): boolean {
  return state.expanded[orchestrator.id] ?? true;
}

function orchestratorItemId(orchestrator: WatchOrchestrator): string {
  return `orchestrator:${orchestrator.id}`;
}

function conversationItemId(conversation: WatchConversation): string {
  return `conversation:${conversation.orchestratorId}:${conversation.rootRunId}`;
}

function compareRunCreatedAt(a: ObservabilityRun, b: ObservabilityRun): number {
  return a.run.created_at.localeCompare(b.run.created_at);
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

function maxIso(values: string[]): string {
  return values.filter(Boolean).sort().at(-1) ?? '';
}

function orchestratorIdFromMetadata(metadata: Record<string, unknown> | undefined): string | null {
  const value = metadata?.orchestrator_id;
  return typeof value === 'string' && value.trim() ? value : null;
}

function formatModelName(run: ObservabilityRun): string {
  return formatModelLike(run.model.name);
}

function formatModelLike(value: string | null): string {
  return value ?? 'default';
}

function formatTimestamp(value: string): string {
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

function textFromContent(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const rec = getRecord(item);
    const text = stringFromRecord(rec, 'text') ?? stringFromRecord(rec, 'content');
    if (text) parts.push(text);
  }
  return parts.join('\n').trim() || null;
}

function errorsFromPayload(payload: Record<string, unknown>): string[] {
  const raw = payload.errors;
  if (!Array.isArray(raw)) return [];
  const errors: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') errors.push(item);
    else {
      const rec = getRecord(item);
      const message = stringFromRecord(rec, 'message') ?? stringFromRecord(rec, 'text');
      if (message) errors.push(message);
    }
  }
  return errors;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function stringFromRecord(value: unknown, key: string): string | null {
  const rec = getRecord(value);
  const raw = rec?.[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function numberFromRecord(value: unknown, key: string): number | null {
  const rec = getRecord(value);
  const raw = rec?.[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function compactJson(value: unknown, maxLength: number): string {
  try {
    return compactText(JSON.stringify(value), maxLength);
  } catch {
    return '';
  }
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, Math.max(0, maxLength - 3))}...` : compact;
}

function normalizeComparableText(value: string): string {
  return stripAnsi(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
