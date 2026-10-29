import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CI_GROUPS, validateGateTargets } from "./lib/targets-plan.mjs";
import { UNIT_TARGETS, validateUnitTargets } from "./lib/test-targets.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "verify-targets-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inventory = validateGateTargets(root);
  for (const id of new Set([...inventory.ci, ...inventory.local])) {
    const file = join(directory, "scripts/verify", `${id}.sh`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
  for (const file of Object.values(UNIT_TARGETS).flat()) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), "");
  }
  for (const file of [
    "targets.mjs",
    "test-target.mjs",
    "lib/targets-plan.mjs",
    "lib/test-targets.mjs",
  ]) {
    mkdirSync(dirname(join(directory, "scripts/verify", file)), { recursive: true });
    cpSync(join(root, "scripts/verify", file), join(directory, "scripts/verify", file));
  }
  return directory;
}
function call(directory, entry, args, env = {}) {
  return spawnSync(process.execPath, [join(directory, "scripts/verify", entry), ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, ...env },
  });
}

await test("every gate and unit file has an explicit target; only split A/B overlap", () => {
  const inventory = validateGateTargets(root);
  assert.deepEqual(inventory.ci.filter((id) => inventory.local.includes(id)).sort(), [
    "a-base",
    "b-tooling",
  ]);
  assert.deepEqual(validateUnitTargets(root).local, [
    "tests/extension-mcp.test.ts",
    "tests/machine-worker.test.ts",
  ]);
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert(workflow.includes(`group: [${Object.keys(CI_GROUPS).join(", ")}]`));
});

await test("unclassified gates and test files fail before any command executes", (t) => {
  const directory = fixture(t);
  writeFileSync(join(directory, "tests/new-platform.test.ts"), "");
  const result = call(directory, "targets.mjs", ["ci", "--group", "docs"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unit test inventory changed/);
  assert.equal(existsSync(join(directory, ".verify")), false);
  rmSync(join(directory, "tests/new-platform.test.ts"));
  writeFileSync(join(directory, "scripts/verify/new-platform.sh"), "");
  assert.throws(() => validateGateTargets(directory), /gate inventory changed/);
});

await test("CI continues after a failing gate and reports its real failure within its assigned group", (t) => {
  const directory = fixture(t);
  writeFileSync(
    join(directory, "scripts/verify/runner.mjs"),
    `
    import {appendFileSync} from 'node:fs';
    const id=process.argv.at(-1);appendFileSync('calls',JSON.stringify({id,target:process.env.SPROUT_VERIFY_TARGET})+'\\n');
    process.exit(id==='f-docs'?7:0);
  `,
  );
  const result = call(directory, "targets.mjs", ["ci", "--group", "docs"]);
  assert.equal(result.status, 1, result.stderr);
  const calls = readFileSync(join(directory, "calls"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    calls,
    CI_GROUPS.docs.map((id) => ({ id, target: "ci" })),
  );
  const report = JSON.parse(readFileSync(join(directory, ".verify/targets/ci-docs.json"), "utf8"));
  assert.deepEqual(
    report.outcomes.map(({ code }) => code),
    [7, 0, 0],
  );
});

await test("local execution selects only the local gates as a single pooled invocation", (t) => {
  const directory = fixture(t);
  writeFileSync(
    join(directory, "scripts/verify/runner.mjs"),
    `
    import {writeFileSync} from 'node:fs';
    writeFileSync('calls',JSON.stringify({args:process.argv.slice(2),target:process.env.SPROUT_VERIFY_TARGET}));
  `,
  );
  const result = call(directory, "targets.mjs", ["local"]);
  assert.equal(result.status, 0, result.stderr);
  const calls = JSON.parse(readFileSync(join(directory, "calls"), "utf8"));
  assert.equal(calls.target, "local");
  assert.deepEqual(calls.args, ["--only", validateGateTargets(root).local.join(",")]);
});

await test("CI unit selection excludes native/Pi files and removes inherited real Pi settings", (t) => {
  const directory = fixture(t);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const executable = join(bin, "pnpm");
  writeFileSync(
    executable,
    `#!${process.execPath}\nimport('node:fs').then(({writeFileSync})=>{writeFileSync('calls',JSON.stringify({args:process.argv.slice(2),mcp:process.env.MCP_EVERYTHING,agent:process.env.PI_CODING_AGENT_DIR,pi:process.env.PI_MCP_MODULE}));process.exit(7)});\n`,
  );
  chmodSync(executable, 0o755);
  const result = call(directory, "test-target.mjs", ["ci"], {
    PATH: `${bin}:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: "/real-agent",
    PI_MCP_MODULE: "/real-module",
    MCP_EVERYTHING: "1",
  });
  assert.equal(result.status, 7, result.stderr);
  const calls = JSON.parse(readFileSync(join(directory, "calls"), "utf8"));
  assert.deepEqual(calls.args.slice(0, 6), ["exec", "vp", "test", "run", "--maxWorkers", "2"]);
  assert.deepEqual(calls.args.slice(6), UNIT_TARGETS.ci);
  assert.equal(calls.mcp, "0");
  assert.equal(calls.pi, undefined);
  assert.notEqual(calls.agent, "/real-agent");
  assert.equal(existsSync(calls.agent), false);
});
