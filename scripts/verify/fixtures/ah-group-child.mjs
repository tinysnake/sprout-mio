import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAhFixture } from "../lib/ah-cleanup.mjs";

const [group, mode] = process.argv.slice(2);
const directory = process.env.AH_FIXTURE_DIRECTORY;
const ids = {
  execution: ["service", "tools", "worker", "S1", "S2", "S3", "S4/S10", "S11"],
  cancellation: ["S6", "S6b", "S6c", "S7"],
  recovery: ["S8", "S12", "S9", "S5"],
};
const checks = ids[group].map((id) => ({ id }));
const ready = join(directory, "ready.json");
if (mode === "native" || mode === "native-failure") {
  const state = join(directory, "private-state");
  const runner = spawn(
    process.execPath,
    [resolve("src/worker/runner.mjs"), "native-test", "private-test-token", state, "/bin/sh"],
    {
      detached: true,
      env: { ...process.env, SPROUT_RUNNER_COMMAND: "trap '' TERM; while :; do sleep 1; done" },
      stdio: "ignore",
    },
  );
  const barrier = join(directory, "release");
  writeFileSync(join(directory, "processes.json"), JSON.stringify([runner.pid]));
  let stopping = false;
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void cleanupAhFixture({ children: [runner], state, completionFiles: [barrier] }).then(() =>
        process.exit(code),
      );
    });
  }
  const observe = setInterval(() => {
    const claim = join(state, "executions/native-test/runner.json");
    if (!existsSync(claim)) return;
    const data = JSON.parse(readFileSync(claim, "utf8"));
    if (!data.childPid) return;
    const descendants = spawnSync("pgrep", ["-P", String(data.childPid)], { encoding: "utf8" });
    if (descendants.status !== 0) return;
    clearInterval(observe);
    writeFileSync(
      ready,
      JSON.stringify({
        wrapper: process.pid,
        ...data,
        descendants: descendants.stdout.trim().split("\n").map(Number),
      }),
    );
  }, 10);
  setInterval(() => {
    if (mode !== "native-failure" || group !== "cancellation") return;
    if (
      ["execution", "cancellation", "recovery"].every((name) =>
        existsSync(join(resolve(directory, ".."), name, "ready.json")),
      )
    )
      process.exit(23);
  }, 10);
} else {
  writeFileSync(ready, JSON.stringify({ wrapper: process.pid }));
  // The success case cannot finish until all three independent children have started.
  const wait = setInterval(() => {
    const parent = resolve(directory, "..");
    if (
      !["execution", "cancellation", "recovery"].every((name) =>
        existsSync(join(parent, name, "ready.json")),
      )
    )
      return;
    clearInterval(wait);
    if (group === "cancellation") {
      if (mode === "failure") process.exit(23);
      if (mode === "missing") checks.pop();
      if (mode === "duplicate") checks[1] = checks[0];
      if (mode === "unexpected") checks[1] = { id: "not-an-original-assertion" };
    }
    writeFileSync(
      join(directory, "evidence.json"),
      JSON.stringify({
        group,
        status: "passed",
        checks,
        readiness: ["service", "tools", "worker"],
      }),
    );
  }, 10);
}
