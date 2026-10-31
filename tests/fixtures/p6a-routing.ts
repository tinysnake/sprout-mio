import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sqlite } from "../../src/db";
import {
  wakeEvaluationInputSchema,
  type WakeEvaluationInput,
} from "../../src/contracts/wake-evaluation";
import {
  evaluateWake,
  prepareWakeEvaluation,
  recipientKey,
  type WakeSnapshotFacts,
  type WakeJudge,
} from "../../src/domain/wake-evaluation";
import { createSmallBrainJudge } from "../../src/domain/wake-providers/small-brain";
import { createJevJudge, JEV_MODEL } from "../../src/domain/wake-providers/jev";
import { loadWakeCases } from "./p6a/cases";

let assertions = 0;
function equal(actual: unknown, expected: unknown) {
  assertions++;
  assert.deepEqual(actual, expected);
}
function ok(value: unknown) {
  assertions++;
  assert.ok(value);
}
const effects = () =>
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
const clock = () => 100;
const threshold = { version: "fixture-v1", yes: 0.8, no: 0.2 };
const cases = loadWakeCases();
const unused: WakeJudge = async () => {
  throw new Error("unselected provider called");
};
function forProvider(input: WakeEvaluationInput, provider: "small_brain" | "jev") {
  const snapshot = {
    ...input,
    policy: {
      ...input.policy,
      provider,
      model: provider === "jev" ? JEV_MODEL : "fixture/model",
    },
    snapshotHash: "0".repeat(64),
  };
  snapshot.snapshotHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return wakeEvaluationInputSchema.parse(snapshot);
}
function judgesFor(input: WakeEvaluationInput, selected: string[]) {
  return {
    small_brain: createSmallBrainJudge({
      agentDir: "/unused",
      clock,
      complete: async (request) => {
        equal(JSON.parse(request.prompt), input);
        return {
          text: JSON.stringify({
            decisions: input.candidates.map((candidate) => ({
              recipient: candidate.recipient,
              decision: selected.includes(recipientKey(candidate.recipient)) ? "yes" : "no",
              certainty: "high",
              reason: "中文 fixture 预设结论",
            })),
          }),
          inputTokens: 123,
          outputTokens: 12,
        };
      },
    }),
    jev: createJevJudge({
      apiKey: "fixture-secret",
      clock,
      threshold,
      fetch: async (url, init) => {
        equal(url, "https://api.typesafe.ai/v1/systemone");
        if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
        const payload = JSON.parse(init.body);
        equal(payload.state, input);
        equal(payload.model, JEV_MODEL);
        equal(Object.keys(payload.questions).length, input.candidates.length);
        ok(
          Object.values(payload.questions).every(
            (question) => (question as { type: string }).type === "noul",
          ),
        );
        return Response.json({
          model: JEV_MODEL,
          answers: Object.fromEntries(
            input.candidates.map((candidate, index) => [
              `candidate_${index}`,
              {
                type: "noul",
                noul: selected.includes(recipientKey(candidate.recipient)) ? 0.95 : 0.05,
              },
            ]),
          ),
          usage: { input_tokens: 123, output_tokens: 12 },
        });
      },
    }),
  };
}

