import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runAhGroups } from "./ah-groups.mjs";
import { selectAhGroups } from "./lib/ah-manifest.mjs";

const fixture = resolve("scripts/verify/fixtures/ah-group-child.mjs");
const groups = ["execution", "cancellation", "recovery"];
const artifacts = mkdtempSync(join(tmpdir(), "verify-ah-groups-tests-"));
console.log(`Test evidence: ${artifacts}`);
const privateDirectory = (name) => mkdtempSync(join(artifacts, `${name}-`));
const command = (mode) => (group) => ({ file: process.execPath, args: [fixture, group, mode] });
async function until(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
  throw new Error(`Timeout: ${message}`);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function pgid(pid) {
  return Number(
    spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim(),
  );
}

test("unknown selectors fail in the shell before either artifact preparation", () => {
  assert.deepEqual(selectAhGroups([]), groups);
  assert.deepEqual(selectAhGroups(["--group", "recovery"]), ["recovery"]);
  const directory = privateDirectory("selector");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const calls = join(directory, "calls");
  writeFileSync(
    join(bin, "node"),
    '#!/bin/sh\nprintf "called\\n" >> "$AH_TEST_CALLS"\nexec "$AH_TEST_NODE" "$@"\n',
    { mode: 0o700 },
  );
  const result = spawnSync(
    "/bin/bash",
    ["scripts/verify/ah-execution-live-e2e.sh", "--group", "unknown"],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AH_TEST_CALLS: calls,
        AH_TEST_NODE: process.execPath,
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected no arguments or --group/);
  assert.equal(readFileSync(calls, "utf8"), "called\n");
});

test("three private children overlap and account for all sixteen original assertions", async () => {
  const summary = await runAhGroups({
    groups,
    directory: privateDirectory("success"),
    commandForGroup: command("success"),
  });
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.expectedChecks.length, 16);
  assert.equal(new Set(summary.expectedChecks).size, 16);
  assert.deepEqual(
    summary.outcomes.map((outcome) => outcome.exitCode),
    [0, 0, 0],
  );
  assert.equal(new Set(summary.outcomes.map((outcome) => outcome.logPath)).size, 3);
});

for (const mode of ["missing", "duplicate", "unexpected", "failure"]) {
  test(`a ${mode} child cannot produce aggregate success`, async () => {
    const summary = await runAhGroups({
      groups,
      directory: privateDirectory(mode),
      commandForGroup: command(mode),
    });
    assert.equal(summary.exitCode, 1);
    const failed = summary.outcomes.find((outcome) => outcome.group === "cancellation");
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, mode === "failure" ? 23 : 0);
    assert.match(failed.error, mode === "failure" ? /exit=23/ : /Invalid AH coverage/);
  });
}

test("a fixture crash cleans its detached native group and stops native work in sibling fixtures", async () => {
  const directory = privateDirectory("native-failure");
  const summary = await runAhGroups({
    groups,
    directory,
    commandForGroup: command("native-failure"),
  });
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.outcomes.find((outcome) => outcome.group === "cancellation").exitCode, 23);
  const owned = groups.flatMap((group) => {
    const native = JSON.parse(readFileSync(join(directory, group, "ready.json"), "utf8"));
    return [native.wrapper, native.pid, native.childPid, ...native.descendants];
  });
  await until(() => owned.every((pid) => !alive(pid)), "native groups and sibling fixtures exited");
  assert(
    summary.outcomes.every((outcome) => !outcome.error?.includes("cleanup:")),
    "already exited native groups must not report cleanup failure",
  );
});

for (const mode of ["SIGINT", "SIGTERM", "deadline"]) {
  test(
    `${mode} cleans a nested launcher, detached real runner and TERM-ignoring native shell group`,
    { timeout: 15000 },
    async () => {
      const directory = privateDirectory(mode);
      const driver = join(directory, "driver.mjs");
      const launcher = new URL("./ah-groups.mjs", import.meta.url).href;
      writeFileSync(
        driver,
        `import { runAhGroups } from ${JSON.stringify(launcher)};\nconst result = await runAhGroups({ groups: ["recovery"], directory: ${JSON.stringify(directory)}, deadlineMs: ${mode === "deadline" ? 1000 : 10000}, commandForGroup: () => ({ file: process.execPath, args: [${JSON.stringify(fixture)}, "recovery", "native"] }) });\nprocess.exitCode = result.exitCode;\n`,
      );
      const fd = openSync(join(directory, "outer.log"), "w");
      const outer = spawn(
        "/bin/bash",
        ["-c", 'trap ":" INT TERM; "$AH_TEST_NODE" "$AH_TEST_DRIVER"'],
        {
          detached: true,
          env: { ...process.env, AH_TEST_NODE: process.execPath, AH_TEST_DRIVER: driver },
          stdio: ["ignore", fd, fd],
        },
      );
      closeSync(fd);
      const exit = new Promise((resolveExit) =>
        outer.once("exit", (code, signal) => resolveExit({ code, signal })),
      );
      let owned = [];
      try {
        const ready = join(directory, "recovery/ready.json");
        await until(() => existsSync(ready), "native command ready");
        const native = JSON.parse(readFileSync(ready, "utf8"));
        await until(
          () =>
            spawnSync("pgrep", ["-P", String(native.childPid)], { encoding: "utf8" }).status === 0,
          "shell grandchild ready",
        );
        const grandchildren = spawnSync("pgrep", ["-P", String(native.childPid)], {
          encoding: "utf8",
        })
          .stdout.trim()
          .split("\n")
          .map(Number);
        owned = [native.wrapper, native.pid, native.childPid, ...grandchildren];
        assert.equal(
          pgid(native.wrapper),
          outer.pid,
          "fixture wrapper must retain the outer Bash process group",
        );
        assert.equal(pgid(native.childPid), native.childPid, "real native shell has its own group");
        if (mode === "SIGINT") process.kill(-outer.pid, "SIGINT");
        if (mode === "SIGTERM") {
          const children = spawnSync("pgrep", ["-P", String(outer.pid)], { encoding: "utf8" })
            .stdout.trim()
            .split("\n")
            .map(Number);
          assert.equal(children.length, 1);
          process.kill(children[0], "SIGTERM");
        }
        const result = await exit;
        assert.equal(result.code, mode === "SIGINT" ? 130 : mode === "SIGTERM" ? 143 : 1);
        await until(() => owned.every((pid) => !alive(pid)), "all nested native processes exited");
        assert(
          existsSync(join(directory, "recovery/release")),
          "cleanup released owned completion barrier",
        );
        const summary = JSON.parse(readFileSync(join(directory, "summary.json"), "utf8"));
        assert.equal(summary.outcomes[0].status, "failed");
        assert.equal(summary.exitCode, result.code);
      } finally {
        try {
          process.kill(-outer.pid, "SIGKILL");
        } catch {}
        for (const pid of owned) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    },
  );
}
