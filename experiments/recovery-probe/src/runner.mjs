// The command under test. It writes its side effect first, records a claim so a
// restarted worker can fence it by token and pid, sleeps, then records its
// terminal result. A kill before the result write leaves no outcome on disk.

import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const effects = opt('--effects');
const sleepMs = Number(opt('--sleep') ?? '0');
const exitCode = Number(opt('--exit') ?? '0');
const claimPath = opt('--claim');
const resultPath = opt('--result');
const token = opt('--token');

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, path);
}

appendFileSync(effects, `executed ${token} ${Date.now()}\n`);
writeAtomic(claimPath, { token, pid: process.pid, startedAt: Date.now() });

await new Promise((resolve) => setTimeout(resolve, sleepMs));

writeAtomic(resultPath, { code: exitCode, signal: null, endedAt: Date.now(), token });
process.exit(exitCode);
