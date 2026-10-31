import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import type { WakeEvaluationInput } from "../../src/contracts/wake-evaluation";
import type { Evaluation, Schedule } from "../../src/domain/chat-schedule";
import type { DeliveryRow } from "../../src/domain/continuation-delivery";
import type { AutomationScheduler } from "../../src/server/automation-scheduler";

const root = resolve(process.env.P6A_EVIDENCE_DIR ?? ".verify/p6a-lifecycle");
const mode = process.argv[2] ?? "main";
const runId = process.env.P6A_LIFECYCLE_RUN ?? `${Date.now()}-${randomUUID()}`;
const directory = join(root, "run", runId);
mkdirSync(directory, { recursive: true });
const logFile = join(root, "run", `${runId}-${mode}.jsonl`);
const startedAt = performance.now();
process.env.DATABASE_URL = join(directory, mode === "main" ? "lifecycle.sqlite" : "restart.sqlite");
process.env.SPROUT_PI_ENABLED = "false";
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
process.env.SPROUT_REPO_DIR = join(directory, "repos");
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.PI_CODING_AGENT_DIR = join(directory, "host-defaults");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(
  join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
  JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "host-default-model",
  }),
);
delete process.env.JEV_API_KEY;
let assertions = 0;
function log(event: string, data: unknown) {
  appendFileSync(logFile, JSON.stringify({ event, mode, data }) + "\n");
}
function equal(actual: unknown, expected: unknown, label: string) {
  try {
    assert.deepEqual(actual, expected, label);
    assertions++;
    log("assertion", { label, actual, expected, passed: true });
  } catch (error) {
    log("assertion", { label, actual, expected, passed: false });
    throw error;
  }
}
function ok(value: unknown, label: string) {
  equal(Boolean(value), true, label);
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
const requests: WakeEvaluationInput[] = [];
let held: ReturnType<typeof barrier> | undefined;
let gateway: ((request: Request) => Promise<Response>) | undefined;
const http = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = new Request(process.env.APP_ORIGIN + req.url!, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: Buffer.concat(chunks),
    });
    (await import("../../src/server/request-context")).initializeRequestContext(request);
    const response = await gateway!(request);
    log("authorized-http", {
      call: JSON.parse(Buffer.concat(chunks).toString()).call,
      status: response.status,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
const address = http.address();
assert(address && typeof address !== "string");
process.env.APP_ORIGIN = `http://127.0.0.1:${address.port}`;
const runtime = await import("../../src/server/runtime");
const { migrateDatabase } = await import("../../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../../src/db");
const schedule = await import("../../src/domain/chat-schedule");
const automation = await import("../../src/domain/chat-automation");
const task = await import("../../src/domain/task");
const runs = await import("../../src/domain/agent-run");
const { newId, ID_PREFIXES } = await import("../../src/contracts/ids");
const { createProject } = await import("../../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../../src/domain/agent");
const { createGroupChat } = await import("../../src/domain/chat");
const { createAutomationScheduler } = await import("../../src/server/automation-scheduler");
const ctx = { userId: "usr_p6a_lifecycle", requestId: newId(ID_PREFIXES.request) };
const count = (table: string, chatId?: string) =>
  schedule.one<{ n: number }>(
    `SELECT count(*) AS n FROM ${table}${chatId ? " WHERE chat_id=?" : ""}`,
    ...(chatId ? [chatId] : []),
  )!.n;
const row = (chatId: string) =>
  schedule.one<Schedule>("SELECT * FROM chat_schedule WHERE chat_id=?", chatId);
const latest = (chatId: string) =>
  schedule.one<Evaluation>(
    "SELECT * FROM wake_evaluation WHERE chat_id=? ORDER BY round DESC LIMIT 1",
    chatId,
  )!;
const deliveries = (chatId: string) =>
  schedule.all<DeliveryRow>(
    "SELECT * FROM continuation_delivery WHERE chat_id=? ORDER BY rowid",
    chatId,
  );
const control = (projectId: string, chatId: string, action: "pause" | "resume" | "stop") =>
  automation.applyChatAutomationCommand(
    {
      projectId,
      chatId,
      action,
      ...(action === "stop" ? { scope: "chat" as const } : {}),
      expectedRevision: schedule.controlFor(chatId).revision,
      requestId: newId(ID_PREFIXES.request),
    },
    ctx,
    new Date(),
  );
function seed(name: string) {
  const project = createProject({ name }, ctx);
  const profile = createAgentProfile(
    { name: `${name} owner`, persona: `${name} 的专属成员`, harness: "pi" },
    ctx,
  );
  addProjectMember(project.id, profile.id, ctx);
  return { project, profile };
}
function group(owner: ReturnType<typeof seed>, title: string) {
  return createGroupChat(
    owner.project.id,
    {
      projectId: owner.project.id,
      title,
      wakePolicy: "owner_led",
      members: [
        { kind: "human", id: ctx.userId },
        { kind: "agent", id: owner.profile.id },
      ],
      initialOwner: { kind: "agent", id: owner.profile.id },
    },
    { kind: "human", userId: ctx.userId, ctx },
  );
}
function assigned(projectId: string, chatId: string, title = "推进真实生命周期") {
  const created = task.createTask({ projectId, title }, ctx).detail;
  return task.assignTask(
    { taskId: created.task.id, expectedRevision: created.task.revision, targetChatId: chatId },
    ctx,
  ).detail;
}
let scheduler: AutomationScheduler;
let competitor: AutomationScheduler | undefined;
const makeDue = (chatId: string) => {
  ok(row(chatId), "assigned Task has a durable schedule");
  schedule.write("UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?", Date.now() - 1, chatId);
};
async function due(chatId: string) {
  makeDue(chatId);
  await scheduler.advance();
  await scheduler.settled();
  return latest(chatId);
}
// Only model completion is substituted. Runtime, SQLite, scheduler, PiSessionProcess,
// executeRun, remote grants and HTTP Task commands are the production implementations.
const runner = join(directory, "owner-runner.mjs");
writeFileSync(
  runner,
  `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
let opened;
const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
async function call(type,input){
  const response=await fetch(opened.remote.endpoint,{method:'POST',headers:{authorization:'Bearer '+opened.remote.secret,'content-type':'application/json','x-request-id':'req_'+randomUUID()},body:JSON.stringify({version:2,call:{type,input:{projectId:opened.remote.projectId,...input}}})});
  const body=await response.json(); if(!body.ok) throw new Error(JSON.stringify(body)); return body.data;
}
for await(const line of createInterface({input:process.stdin})){
  const command=JSON.parse(line);
  try{
    if(command.type==='open'){
      opened=command;emit({type:'ready',id:command.id,snapshot:{model:'fixture',provider:'fixture',thinking:'off',tools:['sprout_task_get','sprout_task_record_append','sprout_task_complete'],extensions:[],sessionId:command.sessionId,sessionFile:command.sessionDirectory+'/fixture.jsonl',cwd:command.cwd,sdkVersion:'fixture',profile:command.profile}});
    }else if(command.type==='prompt'||command.type==='steer'){
      const envelope=JSON.parse(command.text);
      if(envelope.kind!=='continuation'||envelope.deliveryId!==command.messageId||envelope.taskIds.length!==1)throw new Error('Invalid continuation envelope');
      appendFileSync(${JSON.stringify(join(directory, "host-inputs.jsonl"))},JSON.stringify({deliveryId:envelope.deliveryId,runId:opened.sessionId})+'\\n');
      emit({type:'input_delivered',id:command.id,messageId:command.messageId});
      let detail=await call('task_get',{taskId:envelope.taskIds[0]});
      const second=detail.lastRecord?.body==='第一轮：已推进，等待第二次周期检查。';
      detail=(await call('task_mutate',{action:'record_append',taskId:detail.task.id,expectedRevision:detail.task.revision,body:second?'第二轮：已完成。':'第一轮：已推进，等待第二次周期检查。'})).detail;
      if(second)await call('task_mutate',{action:'complete',taskId:detail.task.id,expectedRevision:detail.task.revision});
      emit({type:'settled',id:command.id,text:second?'Task 已完成。':'负责人已推进，下一轮继续。',stopReason:'stop'});
    }else if(command.type==='close')process.exit(0);
    else if(command.type==='abort')emit({type:'failure',id:command.id,code:'aborted',message:'Fixture aborted'});
  }catch(error){emit({type:'failure',id:command.id,code:'fixture_failure',message:String(error)});}
}
`,
);
async function execute(chatId: string) {
  const pending = runs.queuedRunWork().find((work) => work.run.chatId === chatId);
  ok(pending, "scheduler binds continuation to queued owner run input");
  const { PiSessionProcess } = await import("../../src/server/pi-host/process");
  const { executeRun } = await import("../../src/server/pi-host/run");
  const { Effect } = await import("effect");
  const processHandle = new PiSessionProcess(pending!.run.id, runner);
  await Effect.runPromise(
    executeRun(pending!, processHandle, { isStopping: () => false }, Date.now),
  );
  equal(
    schedule.one<{ status: string }>("SELECT status FROM agent_run WHERE id=?", pending!.run.id)!
      .status,
    "completed",
    "real owner run settles successfully",
  );
}
function hostInputs() {
  try {
    return readFileSync(join(directory, "host-inputs.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { deliveryId: string });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
const crashState = join(directory, "crash-state.json");
if (mode === "crash") {
  schedule.onScheduleChange(() => {
    const pending = schedule.one<DeliveryRow>(
      "SELECT * FROM continuation_delivery WHERE state='pending'",
    );
    if (!pending) return;
    const evaluation = latest(pending.chat_id);
    if (evaluation.state !== "decided") return;
    const saved = {
      chatId: pending.chat_id,
      deliveryId: pending.id,
      due: row(pending.chat_id)!.next_due_at,
      evaluationId: evaluation.id,
    };
    writeFileSync(crashState, JSON.stringify(saved));
    log("committed-before-kill", saved);
    writeSync(1, "COMMITTED_BEFORE_SIGKILL\n");
    process.kill(process.pid, "SIGKILL");
  });
}
try {
  if (mode === "recover" || mode === "recover-again") {
    const saved = JSON.parse(readFileSync(crashState, "utf8")) as {
      chatId: string;
      deliveryId: string;
      due: number;
      evaluationId: string;
    };
    equal(latest(saved.chatId).id, saved.evaluationId, "receipt survives actual SIGKILL");
    equal(
      deliveries(saved.chatId)[0].state,
      mode === "recover" ? "pending" : "delivered",
      "persisted pre-restart delivery state",
    );
    equal(row(saved.chatId)!.next_due_at, saved.due, "persisted due time survives process death");
  }
  await runtime.startRuntime({
    complete: async (request) => {
      equal(
        request.model,
        "fixture/host-default-model",
        "unconfigured project uses host default model",
      );
      const input = JSON.parse(request.prompt) as WakeEvaluationInput;
      requests.push(input);
      log("completion", input);
      if (held) await held.promise;
      return {
        text: JSON.stringify({
          decisions: input.candidates.map((candidate) => ({
            recipient: candidate.recipient,
            decision: "yes",
            certainty: "high",
            reason: "负责人继续推进。",
          })),
        }),
        inputTokens: 10,
        outputTokens: 5,
      };
    },
    fetch: async () => {
      throw new Error("No JEV call is permitted for default small_brain");
    },
  });
  scheduler = (
    globalThis as typeof globalThis & { sproutRuntime: { automation: AutomationScheduler } }
  ).sproutRuntime.automation;
  gateway = (await import("../../src/server/remote-agent-gateway")).remoteAgentResponse;
  equal(scheduler.snapshot().started, true, "real runtime starts its production scheduler");
  if (mode === "recover" || mode === "recover-again") {
    const saved = JSON.parse(readFileSync(crashState, "utf8")) as {
      chatId: string;
      deliveryId: string;
      due: number;
    };
    await scheduler.advance();
    await scheduler.settled();
    equal(row(saved.chatId)!.next_due_at, saved.due, "startup scan preserves next scheduled check");
    equal(requests.length, 0, "recovery does not re-evaluate a committed receipt");
    equal(deliveries(saved.chatId).length, 1, "recovery retains original delivery identity");
    if (mode === "recover") {
      equal(
        deliveries(saved.chatId)[0].state,
        "bound",
        "startup scanner binds durable pending delivery",
      );
      await execute(saved.chatId);
    }
    equal(
      deliveries(saved.chatId)[0].state,
      "delivered",
      "recovered delivery has production host ACK",
    );
    equal(
      hostInputs().filter((entry) => entry.deliveryId === saved.deliveryId).length,
      1,
      "same delivery crosses host boundary exactly once across restarts",
    );
    equal(
      runs.queuedRunWork().filter((work) => work.run.chatId === saved.chatId).length,
      0,
      "repeated startup cannot requeue delivered input",
    );
  } else {
    sqlite
      .prepare(
        "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,0,1,1)",
      )
      .run(ctx.userId, "Lifecycle Human", "lifecycle@sprout.test");
    if (mode === "crash") {
      const owner = seed("crash-only");
      const chat = group(owner, "崩溃恢复");
      assigned(owner.project.id, chat.id);
      await due(chat.id);
      assert.fail("crash hook did not observe committed pending delivery");
    }
    const scenario = process.env.P6A_SCENARIO;
    if (!scenario || scenario === "lifecycle") {
      const owner = seed("default-lifecycle");
      equal(owner.project.wakePolicy, undefined, "new Project has no configured evaluator");
      equal(
        schedule.one<{ wake_policy: string | null }>(
          "SELECT wake_policy FROM project WHERE id=?",
          owner.project.id,
        )!.wake_policy,
        null,
        "default Project has no stored policy override",
      );
      const chat = group(owner, "连续生命周期");
      const work = assigned(owner.project.id, chat.id);
      equal(
        count("agent_run", chat.id),
        0,
        "assignment without immediate start does not create run",
      );
      const first = await due(chat.id);
      equal(first.state, "decided", "first due check persists validated receipt");
      equal(JSON.parse(first.result!).provider, "small_brain", "default evaluator is small_brain");
      equal(deliveries(chat.id).length, 1, "first check creates one delivery");
      equal(
        deliveries(chat.id)[0].recipient_id,
        owner.profile.id,
        "continuation addresses the responsible owner",
      );
      const envelope = JSON.parse(deliveries(chat.id)[0].envelope!);
      equal(envelope.taskIds, [work.task.id], "owner run input carries assigned Task");
      await execute(chat.id);
      equal(
        task.getTaskDetail(work.task.id, ctx).task.status,
        "assigned",
        "first owner round advances without finishing Task",
      );
      equal(count("message", chat.id), 2, "first owner round writes record and chat speech");
      equal(deliveries(chat.id)[0].state, "delivered", "first delivery has host ACK");
      await due(chat.id);
      equal(deliveries(chat.id).length, 2, "second check follows changed work facts");
      await execute(chat.id);
      equal(
        task.getTaskDetail(work.task.id, ctx).task.status,
        "finished",
        "second owner round finishes through authorized Task command",
      );
      equal(row(chat.id), undefined, "no assigned Task leaves no schedule");
      await scheduler.advance();
      equal(scheduler.snapshot().timerArmed, false, "no assigned Task leaves no scheduler timer");
      control(owner.project.id, chat.id, "pause");
      equal(schedule.controlFor(chat.id).mode, "paused", "Human pause applies immediately");
      control(owner.project.id, chat.id, "resume");
      equal(schedule.controlFor(chat.id).mode, "enabled", "Human resume applies immediately");
      control(owner.project.id, chat.id, "stop");
      assigned(owner.project.id, chat.id, "停止后显式接续");
      await scheduler.advance();
      equal(row(chat.id), undefined, "new assigned work cannot revive stopped automation");
      const before = requests.length;
      control(owner.project.id, chat.id, "resume");
      await due(chat.id);
      equal(requests.length, before + 1, "explicit Human resumption permits the next check");
      control(owner.project.id, chat.id, "pause");
    }
    if (!scenario || scenario === "claim") {
      const owner = seed("concurrent-claim");
      const chat = group(owner, "同一 due 竞争");
      assigned(owner.project.id, chat.id);
      const before = requests.length;
      held = barrier();
      competitor = createAutomationScheduler({ workerId: "competing-real-scheduler" });
      competitor.start();
      makeDue(chat.id);
      await Promise.all([scheduler.advance(), competitor.advance()]);
      const claimed = latest(chat.id);
      equal(claimed.state, "claimed", "first concurrent advance holds a durable claim");
      equal(count("wake_evaluation", chat.id), 1, "two scheduler advances create one evaluation");
      equal(requests.length - before, 1, "same due moment makes exactly one provider request");
      equal(claimed.attempt, 1, "second scheduler cannot increment leased attempt");
      equal(
        schedule.claimDueEvaluation({
          now: new Date(),
          requestId: newId(ID_PREFIXES.request),
          workerId: "loser",
        }),
        undefined,
        "second writer cannot claim the leased epoch",
      );
      held.release();
      held = undefined;
      await Promise.all([scheduler.settled(), competitor.settled()]);
      competitor.stop();
      equal(
        count("continuation_delivery", chat.id),
        1,
        "concurrent due check creates at most one delivery",
      );
      equal(latest(chat.id).attempt, 1, "winning claim is never overwritten");
      control(owner.project.id, chat.id, "pause");
    }
    if (!scenario || scenario === "isolation") {
      const owners = [seed("PROJECT_A_PRIVATE_CANARY"), seed("PROJECT_B_PRIVATE_CANARY")];
      const chats = owners.flatMap((owner) =>
        [0, 1].map((index) => {
          const chat = group(owner, `${owner.project.name}-${index}`);
          assigned(owner.project.id, chat.id, `${owner.project.name} 机密任务 ${index}`);
          return { owner, chat };
        }),
      );
      held = barrier();
      const before = requests.length;
      for (const { chat } of chats) makeDue(chat.id);
      await scheduler.advance();
      equal(requests.length - before, 4, "two Projects and four Chats evaluate concurrently");
      for (const { owner, chat } of chats) {
        const input = requests.slice(before).find((item) => item.chatId === chat.id)!;
        ok(input, "each Chat receives its own snapshot");
        const foreign = owners.find((candidate) => candidate.project.id !== owner.project.id)!;
        equal(
          JSON.stringify(input).includes(foreign.project.name),
          false,
          "other Project name, persona and Task text never enter snapshot",
        );
        equal(
          input.candidates.map((candidate) => candidate.recipient.id),
          [owner.profile.id],
          "candidate set contains only this Chat owner",
        );
        equal(
          input.tasks.every((item) => item.chatId === chat.id),
          true,
          "snapshot Tasks belong to this Chat",
        );
      }
      held.release();
      held = undefined;
      await scheduler.settled();
      for (const { owner, chat } of chats) {
        equal(
          deliveries(chat.id).map((item) => [item.chat_id, item.project_id, item.recipient_id]),
          [[chat.id, owner.project.id, owner.profile.id]],
          "delivery stays in its Chat and candidate set",
        );
        control(owner.project.id, chat.id, "pause");
      }
    }
    if (!scenario || scenario === "stale") {
      for (const change of ["pause", "stop", "reassign"] as const) {
        const owner = seed(`stale-${change}`);
        const chat = group(owner, `在途 ${change}`);
        const target = group(owner, "改派目标");
        const work = assigned(owner.project.id, chat.id);
        held = barrier();
        makeDue(chat.id);
        await scheduler.advance();
        const evaluation = latest(chat.id);
        equal(evaluation.state, "claimed", "Human race starts with an in-flight evaluation");
        const messages = count("message", chat.id);
        if (change === "reassign")
          task.reassignTask(
            { taskId: work.task.id, expectedRevision: work.task.revision, targetChatId: target.id },
            ctx,
          );
        else control(owner.project.id, chat.id, change);
        held.release();
        held = undefined;
        await scheduler.settled();
        log("human-race-outcome", {
          change,
          evaluationBefore: evaluation,
          evaluationAfter: latest(chat.id),
          control: schedule.controlFor(chat.id),
          deliveries: deliveries(chat.id),
          runs: count("agent_run", chat.id),
          messages: count("message", chat.id),
          schedule: row(chat.id) ?? null,
          task: task.getTaskDetail(work.task.id, ctx).task,
        });
        equal(count("continuation_delivery", chat.id), 0, `${change} admits zero stale deliveries`);
        equal(count("agent_run", chat.id), 0, `${change} creates zero run inputs`);
        equal(count("message", chat.id), messages, `${change} creates zero stale messages`);
        equal(row(chat.id), undefined, `${change} immediately removes automatic schedule`);
        await scheduler.advance();
        equal(count("wake_evaluation", chat.id), 1, `${change} cannot revive the old evaluation`);
        equal(latest(chat.id).state, "stale", `${change} leaves a visible stale result`);
        if (change === "reassign") control(owner.project.id, target.id, "pause");
      }
    }
    if (!scenario || scenario === "budget") {
      const owner = seed("budget-boundary");
      const chat = group(owner, "完整快照预算");
      const tasks = Array.from({ length: 65 }, (_, index) =>
        assigned(owner.project.id, chat.id, `${index} ${"完整任务不可截断".repeat(12)}`),
      );
      const before = requests.length;
      const failed = await due(chat.id);
      equal(
        failed.error_code,
        "context_budget_exceeded",
        "oversized complete snapshot fails deterministically",
      );
      equal(failed.state, "attention", "over-budget receipt remains visible for Human");
      equal(failed.input, null, "oversized snapshot is rejected rather than silently truncated");
      equal(requests.length, before, "over-budget input never reaches model");
      equal(
        count("continuation_delivery", chat.id),
        0,
        "over-budget input never creates a delivery",
      );
      equal(count("agent_run", chat.id), 0, "over-budget input never creates run input");
      equal(
        task.getTasksForChat(chat.id, ctx).length,
        tasks.length,
        "all assigned Tasks survive budget rejection",
      );
      for (const detail of tasks.slice(1))
        task.unassignTask({ taskId: detail.task.id, expectedRevision: detail.task.revision }, ctx);
      const retried = await due(chat.id);
      equal(
        retried.state,
        "decided",
        "new complete snapshot retries successfully after budget reduction",
      );
      equal(
        count("continuation_delivery", chat.id),
        1,
        "budget failure does not poison later scheduling",
      );
      equal(
        latest(chat.id).round,
        failed.round + 1,
        "recovery creates the next check with independent receipt",
      );
      control(owner.project.id, chat.id, "pause");
    }
    if (!scenario || scenario === "authority") {
      const owner = seed("authority");
      const chat = group(owner, "判定和调度写边界");
      const work = assigned(owner.project.id, chat.id);
      // Provision the identity before the observed automation window; identity setup is not a model decision.
      schedule.ensureResponsibleInstance(chat.id, new Date());
      const tables = schedule
        .all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .map((item) => item.name);
      sqlite.exec("CREATE TEMP TABLE lifecycle_mutations(table_name TEXT, operation TEXT)");
      for (const [index, table] of tables.entries())
        for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
          sqlite.exec(
            `CREATE TEMP TRIGGER lifecycle_${index}_${operation} AFTER ${operation} ON main."${table}" BEGIN INSERT INTO lifecycle_mutations VALUES('${table}','${operation}'); END`,
          );
        }
      const allowed = new Set([
        "chat",
        "message",
        "task",
        "task_event",
        "machine_lease",
        "lease_authorization",
        "lease_mutation",
        "agent_run",
        "agent_run_input",
        "agent_run_task",
        "chat_schedule",
        "chat_automation_control",
        "wake_evaluation",
        "wake_evaluation_task",
        "continuation_delivery",
        "continuation_delivery_task",
      ]);
      await due(chat.id);
      const writes = schedule.all<{ table_name: string; operation: string; n: number }>(
        "SELECT table_name,operation,count(*) AS n FROM lifecycle_mutations GROUP BY table_name,operation",
      );
      log("automation-table-writes", writes);
      equal(
        writes.filter((item) => !allowed.has(item.table_name)),
        [],
        "TEMP triggers detect no automation writes outside authorized business and scheduling tables",
      );
      equal(
        task.getTaskDetail(work.task.id, ctx).task.status,
        "assigned",
        "scheduler and evaluator cannot change Task status",
      );
      equal(
        count("message", chat.id),
        0,
        "scheduler and evaluator cannot manufacture owner speech",
      );
      for (const [index] of tables.entries())
        for (const operation of ["INSERT", "UPDATE", "DELETE"])
          sqlite.exec(`DROP TRIGGER lifecycle_${index}_${operation}`);
      control(owner.project.id, chat.id, "pause");
    }
    if (!scenario || scenario === "recovery") {
      async function child(childMode: string) {
        return await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
          stdout: string;
        }>((done, reject) => {
          const processHandle = spawn(
            process.execPath,
            ["--import", "tsx", resolve("tests/fixtures/p6a-lifecycle.ts"), childMode],
            {
              env: { ...process.env, P6A_LIFECYCLE_RUN: runId },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "",
            stderr = "";
          processHandle.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          processHandle.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          const deadline = setTimeout(() => {
            processHandle.kill("SIGKILL");
            reject(new Error(`child ${childMode} exceeded 60 seconds`));
          }, 60_000);
          processHandle.once("error", reject);
          processHandle.once("close", (code, signal) => {
            clearTimeout(deadline);
            log("child-exit", { childMode, code, signal, stdout, stderr });
            done({ code, signal, stdout });
          });
        });
      }
      const killed = await child("crash");
      equal(
        killed.signal,
        "SIGKILL",
        "process dies via real SIGKILL at committed pending boundary",
      );
      ok(
        killed.stdout.includes("COMMITTED_BEFORE_SIGKILL"),
        "crash occurs after receipt and pending delivery commit",
      );
      equal(
        (await child("recover")).code,
        0,
        "fresh runtime scans and delivers persisted pending work",
      );
      equal(
        (await child("recover-again")).code,
        0,
        "second fresh runtime proves no duplicate admission",
      );
    }
  }
  log("result", {
    status: "passed",
    assertions,
    durationMs: performance.now() - startedAt,
    database: process.env.DATABASE_URL,
  });
  console.log(
    `PASS p6a-lifecycle: ${assertions} assertions; real SQLite ${process.env.DATABASE_URL}`,
  );
} catch (error) {
  log("result", {
    status: "failed",
    assertions,
    durationMs: performance.now() - startedAt,
    error: String(error),
    stack: error instanceof Error ? error.stack : null,
    database: process.env.DATABASE_URL,
  });
  throw error;
} finally {
  held?.release();
  competitor?.stop();
  await runtime.shutdownRuntime("p6a-lifecycle-concluded");
  await new Promise<void>((done, reject) =>
    http.close((error) => (error ? reject(error) : done())),
  );
}
