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
const model = process.env.SPROUT_VERIFY_PI_MODEL?.trim() || undefined;
const now = new Date();
const threshold = { version: "p6a-design-default-v1", yes: 0.8, no: 0.2 };
const clock = () => performance.now();
const calls = { small_brain: 0, jev: 0 };
let jevPaidResponseReceived = false;
const judges = {
  small_brain: createSmallBrainJudge({
    agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    clock,
  }),
  jev: createJevJudge({
    apiKey: process.env.JEV_API_KEY,
    threshold,
    clock,
    fetch: async (...args) => {
      calls.jev++;
      const response = await fetch(...args);
      // Observe transport independently of evaluateWake's validated receipt.
      if (response.ok) {
        const data = await response
          .clone()
          .json()
          .catch(() => null);
        jevPaidResponseReceived = typeof data?.usage?.input_tokens === "number";
      }
      return response;
    },
  }),
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
  matched: boolean;
  multi: boolean;
  under: boolean;
  outsideCandidates: string[];
  contractFailures: string[];
  infraFailure: boolean;
  requestCount: number;
  paidResponseReceived: boolean;
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
    let paidResponseReceived = false;
    jevPaidResponseReceived = false;
    const callsBefore = calls[provider];
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
      const selectedJudge: WakeJudge = async (value) => {
        if (provider === "small_brain") calls.small_brain++;
        const raw = await judges[provider](value);
        // Pi completion usage is the host runner's evidence of a paid response;
        // JEV additionally has the independently observed HTTP usage above.
        paidResponseReceived =
          provider === "jev" ? jevPaidResponseReceived : raw.usage.inputTokens !== null;
        return raw;
      };
      receipt = await evaluateWake(input, {
        small_brain: provider === "small_brain" ? selectedJudge : unselected,
        jev: provider === "jev" ? selectedJudge : unselected,
      });
    }
    const selected = receipt.result.selectedRecipients.map(recipientKey).sort();
    const expected = [...fixture.expected.selected].sort();
    const sideEffects = counts();
    const matched = JSON.stringify(selected) === JSON.stringify(expected);
    // Accuracy is measured across the batch. Over- and under-wakes are the two
    // error classes a probabilistic judge actually produces, so they are counted
    // and reported rather than failed per sample; only a recipient outside the
    // snapshot's own candidate set is structurally unsafe.
    const candidateKeys = input.candidates.map((candidate) => recipientKey(candidate.recipient));
    const extra = selected.filter((key) => !expected.includes(key));
    const missing = expected.filter((key) => !selected.includes(key));
    const multi = extra.length > 0;
    const under = missing.length > 0;
    const outsideCandidates = selected.filter((key) => !candidateKeys.includes(key));
    const requestCount = calls[provider] - callsBefore;
    const recordedModel = provider === "jev" ? receipt.usage.resolvedModel : receipt.result.model;
    // Transport/contract failures cannot be hidden by matching an empty set or by
    // another sample's success. A host model that never answered is an infra
    // hiccup, not a broken contract, so the two are counted apart: a paid response
    // must satisfy every check, an unpaid one must at least fail as unavailable.
    const paid = receipt.usage.inputTokens !== null;
    // A raw JSON answer from a flash model occasionally fails to parse; the judge
    // then refuses to wake, which is safe. That and a host hiccup are tolerated
    // once per provider per run. Anything with a paid response must be exact.
    const infraCodes = ["provider_unavailable", "provider_timeout", "provider_invalid_response"];
    const checks = paid
      ? {
          receiptExists: !!receipt.result && !!receipt.usage,
          paidResponseConsistent: paidResponseReceived,
          singleCall: requestCount === 1,
          modelEvidence:
            provider === "jev"
              ? /^jev-\d+\.\d+\.\d+$/.test(recordedModel ?? "")
              : recordedModel === policy.model && receipt.usage.outputTokens !== null,
          sideEffectsZero: Object.values(sideEffects).every((count) => count === 0),
          snapshotHashMatches: receipt.result.snapshotHash === input.snapshotHash,
          validResult:
            receipt.result.errorCode === null ||
            receipt.result.errorCode === "provider_low_certainty",
        }
      : {
          receiptExists: !!receipt.result && !!receipt.usage,
          unpaidIsUnavailable: infraCodes.includes(receipt.result.errorCode ?? "none"),
          sideEffectsZero: Object.values(sideEffects).every((count) => count === 0),
        };
    const contractFailures = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([key]) => key);
    const infraFailure = !paid && contractFailures.length === 0;
    const exitCode = outsideCandidates.length > 0 || contractFailures.length > 0 ? 1 : 0;
    const record = {
      mode: "live",
      provider,
      model: policy.model,
      sample: fixture.id,
      source: fixture.source,
      evaluatedAt: now.toISOString(),
      requestAttempted: attempted,
      requestCount,
      paidResponseReceived,
      recordedModel,
      checks,
      contractFailures,
      infraFailure,
      multi,
      under,
      outsideCandidates,
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
      model: recordedModel ?? policy.model,
      sample: fixture.id,
      exitCode,
      matched,
      multi,
      under,
      outsideCandidates,
      contractFailures,
      infraFailure,
      requestCount,
      paidResponseReceived,
      errorCode: receipt.result.errorCode,
      durationMs: receipt.usage.durationMs,
    });
    console.log(
      `${exitCode ? "FAIL" : "PASS"} live ${provider}/${fixture.id}: ${receipt.result.decision}, selected=${selected.join(",") || "none"}, model=${recordedModel ?? "unavailable"}, matched=${matched}, multi=${multi}, under=${under}, outside=${outsideCandidates.length}, calls=${requestCount}, paid=${paidResponseReceived}, contract=${contractFailures.join(",") || "ok"}, tokens=${receipt.usage.inputTokens ?? "unavailable"}, ms=${receipt.usage.durationMs.toFixed(0)}, reason=${receipt.result.reason}, receipt=${join(directory, `${provider}-${fixture.id}.json`)}`,
    );
  }
}
// Accuracy is a measurement, not a gate: the product ships a probabilistic judge
// and accepts its over- and under-wakes for now (coordinator decision d31). What
// the gate refuses is a broken contract, a recipient outside the candidate set,
// or more than one host hiccup per provider per run.
const accuracy = (["small_brain", "jev"] as const).map((provider) => {
  const rows = summaries.filter((row) => row.provider === provider);
  const flag = (key: "matched" | "multi" | "under") => rows.filter((row) => row[key]).length;
  const outside = rows.filter((row) => row.outsideCandidates.length > 0).length;
  const result = {
    provider,
    models: [...new Set(rows.map((row) => row.model))],
    total: rows.length,
    matched: flag("matched"),
    multi: flag("multi"),
    under: flag("under"),
    outsideCandidates: outside,
    contractFailures: rows.filter((row) => row.contractFailures.length).length,
    infraFailures: rows.filter((row) => row.infraFailure).length,
    calls: calls[provider],
    paidResponses: rows.filter((row) => row.paidResponseReceived).length,
  };
  // JEV cannot gate a release it does not ship: the product deploys the small
  // brain, and the JEV contract is proven by the deterministic routing fixture.
  const gated = provider === "small_brain";
  const tolerated = !gated || result.infraFailures <= 1;
  console.log(
    `${tolerated && (!gated || (result.contractFailures === 0 && result.outsideCandidates === 0)) ? "PASS" : "FAIL"} live run: ${result.matched}/${result.total} matched (multi=${result.multi}, under=${result.under}, outside=${result.outsideCandidates}), contractFailures=${result.contractFailures}, infraFailures=${result.infraFailures} (1 tolerated); provider=${provider}, model=${result.models.join(",")}, calls=${result.calls}, paid=${result.paidResponses}; ${gated ? "gated" : "reported only, not deployed"}`,
  );
  return { ...result, tolerated };
});
const exitCode =
  summaries.some((row) => row.exitCode) ||
  accuracy.some((row) => !row.tolerated || row.contractFailures > 0 || row.outsideCandidates > 0)
    ? 1
    : 0;
writeFileSync(
  join(directory, "summary.json"),
  JSON.stringify({ mode: "live", exitCode, accuracy, samples: summaries }, null, 2) + "\n",
);
console.log(`Live gate exit ${exitCode}; receipts ${directory}; no fixture transport used`);
sqlite.close();
process.exitCode = exitCode;
