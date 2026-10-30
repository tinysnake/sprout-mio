import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validateUnitTargets } from "./lib/test-targets.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const [target, option] = process.argv.slice(2);
const inventory = validateUnitTargets(root);
if (!Object.hasOwn(inventory, target) || process.argv.length > 4 || (option && option !== "--list"))
  throw new Error("Usage: test-target.mjs <ci|local> [--list]");
const files = inventory[target];
if (option === "--list") console.log(JSON.stringify({ target, files }, null, 2));
else {
  console.log(`RUN unit target=${target} files=${files.length}`);
  const environment = { ...process.env, NODE_ENV: "test", MCP_EVERYTHING: "0" };
  if (target === "ci") {
    const agent = mkdtempSync(join(tmpdir(), "sprout-ci-unit-agent-"));
    process.once("exit", () => rmSync(agent, { recursive: true, force: true }));
    for (const name of ["PI_MCP_MODULE", "PI_BIN", "SPROUT_PI_RUNNER", "SPROUT_PI_COMMAND"])
      delete environment[name];
    environment.PI_CODING_AGENT_DIR = agent;
    environment.SPROUT_PI_ENABLED = "false";
  }
  const child = spawn(
    "pnpm",
    ["exec", "vp", "test", "run", "--maxWorkers", target === "ci" ? "2" : "4", ...files],
    {
      cwd: root,
      stdio: "inherit",
      env: environment,
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    });
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  });
}
