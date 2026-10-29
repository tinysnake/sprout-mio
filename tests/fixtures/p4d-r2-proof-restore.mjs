import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

assert(
  process.env.DATABASE_URL,
  "run with DATABASE_URL pointing to an isolated temporary database",
);
const sourcePath = new URL("./p4d-authority.ts", import.meta.url);
const generated = new URL(`./.p4d-r2-proof-${process.pid}.ts`, import.meta.url);
let source = readFileSync(sourcePath, "utf8");
const capture =
  "// Remove only third's historical command proof, retaining matching row/session/origin identity.";
const close = "sqlite.close();";
assert.equal(source.split(capture).length, 2);
assert.equal(source.split(close).length, 2);
source = source.replace(
  capture,
  `
const originalProofs = db.select().from(workerExchangeFrame).all();
const thirdCommand = dispatched.find((x) => x.executionId === third.executionId)!;
const originalThird = sqlite.prepare("SELECT state,drained_at FROM remote_execution WHERE id=?").get(third.executionId);
assert.throws(() => sqlite.prepare("DELETE FROM worker_exchange_frame WHERE machine_id=? AND connection_generation=? AND seq=?").run(thirdCommand.machineId, session.generation, thirdCommand.dispatchSeq), /FOREIGN KEY/);
${capture}`,
);
source = source.replace(
  close,
  `
assert.deepEqual(sqlite.prepare("SELECT state,drained_at FROM remote_execution WHERE id=?").get(third.executionId), originalThird);
for (const frame of originalProofs) {
  db.update(workerExchangeFrame).set({responseJson: frame.responseJson}).where(and(eq(workerExchangeFrame.machineId, frame.machineId), eq(workerExchangeFrame.connectionGeneration, frame.connectionGeneration), eq(workerExchangeFrame.seq, frame.seq))).run();
}
seq -= 1; // The rejected transaction did not consume an exchange sequence.
const restoredResponse = exchange([terminal(dispatched.find((x) => x.executionId === third.executionId)!)]);
assert.deepEqual(restoredResponse.remote.resultAcks, [{executionId: third.executionId, disposition: "accepted"}]);
assert.equal(getExecution({...key, executionId: third.executionId}, human).state, "succeeded");
assert.notEqual(sqlite.prepare("SELECT drained_at FROM remote_execution WHERE id=?").get(third.executionId).drained_at, originalThird.drained_at);
console.log("r2-proof-restore: PASS frame FK retention, failed proof leaves drainedAt unchanged, restored historical proof promotes worker_lost to its real outcome");
${close}`,
);
try {
  writeFileSync(generated, source);
  await import(generated.href);
} finally {
  unlinkSync(generated);
}
