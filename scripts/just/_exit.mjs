import { constants } from 'node:os';

export function exitFromChild(child) {
  if (child.error) {
    process.stderr.write(`${child.error.message}\n`);
    process.exit(1);
  }
  if (typeof child.status === 'number') {
    process.exit(child.status);
  }
  if (child.signal) {
    if (process.platform === 'win32') {
      process.exit(1);
    }
    const number = constants.signals[child.signal];
    process.exit(typeof number === 'number' ? 128 + number : 1);
  }
  process.exit(1);
}
