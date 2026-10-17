/**
 * Side-effect fixture. Appends exactly one line to the given path, optionally
 * sleeps, then exits 0. The line count is the evidence that a command ran an
 * exact number of times.
 */
import { appendFileSync } from 'node:fs';

const [path, sleepMs] = process.argv.slice(2);
appendFileSync(path, `tick ${process.pid}\n`);
if (sleepMs !== undefined) {
  await new Promise((resolve) => setTimeout(resolve, Number(sleepMs)));
}
