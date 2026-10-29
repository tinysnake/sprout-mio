import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const iterations = Number(process.env.R2_Z_ITERATIONS ?? 12);
assert(Number.isInteger(iterations) && iterations >= 1 && iterations <= 30);
const source = readFileSync("scripts/verify/z-lease-integration.sh", "utf8");
const start = "node --input-type=module <<'NODE'\n";
const stop =
  "  browser = await chromium.launch(); context = await browser.newContext({viewport:{width:1440,height:1000}});";
assert.equal(source.split(start).length, 2);
assert.equal(source.split(stop).length, 2);
let code = source.split(start)[1].split(stop)[0];
if (process.env.R2_Z_INJECT_CONFLICT === "1") {
  const online =
    "  await until(async () => (await call('getMachineFn',{machineId})).connection.kind==='online','Worker online');";
  assert.equal(code.split(online).length, 2);
  code = code.replace(
    online,
    online +
      `
  const beforeConflict = await call('getMachineFn', {machineId,projectId});
  assert.equal(beforeConflict.bindings[0].observation, null, 'inject before the first directory observation');
  await call('saveProjectMachineBindingFn', {machineId,projectId,description:'revision changes after configuration',expectedRevision:1});
  console.log('R2_INJECTED_BINDING_REVISION_2');
`,
  );
}
code += `
  const detail = await call('getMachineFn', {machineId, projectId});
  const binding = detail.bindings.find(binding => binding.intent.projectId === projectId);
  assert.equal(detail.connection.kind, 'online');
  assert.equal(binding.observation.current, true);
  assert.equal(binding.observation.fact.generation, detail.connection.generation);
  assert.equal(binding.observation.fact.bindingRevision, binding.intent.revision);
  assert.equal(binding.observation.fact.revision, detail.machine.rootRevision);
  assert.equal(binding.observation.fact.result.kind, 'accessible');
  console.log('R2_STARTUP_CURRENT ' + JSON.stringify({generation: detail.connection.generation, rootRevision: detail.machine.rootRevision, bindingRevision: binding.intent.revision}));
`;
code += source.slice(source.indexOf("} catch(error) {"), source.lastIndexOf("\nNODE"));
const diagnostic = `
  if (existsSync(env.DATABASE_URL)) {
    const diagnosticDb = new Sqlite(env.DATABASE_URL, {readonly:true});
    try {
      console.log('R2_DIAGNOSTIC ' + JSON.stringify({
        memberships: diagnosticDb.prepare('SELECT epoch,state FROM project_machine_membership').all(),
        bindings: diagnosticDb.prepare('SELECT revision FROM project_machine').all(),
        observations: diagnosticDb.prepare('SELECT generation,revision,seq,kind,reason FROM directory_observation').all(),
        frames: diagnosticDb.prepare('SELECT connection_generation,max(seq) AS seq FROM worker_exchange_frame GROUP BY connection_generation').all(),
        connection: diagnosticDb.prepare('SELECT generation,closed_at FROM machine_connection').all(),
      }));
      console.log('R2_WORKER_LOG ' + readFileSync(join(privateDir,'worker.log'),'utf8'));
    } finally { diagnosticDb.close(); }
  }
`;
code = code.replace(
  "  rmSync(privateDir,{recursive:true,force:true});",
  diagnostic + "\n  rmSync(privateDir,{recursive:true,force:true});",
);
let failed = 0;
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const started = performance.now();
  const result = spawnSync(process.execPath, ["--input-type=module"], {
    input: code,
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 4 * 1024 * 1024,
  });
  console.log(
    JSON.stringify({
      iteration,
      durationMs: Math.round(performance.now() - started),
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message,
    }),
  );
  console.log(result.stdout);
  if (result.status !== 0) {
    console.error(result.stderr);
    failed += 1;
    break;
  }
}
assert.equal(failed, 0, "z startup failed; inspect R2_DIAGNOSTIC and R2_WORKER_LOG");
