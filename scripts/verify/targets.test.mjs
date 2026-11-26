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
import {
  CI_GROUPS,
  CONTAINER_GROUPS,
  PORTABLE_GROUPS,
  validateGateTargets,
} from "./lib/targets-plan.mjs";
import {
  CI_UNIT_SHARDS,
  UNIT_TARGETS,
  unitExecution,
  unitShardFiles,
  validateUnitTargets,
} from "./lib/test-targets.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "verify-targets-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inventory = validateGateTargets(root);
  for (const id of new Set([...inventory.ci, ...inventory.local, ...inventory.manual])) {
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
    "lib/suite-plan.mjs",
    "lib/native-lanes.mjs",
    "lib/sandbox.mjs",
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
function jobBlock(workflow, name) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `ci.yml must define the ${name} job`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}
function matrixGroups(workflow, name) {
  const block = jobBlock(workflow, name);
  const match = block.match(/group:\s*\[([\s\S]*?)\]/);
  assert(match, `the ${name} job must declare its gate groups`);
  return match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

await test("every gate and unit file has an explicit target; only split A/B overlap", () => {
  const inventory = validateGateTargets(root);
  assert.deepEqual(inventory.ci.filter((id) => inventory.local.includes(id)).sort(), [
    "a-base",
    "b-tooling",
  ]);
  assert.deepEqual(inventory.manual, ["p8d-windows-worker", "p8d-windows-integration"]);
  for (const id of inventory.manual) {
    assert(!inventory.ci.includes(id));
    assert(!inventory.local.includes(id));
  }
  assert.deepEqual(validateUnitTargets(root).local, [
    "tests/agent-prompt-runner.test.ts",
    "tests/memory-runner.test.ts",
    "tests/assistant-watch-summary-pi.test.ts",
    "tests/chat-skills-foundation.test.ts",
    "tests/chat-skills-delivery.test.ts",
    "tests/chat-skills-spans.test.ts",
    "tests/extension-mcp.test.ts",
    "tests/machine-worker.test.ts",
    "tests/worker-report-budget.test.ts",
  ]);
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const listed = [
    ...matrixGroups(workflow, "portable"),
    ...matrixGroups(workflow, "portableBrowser"),
  ];
  assert.equal(listed.length, Object.keys(CI_GROUPS).length);
  assert.deepEqual(new Set(listed), new Set(Object.keys(CI_GROUPS)));
  assert.deepEqual(matrixGroups(workflow, "portable"), [...PORTABLE_GROUPS]);
  assert.deepEqual(matrixGroups(workflow, "portableBrowser"), [...CONTAINER_GROUPS]);
});

await test("browser groups install the lockfile's Chromium before verification", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const browser = jobBlock(workflow, "portableBrowser");
  assert.doesNotMatch(browser, /^\s+container:/m);
  const groups = matrixGroups(workflow, "portableBrowser");
  assert(!groups.includes("base") && !groups.includes("tooling"));
  assert.match(
    browser,
    /run: pnpm install --frozen-lockfile\b[\s\S]*run: pnpm exec playwright install --with-deps chromium\b[\s\S]*name: Verify assigned gates/,
  );
  assert.doesNotMatch(jobBlock(workflow, "portable"), /playwright install/);
});

await test("CI runner fails when a selected gate skips", (t) => {
  const directory = fixture(t);
  const scripts = join(directory, "scripts/verify");
  cpSync(join(root, "scripts/verify/runner.mjs"), join(scripts, "runner.mjs"));
  cpSync(join(root, "scripts/verify/lib"), join(scripts, "lib"), { recursive: true });
  const gate = join(scripts, "prerequisite-probe.sh");
  const args = ["--only", "prerequisite-probe"];
  writeFileSync(gate, "exit 77\n");
  const ci = call(directory, "runner.mjs", args, { SPROUT_VERIFY_TARGET: "ci" });
  assert.equal(ci.status, 1, ci.stderr);
  assert.match(ci.stdout, /skipped=1/);
  assert.match(ci.stderr, /FAIL CI requires every selected gate to pass/);
  const local = call(directory, "runner.mjs", args, { SPROUT_VERIFY_TARGET: "local" });
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /skipped=1/);
  writeFileSync(gate, "exit 0\n");
  const passed = call(directory, "runner.mjs", args, { SPROUT_VERIFY_TARGET: "ci" });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /skipped=0/);
});

