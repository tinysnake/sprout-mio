/**
 * P0-d experiment c: deliver a new user message while a run is in flight.
 *
 * The run is kept busy by a long bash tool call, so the steering window
 * ("after the current assistant turn finishes its tool calls, before the next
 * LLM call") is observable and wide.
 *
 * Prints a summary and writes the raw RPC record stream to results/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assistantTexts, lastAssistantText, sleep, startPi } from "./lib/rpc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, "results");
mkdirSync(resultsDir, { recursive: true });

const pi = startPi([
  "--mode",
  "rpc",
  "--no-session",
  "--tools",
  "bash",
  "--thinking",
  "off",
]);

const startedAt = Date.now();
const stamp = (record) => ({ t: Date.now() - startedAt, type: record.type, record });

const events = [];
pi.onRecord((record) => {
  if (record.type === "response") return;
  events.push(stamp(record));
});

const summary = { scenario: "c-steer" };

await pi.command({ type: "prompt", message: "Use the bash tool to run the command `sleep 20`. After it returns, reply with the single word SLEPT." });

await pi.waitFor(
  (r) => r.type === "tool_execution_start" && r.toolName === "bash",
  60_000,
  "bash tool start",
);
summary.toolStart = "observed";
await sleep(1500);

summary.stateDuringRun = (await pi.command({ type: "get_state" })).data;

const steerResponse = await pi.command({
  type: "steer",
  message: "Ignore the sleep task. Reply with exactly STEER_RECEIVED and nothing else.",
});
summary.steerResponse = steerResponse;

const rejectedDuringStreaming = await pi.command({
  type: "prompt",
  message: "This prompt has no streamingBehavior and should be rejected.",
});
summary.promptDuringStreamingWithoutBehavior = rejectedDuringStreaming;

await pi.waitFor((r) => r.type === "agent_settled", 120_000, "agent_settled");
summary.agentSettled = true;
summary.finalText = lastAssistantText(pi.records);
summary.assistantTexts = assistantTexts(pi.records);

const messages = (await pi.command({ type: "get_messages" })).data?.messages ?? [];
summary.userMessageTexts = messages
  .filter((m) => m.role === "user")
  .map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("")));
summary.steerReachedTranscript = summary.userMessageTexts.some((t) => t.includes("STEER_RECEIVED"));
summary.originalTaskAbandoned = summary.finalText?.includes("STEER_RECEIVED") ?? false;

const exit = await pi.close();
summary.exit = exit;
summary.eventTypes = events.map((e) => `${e.t}:${e.type}`);

writeFileSync(join(resultsDir, "c-steer.records.jsonl"), pi.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(join(resultsDir, "c-steer.stderr.txt"), pi.stderr.join(""));
writeFileSync(join(resultsDir, "c-steer.summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
