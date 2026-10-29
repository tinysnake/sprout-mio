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

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "verify-runner-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "scripts", "verify"), { recursive: true });
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

  it("直接调用 runner 也接受 package runner 转发的前导 --", () => {
    const fixture = makeFixture();
    fixture.writeScript("a-first", "echo a-first >> marker.log\n");
    fixture.writeScript("b-second", "echo b-second >> marker.log\n");

    const result = fixture.runDirect(["--", "--only=a-first"]);

    expect(result.status).toBe(0);
    expect(markerLines(fixture.root)).toEqual(["a-first"]);
  });
});
