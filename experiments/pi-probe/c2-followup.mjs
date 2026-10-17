/**
 * P0-d experiment c2: follow-up delivery, the other queue mode.
 *
 * A follow-up waits until the run has no more tool calls or steering messages.
 * The run keeps its bash tool busy, then must answer both the original task and
 * the follow-up in the same settled run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assistantTexts, lastAssistantText, sleep, startPi } from "./lib/rpc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, "results");
mkdirSync(resultsDir, { recursive: true });

const pi = startPi(["--mode", "rpc", "--no-session", "--tools", "bash", "--thinking", "off"]);
const summary = { scenario: "c2-followup" };

await pi.command({
  type: "prompt",
  message: "Use the bash tool to run the command `sleep 15`, then reply with the single word SLEPT.",
});
await pi.waitFor((r) => r.type === "tool_execution_start" && r.toolName === "bash", 60_000, "bash start");
await sleep(1500);

summary.followUpResponse = await pi.command({
  type: "follow_up",
  message: "Then, on the next line, write exactly FOLLOWUP_ACK.",
});

await pi.waitFor((r) => r.type === "agent_settled", 120_000, "agent_settled");
summary.assistantTexts = assistantTexts(pi.records);
summary.finalText = lastAssistantText(pi.records);
summary.originalTaskCompleted = summary.assistantTexts.some((t) => t.includes("SLEPT"));
summary.followUpDelivered = summary.assistantTexts.some((t) => t.includes("FOLLOWUP_ACK"));
summary.agentStartCount = pi.records.filter((r) => r.type === "agent_start").length;
summary.exit = await pi.close();

writeFileSync(join(resultsDir, "c2-followup.records.jsonl"), pi.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(join(resultsDir, "c2-followup.summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
