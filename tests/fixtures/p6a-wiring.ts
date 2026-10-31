import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  WakeEvaluationInput,
  WakeEvaluationResult,
} from "../../src/contracts/wake-evaluation";
import type { Evaluation } from "../../src/domain/chat-schedule";
import type { AutomationScheduler } from "../../src/server/automation-scheduler";
import type { EvaluateWake } from "../../src/domain/continuation-delivery";
import type { SmallBrainRequest } from "../../src/domain/wake-providers/small-brain";

const directory = resolve(process.env.P6A_EVIDENCE_DIR ?? ".verify/p6a-wiring");
mkdirSync(directory, { recursive: true });
process.env.DATABASE_URL ??= join(directory, "verification.sqlite");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET ??= randomBytes(32).toString("hex");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
process.env.SPROUT_REPO_DIR = join(directory, "repos");
const originalKey = process.env.JEV_API_KEY;
delete process.env.JEV_API_KEY;

let assertions = 0;
function equal(actual: unknown, expected: unknown, label: string) {
  assertions++;
  assert.deepEqual(actual, expected, label);
}
function ok(value: unknown, label: string) {
  assertions++;
  assert.ok(value, label);
}
const calls = { small_brain: 0, jev: 0 };
let failure: "none" | "throw" | "invalid" = "none";
let observedRequest: SmallBrainRequest | undefined;
const runtime = await import("../../src/server/runtime");
try {
  await runtime.startRuntime({
    complete: async (request) => {
      calls.small_brain++;
      observedRequest = request;
      await new Promise<void>((done) => setImmediate(done));
      if (failure === "throw") throw new Error("fixture transport failure");
      if (failure === "invalid") return { text: "{}", inputTokens: 1, outputTokens: 1 };
      const input = JSON.parse(request.prompt) as WakeEvaluationInput;
      return {
        text: JSON.stringify({
          decisions: input.candidates.map((candidate) => ({
            recipient: candidate.recipient,
            decision: "yes",
            certainty: "high",
            reason: "继续完成已分配的工作。",
          })),
        }),
        inputTokens: 10,
        outputTokens: 5,
      };
    },
    fetch: async (_url, init) => {
      calls.jev++;
      await new Promise<void>((done) => setImmediate(done));
      if (failure === "throw") throw new Error("fixture transport failure");
      const body = JSON.parse(init!.body as string) as { questions: Record<string, unknown> };
      return Response.json(
        failure === "invalid"
          ? {}
          : {
              model: "jev-1.0.0",
              answers: Object.fromEntries(
                Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 0.1 }]),
              ),
              usage: { input_tokens: 10, output_tokens: 5 },
            },
      );
    },
  });
  const globals = globalThis as typeof globalThis & {
    sproutWakeEvaluator?: EvaluateWake;
    sproutRuntime?: { automation: AutomationScheduler };
  };
  ok(globals.sproutWakeEvaluator, "runtime installs its evaluator");
  const scheduler = globals.sproutRuntime!.automation;
  equal(scheduler.snapshot().started, true, "runtime starts the production scheduler");
  const { sqlite } = await import("../../src/db");
  const schedule = await import("../../src/domain/chat-schedule");
  const { newId, ID_PREFIXES } = await import("../../src/contracts/ids");
  const { createProject, updateProjectWakePolicy, getProject } =
    await import("../../src/domain/project");
  const { createAgentProfile, addProjectMember } = await import("../../src/domain/agent");
  const { createGroupChat } = await import("../../src/domain/chat");
  const { createTask, assignTask } = await import("../../src/domain/task");
  const automation = await import("../../src/domain/chat-automation");
  const ctx = { userId: "usr_p6a_wiring", requestId: newId(ID_PREFIXES.request) };
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,0,1,1)",
    )
    .run(ctx.userId, "Wiring", "wiring@sprout.test");
  const project = createProject({ name: "Production wake wiring" }, ctx);
  const profile = createAgentProfile(
    { name: "Worker", persona: "负责推进中文任务", harness: "pi" },
    ctx,
  );
  addProjectMember(project.id, profile.id, ctx);
  function policy(provider: "small_brain" | "jev") {
    return updateProjectWakePolicy(
      {
        projectId: project.id,
        provider,
        expectedConfigRevision: getProject(project.id, ctx).wakePolicy?.configRevision ?? 1,
        requestId: newId(ID_PREFIXES.request),
      },
      ctx,
      {
        model: provider === "jev" ? "jev-latest" : "fixture/host-model",
        thresholdVersion: "p6a-design-default-v1",
      },
      new Date(),
    );
  }
  function group() {
    const chat = createGroupChat(
      project.id,
      {
        projectId: project.id,
        title: "接线验证",
        wakePolicy: "owner_led",
        members: [
          { kind: "human", id: ctx.userId },
          { kind: "agent", id: profile.id },
        ],
        initialOwner: { kind: "agent", id: profile.id },
      },
      { kind: "human", userId: ctx.userId, ctx },
    );
    const task = createTask({ projectId: project.id, title: "推进实现" }, ctx).detail;
    assignTask(
      { taskId: task.task.id, expectedRevision: task.task.revision, targetChatId: chat.id },
      ctx,
    );
    return chat;
  }
  function latest(chatId: string) {
    return schedule.one<Evaluation>(
      "SELECT * FROM wake_evaluation WHERE chat_id=? ORDER BY round DESC LIMIT 1",
      chatId,
    )!;
  }
  function result(evaluation: Evaluation): WakeEvaluationResult {
    return JSON.parse(evaluation.result!);
  }
  const count = (table: string) =>
    schedule.one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;
  async function due(chatId: string) {
    schedule.write(
      "UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?",
      Date.now() - 1,
      chatId,
    );
    await scheduler.advance();
    await scheduler.settled();
    return latest(chatId);
  }
  function pause(chatId: string) {
    automation.applyChatAutomationCommand(
      {
        projectId: project.id,
        chatId,
        action: "pause",
        expectedRevision: schedule.controlFor(chatId).revision,
        requestId: newId(ID_PREFIXES.request),
      },
      ctx,
      new Date(),
    );
  }
  const sideEffectTables = [
    "chat",
    "chat_member",
    "message",
    "task",
    "task_event",
    "task_checklist_item",
    "machine_lease",
    "lease_authorization",
    "lease_mutation",
    "agent_run",
    "continuation_delivery",
  ];
  const sideEffects: Record<string, number> = Object.fromEntries(
    sideEffectTables.map((table) => [table, 0]),
  );
  sqlite.exec("CREATE TEMP TABLE judge_side_effect(table_name TEXT NOT NULL)");
  for (const table of sideEffectTables) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      sqlite.exec(`CREATE TEMP TRIGGER judge_${table}_${operation} AFTER ${operation} ON main.${table}
        BEGIN INSERT INTO judge_side_effect(table_name) VALUES('${table}'); END`);
    }
  }
  async function assertPure(input: WakeEvaluationInput) {
    sqlite.exec("DELETE FROM judge_side_effect");
    await globals.sproutWakeEvaluator!(input);
    for (const table of sideEffectTables) {
      const mutations = schedule.one<{ n: number }>(
        "SELECT count(*) AS n FROM judge_side_effect WHERE table_name=?",
        table,
      )!.n;
      sideEffects[table] += mutations;
      equal(mutations, 0, `judge cannot mutate ${table}`);
    }
  }

  policy("small_brain");
  const chat = group();
  const first = await due(chat.id);
  equal(first.state, "decided", "due runtime check commits a validated receipt");
  equal(result(first).decision, "continue", "installed evaluator reaches the real judge adapter");
  equal(result(first).provider, "small_brain", "policy chooses small brain");
  equal(count("continuation_delivery"), 1, "runtime scheduler creates a continuation delivery");
  equal(calls, { small_brain: 1, jev: 0 }, "one selected provider only");
  equal(
    observedRequest!.model,
    "fixture/host-model",
    "policy model reaches the completion boundary",
  );
  const { homedir } = await import("node:os");
  equal(
    observedRequest!.agentDir,
    resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")),
    "judge uses the host agent directory source",
  );
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const fallbackAgentDir = join(directory, "host-defaults");
  mkdirSync(fallbackAgentDir, { recursive: true });
  writeFileSync(
    join(fallbackAgentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "fixture", defaultModel: "default-model" }),
  );
  try {
    process.env.PI_CODING_AGENT_DIR = fallbackAgentDir;
    const { createWakeEvaluator } = await import("../../src/server/wake-runtime");
    let defaultRequest: SmallBrainRequest | undefined;
    const fallbackEvaluator = createWakeEvaluator({
      clock: () => performance.now(),
      complete: async (request) => {
        defaultRequest = request;
        throw new Error("fixture completion unavailable");
      },
    });
    const input = JSON.parse(first.input!) as WakeEvaluationInput;
    const fallbackResult = await fallbackEvaluator({
      ...input,
      policy: { ...input.policy, model: "" },
    });
    equal(
      defaultRequest!.model,
      "fixture/default-model",
      "missing model uses host defaultProvider/defaultModel semantics",
    );
    equal(
      defaultRequest!.agentDir,
      fallbackAgentDir,
      "host agent directory override reaches the isolated judge",
    );
    equal(
      fallbackResult.model,
      "fixture/default-model",
      "defaulted model is preserved in the validated failed receipt",
    );
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  const frozenFirst = schedule.one("SELECT * FROM wake_evaluation WHERE id=?", first.id);

  policy("jev");
  const beforeMissing = {
    messages: count("message"),
    runs: count("agent_run"),
    deliveries: count("continuation_delivery"),
  };
  const missing = await due(chat.id);
  equal(
    result(missing).errorCode,
    "provider_unavailable",
    "missing JEV key is a durable failed receipt",
  );
  equal(missing.error_code, "provider_unavailable", "evaluation retains failure fact");
  equal(
    calls,
    { small_brain: 1, jev: 0 },
    "missing JEV credentials never invoke small brain or transport",
  );
  equal(
    {
      messages: count("message"),
      runs: count("agent_run"),
      deliveries: count("continuation_delivery"),
    },
    beforeMissing,
    "provider failure creates no messages, runs or deliveries",
  );
  equal(
    schedule.one("SELECT * FROM wake_evaluation WHERE id=?", first.id),
    frozenFirst,
    "new policy leaves old revision receipt unchanged",
  );
  const frozenMissing = schedule.one(
    "SELECT input,result,error_code FROM wake_evaluation WHERE id=?",
    missing.id,
  );

  process.env.JEV_API_KEY = randomBytes(32).toString("hex");
  const jevChat = group();
  const jev = await due(jevChat.id);
  equal(result(jev).provider, "jev", "next configured check reaches JEV");
  equal(result(jev).decision, "do_not_continue", "JEV probability uses frozen thresholds");
  equal(calls, { small_brain: 1, jev: 1 }, "JEV check does not invoke small brain");
  policy("small_brain");
  const switched = await due(jevChat.id);
  equal(result(switched).provider, "small_brain", "next round uses changed provider");
  ok(
    JSON.parse(switched.input!).policy.configRevision >
      JSON.parse(jev.input!).policy.configRevision,
    "next round snapshots the new revision",
  );
  equal(
    schedule.one("SELECT input,result,error_code FROM wake_evaluation WHERE id=?", missing.id),
    frozenMissing,
    "old failure receipt and config revision remain immutable",
  );
  equal(
    latest(chat.id).state,
    "stale",
    "policy change invalidates the old retry without replacing its receipt",
  );

  const paused = group();
  const beforePause = { ...calls };
  const evaluationsBeforePause = count("wake_evaluation");
  schedule.write(
    "UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?",
    Date.now() - 1,
    paused.id,
  );
  pause(paused.id);
  await scheduler.advance();
  await scheduler.settled();
  equal(calls, beforePause, "paused due Chat makes no provider requests");
  equal(count("wake_evaluation"), evaluationsBeforePause, "paused due Chat produces no evaluation");

  // Transport failures and malformed completions exercise the same production validation path.
  pause(chat.id);
  pause(jevChat.id);
  await assertPure(JSON.parse(first.input!));
  await assertPure(JSON.parse(jev.input!));
  for (const provider of ["small_brain", "jev"] as const) {
    policy(provider);
    for (const mode of ["throw", "invalid"] as const) {
      failure = mode;
      const failingChat = group();
      const before = { ...calls };
      const failed = await due(failingChat.id);
      equal(
        result(failed).decision,
        "indeterminate",
        `${provider} ${mode} persists a failed result`,
      );
      ok(result(failed).errorCode, `${provider} ${mode} has an error code`);
      const other = provider === "jev" ? "small_brain" : "jev";
      equal(calls[other], before[other], `${provider} ${mode} never falls back`);
      pause(failingChat.id);
    }
  }
  failure = "none";
  for (const table of sideEffectTables)
    equal(sideEffects[table], 0, `${table} side-effect count is zero`);
  writeFileSync(
    join(directory, "wiring-result.json"),
    JSON.stringify(
      { assertions, calls, sideEffects, models: "deterministic complete/fetch substitutes" },
      null,
      2,
    ),
  );
  console.log(`PASS p6a-wiring: ${assertions} assertions`);
} finally {
  if (originalKey === undefined) delete process.env.JEV_API_KEY;
  else process.env.JEV_API_KEY = originalKey;
  await runtime.shutdownRuntime("p6a-wiring-complete");
}
