import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import type { WorkerBackend, WorkerInvocation, BackendStartInput, FinalizeContext, FinalizedWorkerResult, ParsedBackendEvent } from './WorkerBackend.js';
import { WorkerResultSchema } from '../contract.js';
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
  };
}

export function finalizeFromObserved(context: FinalizeContext): FinalizedWorkerResult {
  const validationError = context.resultEvent ? null : {
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
  const summary = context.resultEvent?.summary ?? '';
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
