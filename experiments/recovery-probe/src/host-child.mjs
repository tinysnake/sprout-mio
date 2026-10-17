// A host process that survives only to be killed, used to inject a real host
// restart. It records intent before submitting, links the execution id, then
// holds the connection open until the harness kills it.

import { HostJournal, WorkerClient } from './host.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const port = Number(opt('--port'));
const journalPath = opt('--journal');
const requestId = opt('--request');
const effects = opt('--effects');
const sleepMs = Number(opt('--sleep') ?? '0');

const fingerprint = { executable: 'recovery-runner', effects, sleepMs, exitCode: 0 };
const journal = new HostJournal(journalPath);
journal.intent(requestId, fingerprint);

const client = new WorkerClient();
await client.connect(port);
const accepted = await client.request({ kind: 'submit', requestId, fingerprint, effects, sleepMs, exitCode: 0 });
journal.linked(requestId, accepted.executionId);

console.log(`SUBMITTED ${accepted.executionId}`);
setInterval(() => {}, 1 << 30);