await test("unit shards are deterministic, disjoint, and complete", () => {
  const files = validateUnitTargets(root).ci;
  const shards = Array.from({ length: CI_UNIT_SHARDS }, (_, index) =>
    unitShardFiles(files, `${index + 1}/${CI_UNIT_SHARDS}`),
  );
  assert.equal(new Set(shards.flat()).size, files.length);
  assert.deepEqual(new Set(shards.flat()), new Set(files));
  assert(shards.every((shard) => shard.length > 0));
  assert.throws(() => unitShardFiles(files, "5/4"), /Expected --shard/);
});

function summary(env) {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const script = jobBlock(workflow, "verify")
    .split("        run: |\n")[1]
    .split("\n      - name:")[0]
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
  return spawnSync("bash", ["-e", "-c", script], {
    env: {
      ...process.env,
      PORTABLE_RESULT: "success",
      BROWSER_RESULT: "success",
      UNIT_RESULT: "success",
      CI_CANCELLED: "false",
      ...env,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
}

await test("required summary rejects unsuccessful, absent, and multiple job results", () => {
  assert.equal(summary({}).status, 0);
  for (const field of ["PORTABLE_RESULT", "BROWSER_RESULT", "UNIT_RESULT"]) {
    for (const result of ["skipped", "cancelled", "failure", "timed_out", ""]) {
      const failure = summary({ [field]: result });
      assert.equal(failure.status, 1);
      assert.match(failure.stderr, /FAIL required job/);
    }
  }
  assert.equal(
    summary({
      PORTABLE_RESULT: "failure",
      BROWSER_RESULT: "cancelled",
      UNIT_RESULT: "skipped",
    }).stderr.match(/FAIL required job/g).length,
    3,
  );
});

await test("workflow runs every unit shard independently and always checks required results", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  for (const name of ["portable", "portableBrowser", "portableUnits"])
    assert.doesNotMatch(jobBlock(workflow, name), /^\s+needs:/m);
  const units = jobBlock(workflow, "portableUnits");
  assert.match(units, /shard: \[1, 2, 3, 4\]/);
  assert.match(units, /pnpm test:ci --shard/);
  assert.match(units, /fail-fast: false/);
  const summary = jobBlock(workflow, "verify");
  assert.deepEqual(summary.match(/needs: \[(.*?)\]/)[1].split(", "), [
    "portable",
    "portableBrowser",
    "portableUnits",
  ]);
  assert.deepEqual(
    [...summary.matchAll(/if: (.*)/g)].map((match) => match[1]),
    ["always()", "always()", "cancelled()"],
  );
  assert.match(summary, /require_success portableUnits/);
});

await test("workflow rejects cancellation using a supported step condition", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const rejection = jobBlock(workflow, "verify").split("- name: Reject cancelled workflow")[1];
  assert.match(rejection, /if: cancelled\(\)/);
  const script = rejection.split("        run: |\n")[1];
  const result = spawnSync("bash", ["-e", "-c", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL workflow cancelled/);
  assert.doesNotMatch(workflow, /CI_CANCELLED:.*cancelled\(\)/);
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

await test("a planned sandbox gate the sandbox whitelist omits fails before any command runs", (t) => {
  const directory = fixture(t);
  const file = join(directory, "scripts/verify/lib/sandbox.mjs");
  writeFileSync(file, readFileSync(file, "utf8").replace(/\n  "bf-p6b-pages",/, ""));
  assert.throws(() => validateGateTargets(directory), /does not whitelist it/);
  const result = call(directory, "targets.mjs", ["ci", "--group", "docs"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /does not whitelist it/);
  assert.equal(existsSync(join(directory, ".verify")), false);
});

await test("a CI group runs as one serial runner and its failure reaches the job", (t) => {
  const directory = fixture(t);
  writeFileSync(
    join(directory, "scripts/verify/runner.mjs"),
    `
    import {appendFileSync} from 'node:fs';
    appendFileSync('calls',JSON.stringify({args:process.argv.slice(2),target:process.env.SPROUT_VERIFY_TARGET})+'\\n');
    process.exit(7);
  `,
  );
  const result = call(directory, "targets.mjs", ["ci", "--group", "docs"]);
  assert.equal(result.status, 1, result.stderr);
  const calls = readFileSync(join(directory, "calls"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls, [
    { args: ["--only", CI_GROUPS.docs.join(","), "--max-parallel", "1"], target: "ci" },
  ]);
  const report = JSON.parse(readFileSync(join(directory, ".verify/targets/ci-docs.json"), "utf8"));
  assert.deepEqual(
    report.outcomes.map(({ gates, code }) => ({ gates, code })),
    [{ gates: CI_GROUPS.docs, code: 7 }],
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
    `#!${process.execPath}\nimport('node:fs').then(({writeFileSync})=>{writeFileSync('calls',JSON.stringify({args:process.argv.slice(2),mcp:process.env.MCP_EVERYTHING,agent:process.env.PI_CODING_AGENT_DIR,pi:process.env.PI_MCP_MODULE,database:process.env.DATABASE_URL,piData:process.env.SPROUT_PI_DATA_DIR,repos:process.env.SPROUT_REPO_DIR,cache:process.env.XDG_CACHE_HOME}));process.exit(7)});\n`,
  );
  chmodSync(executable, 0o755);
  const result = call(directory, "test-target.mjs", ["ci"], {
    PATH: `${bin}:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: "/real-agent",
    PI_MCP_MODULE: "/real-module",
    MCP_EVERYTHING: "1",
    DATABASE_URL: "/foreign/database",
    SPROUT_PI_DATA_DIR: "/foreign/pi",
    SPROUT_REPO_DIR: "/foreign/repos",
    XDG_CACHE_HOME: "/foreign/cache",
  });
  assert.equal(result.status, 7, result.stderr);
  const calls = JSON.parse(readFileSync(join(directory, "calls"), "utf8"));
  assert.deepEqual(calls.args.slice(0, 6), ["exec", "vp", "test", "run", "--maxWorkers", "2"]);
  assert.deepEqual(
    calls.args.slice(6).filter((arg) => !arg.startsWith("--")),
    UNIT_TARGETS.ci,
  );
  assert.equal(calls.mcp, "0");
  assert.equal(calls.pi, undefined);
  assert.notEqual(calls.agent, "/real-agent");
  assert.equal(existsSync(calls.agent), false);
  for (const field of ["database", "piData", "repos", "cache"]) {
    assert.equal(dirname(calls[field]), dirname(calls.agent));
    assert(!calls[field].startsWith("/foreign"));
  }
});

await test("unit execution report must contain each planned exact path once", () => {
  const files = ["tests/first.test.ts", "tests/second.test.ts"];
  const report = {
    success: true,
    testResults: files.map((name) => ({ name: join(root, name) })),
    numTotalTests: 3,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
  };
  assert.equal(unitExecution(files, report, root).complete, true);
  assert.equal(
    unitExecution(files, { ...report, testResults: report.testResults.slice(0, 1) }, root).complete,
    false,
  );
  assert.equal(
    unitExecution(
      files,
      { ...report, testResults: [...report.testResults, report.testResults[0]] },
      root,
    ).complete,
    false,
  );
  assert.equal(unitExecution(files, report, root).success, true);
  for (const field of ["numFailedTests", "numPendingTests", "numTodoTests"])
    assert.equal(unitExecution(files, { ...report, [field]: 1 }, root).success, false);
  assert.equal(
    unitExecution(
      files,
      {
        ...report,
        testResults: [...report.testResults, { name: join(root, "tests/extra.test.ts") }],
      },
      root,
    ).complete,
    false,
  );
});

await test("B cannot omit units from an unplanned CI invocation", () => {
  const result = spawnSync("bash", ["scripts/verify/b-tooling.sh"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, SPROUT_VERIFY_TARGET: "ci", SPROUT_VERIFY_CI_UNITS: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires the validated independent unit plan/);
});

await test("ungrouped CI still runs all portable units after a failing gate batch", (t) => {
  const directory = fixture(t);
  for (const [file, code] of [
    ["runner.mjs", 7],
    ["test-target.mjs", 9],
  ]) {
    writeFileSync(
      join(directory, "scripts/verify", file),
      `
      import {appendFileSync} from 'node:fs';
      appendFileSync('calls', JSON.stringify(process.argv.slice(2))+'\\n');
      process.exit(${code});
    `,
    );
  }
  const result = call(directory, "targets.mjs", ["ci"]);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(readFileSync(join(directory, ".verify/targets/ci-all.json"), "utf8"));
  assert.deepEqual(
    report.outcomes.map(({ code }) => code),
    [7, 9],
  );
  assert.deepEqual(report.outcomes[1].command, ["scripts/verify/test-target.mjs", "ci"]);
  assert.equal(readFileSync(join(directory, "calls"), "utf8").trim().split("\n").length, 2);
});

await test("a unit shard selects only its exact paths and records its failed exit", (t) => {
  const directory = fixture(t);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pnpm"),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync('calls',JSON.stringify(process.argv.slice(2)));process.exit(7);`,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  const result = call(directory, "test-target.mjs", ["ci", "--shard", "2/4"], {
    PATH: `${bin}:${process.env.PATH}`,
  });
  assert.equal(result.status, 7, result.stderr);
  const report = JSON.parse(readFileSync(join(directory, ".verify/units/ci-2-of-4.json"), "utf8"));
  const args = JSON.parse(readFileSync(join(directory, "calls"), "utf8"));
  assert.deepEqual(
    args.slice(6).filter((arg) => !arg.startsWith("--")),
    unitShardFiles(UNIT_TARGETS.ci, "2/4"),
  );
  assert.deepEqual(
    report.files,
    args.slice(6).filter((arg) => !arg.startsWith("--")),
  );
  assert.equal(report.shard, "2/4");
  assert.equal(report.code, 7);
});

await test("unit CLI rejects a zero exit that omitted files or execution JSON", (t) => {
  const directory = fixture(t);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pnpm"),
    `#!${process.execPath}
    const fs=require('node:fs'), path=require('node:path');
    const args=process.argv.slice(2);
    const selected=args.slice(6).filter(arg=>!arg.startsWith('--'));
    const destination=args.find(arg=>arg.startsWith('--outputFile.json=')).slice('--outputFile.json='.length);
    if(process.env.FAKE_RESULT!=='absent') {
      fs.writeFileSync(destination,JSON.stringify({success:true,numTotalTests:selected.length,numFailedTests:0,numPendingTests:0,numTodoTests:0,testResults:(process.env.FAKE_RESULT==='partial'?selected.slice(1):selected).map(name=>({name:path.resolve(name)}))}));
    }
  `,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  for (const mode of ["complete", "partial", "absent"]) {
    const result = call(directory, "test-target.mjs", ["ci", "--shard", "1/4"], {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_RESULT: mode,
    });
    assert.equal(result.status, mode === "complete" ? 0 : 1, result.stderr);
    const report = JSON.parse(
      readFileSync(join(directory, ".verify/units/ci-1-of-4.json"), "utf8"),
    );
    assert.equal(report.code, 0);
    if (mode === "complete") assert.deepEqual(report.execution.executedFiles, report.files);
    else assert(report.executionError);
  }
});

await test("unit termination forwards the signal and cannot turn a child clean exit green", (t) => {
  const directory = fixture(t);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pnpm"),
    `#!${process.execPath}
    process.on('SIGTERM',()=>{ require('node:fs').writeFileSync('signal','SIGTERM');process.exit(0); });
    setInterval(()=>{},1000);
    process.kill(process.ppid,'SIGTERM');
  `,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  const result = call(directory, "test-target.mjs", ["ci", "--shard", "1/4"], {
    PATH: `${bin}:${process.env.PATH}`,
  });
  assert.equal(result.status, 143, result.stderr);
  assert.equal(readFileSync(join(directory, "signal"), "utf8"), "SIGTERM");
  const report = JSON.parse(readFileSync(join(directory, ".verify/units/ci-1-of-4.json"), "utf8"));
  assert.equal(report.interrupted, "SIGTERM");
});
