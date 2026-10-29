import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const statuses = ["short-running", "long-running", "completed-unretrieved"];
const shards = ["host-disconnect", "host-restart", "worker-restart", "machine-restart"].map(
  (fault) => ({ fault, cells: statuses.map((status) => `${fault}__${status}`) }),
);

function selectedShards(selector) {
  if (selector === undefined) return shards;
  const cells = selector.split(",");
  const valid = new Set(shards.flatMap((shard) => shard.cells));
  assert(
    cells.every((cell) => valid.has(cell)),
    "SPROUT_MATRIX_CELLS contains an invalid or empty cell",
  );
  assert.equal(new Set(cells).size, cells.length, "SPROUT_MATRIX_CELLS contains duplicate cells");
  return shards
    .map((shard) => ({ ...shard, cells: shard.cells.filter((cell) => cells.includes(cell)) }))
    .filter((shard) => shard.cells.length);
}

export async function runMatrix({
  fixtureArgs = ["--import", "tsx", "tests/fixtures/execution-recovery-matrix.ts"],
  env = process.env,
  root = ".verify",
  timeoutMs = 15 * 60 * 1000,
} = {}) {
  const selected = selectedShards(env.SPROUT_MATRIX_CELLS);
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(resolve(root), "aj-shards-"));
  const children = [];
  let interrupted = 0;
  let escalation;
  const interrupt = (code) => {
    if (interrupted) return;
    interrupted = code;
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    escalation = setTimeout(() => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 15000);
  };
  const onInt = () => interrupt(130);
  const onTerm = () => interrupt(143);
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const timeout = setTimeout(() => interrupt(124), timeoutMs);
  console.log(`aj recovery shard logs: ${directory}`);
  try {
    const outcomes = await Promise.all(
      selected.map((shard) => {
        const logPath = join(directory, `${shard.fault}.log`);
        const fd = openSync(logPath, "w", 0o600);
        const child = spawn(process.execPath, fixtureArgs, {
          env: { ...env, SPROUT_MATRIX_CELLS: shard.cells.join(",") },
          stdio: ["ignore", fd, fd],
        });
        closeSync(fd);
        children.push(child);
        return new Promise((done) => {
          let error;
          child.once("error", (cause) => {
            error = cause.message;
          });
          child.once("close", (exitCode, signal) => {
            let log = "";
            try {
              log = readFileSync(logPath, "utf8");
            } catch (cause) {
              error = cause.message;
            }
            const results = [...log.matchAll(/^  (\S+): expected=(.*?) actual=(.*?)$/gm)];
            const cells = results.map((match) => match[1]);
            const coverage =
              cells.length === shard.cells.length &&
              shard.cells.every((cell) => cells.filter((seen) => seen === cell).length === 1);
            const passed = exitCode === 0 && coverage;
            done({
              fault: shard.fault,
              expectedCells: shard.cells,
              cells,
              exitCode,
              signal,
              error,
              passed,
              logPath,
              results: results.map((match) => match[0].trim()),
            });
          });
        });
      }),
    );
    const exitCode = interrupted || (outcomes.every((outcome) => outcome.passed) ? 0 : 1);
    writeFileSync(
      join(directory, "summary.json"),
      JSON.stringify({ exitCode, outcomes }, null, 2),
      { mode: 0o600 },
    );
    for (const outcome of outcomes) {
      console.log(
        `${outcome.passed ? "PASS" : "FAIL"} ${outcome.fault} cells=${outcome.cells.length}/${outcome.expectedCells.length} exit=${outcome.exitCode} signal=${outcome.signal} log=${outcome.logPath}${outcome.error ? ` error=${outcome.error}` : ""}`,
      );
      for (const result of outcome.results) console.log(`  ${result}`);
    }
    console.log(
      `aj-recovery-matrix: ${exitCode === 0 ? "PASS" : "FAIL"} (${outcomes.reduce((count, outcome) => count + outcome.cells.length, 0)} cells)`,
    );
    return exitCode;
  } catch (error) {
    interrupt(1);
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise((done) => child.once("close", done)),
      ),
    );
    throw error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(escalation);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert(
      process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--validate"),
      "unexpected matrix launcher argument",
    );
    selectedShards(process.env.SPROUT_MATRIX_CELLS);
    if (process.argv[2] !== "--validate") process.exitCode = await runMatrix();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
