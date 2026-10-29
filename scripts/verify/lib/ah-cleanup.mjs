import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function signal(pid, name, group = false) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(group ? -pid : pid, name);
  } catch (error) {
    if (error.code === "ESRCH") return;
    // macOS can return EPERM for a group that vanished between the two cleanup passes.
    if (error.code === "EPERM" && group) {
      const snapshot = spawnSync("ps", ["-axo", "pgid="], { encoding: "utf8" });
      if (
        snapshot.status === 0 &&
        !snapshot.stdout.split("\n").some((line) => Number(line.trim()) === pid)
      )
        return;
    }
    throw error;
  }
}

export function killAhNativeCommands(state) {
  const executions = join(state, "executions");
  if (!existsSync(executions)) return;
  const claims = [];
  for (const entry of readdirSync(executions, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(executions, entry.name, "runner.json");
    if (!existsSync(path)) continue;
    const claim = JSON.parse(readFileSync(path, "utf8"));
    if (claim.executionId !== entry.name) throw new Error(`Invalid private runner claim: ${path}`);
    claims.push(claim);
  }
  if (claims.length === 0) return;
  // Freeze producers before taking ancestry: a spawned command may not yet be in runner.json.
  for (const claim of claims) signal(claim.pid, "SIGSTOP", true);
  try {
    let processes;
    const deadline = Date.now() + 2000;
    for (;;) {
      const snapshot = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat="], {
        encoding: "utf8",
      });
      if (snapshot.status !== 0) throw new Error("Cannot inspect private runner descendants");
      processes = snapshot.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [pid, ppid, pgid, status] = line.trim().split(/\s+/);
          return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), status };
        });
      if (
        claims.every((claim) => {
          const runner = processes.find((row) => row.pid === claim.pid);
          return !runner || runner.status.startsWith("T") || runner.status.startsWith("Z");
        })
      )
        break;
      if (Date.now() >= deadline) throw new Error("Private runners did not stop before cleanup");
    }
    const descendants = new Set(
      claims.map((claim) => claim.pid).filter((pid) => Number.isSafeInteger(pid) && pid > 1),
    );
    let changed;
    do {
      changed = false;
      for (const row of processes) {
        if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
          descendants.add(row.pid);
          changed = true;
        }
      }
    } while (changed);
    const groups = new Set(claims.map((claim) => claim.childPid));
    for (const row of processes) {
      if (descendants.has(row.pid)) groups.add(row.pgid);
    }
    const runnerGroups = new Set(claims.map((claim) => claim.pid));
    for (const pgid of groups) {
      if (!runnerGroups.has(pgid)) signal(pgid, "SIGKILL", true);
    }
  } finally {
    for (const claim of claims) signal(claim.pid, "SIGKILL", true);
  }
}

export async function cleanupAhFixture({
  children,
  state,
  completionFiles = [],
  childrenPids = [],
}) {
  for (const path of completionFiles) writeFileSync(path, "release", { mode: 0o600 });
  // Resume frozen components before terminating them; command runners have separate groups.
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGCONT");
    child.kill("SIGTERM");
  }
  killAhNativeCommands(state);
  for (const pid of childrenPids) signal(pid, "SIGKILL", true);
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        const deadline = setTimeout(() => child.kill("SIGKILL"), 2500);
        child.once("exit", () => {
          clearTimeout(deadline);
          resolve();
        });
      });
    }),
  );
  // A Worker may have been dispatching when TERM arrived. Read its final claims after exit.
  killAhNativeCommands(state);
}
