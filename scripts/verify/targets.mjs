import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CI_GROUPS, validateGateTargets } from "./lib/targets-plan.mjs";
import { validateUnitTargets } from "./lib/test-targets.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const [target, ...args] = process.argv.slice(2);
const valid = new Set(["ci", "local"]);
let group;
let list = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--list") list = true;
  else if (args[i] === "--group" && args[i + 1]) group = args[++i];
  else throw new Error(`Unknown target option: ${args[i]}`);
}
if (!valid.has(target) || (group && (target !== "ci" || !Object.hasOwn(CI_GROUPS, group))))
  throw new Error("Usage: targets.mjs <ci|local> [--group <CI group>] [--list]");
const inventory = validateGateTargets(root);
validateUnitTargets(root);
const gates = group ? CI_GROUPS[group] : inventory[target];
if (list) {
  console.log(JSON.stringify({ target, group: group ?? null, gates }, null, 2));
} else {
  let active;
  let interrupted;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      interrupted ??= signal;
      if (active?.pid) {
        try {
          process.kill(active.pid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    });
  const outcomes = [];
  // CI jobs have independent checkouts; keep each job's gates serial on the hosted runner.
  const batches = target === "ci" ? gates.map((gate) => [gate]) : [gates];
  for (const batch of batches) {
    if (interrupted) break;
    const startedAt = new Date().toISOString();
    console.log(`RUN target=${target} group=${group ?? "all"} gates=${batch.join(",")}`);
    const result = await new Promise((resolve) => {
      active = spawn(process.execPath, ["scripts/verify/runner.mjs", "--only", batch.join(",")], {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, SPROUT_VERIFY_TARGET: target },
      });
      active.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
      active.once("exit", (code, signal) => resolve({ code, signal }));
    });
    active = undefined;
    outcomes.push({ gates: batch, startedAt, finishedAt: new Date().toISOString(), ...result });
  }
  const directory = join(root, ".verify/targets");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${target}-${group ?? "all"}.json`),
    JSON.stringify(
      {
        target,
        group: group ?? null,
        selectedGates: gates,
        interrupted: interrupted ?? null,
        outcomes,
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = interrupted
    ? interrupted === "SIGINT"
      ? 130
      : 143
    : outcomes.some((result) => result.code !== 0)
      ? 1
      : 0;
}