for (const fixture of cases) {
  const before = assertions;
  const prepared = prepareWakeEvaluation(fixture.facts, new Date(fixture.now));
  equal(prepared.kind, fixture.expected.preparation);
  equal(
    prepared.kind === "model" || prepared.kind === "rule" ? prepared.input : null,
    fixture.input,
  );
  equal(
    fixture.input?.candidates.map((candidate) => recipientKey(candidate.recipient)) ?? [],
    fixture.expected.candidates,
  );
  if (fixture.input && prepared.kind === "model") {
    for (const provider of ["small_brain", "jev"] as const) {
      const input = forProvider(fixture.input, provider);
      let selectedCalls = 0;
      let otherCalls = 0;
      const available = judgesFor(input, fixture.expected.selected);
      const selected: WakeJudge = async () => {
        selectedCalls++;
        return available[provider](input);
      };
      const other: WakeJudge = async () => {
        otherCalls++;
        return unused(input);
      };
      const receipt = await evaluateWake(input, {
        small_brain: provider === "small_brain" ? selected : other,
        jev: provider === "jev" ? selected : other,
      });
      equal(receipt.result.selectedRecipients.map(recipientKey), fixture.expected.selected);
      equal(receipt.result.errorCode, null);
      equal(receipt.result.recipients.length, input.candidates.length);
      equal(receipt.usage.inputTokens, 123);
      equal(selectedCalls, fixture.expected.providerCalls);
      equal(otherCalls, 0);
      equal(effects(), fixture.expected.sideEffects);
    }
  } else if (prepared.kind === "rule") {
    equal(prepared.result.selectedRecipients.map(recipientKey), fixture.expected.selected);
    equal(fixture.expected.providerCalls, 0);
    equal(effects(), fixture.expected.sideEffects);
  } else {
    equal(fixture.expected.providerCalls, 0);
    equal(prepared.kind === "skipped" && prepared.reasonCode, "no_assigned_task");
    equal(effects(), fixture.expected.sideEffects);
  }
  console.log(`PASS ${fixture.id}: ${assertions - before} assertions (fixture, no paid calls)`);
}

const baseline = cases.find((fixture) => fixture.id === "w06")!;
const input = baseline.input!;
const beforeRules = assertions;
const clone = (): WakeSnapshotFacts => structuredClone(baseline.facts);
const mentionFacts = clone();
const target = mentionFacts.members[1];
const mentioned = prepareWakeEvaluation(
  {
    ...mentionFacts,
    chat: { ...mentionFacts.chat, wakePolicy: "owner_led" },
    triggerMessage: { ...mentionFacts.triggerMessage!, body: `${target.profileName} 请处理` },
  },
  new Date(baseline.now),
);
equal(mentioned.kind, "rule");
if (mentioned.kind === "rule")
  equal(mentioned.result.selectedRecipients.map(recipientKey), [
    recipientKey(target.candidate.recipient),
  ]);
for (const field of ["projectMember", "effectiveMember"] as const) {
  const facts = clone();
  const prepared = prepareWakeEvaluation(
    { ...facts, members: facts.members.map((m, index) => (index ? m : { ...m, [field]: false })) },
    new Date(baseline.now),
  );
  ok(prepared.kind === "model");
  if (prepared.kind === "model") equal(prepared.input.candidates.length, facts.members.length - 1);
}
const senderFacts = clone();
const senderPrepared = prepareWakeEvaluation(
  {
    ...senderFacts,
    triggerMessage: {
      ...senderFacts.triggerMessage!,
      kind: "agent",
      sender: senderFacts.members[0].candidate.recipient,
    },
  },
  new Date(baseline.now),
);
ok(senderPrepared.kind === "model");
if (senderPrepared.kind === "model")
  ok(
    !senderPrepared.input.candidates.some(
      (c) => c.recipient.id === senderFacts.members[0].candidate.recipient.id,
    ),
  );
