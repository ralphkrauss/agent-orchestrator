import { Writable } from 'node:stream';
import * as readline from 'node:readline';

export class PromptNotInteractiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptNotInteractiveError';
  }
}

export interface PromptOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Read a single line from the controlling terminal without echoing the typed
 * characters. The returned string is the raw input minus the terminating
 * newline; callers are expected to `trim()` and validate.
 *
 * Throws {@link PromptNotInteractiveError} when stdin or stdout is not a TTY,
 * since piped input would otherwise leak the secret into the terminal.
 */
export async function promptSecret(question: string, options: PromptOptions = {}): Promise<string> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const inputIsTty = (input as NodeJS.ReadStream).isTTY === true;
  const outputIsTty = (output as NodeJS.WriteStream).isTTY === true;
  if (!inputIsTty || !outputIsTty) {
    throw new PromptNotInteractiveError(
      'interactive auth requires a TTY; use --from-env or --from-stdin in scripts',
    );
  }

  const muted = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Allow newline / carriage return through so the cursor still advances
      // when the user presses enter; everything else (the typed characters
      // that readline echoes back) is swallowed.
      const passthrough = text.replace(/[^\r\n]/g, '');
      if (passthrough.length > 0) {
        (output as NodeJS.WritableStream).write(passthrough);
      }
      callback();
    },
  });

  // Write the prompt directly so the question text is visible.
  output.write(question);

  const rl = readline.createInterface({
    input,
    output: muted,
    terminal: true,
  });

  try {
    return await new Promise<string>((resolveLine, rejectLine) => {
      rl.once('line', (line) => resolveLine(line));
      rl.once('close', () => rejectLine(new Error('input stream closed before a line was read')));
    });
  } finally {
    rl.close();
  }
}
