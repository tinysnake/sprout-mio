import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sqlite } from "../../src/db";
import {
  evaluateWake,
  failedWakeResult,
  prepareWakeEvaluation,
  recipientKey,
  type WakeReceipt,
  type WakeJudge,
} from "../../src/domain/wake-evaluation";
import { createSmallBrainJudge } from "../../src/domain/wake-providers/small-brain";
import { createJevJudge, JEV_MODEL } from "../../src/domain/wake-providers/jev";
import { loadWakeCases } from "./p6a/cases";

const directory = resolve(process.env.SPROUT_VERIFY_DIR ?? ".verify/p6a-live-routing");
mkdirSync(directory, { recursive: true });
const model = process.env.SPROUT_VERIFY_PI_MODEL;
const now = new Date();
const threshold = { version: "p6a-design-default-v1", yes: 0.8, no: 0.2 };
const clock = () => performance.now();
const judges = {
  small_brain: createSmallBrainJudge({
    agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    clock,
  }),
  jev: createJevJudge({ apiKey: process.env.JEV_API_KEY, threshold, clock }),
};
const counts = () =>
  Object.fromEntries(
    [
      ["runs", "agent_run"],
      ["messages", "message"],
      ["inputs", "agent_run_input"],
    ].map(([key, table]) => [
      key,
      (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
    ]),
  );
const summaries: {
  provider: string;
  model: string;
  sample: string;
  exitCode: number;
  errorCode: string | null;
  durationMs: number;
}[] = [];
for (const provider of ["small_brain", "jev"] as const) {
  for (const fixture of loadWakeCases().filter((item) => item.input)) {
    const policy = {
      provider,
      configRevision: 1,
      model: provider === "jev" ? JEV_MODEL : (model ?? "missing/model"),
      thresholdVersion: threshold.version,
    };
    const prepared = prepareWakeEvaluation({ ...fixture.facts, policy }, now);
    if (prepared.kind !== "model" && prepared.kind !== "rule")
      throw new Error(`Missing live input for ${fixture.id}`);
    const input = prepared.input;
    const start = clock();
    // Direct adapter evaluation also measures explicit rule sample w22; this does not dispatch it.
    let attempted = true;
    let receipt: WakeReceipt;
    if (provider === "small_brain" && !model) {
      attempted = false;
      receipt = {
        result: failedWakeResult(
          input,
          "provider_unavailable",
          "缺少 SPROUT_VERIFY_PI_MODEL；必须由 live-model.sh 显式选择真实模型",
        ),
        usage: {
          inputTokens: null,
          outputTokens: null,
          inputCharacters: Array.from(JSON.stringify(input)).length,
          durationMs: 0,
        },
      };
    } else {
      if (provider === "jev" && !process.env.JEV_API_KEY?.trim()) attempted = false;
      const unselected: WakeJudge = async () => {
        throw new Error("provider fallback forbidden");
      };
      receipt = await evaluateWake(input, {
        small_brain: provider === "small_brain" ? judges.small_brain : unselected,
        jev: provider === "jev" ? judges.jev : unselected,
      });
    }
    const selected = receipt.result.selectedRecipients.map(recipientKey).sort();
    const expected = [...fixture.expected.selected].sort();
    const sideEffects = counts();
    const matched = JSON.stringify(selected) === JSON.stringify(expected);
    const sideEffectsZero = Object.values(sideEffects).every((count) => count === 0);
    const exitCode = receipt.result.errorCode === null && matched && sideEffectsZero ? 0 : 1;
    const record = {
      mode: "live",
      provider,
      model: policy.model,
      sample: fixture.id,
      source: fixture.source,
      evaluatedAt: now.toISOString(),
      requestAttempted: attempted,
      paidResponseReceived: receipt.usage.inputTokens !== null,
      inputUsage: receipt.usage,
      runnerDurationMs: clock() - start,
      threshold:
        provider === "jev"
          ? { ...threshold, calibrated: false, source: "p6a-design.md §1.2 coordinator defaults" }
          : null,
      input,
      chineseResult: receipt.result,
      expectedSelected: expected,
      matched,
      sideEffects,
      exitCode,
    };
    writeFileSync(
      join(directory, `${provider}-${fixture.id}.json`),
      JSON.stringify(record, null, 2) + "\n",
    );
    summaries.push({
      provider,
      model: policy.model,
      sample: fixture.id,
      exitCode,
      errorCode: receipt.result.errorCode,
      durationMs: receipt.usage.durationMs,
    });
    console.log(
      `${exitCode ? "FAIL" : "PASS"} live ${provider}/${fixture.id}: ${receipt.result.decision}, selected=${selected.join(",") || "none"}, tokens=${receipt.usage.inputTokens ?? "unavailable"}, ms=${receipt.usage.durationMs.toFixed(0)}, reason=${receipt.result.reason}, receipt=${join(directory, `${provider}-${fixture.id}.json`)}`,
    );
  }
}
const exitCode = summaries.some((row) => row.exitCode) ? 1 : 0;
writeFileSync(
  join(directory, "summary.json"),
  JSON.stringify({ mode: "live", exitCode, samples: summaries }, null, 2) + "\n",
);
console.log(`Live gate exit ${exitCode}; receipts ${directory}; no fixture transport used`);
sqlite.close();
process.exitCode = exitCode;
