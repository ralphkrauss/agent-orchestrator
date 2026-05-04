import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import type { WorkerBackend, WorkerInvocation, BackendStartInput, FinalizeContext, FinalizedWorkerResult, ParsedBackendEvent } from './WorkerBackend.js';
import { WorkerResultSchema, type Backend, type RunError, type RunErrorCategory, type RunErrorSource } from '../contract.js';
import { deriveObservedResult } from './resultDerivation.js';

export async function resolveBinary(
  binary: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const pathValue = env.PATH ?? env.Path ?? '';
  const candidates = binary.includes('/') || binary.includes('\\')
    ? [binary]
    : pathValue.split(pathDelimiter(platform)).filter(Boolean).flatMap((dir) => binaryCandidates(dir, binary, platform, env));

  for (const candidate of candidates) {
    try {
      const path = isAbsolute(candidate) ? candidate : join(process.cwd(), candidate);
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Continue searching PATH.
    }
  }

  return null;
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : delimiter;
}

function binaryCandidates(dir: string, binary: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const exact = join(dir, binary);
  if (platform !== 'win32' || extname(binary)) return [exact];

  const extensions = (env.PATHEXT || env.Pathext || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);
  return [exact, ...extensions.map((extension) => join(dir, `${binary}${extension}`))];
}

export function invocation(
  command: string,
  args: string[],
  input: BackendStartInput,
): WorkerInvocation {
  return {
    command,
    args,
    cwd: input.cwd,
    stdinPayload: input.prompt,
  };
}

export function emptyParsedEvent(): ParsedBackendEvent {
  return {
    events: [],
    filesChanged: [],
    commandsRun: [],
    errors: [],
  };
}

export function finalizeFromObserved(context: FinalizeContext): FinalizedWorkerResult {
  const validationError = context.resultEvent || context.runStatusOverride ? null : {
    message: 'worker result event missing',
    context: { exit_code: context.exitCode, signal: context.signal },
  };
  const errors = validationError ? [...context.errors, validationError] : [...context.errors];
  const derived = deriveObservedResult({
    exitCode: context.exitCode,
    resultEventPresent: context.resultEvent !== null,
    resultEventValid: context.resultEvent !== null,
    stopReason: context.resultEvent?.stopReason ?? null,
    runStatusOverride: context.runStatusOverride,
  });

  const files = Array.from(new Set([...context.filesChangedFromGit, ...context.filesChangedFromEvents])).sort();
  const commands = Array.from(new Set(context.commandsRun));
  const resultSummary = context.resultEvent?.summary.trim() ? context.resultEvent.summary : null;
  const fallbackSummary = context.lastAssistantMessage?.trim() ? context.lastAssistantMessage : null;
  const summary = context.runStatusOverride
    ? actionableErrorSummary(errors)
    : resultSummary ?? fallbackSummary ?? actionableErrorSummary(errors);
  const result = WorkerResultSchema.parse({
    status: derived.workerStatus,
    summary,
    files_changed: files,
    commands_run: commands,
    artifacts: context.artifacts,
    errors,
  });

  return { runStatus: derived.runStatus, result };
}

function actionableErrorSummary(errors: { message: string }[]): string {
  return errors.find((error) => !genericResultErrors.has(error.message))?.message
    ?? errors[0]?.message
    ?? '';
}

const genericResultErrors = new Set([
  'worker process exited unsuccessfully',
  'worker result event missing',
]);

export abstract class BaseBackend implements WorkerBackend {
  abstract readonly name: WorkerBackend['name'];
  abstract readonly binary: string;
  abstract start(input: BackendStartInput): Promise<WorkerInvocation>;
  abstract resume(sessionId: string, input: BackendStartInput): Promise<WorkerInvocation>;
  abstract parseEvent(raw: unknown): ParsedBackendEvent;

  finalizeResult(context: FinalizeContext): FinalizedWorkerResult {
    return finalizeFromObserved(context);
  }
}

export function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        const rec = getRecord(item);
        return rec ? getString(rec.text) ?? getString(rec.content) : undefined;
      })
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  const rec = getRecord(value);
  if (rec) return getString(rec.text) ?? getString(rec.content);
  return undefined;
}

