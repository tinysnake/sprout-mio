import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureModels, fixtureProvider, startModelFixture, statusTurn } from "./model-fixture.mjs";

const [extension, metadataPath] = process.argv.slice(2);
assert(extension && metadataPath, "extension path and metadata path required");
const privateDir = mkdtempSync(join(tmpdir(), "sprout-status-model-fixture-"));
let fixture;
let child;
let childDone;
let killTimer;
let interrupted = false;
const stop = () => {
  interrupted = true;
  child?.kill("SIGTERM");
  killTimer ??= setTimeout(() => child?.kill("SIGKILL"), 3000);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  fixture = await startModelFixture({ privateDir });
  fixture.arm("status", statusTurn());
  console.log(
    `CHAT mode=model-fixture runner=installed-Pi-CLI provider/model=${fixture.model("status")} thinking=off`,
  );
  const sessions = join(privateDir, "sessions");
  child = spawn(
    process.execPath,
    [
      join(fixture.agentDir, "bin", "pi"),
      "--offline",
      "--model",
      fixture.model("status"),
      "--thinking",
      "off",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "-e",
      resolve(extension),
      "--tools",
      "sprout_status",
      "--mode",
      "json",
      "--session-dir",
      sessions,
      "-p",
      statusTurn().expectedUserText,
    ],
    {
      env: { ...process.env, PI_CODING_AGENT_DIR: fixture.agentDir },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  childDone = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const { code, signal } = await childDone;
  assert.equal(code, 0, "real Pi CLI exits successfully");
  assert.equal(signal, null, "real Pi CLI was not interrupted");
  assert(!interrupted, "status fixture was not interrupted");
  fixture.assertDrained();
  const entries = readdirSync(sessions)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) =>
      readFileSync(join(sessions, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  const actualModels = entries
    .filter((entry) => entry.type === "model_change")
    .map(({ provider, modelId }) => ({ provider, model: modelId }));
  const actualThinking = entries
    .filter((entry) => entry.type === "thinking_level_change")
    .map((entry) => entry.thinkingLevel);
  assert(
    actualModels.length > 0 &&
      actualModels.every(
        (entry) => entry.provider === fixtureProvider && entry.model === fixtureModels.status,
      ),
    "actual CLI model is pinned to the local fixture",
  );
  assert(
    actualThinking.length > 0 && actualThinking.every((thinking) => thinking === "off"),
    "actual CLI thinking is off",
  );
  const metadata = { ...fixture.metadata(), actualModels, actualThinking };
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  console.log(`CHAT metadata ${JSON.stringify(metadata)}`);
} catch (error) {
  if (fixture) writeFileSync(metadataPath, JSON.stringify(fixture.metadata(), null, 2));
  console.error(error instanceof Error ? error.message : "status model fixture failed");
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  clearTimeout(killTimer);
  if (child?.exitCode === null && child?.signalCode === null) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      await childDone;
    } catch {
    } finally {
      clearTimeout(timer);
    }
  }
  await fixture?.close();
  rmSync(privateDir, { recursive: true, force: true });
}
