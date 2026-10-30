import { afterEach, expect, it } from "vite-plus/test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(
  new URL("../scripts/verify/aj-recovery-matrix.mjs", import.meta.url),
);
const roots: string[] = [];
const faults = ["host-disconnect", "host-restart", "worker-restart", "machine-restart"];
const statuses = ["short-running", "long-running", "completed-unretrieved"];
const allCells = faults.flatMap((fault) => statuses.map((status) => `${fault}__${status}`));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aj-shards-test-"));
  roots.push(root);
  const fake = join(root, "fake.mjs");
  const runner = join(root, "run.mjs");
  writeFileSync(
    fake,
    `
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const cells = process.env.SPROUT_MATRIX_CELLS.split(',');
const fault = cells[0].split('__')[0];
writeFileSync(fault + '.started', 'started');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
let closing = false;
function finish(code) {
  if (closing) return;
  closing = true;
  if (descendant.exitCode !== null || descendant.signalCode !== null) process.exit(code);
  descendant.once('close', () => process.exit(code));
  process.kill(-descendant.pid, 'SIGKILL');
}
process.on('SIGTERM', () => finish(143));
process.on('SIGINT', () => finish(130));
writeFileSync(fault + '.pids', JSON.stringify([process.pid, descendant.pid]));
const deadline = Date.now() + 8000;
const timer = setInterval(() => {
  if (Date.now() > deadline) { clearInterval(timer); finish(124); return; }
  if (process.env.MODE === 'hang') return;
  if (process.env.MODE === 'barrier' && !${JSON.stringify(faults)}.every(f => existsSync(f + '.pids'))) return;
  clearInterval(timer);
  for (const cell of cells) console.log('  ' + (process.env.MODE === 'bad-coverage' ? cells[0] : cell) + ': expected=running -> unknown actual=unknown');
  finish(process.env.MODE === 'failure' && fault === 'worker-restart' ? 7 : 0);
}, 20);
`,
  );
  writeFileSync(
    runner,
    `
import { runMatrix } from ${JSON.stringify(launcher)};
try {
  process.exitCode = await runMatrix({ fixtureArgs: [${JSON.stringify(fake)}], root: 'results', timeoutMs: Number(process.env.TEST_TIMEOUT || 12000) });
} catch (error) { console.error(error.message); process.exitCode = 1; }
`,
  );
  return {
    root,
    runner,
    run(mode: string, selector?: string) {
      const env: NodeJS.ProcessEnv = { ...process.env, MODE: mode };
      delete env.SPROUT_MATRIX_CELLS;
      if (selector !== undefined) env.SPROUT_MATRIX_CELLS = selector;
      return spawnSync(process.execPath, [runner], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 20000,
      });
    },
    summary() {
      const directory = join(root, "results", readdirSync(join(root, "results"))[0]);
      return JSON.parse(readFileSync(join(directory, "summary.json"), "utf8")) as {
        exitCode: number;
        outcomes: {
          fault: string;
          cells: string[];
          exitCode: number;
          passed: boolean;
          logPath: string;
        }[];
      };
    },
  };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("process orchestration condition timed out");
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("runs four fault shards concurrently and accounts for all twelve cells and raw logs", () => {
  const setup = fixture();
  const result = setup.run("barrier");
  expect(result.status, result.stderr).toBe(0);
  const summary = setup.summary();
  expect(summary.outcomes).toHaveLength(4);
  expect(summary.outcomes.flatMap((outcome) => outcome.cells).sort()).toEqual([...allCells].sort());
  for (const outcome of summary.outcomes) {
    expect(outcome.passed).toBe(true);
    expect(readFileSync(outcome.logPath, "utf8")).toContain(outcome.cells[0]);
  }
});

it("intersects an explicit selection with the fixed shards", () => {
  const setup = fixture();
  const selected = [allCells[1], allCells[8]];
  const result = setup.run("selected", selected.join(","));
  expect(result.status, result.stderr).toBe(0);
  expect(
    setup
      .summary()
      .outcomes.flatMap((outcome) => outcome.cells)
      .sort(),
  ).toEqual(selected.sort());
  expect(readdirSync(setup.root).filter((name) => name.endsWith(".started"))).toHaveLength(2);
});

it("rejects invalid, duplicate and empty selections before spawning or creating run artifacts", () => {
  const setup = fixture();
  for (const selector of [
    "",
    "unknown",
    `${allCells[0]},${allCells[0]}`,
    `${allCells[0]},`,
    `${allCells[0]},unknown`,
  ]) {
    const result = setup.run("selected", selector);
    expect(result.status).toBe(1);
    expect(existsSync(join(setup.root, "results"))).toBe(false);
    expect(readdirSync(setup.root).some((name) => name.endsWith(".started"))).toBe(false);
  }
});

it.each(["failure", "bad-coverage"])(
  "fails on %s while retaining every bounded shard outcome",
  (mode) => {
    const setup = fixture();
    const result = setup.run(mode);
    expect(result.status).toBe(1);
    const summary = setup.summary();
    expect(summary.outcomes).toHaveLength(4);
    expect(summary.outcomes.some((outcome) => !outcome.passed)).toBe(true);
    if (mode === "failure")
      expect(summary.outcomes.find((outcome) => outcome.fault === "worker-restart")?.exitCode).toBe(
        7,
      );
  },
);

it.each(["SIGTERM", "SIGINT", "process-group", "timeout"] as const)(
  "cleans up owned fixture descendants on %s",
  async (signal) => {
    const setup = fixture();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MODE: "hang",
      TEST_TIMEOUT: signal === "timeout" ? "2000" : "12000",
    };
    delete env.SPROUT_MATRIX_CELLS;
    const child = spawn(process.execPath, [setup.runner], {
      cwd: setup.root,
      env,
      stdio: "ignore",
      detached: signal === "process-group",
    });
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    let pids: number[] = [];
    try {
      await until(() => faults.every((fault) => existsSync(join(setup.root, `${fault}.pids`))));
      pids = faults.flatMap(
        (fault) => JSON.parse(readFileSync(join(setup.root, `${fault}.pids`), "utf8")) as number[],
      );
      expect(pids.every(alive)).toBe(true);
      if (signal === "process-group") process.kill(-child.pid!, "SIGTERM");
      else if (signal !== "timeout") child.kill(signal);
      expect(await closed).toBe(signal === "timeout" ? 124 : signal === "SIGINT" ? 130 : 143);
      await until(() => pids.every((pid) => !alive(pid)));
      expect(setup.summary().outcomes).toHaveLength(4);
    } finally {
      child.kill("SIGTERM");
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  },
);
