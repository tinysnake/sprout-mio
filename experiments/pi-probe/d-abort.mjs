/**
 * P0-d experiment d: stop a running agent from the host.
 *
 * Uses a persistent session so the probe can also prove the session is intact
 * and resumable after the abort. Replay step 2 asserts that.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lastAssistantText, sleep, startPi } from "./lib/rpc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, "results");
const sessionDir = join(resultsDir, "d-sessions");
mkdirSync(sessionDir, { recursive: true });
rmSync(join(sessionDir, "..", "d-sessions"), { recursive: true, force: true });
mkdirSync(sessionDir, { recursive: true });

const pi = startPi([
  "--mode",
  "rpc",
  "--session-dir",
  sessionDir,
  "--session-id",
  "probe-d",
  "--tools",
  "bash",
  "--thinking",
  "off",
]);

const startedAt = Date.now();
const events = [];
pi.onRecord((record) => {
  if (record.type !== "response") events.push(`${Date.now() - startedAt}:${record.type}`);
});

const summary = { scenario: "d-abort" };

const promptResponse = await pi.command({
  type: "prompt",
  message: "Use the bash tool to run the command `sleep 60`, then reply with the single word DONE.",
});
summary.promptDisposition = promptResponse.data?.disposition;

await pi.waitFor(
  (r) => r.type === "tool_execution_start" && r.toolName === "bash",
  60_000,
  "bash tool start",
);
summary.toolStart = "observed";
await sleep(1500);

const stateDuringRun = (await pi.command({ type: "get_state" })).data;
summary.isStreamingDuringRun = stateDuringRun?.isStreaming;
summary.messageCountDuringRun = stateDuringRun?.messageCount;
summary.sessionFile = stateDuringRun?.sessionFile;

const abortResponse = await pi.command({ type: "abort" }, 90_000);
summary.abortResponse = abortResponse;

const stateAfterAbort = (await pi.command({ type: "get_state" })).data;
summary.isStreamingAfterAbort = stateAfterAbort?.isStreaming;
summary.messageCountAfterAbort = stateAfterAbort?.messageCount;

const settled = pi.records.find((r) => r.type === "agent_settled");
summary.agentSettledAbortedFlag = settled?.aborted ?? null;
summary.lastTextAfterAbort = lastAssistantText(pi.records);
summary.childExit = await pi.close();
summary.exitIsClean = pi.exited === true;
summary.eventTypes = events;

writeFileSync(join(resultsDir, "d-abort.records.jsonl"), pi.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(join(resultsDir, "d-abort.stderr.txt"), pi.stderr.join(""));
writeFileSync(join(resultsDir, "d-abort.summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