export function errorFromEvent(record: Record<string, unknown>, backend: Backend): RunError | null {
  const nestedError = getRecord(record.error);
  const message =
    getString(nestedError?.message)
    ?? getString(record.message)
    ?? (typeof record.error === 'string' ? record.error : undefined);
  if (!message) return null;

  const context: Record<string, unknown> = {};
  const status = record.status;
  if (typeof status === 'string' || typeof status === 'number') context.status = status;
  const type = getString(nestedError?.type) ?? getString(record.type);
  if (type) context.type = type;
  const code = getString(nestedError?.code) ?? getString(record.code);
  if (code) context.code = code;
  return classifyBackendError({
    backend,
    source: 'backend_event',
    message,
    context: Object.keys(context).length > 0 ? context : undefined,
  });
}

export function classifyBackendError(input: {
  backend: Backend;
  source: RunErrorSource;
  message: string;
  context?: Record<string, unknown>;
}): RunError {
  const category = classifyErrorCategory(input.message, input.context);
  return {
    message: input.message,
    category,
    source: input.source,
    backend: input.backend,
    retryable: category === 'rate_limit' || category === 'backend_unavailable',
    fatal: category !== 'unknown',
    context: input.context,
  };
}

function classifyErrorCategory(message: string, context: Record<string, unknown> | undefined): RunErrorCategory {
  const normalizedMessage = message.toLowerCase();
  const code = stringContext(context, 'code').toLowerCase();
  const type = stringContext(context, 'type').toLowerCase();
  const status = stringContext(context, 'status').toLowerCase();
  const structured = [code, type, status].join(' ');
  const haystack = [normalizedMessage, structured].join(' ');

  if (/\b(auth|authentication|unauthorized|unauthorised|credential|api key|login)\b/.test(haystack)) return 'auth';
  if (/\b(rate.?limit|too many requests|429)\b/.test(haystack)) return 'rate_limit';
  if (/\b(quota|insufficient_quota|billing|credit|credits)\b/.test(haystack)) return 'quota';
  if (/\b(invalid.?model|unknown model|model .*not found|model .*does not exist|model .*not supported|unsupported model)\b/.test(haystack)) return 'invalid_model';
  if (/\b(permission denied|access denied|not allowed|policy|forbidden)\b/.test(haystack)) return 'permission';
  if (isProtocolError(normalizedMessage, structured, status)) return 'protocol';
  if (isBackendUnavailableError(normalizedMessage, structured, status)) return 'backend_unavailable';
  return 'unknown';
}

function isProtocolError(message: string, structured: string, status: string): boolean {
  return status === '400'
    || /\b(?:invalid[_-]request|bad[_-]request|schema[_-]validation|json[_-]parse)(?:[_-]error)?\b/.test(structured)
    || /\b(protocol error|schema validation|schema error|malformed|invalid request|bad request|json parse|parse error|failed to parse|invalid json|unexpected token)\b/.test(message);
}

function isBackendUnavailableError(message: string, structured: string, status: string): boolean {
  return ['500', '502', '503', '504'].includes(status)
    || /\b(econnrefused|econnreset|econnaborted|etimedout|(?:service[_-]unavailable|backend[_-]unavailable)(?:[_-]error)?)\b/.test(structured)
    || /\b(service unavailable|backend unavailable|network error|connection refused|connection reset|connection failed|connection timed out|request timed out|timeout exceeded|econnrefused|econnreset|etimedout)\b/.test(message);
}

function stringContext(context: Record<string, unknown> | undefined, key: string): string {
  const value = context?.[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

export function pathFromToolInput(input: unknown): string[] {
  const rec = getRecord(input);
  if (!rec) return [];
  return [
    getString(rec.file_path),
    getString(rec.path),
    getString(rec.file),
  ].filter((item): item is string => Boolean(item));
}

export function commandFromToolInput(input: unknown): string[] {
  const rec = getRecord(input);
  if (!rec) return [];
  return [
    getString(rec.command),
    getString(rec.cmd),
  ].filter((item): item is string => Boolean(item));
}
