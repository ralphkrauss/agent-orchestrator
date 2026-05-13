import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useWindowSize, type Instance } from 'ink';
import type { SnapshotEnvelope } from './observabilityFormat.js';
import {
  applyWatchRawInput,
  buildWatchViewModel,
  clampWatchDashboardState,
  createWatchDashboardState,
  renderMarkdownToAnsi,
  selectWatchSidebarItemAt,
  selectedWatchSidebarItem,
  selectedWatchTranscriptBlocks,
  watchMouseClickPosition,
  watchSidebarItems,
  type WatchDashboardState,
  type WatchSidebarItem,
  type WatchTranscriptBlock,
  type WatchViewModel,
} from './watchViewModel.js';

interface RunWatchTuiOptions {
  initialEnvelope: SnapshotEnvelope;
  readSnapshot: () => Promise<SnapshotEnvelope>;
  intervalMs: number;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

const MOUSE_ENABLE_SEQUENCE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007h\x1b[?1015h';
const MOUSE_DISABLE_SEQUENCE = '\x1b[?1015l\x1b[?1007l\x1b[?1006l\x1b[?1002l\x1b[?1000l';
const SCREEN_ENTER_SEQUENCE = '\x1b[?1049h';
const SCREEN_EXIT_SEQUENCE = '\x1b[?1049l';

interface WatchAppProps {
  initialEnvelope: SnapshotEnvelope;
  readSnapshot: () => Promise<SnapshotEnvelope>;
  intervalMs: number;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  onQuit?: () => void;
}

export async function runWatchTui(options: RunWatchTuiOptions): Promise<void> {
  let instance: Instance | null = null;
  let quitRequested = false;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const mouseEnabled = Boolean(stdout.isTTY);
  const rawModeSupported = Boolean(stdin.isTTY && typeof stdin.setRawMode === 'function');
  const stdinWasRaw = Boolean(stdin.isRaw);
  const requestQuit = () => {
    if (quitRequested) return;
    quitRequested = true;
    instance?.unmount();
  };
  try {
    if (rawModeSupported) {
      stdin.setRawMode(true);
      stdin.resume();
    }
    if (mouseEnabled) stdout.write(SCREEN_ENTER_SEQUENCE);
    instance = render(
      <WatchApp
        initialEnvelope={options.initialEnvelope}
        readSnapshot={options.readSnapshot}
        intervalMs={options.intervalMs}
        stdin={stdin}
        stdout={stdout}
        onQuit={requestQuit}
      />,
      {
        stdin,
        stdout,
        stderr,
        exitOnCtrlC: false,
        incrementalRendering: true,
        interactive: true,
        maxFps: 60,
      },
    );
    await instance.waitUntilExit();
  } finally {
    if (mouseEnabled) stdout.write(`${MOUSE_DISABLE_SEQUENCE}${SCREEN_EXIT_SEQUENCE}`);
    if (rawModeSupported && !stdinWasRaw) stdin.setRawMode(false);
    if (rawModeSupported) stdin.pause();
    instance?.cleanup();
  }
}

export function WatchApp({ initialEnvelope, readSnapshot, intervalMs, stdin, stdout, onQuit }: WatchAppProps): React.ReactElement {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [envelope, setEnvelope] = useState(initialEnvelope);
  const [state, setState] = useState<WatchDashboardState>(() => createWatchDashboardState());
  const [mouseCapture, setMouseCapture] = useState(() => Boolean(stdout?.isTTY));
  const model = useMemo(() => buildWatchViewModel(envelope), [envelope]);
  const clamped = clampWatchDashboardState(state, model);
  const stateRef = useRef(clamped);
  const width = Math.max(60, columns || process.stdout.columns || 100);
  const height = Math.max(12, rows || process.stdout.rows || 30);
  const sidebarWidth = Math.min(46, Math.max(28, Math.floor(width * 0.34)));
  const mainWidth = Math.max(30, width - sidebarWidth - 4);
  const mainContentWidth = Math.max(20, mainWidth - 7);
  const bodyHeight = Math.max(5, height - (model.error ? 4 : 3));
  const transcriptHeight = Math.max(1, bodyHeight - 2);
  const selectedItem = useMemo(() => selectedWatchSidebarItem(model, clamped), [model, clamped.mode, clamped.selectedId]);
  const mainSurface = selectedItem?.kind === 'conversation' ? 'chat' : 'overview';
  const transcriptBlocks = useMemo(() => selectedWatchTranscriptBlocks(model, clamped), [model, clamped.mode, clamped.selectedId]);
  const transcriptRows = useMemo(() => transcriptRowsFromBlocks(transcriptBlocks, mainContentWidth, mainSurface), [transcriptBlocks, mainContentWidth, mainSurface]);
  const transcriptMaxScroll = Math.max(0, transcriptRows.length - transcriptHeight);
  const visibleTranscript = useMemo(
    () => visibleRows(transcriptRows, clamped, transcriptHeight, mainSurface === 'chat'),
    [transcriptRows, clamped.follow, clamped.scrollOffset, transcriptHeight, mainSurface],
  );

  useEffect(() => {
    stateRef.current = clamped;
  }, [clamped]);

  useEffect(() => {
    if (!stdout?.isTTY) return;
    stdout.write(mouseCapture ? MOUSE_ENABLE_SEQUENCE : MOUSE_DISABLE_SEQUENCE);
  }, [stdout, mouseCapture]);

  useEffect(() => {
    let cancelled = false;
    let timer: NodeJS.Timeout | null = null;
    const refresh = async () => {
      try {
        const next = await readSnapshot();
        if (!cancelled) {
          setEnvelope((current) => envelopeDisplayKey(current) === envelopeDisplayKey(next) ? current : next);
        }
      } finally {
        if (!cancelled) timer = setTimeout(refresh, intervalMs);
      }
    };
    timer = setTimeout(refresh, intervalMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs, readSnapshot]);

  useEffect(() => {
    const next = clampWatchDashboardState(state, model);
    if (next.selectedId !== state.selectedId || next.follow !== state.follow || next.scrollOffset !== state.scrollOffset) {
      setState(next);
    }
  }, [model, state]);

  useEffect(() => {
    if (!stdin?.isTTY) return;
    const inputStream = stdin;
    const onData = (chunk: Buffer | string) => {
      const input = chunk.toString();
      const clickedRow = sidebarItemIndexFromMouse(input, sidebarWidth, bodyHeight, Boolean(model.error));
      if (clickedRow !== null) {
        const nextState = selectWatchSidebarItemAt(stateRef.current, model, clickedRow);
        stateRef.current = nextState;
        setState(nextState);
        return;
      }

      const result = applyWatchRawInput(stateRef.current, model, input, mainWidth - 2, transcriptHeight, transcriptMaxScroll);
      stateRef.current = result.state;
      if (result.quit) {
        exit();
        onQuit?.();
        return;
      }
      if (result.toggleMouseCapture) setMouseCapture((current) => !current);
      setState(result.state);
    };
    inputStream.on('data', onData);
    return () => {
      inputStream.off('data', onData);
    };
  }, [stdin, exit, onQuit, model, mainWidth, transcriptHeight, transcriptMaxScroll]);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Header model={model} state={clamped} />
      {model.error ? <Text color="red">error: {model.error}</Text> : null}
      <Box flexDirection="row" height={bodyHeight}>
        <Sidebar model={model} state={clamped} width={sidebarWidth} height={bodyHeight} />
        <MainPane rows={visibleTranscript} width={mainWidth} contentWidth={mainContentWidth} height={bodyHeight} state={clamped} totalRows={transcriptRows.length} surface={mainSurface} selected={selectedItem} />
      </Box>
      <Footer state={clamped} mouseCapture={mouseCapture} />
    </Box>
  );
}

function Header({ model, state }: { model: WatchViewModel; state: WatchDashboardState }): React.ReactElement {
  const modeCount = state.mode === 'live' ? model.live.length : model.archive.length;
  return (
    <Box>
      <Text bold color="cyan">agent-orchestrator watch</Text>
      <Text color={model.running ? 'green' : 'yellow'}> {model.running ? 'running' : 'stopped'}</Text>
      <Text dimColor>  live </Text>
      <Text color="green">{model.live.length}</Text>
      <Text dimColor>  archive </Text>
      <Text color="yellow">{model.archive.length}</Text>
      <Text dimColor>  {state.mode} </Text>
      <Text>{modeCount}</Text>
    </Box>
  );
}

function Sidebar({ model, state, width, height }: { model: WatchViewModel; state: WatchDashboardState; width: number; height: number }): React.ReactElement {
  const items = watchSidebarItems(model, state);
  const contentHeight = Math.max(1, height - 3);
  const rows = items.slice(0, contentHeight);
  const title = state.mode === 'live' ? 'Live orchestrators' : 'Archive';
  const renderedRows = rows.length === 0
    ? [<Text key="empty" dimColor>{state.mode === 'live' ? 'No live sessions.' : 'No archived sessions.'}</Text>]
    : rows.map((item) => <SidebarRow key={item.id} item={item} selected={item.id === state.selectedId} state={state} />);
  while (renderedRows.length < contentHeight) {
    renderedRows.push(<Text key={`pad:${renderedRows.length}`}> </Text>);
  }
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color={state.mode === 'live' ? 'green' : 'yellow'}>{title}</Text>
      {renderedRows}
    </Box>
  );
}

function SidebarRow({ item, selected, state }: { item: WatchSidebarItem; selected: boolean; state: WatchDashboardState }): React.ReactElement {
  if (item.kind === 'orchestrator') {
    const expanded = state.expanded[item.orchestrator.id] ?? true;
    return (
      <SelectedText selected={selected}>
        {selected ? '>' : ' '} {expanded ? 'v' : '+'} {statusLabel(item.orchestrator.status)} {item.orchestrator.runningCount}/{item.orchestrator.workerCount} {plainSidebarText(item.orchestrator.label)}
      </SelectedText>
    );
  }

  const conversation = item.conversation!;
  return (
    <SelectedText selected={selected} dim={!selected}>
      {'  '}{selected ? '>' : ' '} {statusLabel(conversation.status)} {conversation.workerName}  {plainSidebarText(conversation.title)}
    </SelectedText>
  );
}

function SelectedText({ selected, dim, children }: { selected: boolean; dim?: boolean; children: React.ReactNode }): React.ReactElement {
  return (
    <Text color={selected ? 'black' : undefined} backgroundColor={selected ? 'cyan' : undefined} bold={selected} dimColor={dim} wrap="truncate">
      {children}
    </Text>
  );
}

function plainSidebarText(value: string): string {
  return stripAnsiForDisplay(value)
    .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replaceAll(/`([^`]*)`/g, '$1')
    .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
    .replaceAll(/\*([^*]+)\*/g, '$1')
    .replaceAll(/__([^_]+)__/g, '$1')
    .replaceAll(/_([^_]+)_/g, '$1')
    .replaceAll(/[>#]/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function stripAnsiForDisplay(value: string): string {
  return value.replaceAll(/\x1b\[[0-9;]*m/g, '');
}

function MainPane({
  rows,
  width,
  contentWidth,
  height,
  state,
  totalRows,
  surface,
  selected,
}: {
  rows: TranscriptRow[];
  width: number;
  contentWidth: number;
  height: number;
  state: WatchDashboardState;
  totalRows: number;
  surface: 'overview' | 'chat';
  selected: WatchSidebarItem | null;
}): React.ReactElement {
  const followColor = state.follow ? 'green' : 'yellow';
  const borderColor = surface === 'overview' ? 'blue' : followColor;
  const viewportRows = Math.max(1, rows.length);
  const scroll = scrollMetrics(state, totalRows, viewportRows, surface === 'chat');
  const title = surface === 'overview'
    ? 'Overview'
    : `Timeline${selected?.conversation ? `: ${selected.conversation.workerName}` : ''}`;
  const status = surface === 'overview' ? 'DASHBOARD' : state.follow ? 'FOLLOW latest' : `SCROLLED +${state.scrollOffset}`;
  const header = `${title}  ${status}  ${scroll.label}  ${totalRows} rows`;
  const contentHeight = Math.max(1, height - 2);
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle={surface === 'overview' ? 'double' : 'single'} borderColor={borderColor} paddingX={1}>
      <Box width={contentWidth} height={1}>
        <Text bold color={surface === 'overview' ? 'blue' : 'cyan'} wrap="truncate">{header}</Text>
      </Box>
      <Box flexDirection="row" height={contentHeight}>
        <Box flexDirection="column" width={contentWidth}>
          <Text> </Text>
          {rows.map((row) => (
            <TranscriptRowView key={row.id} row={row} surface={surface} />
          ))}
        </Box>
        <ScrollIndicator height={viewportRows} metrics={scroll} activeColor={followColor} />
      </Box>
    </Box>
  );
}

function Footer({ state, mouseCapture }: { state: WatchDashboardState; mouseCapture: boolean }): React.ReactElement {
  return (
    <Text dimColor>
      Up/Down j/k/click select | wheel/u/d scroll | m {mouseCapture ? 'text' : 'wheel'} | Space | Tab {state.mode === 'live' ? 'archive' : 'live'} | q quit
    </Text>
  );
}

function sidebarItemIndexFromMouse(input: string, sidebarWidth: number, bodyHeight: number, hasErrorLine: boolean): number | null {
  const click = watchMouseClickPosition(input);
  if (!click || click.x < 1 || click.x > sidebarWidth) return null;
  const bodyTop = hasErrorLine ? 3 : 2;
  const rowIndex = click.y - bodyTop - 2;
  const contentHeight = Math.max(1, bodyHeight - 3);
  return rowIndex >= 0 && rowIndex < contentHeight ? rowIndex : null;
}

type TranscriptRow =
  | { id: string; kind: 'pad' }
  | { id: string; kind: 'spacer' }
  | { id: string; kind: 'chatHeader'; block: WatchTranscriptBlock; text: string }
  | { id: string; kind: 'chatBody'; block: WatchTranscriptBlock; text: string }
  | { id: string; kind: 'overviewTitle'; block: WatchTranscriptBlock; title: string; status: string | null }
  | { id: string; kind: 'overviewMetric'; block: WatchTranscriptBlock; metrics: string[] }
  | { id: string; kind: 'overviewSection'; text: string }
  | { id: string; kind: 'overviewWorker'; block: WatchTranscriptBlock; name: string; status: string; meta: string }
  | { id: string; kind: 'overviewField'; block: WatchTranscriptBlock; label: string; text: string }
  | { id: string; kind: 'overviewMeta'; block: WatchTranscriptBlock; text: string };

function TranscriptRowView({ row, surface }: { row: TranscriptRow; surface: 'overview' | 'chat' }): React.ReactElement {
  if (row.kind === 'pad' || row.kind === 'spacer') return <Text> </Text>;
  if (surface === 'overview') return <OverviewRowView row={row} />;

  return <ChatRowView row={row} />;
}

function ChatRowView({ row }: { row: TranscriptRow }): React.ReactElement {
  if (row.kind !== 'chatHeader' && row.kind !== 'chatBody') return <Text> </Text>;

  const color = transcriptColor(row.block);
  const railColor = runRailColor(row.block);
  if (row.kind === 'chatHeader') {
    const badge = chatBadge(row.block);
    return (
      <Text wrap="wrap">
        <Text color={railColor}>┃</Text>
        <Text> </Text>
        <Text color="black" backgroundColor={color} bold>{badge}</Text>
        <Text color={color} bold> {row.text}</Text>
      </Text>
    );
  }

  return (
    <Text wrap="wrap">
      <Text color={railColor}>┃</Text>
      <Text color={color} dimColor> │ </Text>
      <Text color={row.block.tone === 'result' ? 'white' : row.block.subtle ? 'gray' : undefined} bold={row.block.tone === 'result'}>{row.text}</Text>
    </Text>
  );
}

function OverviewRowView({ row }: { row: TranscriptRow }): React.ReactElement {
  if (row.kind === 'overviewSection') {
    return (
      <Text wrap="truncate">
        <Text color="gray">─ </Text>
        <Text color="blue" bold>{row.text}</Text>
        <Text color="gray"> </Text>
      </Text>
    );
  }
  if (
    row.kind !== 'overviewTitle'
    && row.kind !== 'overviewMetric'
    && row.kind !== 'overviewWorker'
    && row.kind !== 'overviewField'
    && row.kind !== 'overviewMeta'
  ) {
    return <Text> </Text>;
  }

  if (row.kind === 'overviewTitle') {
    return (
      <Text wrap="truncate">
        <Text color={transcriptColor(row.block)} bold>● </Text>
        <Text bold>{row.title}</Text>
        {row.status ? <Text color={transcriptColor(row.block)} bold>  {row.status}</Text> : null}
      </Text>
    );
  }

  if (row.kind === 'overviewMetric') {
    return (
      <Text wrap="truncate">
        <Text color="gray">  </Text>
        {row.metrics.map((metric, index) => (
          <React.Fragment key={`${row.id}:${index}`}>
            {index > 0 ? <Text color="gray">  ·  </Text> : null}
            <Text color="cyan">{metricLabel(metric)}</Text>
            <Text>{metricValue(metric)}</Text>
          </React.Fragment>
        ))}
      </Text>
    );
  }

  if (row.kind === 'overviewWorker') {
    const color = transcriptColor(row.block);
    return (
      <Text wrap="truncate">
        <Text color={color} bold>{statusDot(row.block)} </Text>
        <Text bold>{row.name}</Text>
        <Text color={color} bold>  {row.status}</Text>
        {row.meta ? <Text color="gray">  {row.meta}</Text> : null}
      </Text>
    );
  }

  if (row.kind === 'overviewField') {
    const label = row.label ? `${row.label}:`.padEnd(11, ' ') : ''.padEnd(11, ' ');
    return (
      <Text wrap="truncate">
        <Text color="gray">  │ </Text>
        <Text color="cyan" bold>{label}</Text>
        <Text>{row.text}</Text>
      </Text>
    );
  }

  return (
    <Text wrap="truncate">
      <Text color="gray">    {row.text}</Text>
    </Text>
  );
}

function transcriptRowsFromBlocks(blocks: WatchTranscriptBlock[], width: number, surface: 'overview' | 'chat'): TranscriptRow[] {
  if (surface === 'overview') return overviewRowsFromBlocks(blocks, width);
  return chatRowsFromBlocks(blocks, width);
}

function chatRowsFromBlocks(blocks: WatchTranscriptBlock[], width: number): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const bodyWidth = Math.max(1, width - 4);
  for (const [blockIndex, block] of blocks.entries()) {
    if (blockIndex > 0) rows.push({ id: `${block.id}:spacer`, kind: 'spacer' });
    const headerWidth = Math.max(1, width - displayWidth(`┃ ${chatBadge(block)} `));
    const headerLines = wrapPlainLine(transcriptHeaderText(block), headerWidth);
    for (const [lineIndex, line] of headerLines.entries()) {
      rows.push({ id: `${block.id}:header:${lineIndex}`, kind: 'chatHeader', block, text: line });
    }
    const bodyLines = renderMarkdownToAnsi(block.body, Math.max(20, bodyWidth));
    for (const [lineIndex, line] of bodyLines.entries()) {
      const wrapped = wrapPlainLine(stripAnsiForDisplay(line), bodyWidth);
      for (const [wrapIndex, wrappedLine] of wrapped.entries()) {
        rows.push({ id: `${block.id}:body:${lineIndex}:${wrapIndex}`, kind: 'chatBody', block, text: wrappedLine });
      }
    }
  }
  return rows.length > 0 ? rows : [{ id: 'empty', kind: 'pad' }];
}

function overviewRowsFromBlocks(blocks: WatchTranscriptBlock[], width: number): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const [session, ...workers] = blocks;
  if (!session) return [{ id: 'empty', kind: 'pad' }];

  rows.push({
    id: `${session.id}:title`,
    kind: 'overviewTitle',
    block: session,
    title: session.title || session.label,
    status: session.status,
  });

  const sessionFields = overviewFieldMap(session.body);
  const metrics = [
    overviewMetricText('Workers', sessionFields),
    overviewMetricText('Open', sessionFields),
    overviewMetricText('Last update', sessionFields),
  ].filter((value): value is string => Boolean(value));
  for (const [index, metric] of metrics.entries()) {
    rows.push({ id: `${session.id}:metrics:${index}`, kind: 'overviewMetric', block: session, metrics: [metric] });
  }
  const workspace = sessionFields.get('Workspace');
  if (workspace) appendOverviewFieldRows(rows, session, 'Workspace', workspace, width);

  rows.push({ id: `${session.id}:spacer`, kind: 'spacer' });
  rows.push({ id: `${session.id}:workers`, kind: 'overviewSection', text: 'Workers' });
  rows.push({ id: `${session.id}:workers:spacer`, kind: 'spacer' });

  for (const [index, worker] of workers.entries()) {
    const fields = overviewFieldMap(worker.body);
    const runs = fields.get('Runs');
    const meta = [...worker.metadata, runs ? formatRunCount(runs) : null].filter((value): value is string => Boolean(value)).join('  ·  ');
    if (index > 0) rows.push({ id: `${worker.id}:spacer`, kind: 'spacer' });
    rows.push({
      id: `${worker.id}:worker`,
      kind: 'overviewWorker',
      block: worker,
      name: worker.label,
      status: worker.title,
      meta: '',
    });
    if (meta) appendOverviewMetaRows(rows, worker, meta, width);
    const task = fields.get('Task');
    if (task) appendOverviewFieldRows(rows, worker, 'Task', task, width);
    const latest = fields.get('Latest');
    if (latest) appendOverviewFieldRows(rows, worker, 'Now', latest, width);
  }

  return rows.length > 0 ? rows : [{ id: 'empty', kind: 'pad' }];
}

function appendOverviewFieldRows(rows: TranscriptRow[], block: WatchTranscriptBlock, label: string, value: string, width: number): void {
  const bodyWidth = Math.max(10, width - 16);
  const lines = wrapPlainLine(value, bodyWidth);
  for (const [index, line] of lines.entries()) {
    rows.push({
      id: `${block.id}:field:${label}:${index}`,
      kind: 'overviewField',
      block,
      label: index === 0 ? label : '',
      text: line,
    });
  }
}

function appendOverviewMetaRows(rows: TranscriptRow[], block: WatchTranscriptBlock, value: string, width: number): void {
  const bodyWidth = Math.max(10, width - 8);
  const lines = wrapPlainLine(value, bodyWidth);
  for (const [index, line] of lines.entries()) {
    rows.push({
      id: `${block.id}:meta:${index}`,
      kind: 'overviewMeta',
      block,
      text: line,
    });
  }
}

function overviewFieldMap(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of body.split('\n')) {
    const match = /^([^:]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    fields.set(match[1]!, match[2] ?? '');
  }
  return fields;
}

function overviewMetricText(label: string, fields: Map<string, string>): string | null {
  const value = fields.get(label);
  return value ? `${label}: ${value}` : null;
}

function formatRunCount(value: string): string {
  const count = Number(value);
  if (!Number.isFinite(count)) return `${value} runs`;
  return count === 1 ? '1 run' : `${count} runs`;
}

function transcriptHeaderText(block: WatchTranscriptBlock): string {
  const timestamp = block.timestamp ? shortTimestamp(block.timestamp) : null;
  const title = block.title && block.title !== block.label ? block.title : null;
  return [
    title ?? block.label,
    block.status,
    block.round ? `Run ${block.round}` : null,
    ...block.metadata,
    timestamp,
  ].filter((value): value is string => Boolean(value)).join('  ');
}

function chatBadge(block: WatchTranscriptBlock): string {
  if (block.actor === 'supervisor') return ' SUPERVISOR → WORKER ';
  if (block.actor === 'worker') return ' WORKER MESSAGE ';
  if (block.actor === 'result') return ' FINAL RESPONSE ';
  if (block.actor === 'tool') return ' TOOL ';
  if (block.actor === 'run') return ' RUN ';
  if (block.actor === 'status') return ' ACTIVITY ';
  if (block.actor === 'error') return ' ERROR ';
  return ' INFO ';
}

function statusDot(block: WatchTranscriptBlock): string {
  if (block.tone === 'running') return '●';
  if (block.tone === 'success') return '✓';
  if (block.tone === 'error') return '!';
  if (block.tone === 'result') return '◆';
  return '•';
}

function metricLabel(metric: string): string {
  const index = metric.indexOf(':');
  return index === -1 ? '' : `${metric.slice(0, index)}: `;
}

function metricValue(metric: string): string {
  const index = metric.indexOf(':');
  return index === -1 ? metric : metric.slice(index + 1).trimStart();
}

function wrapPlainLine(line: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  if (displayWidth(line) <= maxWidth) return [line];

  const rows: string[] = [];
  let remaining = line;
  while (displayWidth(remaining) > maxWidth) {
    const breakAt = wrapIndex(remaining, maxWidth);
    rows.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).replace(/^\s+/, '');
  }
  rows.push(remaining);
  return rows;
}

function wrapIndex(value: string, width: number): number {
  let visible = 0;
  let index = 0;
  let lastSpace = -1;
  for (const char of value) {
    const next = visible + charWidth(char);
    if (next > width) break;
    if (char === ' ' && visible > 0) lastSpace = index + char.length;
    visible = next;
    index += char.length;
  }
  if (index >= value.length) return value.length;
  if (lastSpace > 0) return lastSpace;
  return Math.max(1, index);
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) width += charWidth(char);
  return width;
}

function charWidth(char: string): number {
  if (/[\u0000-\u001f\u007f]/.test(char)) return 0;
  return 1;
}

function visibleRows(rows: TranscriptRow[], state: WatchDashboardState, height: number, alignBottom: boolean): TranscriptRow[] {
  const visibleHeight = Math.max(1, height);
  const maxStart = Math.max(0, rows.length - visibleHeight);
  const start = alignBottom
    ? state.follow ? maxStart : Math.max(0, maxStart - state.scrollOffset)
    : state.follow ? 0 : Math.min(maxStart, state.scrollOffset);
  const visible = rows.slice(start, start + visibleHeight);
  const padCount = Math.max(0, visibleHeight - visible.length);
  const padding = Array.from({ length: padCount }, (_, index) => ({ id: `pad:${index}`, kind: 'pad' as const }));
  return alignBottom ? [...padding, ...visible] : [...visible, ...padding];
}

interface ScrollMetrics {
  maxScroll: number;
  start: number;
  thumbStart: number;
  thumbSize: number;
  label: string;
}

function scrollMetrics(state: WatchDashboardState, totalRows: number, viewportRows: number, alignBottom: boolean): ScrollMetrics {
  const visibleRowsCount = Math.max(1, viewportRows);
  const maxScroll = Math.max(0, totalRows - visibleRowsCount);
  const start = alignBottom
    ? state.follow ? maxScroll : Math.max(0, maxScroll - state.scrollOffset)
    : state.follow ? 0 : Math.min(maxScroll, state.scrollOffset);
  const trackRows = visibleRowsCount;
  const thumbSize = totalRows <= visibleRowsCount
    ? trackRows
    : Math.max(1, Math.floor(trackRows * visibleRowsCount / Math.max(1, totalRows)));
  const thumbStart = maxScroll === 0
    ? 0
    : Math.round((trackRows - thumbSize) * (start / maxScroll));
  const percent = maxScroll === 0 ? 100 : Math.round((start / maxScroll) * 100);
  const end = Math.min(totalRows, start + visibleRowsCount);
  const position = maxScroll === 0
    ? 'all'
    : start === 0
      ? 'top'
      : start >= maxScroll
        ? 'bottom'
        : `${percent}%`;
  const label = `${position} ${start + 1}-${end}/${totalRows}`;
  return { maxScroll, start, thumbStart, thumbSize, label };
}

function ScrollIndicator({ height, metrics, activeColor }: { height: number; metrics: ScrollMetrics; activeColor: string }): React.ReactElement {
  const rows = Array.from({ length: Math.max(1, height) }, (_, index) => {
    const active = index >= metrics.thumbStart && index < metrics.thumbStart + metrics.thumbSize;
    return (
      <Text key={index} backgroundColor={active ? activeColor : undefined} color={active ? activeColor : 'gray'}>
        {active ? ' ' : '|'}
      </Text>
    );
  });
  return <Box flexDirection="column" width={1}>{rows}</Box>;
}

function transcriptColor(block: WatchTranscriptBlock): string {
  if (block.tone === 'supervisor') return 'cyan';
  if (block.tone === 'worker') return 'green';
  if (block.tone === 'tool') return 'yellow';
  if (block.tone === 'success') return 'green';
  if (block.tone === 'running') return 'blue';
  if (block.tone === 'error') return 'red';
  if (block.tone === 'result') return 'magenta';
  return 'gray';
}

function runRailColor(block: WatchTranscriptBlock): string {
  if (block.round === null) return 'gray';
  const colors = ['cyan', 'magenta', 'green', 'yellow', 'blue'];
  return colors[(block.round - 1) % colors.length]!;
}

function statusLabel(status: string): string {
  if (status === 'running' || status === 'in_progress') return '[run]';
  if (status === 'completed' || status === 'idle') return '[ok]';
  if (status === 'waiting_for_user') return '[wait]';
  if (status === 'failed' || status === 'timed_out' || status === 'cancelled' || status === 'orphaned' || status === 'attention' || status === 'stale') return '[err]';
  return `[${status}]`;
}

function shortTimestamp(value: string): string {
  const match = /\b\d{2}:\d{2}:\d{2}/.exec(value);
  return match?.[0] ?? value;
}

function envelopeDisplayKey(envelope: SnapshotEnvelope): string {
  const { generated_at: _generatedAt, ...snapshot } = envelope.snapshot;
  return JSON.stringify({ running: envelope.running, error: envelope.error ?? null, snapshot });
}