const nonowner = prepareWakeEvaluation(
  {
    ...senderFacts,
    triggerMessage: {
      ...senderFacts.triggerMessage!,
      kind: "agent",
      sender: senderFacts.members[1].candidate.recipient,
    },
  },
  new Date(baseline.now),
);
ok(nonowner.kind === "model");
const longFacts = clone();
const messages = Array.from({ length: 25 }, (_, index) => ({
  ...longFacts.recentMessages[0],
  id: `msg_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  body: "😀".repeat(3000),
  createdAt: new Date(new Date(baseline.now).getTime() + index * 1000).toISOString(),
}));
const trimmed = prepareWakeEvaluation(
  {
    ...longFacts,
    recentMessages: messages,
    triggerMessage: { ...longFacts.triggerMessage!, body: "中".repeat(3000) },
  },
  new Date(baseline.now),
);
ok(trimmed.kind === "model");
if (trimmed.kind === "model") {
  equal(trimmed.input.recentMessages.length, 6);
  equal(trimmed.input.truncation.recentMessageCharacters, 12000);
  equal(trimmed.input.truncation.droppedMessageIdRange, {
    first: messages[0].id,
    last: messages[18].id,
  });
  equal(Array.from(trimmed.input.triggerMessage!.body).length, 2000);
  equal(trimmed.input.triggerMessage!.truncated, true);
  ok(
    trimmed.input.recentMessages.every(
      (message) => message.truncated && Array.from(message.body).length === 2000,
    ),
  );
}
const manyShort = prepareWakeEvaluation(
  { ...longFacts, recentMessages: messages.map((m) => ({ ...m, body: "短" })) },
  new Date(baseline.now),
);
if (manyShort.kind !== "model") throw new Error("expected model");
equal(manyShort.input.recentMessages.length, 20);
const overflow = prepareWakeEvaluation(
  {
    ...longFacts,
    members: Array.from({ length: 200 }, (_, index) => ({
      ...longFacts.members[0],
      candidate: {
        ...longFacts.members[0].candidate,
        recipient: { kind: "agent", id: `large_${index}` },
        personaSummary: "中".repeat(600),
      },
    })),
  },
  new Date(baseline.now),
);
equal(overflow.kind, "failed");
if (overflow.kind === "failed") equal(overflow.result.errorCode, "context_budget_exceeded");
const taskFacts = structuredClone(cases.find((fixture) => fixture.id === "w12")!.facts);
const assignedTask = taskFacts.tasks[0];
const periodic = prepareWakeEvaluation(
  {
    ...taskFacts,
    source: "task_periodic",
    triggerId: "round_2",
    triggerMessage: null,
    tasks: [
      assignedTask,
      {
        ...assignedTask,
        id: "tsk_00000000-0000-4000-8000-000000000001",
        title: "第二个 assigned Task",
        recordCount: 1,
        lastRecord: {
          id: "record_1",
          seq: 1,
          kind: "progress",
          body: "记录".repeat(1000),
          truncated: false,
        },
      },
    ],
  },
  new Date(baseline.now),
);
ok(periodic.kind === "model");
if (periodic.kind === "model") {
  equal(
    periodic.input.candidates.map((c) => recipientKey(c.recipient)),
    [recipientKey(taskFacts.chat.owner)],
  );
  equal(periodic.input.tasks.length, 2);
  equal(periodic.input.tasks[1].lastRecord!.truncated, true);
  equal(
    Array.from(periodic.input.tasks[1].title + periodic.input.tasks[1].lastRecord!.body).length,
    1000,
  );
}
const pressure = prepareWakeEvaluation(
  {
    ...longFacts,
    recentMessages: messages,
    members: Array.from({ length: 30 }, (_, index) => ({
      ...longFacts.members[0],
      candidate: {
        ...longFacts.members[0].candidate,
        recipient: { kind: "agent", id: `pressure_${index}` },
        personaSummary: "中".repeat(600),
      },
    })),
  },
  new Date(baseline.now),
);
ok(pressure.kind === "model");
if (pressure.kind === "model") {
  equal(pressure.input.candidates.length, 30);
  ok(Array.from(JSON.stringify(pressure.input)).length <= 24000);
  ok(pressure.input.recentMessages.length < 6);
  equal(pressure.input.triggerMessage, longFacts.triggerMessage);
}
equal(effects(), { runs: 0, messages: 0, inputs: 0 });
console.log(`PASS candidate rules and Unicode budgets: ${assertions - beforeRules} assertions`);

for (const provider of ["small_brain", "jev"] as const) {
  const before = assertions;
  const request = forProvider(input, provider);
  const errors =
    provider === "jev"
      ? [
          "credentials",
          "auth",
          "503",
          "timeout",
          "missing",
          "nan",
          "range",
          "model",
          "low",
          "mixed",
        ]
      : ["unavailable", "timeout", "invalid", "missing", "duplicate", "low", "mixed"];
  for (const error of errors) {
    const caseStart = assertions;
    const judge =
      provider === "jev"
        ? createJevJudge({
            apiKey: error === "credentials" ? undefined : "fixture-secret",
            threshold,
            clock,
            fetch: async () => {
              if (error === "timeout") throw new DOMException("timeout", "TimeoutError");
              if (error === "auth" || error === "503")
                return new Response(null, { status: error === "auth" ? 401 : 503 });
              return Response.json({
                model: error === "model" ? "jev-0.9.9" : JEV_MODEL,
                answers: Object.fromEntries(
                  request.candidates.slice(error === "missing" ? 1 : 0).map((_, index) => [
                    `candidate_${index}`,
                    {
                      type: "noul",
                      noul:
                        error === "nan"
                          ? "NaN"
                          : error === "range"
                            ? 2
                            : error === "low" || (error === "mixed" && index > 0)
                              ? 0.5
                              : 0.95,
                    },
                  ]),
                ),
                usage: { input_tokens: 123, output_tokens: 12 },
              });
            },
          })
        : createSmallBrainJudge({
            agentDir: "/unused",
            clock,
            complete: async () => {
              if (error === "unavailable") throw new Error("offline");
              if (error === "timeout") throw new DOMException("timeout", "TimeoutError");
              const decisions = request.candidates.map((c, index) => ({
                recipient: c.recipient,
                decision: "yes",
                certainty: error === "low" || (error === "mixed" && index > 0) ? "low" : "high",
                reason: "中文预设判断",
              }));
              return {
                text:
                  error === "invalid"
                    ? "not JSON"
                    : JSON.stringify({
                        decisions:
                          error === "missing"
                            ? decisions.slice(1)
                            : error === "duplicate"
                              ? [decisions[0], decisions[0]]
                              : decisions,
                      }),
                inputTokens: 123,
                outputTokens: 12,
              };
            },
          });
    let fallbacks = 0;
    const receipt = await evaluateWake(request, {
      small_brain:
        provider === "small_brain"
          ? judge
          : async () => {
              fallbacks++;
              return unused(request);
            },
      jev:
        provider === "jev"
          ? judge
          : async () => {
              fallbacks++;
              return unused(request);
            },
    });
    equal(fallbacks, 0);
    equal(receipt.result.selectedRecipients.length, error === "mixed" ? 1 : 0);
    equal(receipt.result.decision, error === "mixed" ? "continue" : "indeterminate");
    const expectedCode = ["low", "mixed"].includes(error)
      ? "provider_low_certainty"
      : error === "timeout"
        ? "provider_timeout"
        : error === "auth"
          ? "provider_auth_failed"
          : ["credentials", "503", "unavailable"].includes(error)
            ? "provider_unavailable"
            : "provider_invalid_response";
    equal(receipt.result.errorCode, expectedCode);
    if (["low", "mixed"].includes(error)) equal(receipt.result.errorCode, "provider_low_certainty");
    if (error === "credentials") {
      equal(receipt.result.reasonCode, "wake_provider_unavailable");
      ok(receipt.result.reason.includes("JEV_API_KEY"));
    }
    equal(effects(), { runs: 0, messages: 0, inputs: 0 });
    console.log(
      `PASS ${provider}/${error}: ${assertions - caseStart} assertions (fixture failure boundary)`,
    );
  }
  console.log(`PASS ${provider} failures: ${assertions - before} assertions`);
}
// The dependency boundary must not acquire Chat, Task, run, Machine, or database capabilities.
for (const path of [
  "src/domain/wake-evaluation.ts",
  "src/domain/wake-providers/small-brain.ts",
  "src/domain/wake-providers/jev.ts",
  "src/domain/wake-providers/shared.ts",
  "scripts/pi-wake-runner.mjs",
]) {
  ok(
    !/Date\.now\(|from ["'].*(?:db|agent-run|machine|project-context)["']|sendMessage\(|createAgentSession\(/.test(
      readFileSync(path, "utf8"),
    ),
  );
}
console.log(`PASS p6a-routing: ${assertions} assertions; fixture only; zero runs/messages/inputs`);
sqlite.close();
