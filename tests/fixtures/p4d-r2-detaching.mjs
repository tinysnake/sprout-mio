import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

assert(process.env.DATABASE_URL, "use an isolated temporary DATABASE_URL");
let source = readFileSync(new URL("./p4d-removal.ts", import.meta.url), "utf8");
const generated = new URL(`./.p4d-r2-detaching-${process.pid}.ts`, import.meta.url);
function replaceOnce(before, after) {
  assert.equal(source.split(before).length, 2, before);
  source = source.replace(before, after);
}
replaceOnce(
  "const scenario = process.argv[2];",
  'const scenario = "detach";\nlet r2Probe: (() => unknown) | undefined;',
);
replaceOnce(
  "  const { session, secret } = workerConnection(holder, key.machineId, ticket);",
  '  const root = saveMachineRootDirectory({machineId:key.machineId, directory:"/tmp", expectedRevision:1}, holder);\n  const { session, secret } = workerConnection(holder, key.machineId, ticket);',
);
replaceOnce(
  "        observations: [],",
  '        observations: [{machineId:key.machineId, projectId:key.projectId, generation:session.generation, bindingRevision:1, revision:root.revision, seq, checkedAt:holder.now.toISOString(), result:{kind:"accessible",realPath:"/tmp"}}],',
);
replaceOnce(
  "  exchange();\n  const execution",
  "  r2Probe = exchange;\n  exchange();\n  const execution",
);
replaceOnce(
  "  const pendingView = detach(busy.key, human());",
  `  assert.equal(getMachine({machineId:busy.machineId}, busyHolder).bindings[0]?.observation?.current, true);
  const pendingView = detach(busy.key, human());
  assert.equal(getMachine({machineId:busy.machineId}, busyHolder).bindings[0]?.observation, null);
  assert.throws(() => r2Probe!(), fails("conflict"));
  assert.equal(getMachine({machineId:busy.machineId}, busyHolder).bindings[0]?.observation, null);
  console.log("r2-detaching: PASS active fact cleared before detaching completes, same-revision probe rejected while detaching");`,
);
try {
  writeFileSync(generated, source);
  await import(generated.href);
} finally {
  unlinkSync(generated);
}
