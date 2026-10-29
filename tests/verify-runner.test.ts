import { afterEach, describe, expect, it } from "vite-plus/test";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUITE_PLAN, fitsResources } from "../scripts/verify/lib/suite-plan.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "verify-runner-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "scripts", "verify", "lib"), { recursive: true });
  for (const name of ["native-lanes.mjs", "suite-plan.mjs"])
    copyFileSync(
      join(repositoryRoot, "scripts/verify/lib", name),
      join(root, "scripts/verify/lib", name),
    );
  writeFileSync(
    join(root, "scripts/verify/prepare.mjs"),
    `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const kind = process.argv[2];
const context = JSON.parse(readFileSync(process.env.SPROUT_VERIFY_RUN_DIR + '/context.json'));
if (context.ownerPid !== process.ppid || context.root !== process.cwd()) process.exit(21);
appendFileSync('preparation.log', kind + ':' + process.env.SPROUT_VERIFY_PREPARED_ONLY + '\\n');
if (existsSync('fail-preparation') && readFileSync('fail-preparation', 'utf8') === kind) process.exit(19);
`,
  );
  copyFileSync(
    join(repositoryRoot, "scripts", "verify", "runner.mjs"),
    join(root, "scripts", "verify", "runner.mjs"),
  );
  copyFileSync(join(repositoryRoot, "scripts", "verify.sh"), join(root, "scripts", "verify.sh"));

  return {
    root,
    writeScript(id: string, body: string) {
      writeFileSync(join(root, "scripts", "verify", `${id}.sh`), body);
    },
    writeDatabase(unit: string) {
      const directory = join(root, ".verify", unit);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "verification.sqlite"), `database ${unit}`);
    },
    run(args: string[]) {
      return spawnSync("bash", ["scripts/verify.sh", ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
    },
    runDirect(args: string[]) {
      return spawnSync("node", ["scripts/verify/runner.mjs", ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
    },
    singleRunDirectory() {
      const runs = readdirSync(join(root, ".verify", "runs"));
      expect(runs).toHaveLength(1);
      return join(root, ".verify", "runs", runs[0]);
    },
    runsDirectoryExists() {
      return existsSync(join(root, ".verify", "runs"));
    },
  };
}

function markerLines(root: string) {
  const marker = join(root, "marker.log");
  if (!existsSync(marker)) return [];
  return readFileSync(marker, "utf8").trim().split("\n").filter(Boolean);
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for condition");
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("verify runner", () => {
  it("declares an admissible resource plan for every current gate", () => {
    const ids = readdirSync(join(repositoryRoot, "scripts/verify"))
      .filter((name) => name.endsWith(".sh"))
      .map((name) => name.slice(0, -3))
      .sort();
    expect(Object.keys(SUITE_PLAN).sort()).toEqual(ids);
    for (const plan of Object.values(SUITE_PLAN))
      expect(fitsResources({}, plan.resources)).toBe(true);
  });

  it("按文件名字典序执行，失败后继续，并报告真实状态、耗时和日志", () => {
    const fixture = makeFixture();
    fixture.writeScript("a-first", 'echo "first out"\nsleep 0.02\n');
    fixture.writeScript("b-fail", 'echo "fail out"\necho "fail err" >&2\nsleep 0.12\nexit 3\n');
    fixture.writeScript("c-last", 'echo "last out"\nsleep 0.25\n');

    const result = fixture.run([]);
    const output = String(result.stdout);

    expect(result.status).toBe(1);
    expect(
      output
        .split("\n")
        .filter((line) => line.startsWith("RUN "))
        .map((line) => line.split(" ")[1]),
    ).toEqual(["a-first", "b-fail", "c-last"]);
    expect(output).toContain("PASS a-first");
    expect(output).toContain("FAIL b-fail");
    expect(output).toContain("PASS c-last");
    expect(output).toMatch(/Verification scripts=3 failed=1/);

    const summaryStart = output.indexOf("Slowest first");
    expect(summaryStart).toBeGreaterThanOrEqual(0);
    const summary = output.slice(summaryStart).split("\n");
    const slowest = summary
      .map((line) => line.match(/^\s+\d+ms (?:PASS|FAIL) (\S+)/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => match[1]);
    expect(slowest).toEqual(["c-last", "b-fail", "a-first"]);

    const runDirectory = fixture.singleRunDirectory();
    expect(output).toContain(
      join(".verify", "runs", runDirectory.split("/").at(-1)!, "report.json"),
    );
    const report = JSON.parse(readFileSync(join(runDirectory, "report.json"), "utf8"));

    expect(report.count).toBe(3);
    expect(report.failed).toBe(1);
    expect(report.outcomes.map((outcome: { id: string }) => outcome.id)).toEqual([
      "a-first",
      "b-fail",
      "c-last",
    ]);
    expect(report.outcomes.map((outcome: { status: string }) => outcome.status)).toEqual([
      "passed",
      "failed",
      "passed",
    ]);
    expect(report.outcomes[1].exitCode).toBe(3);
    expect(report.outcomes[0].signal).toBeNull();

    let totalScriptMs = 0;
    for (const outcome of report.outcomes) {
      expect(outcome.path).toBe(`scripts/verify/${outcome.id}.sh`);
      expect(Number.isInteger(outcome.durationMs)).toBe(true);
      expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(outcome.startedAt))).toBe(false);
      expect(existsSync(outcome.logPath)).toBe(true);
      totalScriptMs += outcome.durationMs;
    }
    expect(readFileSync(report.outcomes[1].logPath, "utf8")).toContain("fail err");
    expect(report.durationMs).toBeGreaterThanOrEqual(totalScriptMs);
    expect(Date.parse(report.outcomes[2].startedAt)).toBeGreaterThanOrEqual(
      Date.parse(report.outcomes[1].startedAt),
    );
  });

  it("--only 只运行精确选中的脚本，只清理选中目录的数据库", () => {
    const fixture = makeFixture();
    fixture.writeScript("a-first", "echo a-first >> marker.log\n");
    fixture.writeScript("b-second", "echo b-second >> marker.log\n");
    fixture.writeScript("c-third", "echo c-third >> marker.log\n");
    fixture.writeDatabase("a-first");
    fixture.writeDatabase("b-second");
    fixture.writeDatabase("c-third");

    const result = fixture.run(["--", "--only", "a-first,c-third"]);

    expect(result.status).toBe(0);
    expect(markerLines(fixture.root)).toEqual(["a-first", "c-third"]);
    expect(existsSync(join(fixture.root, ".verify", "a-first", "verification.sqlite"))).toBe(false);
    expect(existsSync(join(fixture.root, ".verify", "b-second", "verification.sqlite"))).toBe(true);
    expect(existsSync(join(fixture.root, ".verify", "c-third", "verification.sqlite"))).toBe(false);
  });

  it("非法选择在运行脚本和清理数据库之前被拒绝，help 无副作用", () => {
    const fixture = makeFixture();
    fixture.writeScript("a-first", "echo a-first >> marker.log\n");
    fixture.writeScript("b-second", "echo b-second >> marker.log\n");
    fixture.writeDatabase("a-first");
    fixture.writeDatabase("b-second");

    for (const args of [
      ["--only", "missing"],
      ["--only", "../a-first"],
      ["--only", ""],
      ["--only", "a-first,missing"],
      ["--only", "a-first,a-first"],
      ["--unknown"],
    ]) {
      const result = fixture.run(args);
      expect(result.status).not.toBe(0);
      expect(markerLines(fixture.root)).toEqual([]);
      expect(existsSync(join(fixture.root, ".verify", "a-first", "verification.sqlite"))).toBe(
        true,
      );
      expect(existsSync(join(fixture.root, ".verify", "b-second", "verification.sqlite"))).toBe(
        true,
      );
      expect(fixture.runsDirectoryExists()).toBe(false);
    }

    const help = fixture.run(["--help"]);
    expect(help.status).toBe(0);
    expect(String(help.stdout)).toContain("--only");
    expect(markerLines(fixture.root)).toEqual([]);
    expect(fixture.runsDirectoryExists()).toBe(false);
    expect(existsSync(join(fixture.root, ".verify", "a-first", "verification.sqlite"))).toBe(true);
  });

  it("SIGTERM 中断当前脚本，写部分报告并以 143 退出且不再派发下一个", async () => {
    const fixture = makeFixture();
    fixture.writeScript(
      "a-hang",
      `#!/usr/bin/env bash
set -uo pipefail
bash -c 'trap "" TERM; while :; do sleep 1; done' &
child=$!
printf '%s\\n' "$child" > child.pid
trap 'kill -KILL "$child" 2>/dev/null' EXIT TERM INT
wait "$child"
`,
    );
    fixture.writeScript("b-next", "echo b-next > next.marker\n");

    const child = spawn("bash", ["scripts/verify.sh"], { cwd: fixture.root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    await waitFor(() => existsSync(join(fixture.root, "child.pid")));
    const tracked = Number(readFileSync(join(fixture.root, "child.pid"), "utf8").trim());
    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on("close", (code) => resolve(code)),
    );

    expect(exitCode).toBe(143);
    expect(stderr).not.toContain("timed out");
    expect(existsSync(join(fixture.root, "next.marker"))).toBe(false);
    expect(stdout).not.toContain("PASS a-hang");
    expect(stdout).not.toMatch(/Verification scripts=1 failed=0/);
    expect(stdout).toContain("FAIL a-hang");

    const report = JSON.parse(
      readFileSync(join(fixture.singleRunDirectory(), "report.json"), "utf8"),
    );
    expect(report.interrupted).toMatchObject({ signal: "SIGTERM", exitCode: 143 });
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0].id).toBe("a-hang");
    expect(report.outcomes[0].status).toBe("failed");
    expect(report.failed).toBe(1);

    await waitFor(() => !isAlive(tracked), 5_000);
    expect(isAlive(tracked)).toBe(false);
  }, 20_000);

  it("捕获 SIGTERM 并退出 0 的脚本在中断运行中不会 PASS，并保留真实退出码", async () => {
    const fixture = makeFixture();
    fixture.writeScript(
      "a-catch",
      `#!/usr/bin/env bash
set -uo pipefail
printf '%s\\n' "$$" > child.pid
trap 'exit 0' TERM
while :; do sleep 1; done
`,
    );
    fixture.writeScript("b-next", "echo b-next > next.marker\n");

    const child = spawn("bash", ["scripts/verify.sh"], { cwd: fixture.root });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));

    await waitFor(() => existsSync(join(fixture.root, "child.pid")));
    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on("close", (code) => resolve(code)),
    );

    expect(exitCode).toBe(143);
    expect(existsSync(join(fixture.root, "next.marker"))).toBe(false);
    expect(stdout).not.toContain("PASS a-catch");
    expect(stdout).toContain("FAIL a-catch");
    expect(stdout).toContain("exit=0");
    expect(stdout).toContain("interrupted=SIGTERM");

    const report = JSON.parse(
      readFileSync(join(fixture.singleRunDirectory(), "report.json"), "utf8"),
    );
    expect(report.interrupted).toMatchObject({ signal: "SIGTERM", exitCode: 143 });
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0].status).toBe("failed");
    expect(report.outcomes[0].exitCode).toBe(0);
    expect(report.outcomes[0].signal).toBeNull();
    expect(report.failed).toBe(1);
  }, 20_000);

  it("accounts for all native fixtures, keeps aj exclusive, and releases capacity after failure", async () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.root, "native.mjs"),
      `
import { existsSync, writeFileSync } from 'node:fs';
const id = process.argv[2];
if (process.env.SPROUT_VERIFY_PREPARED_ONLY !== '1') process.exit(22);
if (id !== 'ab' && process.env.NODE_ENV !== 'production') process.exit(23);
writeFileSync(id + '.started', '');
while (!existsSync(id + '.release')) await new Promise(r => setTimeout(r, 10));
writeFileSync(id + '.finished', '');
process.exit(id === 'u' ? 7 : 0);
`,
    );
    const ids = [
      "ah-execution-live-e2e",
      "aj-recovery-matrix",
      "u-machine-ui",
      "w-worker-remote",
      "ab-worker-long-command",
    ];
    for (const id of ids) fixture.writeScript(id, `exec node native.mjs ${id.split("-")[0]}\n`);
    const child = spawn(process.execPath, ["scripts/verify/runner.mjs"], {
      cwd: fixture.root,
      stdio: "ignore",
    });
    const completed = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    const started = (id: string) => existsSync(join(fixture.root, `${id}.started`));
    const release = (id: string) => writeFileSync(join(fixture.root, `${id}.release`), "");
    try {
      await waitFor(() => started("ah") && started("u"));
      expect(["aj", "w", "ab"].filter(started)).toEqual([]);
      expect(
        readFileSync(join(fixture.root, "preparation.log"), "utf8").trim().split("\n"),
      ).toEqual(["install:0", "server:0", "worker:0"]);
      release("u");
      await waitFor(() => started("w"));
      expect(started("aj")).toBe(false);
      expect(started("ab")).toBe(false);
      release("w");
      await waitFor(() => started("ab"));
      release("ah");
      await waitFor(() => existsSync(join(fixture.root, "ah.finished")));
      expect(started("aj")).toBe(false);
      release("ab");
      await waitFor(() => started("aj"));
      release("aj");
      expect(await completed).toBe(1);
      const report = JSON.parse(
        readFileSync(join(fixture.singleRunDirectory(), "report.json"), "utf8"),
      );
      expect(report.outcomes.map((outcome: { id: string }) => outcome.id)).toEqual([...ids].sort());
      expect(
        report.outcomes.find((outcome: { id: string }) => outcome.id === "u-machine-ui").exitCode,
      ).toBe(7);
      expect(report.failed).toBe(1);
      expect(report.passed).toBe(4);
    } finally {
      for (const id of ["ah", "aj", "u", "w", "ab"]) release(id);
      child.kill("SIGTERM");
      await completed;
    }
  }, 20_000);

  it("prepares selected consumers and preserves runnable gates after preparation failure", () => {
    const fixture = makeFixture();
    for (const id of ["aa-execution-log-contracts", "u-machine-ui", "w-worker-remote", "z-later"])
      fixture.writeScript(id, `echo ${id} >> marker.log\n`);
    const result = fixture.run(["--only=u-machine-ui,w-worker-remote"]);
    expect(result.status).toBe(0);
    expect(markerLines(fixture.root).sort()).toEqual(["u-machine-ui", "w-worker-remote"]);
    expect(readFileSync(join(fixture.root, "preparation.log"), "utf8")).toBe(
      "install:0\nserver:0\nworker:0\n",
    );
    rmSync(join(fixture.root, "marker.log"));
    writeFileSync(join(fixture.root, "fail-preparation"), "server");
    const failed = fixture.run([
      "--only=aa-execution-log-contracts,u-machine-ui,w-worker-remote,z-later",
    ]);
    expect(failed.status).toBe(1);
    expect(markerLines(fixture.root)).toEqual(["aa-execution-log-contracts", "z-later"]);
    const reports = readdirSync(join(fixture.root, ".verify/runs")).map((id) =>
      JSON.parse(readFileSync(join(fixture.root, ".verify/runs", id, "report.json"), "utf8")),
    );
    const report = reports.find((entry) => entry.failed === 2);
    expect(report.count).toBe(4);
    expect(
      report.outcomes.map((entry: { id: string; exitCode: number | null }) => [
        entry.id,
        entry.exitCode,
      ]),
    ).toEqual([
      ["aa-execution-log-contracts", 0],
      ["u-machine-ui", null],
      ["w-worker-remote", null],
      ["z-later", 0],
    ]);
    expect(readFileSync(report.outcomes[1].logPath, "utf8")).toContain("exit=19");
  });

  it("runs gates whose own preparation succeeded when an unrelated producer fails", () => {
    const fixture = makeFixture();
    for (const id of ["e-project", "x2-mcp-extension"])
      fixture.writeScript(id, `echo ${id} >> marker.log\n`);
    writeFileSync(join(fixture.root, "fail-preparation"), "extension");
    const result = fixture.run([]);
    expect(result.status).toBe(1);
    expect(markerLines(fixture.root)).toEqual(["e-project"]);
    const report = JSON.parse(
      readFileSync(join(fixture.singleRunDirectory(), "report.json"), "utf8"),
    );
    expect(
      report.outcomes.map((entry: { id: string; exitCode: number | null }) => [
        entry.id,
        entry.exitCode,
      ]),
    ).toEqual([
      ["e-project", 0],
      ["x2-mcp-extension", null],
    ]);
    expect(report.outcomes[1].blockedBy).toBe("prepare-extension");
  });

  it("overlaps stable API consumers and joins them before an unknown gate", async () => {
    const fixture = makeFixture();
    for (const id of ["e-project", "h-project-agents"])
      fixture.writeScript(
        id,
        `node --input-type=module <<'JS'\nimport {existsSync,writeFileSync} from 'node:fs';\nwriteFileSync('${id}.started','');\nwhile(!existsSync('release')) await new Promise(r=>setTimeout(r,10));\nwriteFileSync('${id}.finished','');\nprocess.exit('${id}' === 'e-project' ? 5 : 0);\nJS\n`,
      );
    fixture.writeScript(
      "z-later",
      "test -f e-project.finished && test -f h-project-agents.finished\necho joined >> marker.log\n",
    );
    const child = spawn(process.execPath, ["scripts/verify/runner.mjs"], {
      cwd: fixture.root,
      stdio: "ignore",
    });
    const completed = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      await waitFor(
        () =>
          ["e-project", "h-project-agents"].every((id) =>
            existsSync(join(fixture.root, `${id}.started`)),
          ),
        2500,
      );
      expect(markerLines(fixture.root)).toEqual([]);
      writeFileSync(join(fixture.root, "release"), "");
      expect(await completed).toBe(1);
      expect(markerLines(fixture.root)).toEqual(["joined"]);
      const report = JSON.parse(
        readFileSync(join(fixture.singleRunDirectory(), "report.json"), "utf8"),
      );
      expect(
        report.outcomes.map((entry: { id: string; exitCode: number }) => [
          entry.id,
          entry.exitCode,
        ]),
      ).toEqual([
        ["e-project", 5],
        ["h-project-agents", 0],
        ["z-later", 0],
      ]);
      expect(report.preparation.map((entry: { id: string }) => entry.id)).toEqual([
        "prepare-install",
        "prepare-server",
      ]);
    } finally {
      writeFileSync(join(fixture.root, "release"), "");
      child.kill("SIGTERM");
      await completed;
    }
  });

  it("serializes colliding fixed ports while admitting unrelated work", async () => {
    const fixture = makeFixture();
    const ids = ["ag-execution-wiring-ui", "e-project", "h-project-agents"];
    for (const id of ids)
      fixture.writeScript(
        id,
        `node --input-type=module <<'JS'\nimport {existsSync,writeFileSync} from 'node:fs';\nwriteFileSync('${id}.started','');\nwhile(!existsSync('${id}.release')) await new Promise(r=>setTimeout(r,10));\nJS\n`,
      );
    const child = spawn(process.execPath, ["scripts/verify/runner.mjs"], {
      cwd: fixture.root,
      stdio: "ignore",
    });
    const completed = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      await waitFor(() =>
        ["ag-execution-wiring-ui", "h-project-agents"].every((id) =>
          existsSync(join(fixture.root, `${id}.started`)),
        ),
      );
      expect(existsSync(join(fixture.root, "e-project.started"))).toBe(false);
      writeFileSync(join(fixture.root, "ag-execution-wiring-ui.release"), "");
      await waitFor(() => existsSync(join(fixture.root, "e-project.started")));
      expect(existsSync(join(fixture.root, "h-project-agents.release"))).toBe(false);
      for (const id of ids) writeFileSync(join(fixture.root, `${id}.release`), "");
      expect(await completed).toBe(0);
    } finally {
      for (const id of ids) writeFileSync(join(fixture.root, `${id}.release`), "");
      child.kill("SIGTERM");
      await completed;
    }
  });

  it("keeps distinct preparation evidence across unknown gate barriers", () => {
    const fixture = makeFixture();
    for (const id of ["e-project", "g-unknown", "h-project-agents"])
      fixture.writeScript(id, `echo ${id} >> marker.log\n`);
    const result = fixture.run([]);
    expect(result.status).toBe(0);
    expect(markerLines(fixture.root)).toEqual(["e-project", "g-unknown", "h-project-agents"]);
    const report = JSON.parse(
      readFileSync(join(fixture.singleRunDirectory(), "report.json"), "utf8"),
    );
    expect(report.preparation).toHaveLength(4);
    expect(
      new Set(report.preparation.map((entry: { logPath: string }) => entry.logPath)).size,
    ).toBe(4);
    for (const entry of report.preparation) expect(existsSync(entry.logPath)).toBe(true);
  });

  it("forwards the first signal to all gates, lets nested launchers clean up, and kills detached stragglers at one deadline", async () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.root, "nested.mjs"),
      `
import { writeFileSync } from 'node:fs';
const id = process.argv[2];
process.on('SIGTERM', () => {
  writeFileSync(id + '.forwarded', '');
  if (id === 'ah') setTimeout(() => { writeFileSync(id + '.cleaned', ''); process.exit(0); }, 250);
});
process.on('SIGINT', () => {});
writeFileSync(id + '.nested.pid', String(process.pid));
setInterval(() => {}, 1000);
`,
    );
    writeFileSync(
      join(fixture.root, "launcher.mjs"),
      `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const id = process.argv[2];
const nested = spawn(process.execPath, ['nested.mjs', id], { detached: true, stdio: 'ignore' });
writeFileSync(id + '.launcher.pid', String(process.pid));
process.on('SIGTERM', () => process.kill(-nested.pid, 'SIGTERM'));
process.on('SIGINT', () => {});
nested.on('exit', () => process.exit(0));
`,
    );
    for (const id of ["ah-execution-live-e2e", "u-machine-ui"])
      fixture.writeScript(id, `exec node launcher.mjs ${id.split("-")[0]}\n`);
    for (const id of ["aj-recovery-matrix", "w-worker-remote"])
      fixture.writeScript(id, `echo ${id} >> marker.log\n`);
    const child = spawn(process.execPath, ["scripts/verify/runner.mjs"], {
      cwd: fixture.root,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    child.stderr?.on("data", (chunk) => {
      errors += chunk;
    });
    const completed = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    const pid = (id: string) => Number(readFileSync(join(fixture.root, id + ".pid"), "utf8"));
    try {
      await waitFor(() =>
        ["ah", "u"].every((id) => existsSync(join(fixture.root, id + ".nested.pid"))),
      );
      const started = Date.now();
      child.kill("SIGTERM");
      await waitFor(() =>
        ["ah", "u"].every((id) => existsSync(join(fixture.root, id + ".forwarded"))),
      );
      child.kill("SIGINT");
      await waitFor(() => existsSync(join(fixture.root, "ah.cleaned")));
      expect(isAlive(pid("u.nested"))).toBe(true);
      expect(await completed, errors).toBe(143);
      expect(Date.now() - started).toBeLessThan(14_000);
      expect(markerLines(fixture.root)).toEqual([]);
      for (const id of ["ah.launcher", "ah.nested", "u.launcher", "u.nested"]) {
        await waitFor(() => !isAlive(pid(id)));
      }
      const report = JSON.parse(
        readFileSync(join(fixture.singleRunDirectory(), "report.json"), "utf8"),
      );
      expect(report.interrupted).toEqual({ signal: "SIGTERM", exitCode: 143 });
      expect(report.outcomes.map((entry: { id: string }) => entry.id)).toEqual([
        "ah-execution-live-e2e",
        "u-machine-ui",
      ]);
      expect(report.failed).toBe(2);
      expect(report.outcomes[0].exitCode).toBe(0);
      expect(report.outcomes[1].signal).toBe("SIGKILL");
    } finally {
      child.kill("SIGTERM");
      for (const file of readdirSync(fixture.root).filter((name) => name.endsWith(".pid"))) {
        try {
          process.kill(Number(readFileSync(join(fixture.root, file), "utf8")), "SIGKILL");
        } catch {}
      }
      await completed;
    }
  }, 25_000);

  it("直接调用 runner 也接受 package runner 转发的前导 --", () => {
    const fixture = makeFixture();
    fixture.writeScript("a-first", "echo a-first >> marker.log\n");
    fixture.writeScript("b-second", "echo b-second >> marker.log\n");

    const result = fixture.runDirect(["--", "--only=a-first"]);

    expect(result.status).toBe(0);
    expect(markerLines(fixture.root)).toEqual(["a-first"]);
  });
});
