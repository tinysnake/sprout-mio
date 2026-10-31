import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  WakeEvaluationInput,
  WakeEvaluationResult,
} from "../../src/contracts/wake-evaluation";
import type { Evaluation, SchedulerContext, Schedule } from "../../src/domain/chat-schedule";
import type { DeliveryRow } from "../../src/domain/continuation-delivery";
const suite = process.argv[2] ?? "scheduler";
const directory = process.env.P6A_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), "p6a-schedule-"));
mkdirSync(directory, { recursive: true });
process.env.DATABASE_URL ??= join(directory, "verification.sqlite");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET ??= randomBytes(32).toString("hex");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
process.env.SPROUT_REPO_DIR = join(directory, "repos");
let http: ReturnType<typeof createServer> | undefined;
let observedAutomationRead: (() => void) | undefined;
let gateway: ((request: Request) => Promise<Response>) | undefined;
if (suite === "integration") {
  http = createServer(async (req, res) => {
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
      if (
        JSON.parse(Buffer.concat(chunks).toString()).call.type === "chat_automation_get" &&
        response.ok
      )
        observedAutomationRead?.();
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((done) => http!.listen(0, "127.0.0.1", done));
  const address = http.address();
  assert(address && typeof address !== "string");
  process.env.APP_ORIGIN = `http://127.0.0.1:${address.port}`;
}
const { migrateDatabase } = await import("../../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../../src/db");
const schedule = await import("../../src/domain/chat-schedule");
const delivery = await import("../../src/domain/continuation-delivery");
const automation = await import("../../src/domain/chat-automation");
const { createAutomationScheduler } = await import("../../src/server/automation-scheduler");
const runs = await import("../../src/domain/agent-run");
if (suite === "recover") {
  runs.recoverAgentRuns();
  schedule.recoverSchedules(new Date(process.env.P6A_NOW!));
  const result = {
    controls: schedule.all("SELECT * FROM chat_automation_control"),
    schedules: schedule.all("SELECT * FROM chat_schedule"),
    deliveries: schedule.all("SELECT id,state,run_id,error_code FROM continuation_delivery"),
    claim:
      schedule.claimDueEvaluation({
        now: new Date(process.env.P6A_NOW!),
        requestId: "req_00000000-0000-4000-8000-000000000000",
        workerId: "restarted",
      }) ?? null,
  };
  console.log("RECOVER " + JSON.stringify(result));
  sqlite.close();
  process.exit(0);
}
const { newId, ID_PREFIXES } = await import("../../src/contracts/ids");
const { createProject, updateProjectWakePolicy, getProject } =
  await import("../../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../../src/domain/agent");
const { createGroupChat, sendMessage, setChatOwner } = await import("../../src/domain/chat");
const task = await import("../../src/domain/task");
const ctx = { userId: "usr_p6a_schedule", requestId: newId(ID_PREFIXES.request) };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,0,1,1)",
  )
  .run(ctx.userId, "P6a", "p6a@schedule.test");
const project = createProject({ name: "P6a production domain gate" }, ctx);
const profiles = ["Alpha", "Beta"].map((name) => {
  const p = createAgentProfile({ name, persona: "推进中文协作目标", harness: "pi" }, ctx);
  addProjectMember(project.id, p.id, ctx);
  return p;
});
updateProjectWakePolicy(
  {
    projectId: project.id,
    provider: "small_brain",
    expectedConfigRevision: 1,
    requestId: newId(ID_PREFIXES.request),
  },
  ctx,
  { model: "fixture-small-brain", thresholdVersion: "fixture-v1" },
  new Date(),
);
let assertions = 0;
function equal(actual: unknown, expected: unknown, label: string) {
  assertions++;
  assert.deepEqual(actual, expected, label);
}
function ok(value: unknown, label: string) {
  assertions++;
  assert.ok(value, label);
}
function group(human = false) {
  return createGroupChat(
    project.id,
    {
      projectId: project.id,
      title: "周期推进",
      wakePolicy: "owner_led",
      members: [
        { kind: "human", id: ctx.userId },
        ...profiles.map((p) => ({ kind: "agent" as const, id: p.id })),
      ],
      initialOwner: human
        ? { kind: "human", id: ctx.userId }
        : { kind: "agent", id: profiles[0].id },
    },
    { kind: "human", userId: ctx.userId, ctx },
  );
}
function assigned(chatId: string) {
  const created = task.createTask({ projectId: project.id, title: "实现周期检查" }, ctx).detail;
  return task.assignTask(
    { taskId: created.task.id, expectedRevision: created.task.revision, targetChatId: chatId },
    ctx,
  ).detail;
}
const count = (table: string) =>
  schedule.one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;
const row = (chatId: string) =>
  schedule.one<Schedule>("SELECT * FROM chat_schedule WHERE chat_id=?", chatId);
const drow = (id: string) =>
  schedule.one<DeliveryRow>("SELECT * FROM continuation_delivery WHERE id=?", id)!;
const latest = (chatId: string) =>
  schedule.one<Evaluation>(
    "SELECT * FROM wake_evaluation WHERE chat_id=? ORDER BY round DESC LIMIT 1",
    chatId,
  )!;
const atDue = (chatId: string) => new Date(row(chatId)!.next_due_at!);
const internal = (now: Date): SchedulerContext => ({
  now,
  requestId: newId(ID_PREFIXES.request),
  workerId: "gate",
});
const yes = async (input: WakeEvaluationInput): Promise<WakeEvaluationResult> => ({
  decision: "continue",
  reason: "负责人有明确下一步，需要继续推进。",
  reasonCode: "fixture_continue",
  recipients: input.candidates.map((c) => ({
    recipient: c.recipient,
    decision: "yes",
    reason: "当前责任人",
    probability: null,
  })),
  selectedRecipients: input.candidates.map((c) => c.recipient),
  probability: null,
  provider: input.policy.provider,
  model: input.policy.model,
  version: input.policy.thresholdVersion,
  snapshotHash: input.snapshotHash,
  errorCode: null,
});
async function check(chatId: string, now = atDue(chatId), evaluate = yes) {
  schedule.reconcileChatSchedule(chatId, now);
  const e = schedule.claimDueEvaluation(internal(now));
  ok(e, "due evaluation claimed");
  await delivery.evaluateClaim(e!, evaluate, internal(now));
  return latest(chatId);
}
/**
 * Landing gate: while the provider is deciding, only the persisted policy fact moves, so neither a
 * database trigger nor the domain reconciler touches the evaluation row. `commitEvaluationResult`'s
 * epoch check is then the single writer that can fence the late result, and the row itself (state,
 * result) is what proves the fence ran; a delivery-row assertion alone cannot see this choice.
 */
async function landingFence() {
  const fleeting = group();
  assigned(fleeting.id);
  const now = atDue(fleeting.id);
  const claimed = schedule.claimDueEvaluation(internal(now))!;
  const input = delivery.buildPeriodicInput(claimed, now);
  const result = await yes(input);
  const policy = schedule.one<{ wake_policy: string }>(
    "SELECT wake_policy FROM project WHERE id=?",
    project.id,
  )!.wake_policy;
  schedule.write(
    "UPDATE project SET wake_policy=? WHERE id=?",
    JSON.stringify({ ...JSON.parse(policy), thresholdVersion: "landing-fence" }),
    project.id,
  );
  try {
    equal(
      [latest(fleeting.id).state, latest(fleeting.id).result],
      ["claimed", null],
      "a policy fact change alone leaves the evaluation claimed for the landing gate",
    );
    equal(
      delivery.commitEvaluationResult(claimed, input, result, now),
      null,
      "landing gate rejects a late result whose facts moved after the snapshot",
    );
    equal(
      [
        latest(fleeting.id).state,
        latest(fleeting.id).result,
        latest(fleeting.id).claim_token,
        latest(fleeting.id).lease_until,
        latest(fleeting.id).next_attempt_at,
      ],
      ["stale", null, null, null, null],
      "fenced landing marks the evaluation stale without storing the result",
    );
    equal(
      schedule.one("SELECT 1 FROM continuation_delivery WHERE chat_id=?", fleeting.id),
      undefined,
      "a fenced landing writes no continuation delivery",
    );
  } finally {
    schedule.write("UPDATE project SET wake_policy=? WHERE id=?", policy, project.id);
  }
}
async function restart(now: Date) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", resolve("tests/fixtures/p6a-schedule.ts"), "recover"],
    {
      env: { ...process.env, P6A_NOW: now.toISOString() },
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return JSON.parse(
    stdout
      .split("\n")
      .find((line) => line.startsWith("RECOVER "))!
      .slice(8),
  );
}
function control(
  chatId: string,
  action: "disable" | "enable" | "abort",
  now: Date,
  runId?: string,
) {
  return automation.applyChatAutomationCommand(
    {
      projectId: project.id,
      chatId,
      action,
      ...(runId ? { runId } : {}),
      expectedRevision: schedule.controlFor(chatId).revision,
      requestId: newId(ID_PREFIXES.request),
    },
    ctx,
    now,
  );
}
try {
  if (suite === "scheduler") {
    let now = new Date();
    const callbacks = new Map<number, () => void>();
    let nextTimer = 0;
    const scheduler = createAutomationScheduler({
      clock: {
        now: () => now,
        setTimeout: (fn) => {
          callbacks.set(++nextTimer, fn);
          return nextTimer;
        },
        clearTimeout: (id) => {
          callbacks.delete(id as number);
        },
      },
      evaluateWake: yes,
    });
    scheduler.start();
    await scheduler.settled();
    equal(
      [count("chat_schedule"), callbacks.size],
      [0, 0],
      "no assigned Task means no schedule and no timer",
    );
    const chat = group();
    let work = assigned(chat.id);
    now = new Date(work.task.updatedAt);
    await Promise.resolve();
    await Promise.resolve();
    equal(count("chat_schedule"), 1, "assigned Chat has one schedule");
    equal(callbacks.size, 1, "Task mutation rearms one timer");
    const due = row(chat.id)!.next_due_at!;
    equal(due, now.getTime() + 300000, "first check waits 300 seconds");
    const work2 = assigned(chat.id);
    equal(count("chat_schedule"), 1, "two assigned Tasks share Chat key");
    scheduler.stop();
    equal(callbacks.size, 0, "shutdown clears timer");
    const recovered = await restart(new Date(due - 1));
    equal(recovered.schedules.length, 1, "fresh process recovers persisted schedule");
    equal(recovered.schedules[0].next_due_at, due, "restart preserves due time");
    scheduler.start();
    now = new Date(due);
    await scheduler.advance();
    await scheduler.settled();
    equal(latest(chat.id).state, "decided", "startup-restored timer drives real evaluation");
    equal(
      row(chat.id)!.next_due_at! - now.getTime(),
      schedule.INTERVAL_MS,
      "a successful check re-arms exactly one policy interval from now",
    );
    // P2-2: the trigger writes the interval as a SQL literal, so read the migration text (the
    // newest definition is the one that runs) and hold it equal to the constant. Asserting only the
    // TypeScript config would let the constant and the trigger drift apart unnoticed.
    const intervalLiterals = readdirSync(resolve("drizzle"))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .flatMap((name) =>
        [...readFileSync(resolve("drizzle", name), "utf8").matchAll(/NEW\.updated_at\+(\d+)/g)].map(
          (match) => ({ name, literal: Number(match[1]) }),
        ),
      );
    ok(
      intervalLiterals.length > 0,
      "migrations write the schedule interval as an explicit literal",
    );
    const newestIntervalMigration = intervalLiterals.at(-1)!.name;
    equal(
      [
        ...new Set(
          intervalLiterals
            .filter((entry) => entry.name === newestIntervalMigration)
            .map((entry) => entry.literal),
        ),
      ],
      [schedule.INTERVAL_MS],
      `newest migration trigger literal in ${newestIntervalMigration} equals INTERVAL_MS`,
    );
    equal(
      schedule.all("SELECT * FROM wake_evaluation_task").length,
      2,
      "round snapshots complete assigned Task set",
    );
    work = task.cancelTask(
      { taskId: work.task.id, expectedRevision: work.task.revision },
      ctx,
    ).detail;
    task.cancelTask({ taskId: work2.task.id, expectedRevision: work2.task.revision }, ctx);
    await Promise.resolve();
    equal(
      [count("chat_schedule"), callbacks.size],
      [0, 0],
      "last assigned Task cancellation removes schedule and timer",
    );
    scheduler.stop();
    equal(
      getProject(project.id, ctx).wakePolicy?.provider,
      "small_brain",
      "Project policy is persisted and read",
    );
    equal(
      schedule.all("PRAGMA foreign_key_check"),
      [],
      "migration and schedule rows preserve foreign keys",
    );
    const source = group(),
      target = group();
    let moved = assigned(source.id);
    moved = task.reassignTask(
      { taskId: moved.task.id, expectedRevision: moved.task.revision, targetChatId: target.id },
      ctx,
    ).detail;
    equal(
      [row(source.id), !!row(target.id)],
      [undefined, true],
      "reassignment moves schedule membership in the same transaction",
    );
    moved = task.unassignTask(
      { taskId: moved.task.id, expectedRevision: moved.task.revision },
      ctx,
    ).detail;
    equal(row(target.id), undefined, "withdrawal removes schedule when no assigned Task remains");
    moved = task.assignTask(
      { taskId: moved.task.id, expectedRevision: moved.task.revision, targetChatId: target.id },
      ctx,
    ).detail;
    moved = task.cancelTask(
      { taskId: moved.task.id, expectedRevision: moved.task.revision },
      ctx,
    ).detail;
    task.reopenTask({ taskId: moved.task.id, expectedRevision: moved.task.revision }, ctx);
    ok(row(target.id), "reopening an assigned Task restores schedule membership");
    control(target.id, "disable", new Date());
    const contextual = group();
    assigned(contextual.id);
    const messageIds: string[] = [];
    for (let n = 0; n < 25; n++) {
      const id = newId(ID_PREFIXES.message);
      messageIds.push(id);
      schedule.write(
        "INSERT INTO message(id,chat_id,sender_kind,sender_id,body,created_at) VALUES(?,?,?,?,?,?)",
        id,
        contextual.id,
        "human",
        ctx.userId,
        "中文".repeat(1000),
        1700000000 + n,
      );
    }
    await check(contextual.id);
    const snapshot = JSON.parse(latest(contextual.id).input!) as WakeEvaluationInput;
    equal(snapshot.recentMessages.length, 20, "bounded context retains at most twenty messages");
    equal(
      snapshot.truncation.droppedMessageIdRange,
      { first: messageIds[0], last: messageIds[4] },
      "omitted messages carry an exact identity range",
    );
    equal(
      [snapshot.latestReadableMessageId, snapshot.recentMessages.at(-1)?.body.length],
      [messageIds[24], 2000],
      "character budget prioritizes the newest readable message",
    );
  }
  if (suite === "delivery") {
    const chat = group();
    assigned(chat.id);
    assigned(chat.id);
    const before = [count("message"), count("task_event")];
    await check(chat.id);
    let item = schedule.one<DeliveryRow>(
      "SELECT * FROM continuation_delivery WHERE chat_id=?",
      chat.id,
    )!;
    equal(item.recipient_id, profiles[0].id, "one responsible Agent receives directed input");
    equal(delivery.deliveryView(item).taskIds.length, 2, "delivery traces both Tasks");
    delivery.bindPendingDeliveries(atDue(chat.id));
    item = drow(item.id);
    ok(item.run_id, "bound input uses agent-run allocator");
    equal(
      schedule.one<{ agent_profile_id: string }>(
        "SELECT agent_profile_id FROM agent_instance WHERE id=?",
        item.instance_id,
      )!.agent_profile_id,
      profiles[0].id,
      "run belongs to responsible instance",
    );
    await check(chat.id);
    equal(count("continuation_delivery"), 1, "same Chat conclusions merge and deduplicate");
    equal(
      [count("message"), count("task_event")],
      before,
      "checks do not forge Task events or messages",
    );
    schedule.write(
      "UPDATE agent_run SET status='running',started_at=queued_at WHERE id=?",
      item.run_id,
    );
    let sends = 0;
    delivery.admitContinuation(item.id, item.run_id!, atDue(chat.id), () => {
      sends++;
      return true;
    });
    delivery.admitContinuation(item.id, item.run_id!, atDue(chat.id), () => {
      sends++;
      return true;
    });
    equal(sends, 1, "admitted input cannot send twice before ACK");
    const recovered = await restart(atDue(chat.id));
    equal(
      recovered.deliveries.find((d: { id: string }) => d.id === item.id).error_code,
      "delivery_unknown",
      "restart preserves attempted unknown delivery",
    );
    equal(recovered.claim, null, "unknown delivery blocks automatic new checks");
    equal(
      delivery.pendingContinuations(item.run_id!).length,
      0,
      "admitted unknown is never selected again",
    );
    const reissueAt = new Date(item.created_at + 900000);
    control(chat.id, "disable", reissueAt);
    control(chat.id, "enable", reissueAt);
    ok(
      schedule.hasUnknownDeliveryBarrier(chat.id),
      "enable does not automatically resend an unknown input",
    );
    const reissued = automation.applyChatAutomationCommand(
      {
        action: "reissue",
        projectId: project.id,
        chatId: chat.id,
        expectedRevision: schedule.controlFor(chat.id).revision,
        requestId: newId(ID_PREFIXES.request),
        deliveryId: item.id,
        confirmedUnknown: true,
      },
      ctx,
      reissueAt,
    );
    ok(
      reissued.view.deliveries.some(
        (d) => d.supersedesDeliveryId === item.id && d.deliveryId !== item.id,
      ),
      "Human confirmation creates a new delivery identity linked to unknown original",
    );
    equal(
      drow(item.id).error_code,
      "delivery_unknown",
      "reissue preserves the original attempted fact",
    );
    // Keep the explicit reissue pending while other independent Chat cases run.
    const reminder = group(true);
    assigned(reminder.id);
    await check(reminder.id);
    const human = schedule.one<DeliveryRow>(
      "SELECT * FROM continuation_delivery WHERE chat_id=?",
      reminder.id,
    )!;
    equal(
      [human.state, human.run_id, human.instance_id],
      ["presented", null, null],
      "Human owner only gets reminder",
    );
    ok(
      automation.getChatAutomation(project.id, reminder.id, ctx).view.remindedHuman,
      "Human reminder is visible in read view",
    );
    sendMessage(
      reminder.id,
      { senderKind: "human", senderId: ctx.userId, body: "@Beta 一次显式操作" },
      ctx,
    );
    equal(
      automation.getChatAutomation(project.id, reminder.id, ctx).view.activeRunIds,
      [],
      "Human responsibility view never claims an Agent run for its reminder",
    );
    equal(
      schedule.one<{ n: number }>(
        "SELECT count(*) AS n FROM agent_run WHERE chat_id=? AND status IN ('queued','running')",
        reminder.id,
      )!.n,
      1,
      "an independent explicit Agent run remains real",
    );
    control(reminder.id, "abort", new Date());
    equal(
      schedule.one<{ n: number }>(
        "SELECT count(*) AS n FROM agent_run WHERE chat_id=? AND status IN ('queued','running')",
        reminder.id,
      )!.n,
      0,
      "Chat abort stops every live run even when the responsible owner is Human",
    );
    const changing = group();
    let changingWork = assigned(changing.id);
    await check(changing.id);
    const stale = schedule.one<DeliveryRow>(
      "SELECT * FROM continuation_delivery WHERE chat_id=?",
      changing.id,
    )!;
    changingWork = task.cancelTask(
      { taskId: changingWork.task.id, expectedRevision: changingWork.task.revision },
      ctx,
    ).detail;
    delivery.bindPendingDeliveries(new Date());
    equal(
      drow(stale.id).state,
      "canceled",
      "Task state change invalidates old delivery before binding",
    );
    const ownerChanged = group();
    assigned(ownerChanged.id);
    await check(ownerChanged.id);
    const oldOwnerDelivery = schedule.one<DeliveryRow>(
      "SELECT * FROM continuation_delivery WHERE chat_id=?",
      ownerChanged.id,
    )!;
    setChatOwner(
      ownerChanged.id,
      { kind: "agent", id: profiles[1].id },
      ownerChanged.governanceRevision,
      { kind: "human", userId: ctx.userId, ctx },
    );
    equal(
      drow(oldOwnerDelivery.id).state,
      "canceled",
      "ownership changes invalidate unadmitted input to old responsible Agent",
    );
    equal(
      schedule.responsibleRecipient(ownerChanged.id)?.id,
      profiles[1].id,
      "next evaluation resolves the new unique responsible Agent",
    );
    control(ownerChanged.id, "disable", new Date());
    const backoff = group();
    assigned(backoff.id);
    const unavailable = async (input: WakeEvaluationInput): Promise<WakeEvaluationResult> => ({
      ...(await yes(input)),
      decision: "indeterminate",
      recipients: [],
      selectedRecipients: [],
      errorCode: "provider_unavailable",
      reasonCode: "wake_provider_unavailable",
    });
    let prior = atDue(backoff.id).getTime();
    await check(backoff.id, new Date(prior), unavailable);
    equal(
      row(backoff.id)!.next_due_at,
      prior + 30000,
      "first provider failure backs off 30 seconds",
    );
    prior = row(backoff.id)!.next_due_at!;
    await check(backoff.id, new Date(prior), unavailable);
    equal(row(backoff.id)!.next_due_at, prior + 120000, "second failure backs off 120 seconds");
    await check(backoff.id, atDue(backoff.id), unavailable);
    equal(
      [latest(backoff.id).attempt, latest(backoff.id).state, row(backoff.id)!.next_due_at],
      [3, "attention", null],
      "bounded retries persist attention barrier",
    );
    const failing = group();
    assigned(failing.id);
    await check(failing.id);
    for (let n = 1; n <= 3; n++) {
      delivery.bindPendingDeliveries(atDue(failing.id));
      const input = schedule.one<DeliveryRow>(
        "SELECT * FROM continuation_delivery WHERE chat_id=?",
        failing.id,
      )!;
      schedule.write(
        "UPDATE agent_run SET status='running',started_at=queued_at WHERE id=?",
        input.run_id,
      );
      runs.transitionAgentRun(
        input.run_id!,
        "failed",
        { errorCode: "fixture_failure", errorMessage: "runner failed before admission" },
        ctx,
      );
      equal(
        schedule.one<{ n: number }>(
          "SELECT count(*) AS n FROM agent_run WHERE chat_id=?",
          failing.id,
        )!.n,
        n,
        "failure callback does not immediately open another run",
      );
      await check(failing.id);
    }
    delivery.bindPendingDeliveries(atDue(failing.id));
    equal(
      schedule.one<DeliveryRow>("SELECT * FROM continuation_delivery WHERE chat_id=?", failing.id)!
        .error_code,
      "run_repeated_failure",
      "three failed rounds persist an attention barrier",
    );
    equal(
      schedule.one<{ n: number }>(
        "SELECT count(*) AS n FROM agent_run WHERE chat_id=?",
        failing.id,
      )!.n,
      3,
      "repeated failure budget prevents a fourth automatic run",
    );
    await landingFence();
  }
  if (suite === "control") {
    const chat = group();
    assigned(chat.id);
    const now = atDue(chat.id);
    const e = schedule.claimDueEvaluation(internal(now))!;
    const input = delivery.buildPeriodicInput(e, now);
    const result = await yes(input);
    const disabled = control(chat.id, "disable", now);
    equal(
      [disabled.view.mode, disabled.view.epoch, count("chat_schedule")],
      ["off", 2, 0],
      "disable increments epoch and removes executable schedule",
    );
    equal(
      delivery.commitEvaluationResult(e, input, result, now),
      null,
      "control changed after provider snapshot rejects completed evaluation",
    );
    equal(
      delivery.createContinuationDelivery(e, input, result, now),
      null,
      "control changed after successful decision rejects input creation",
    );
    equal(
      schedule.claimDueEvaluation(internal(new Date(now.getTime() + 3600000))),
      undefined,
      "first epoch gate prevents checks while automation is off",
    );
    control(chat.id, "enable", now);
    equal(
      row(chat.id)!.next_due_at,
      now.getTime() + 300000,
      "Human enable starts a fresh interval",
    );
    await check(chat.id);
    delivery.bindPendingDeliveries(atDue(chat.id));
    const bound = schedule.one<DeliveryRow>(
      "SELECT * FROM continuation_delivery WHERE chat_id=?",
      chat.id,
    )!;
    schedule.write(
      "UPDATE agent_run SET status='running',started_at=queued_at WHERE id=?",
      bound.run_id,
    );
    control(chat.id, "disable", atDue(chat.id));
    equal(
      schedule.one<{ status: string }>("SELECT status FROM agent_run WHERE id=?", bound.run_id)!
        .status,
      "running",
      "disable permits current run to finish",
    );
    equal(
      [drow(bound.id).state, drow(bound.id).cancel_reason],
      ["canceled", "human_disabled"],
      "disable cancels the unadmitted continuation instead of admitting it",
    );
    let sends = 0;
    delivery.admitContinuation(bound.id, bound.run_id!, now, () => ++sends);
    equal(sends, 0, "disabled Chat cannot admit a canceled continuation");
    const agentCtx = {
      ...ctx,
      agent: {
        runId: bound.run_id!,
        instanceId: bound.instance_id!,
        agentProfileId: profiles[0].id,
      },
    };
    ok(
      automation.getChatAutomation(project.id, chat.id, agentCtx).denials.enable,
      "Agent read explains denied controls",
    );
    let agentCode = "";
    try {
      automation.applyChatAutomationCommand(
        {
          projectId: project.id,
          chatId: chat.id,
          action: "enable",
          expectedRevision: schedule.controlFor(chat.id).revision,
          requestId: newId(ID_PREFIXES.request),
        },
        agentCtx,
        now,
      );
    } catch (error) {
      agentCode = (error as { code: string }).code;
    }
    equal(agentCode, "forbidden", "Agent identity cannot impersonate Project Human for control");
    control(chat.id, "enable", now);
    // A fresh unadmitted continuation proves what a chat-wide abort cancels and stops.
    await check(chat.id);
    delivery.bindPendingDeliveries(atDue(chat.id));
    const abortable = schedule.one<DeliveryRow>(
      "SELECT * FROM continuation_delivery WHERE chat_id=? AND admitted_at IS NULL AND state IN ('pending','bound')",
      chat.id,
    )!;
    ok(abortable, "enabled Chat builds a fresh unadmitted continuation");
    const beforeAbort = schedule.controlFor(chat.id);
    const closed = control(chat.id, "abort", now);
    equal(
      [closed.view.mode, closed.view.epoch],
      ["off", beforeAbort.epoch + 1],
      "chat-wide abort closes automation and advances the epoch again",
    );
    equal(
      schedule.one<{ status: string }>("SELECT status FROM agent_run WHERE id=?", bound.run_id)!
        .status,
      "aborted",
      "chat-wide abort stops the running run",
    );
    equal(
      [drow(abortable.id).state, drow(abortable.id).cancel_reason],
      ["canceled", "human_aborted"],
      "chat-wide abort cancels the unadmitted continuation with the Human abort reason",
    );
    equal(count("chat_automation_abort"), 1, "host abort intent persists");
    const recovered = await restart(new Date(now.getTime() + 3600000));
    equal(
      [
        recovered.controls.find((c: { chat_id: string }) => c.chat_id === chat.id).mode,
        recovered.schedules.length,
        recovered.claim,
      ],
      ["off", 0, null],
      "fresh process cannot bypass abort",
    );
    const another = assigned(chat.id);
    equal(count("chat_schedule"), 0, "new assignment cannot restore automation");
    task.cancelTask({ taskId: another.task.id, expectedRevision: another.task.revision }, ctx);
    const command = {
      action: "enable" as const,
      projectId: project.id,
      chatId: chat.id,
      expectedRevision: schedule.controlFor(chat.id).revision,
      requestId: newId(ID_PREFIXES.request),
    };
    const first = automation.applyChatAutomationCommand(command, ctx, now);
    equal(
      automation.applyChatAutomationCommand(command, ctx, now),
      first,
      "same request/payload returns persisted result",
    );
    let code = "";
    try {
      automation.applyChatAutomationCommand({ ...command, action: "disable" }, ctx, now);
    } catch (error) {
      code = (error as { code: string }).code;
    }
    equal(code, "conflict", "same request with different payload conflicts");
    const view = automation.getChatAutomation(project.id, chat.id, ctx);
    ok(
      view.allowedActions.includes("chat.automation.disable") && !view.denials.disable,
      "read data includes permitted controls",
    );
    equal(count("message"), 0, "control and automatic checks never forge Human messages");
    // Run-scoped abort: two Agent runs in one Chat, only the named one stops.
    const scoped = group(true);
    sendMessage(
      scoped.id,
      { senderKind: "human", senderId: ctx.userId, body: "@Alpha @Beta 各自确认一次" },
      ctx,
    );
    const live = schedule.all<{ id: string }>(
      "SELECT id FROM agent_run WHERE chat_id=? AND status IN ('queued','running') ORDER BY rowid",
      scoped.id,
    );
    equal(live.length, 2, "two named Agents open two live runs");
    const scopedBefore = schedule.controlFor(scoped.id);
    const scopedView = control(scoped.id, "abort", now, live[0].id);
    const scopedAfter = schedule.controlFor(scoped.id);
    equal(
      [scopedView.view.mode, scopedAfter.mode, scopedAfter.epoch],
      ["enabled", "enabled", scopedBefore.epoch],
      "run-scoped abort leaves the Chat switch and its epoch untouched",
    );
    equal(
      [
        schedule.one<{ status: string }>("SELECT status FROM agent_run WHERE id=?", live[0].id)!
          .status,
        schedule.one<{ status: string }>("SELECT status FROM agent_run WHERE id=?", live[1].id)!
          .status,
      ],
      ["aborted", "queued"],
      "run-scoped abort stops only the named run",
    );
    equal(
      count("chat_automation_abort"),
      2,
      "each run-scoped abort persists its own host abort intent",
    );
    const revoked = group();
    schedule.write("DELETE FROM chat_member WHERE chat_id=? AND member_kind='human'", revoked.id);
    let revokedCode = "";
    try {
      automation.getChatAutomation(project.id, revoked.id, ctx);
    } catch (error) {
      revokedCode = (error as { code: string }).code;
    }
    equal(
      revokedCode,
      "not_found",
      "Project ownership cannot bypass current Human Chat membership",
    );
    const hanging = group();
    assigned(hanging.id);
    const hangingNow = atDue(hanging.id),
      claimed = schedule.claimDueEvaluation(internal(hangingNow))!;
    let finish!: (value: WakeEvaluationResult) => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const judging = delivery.evaluateClaim(
      claimed,
      async (input) => {
        const result = await yes(input);
        entered();
        return await new Promise<WakeEvaluationResult>((resolve) => {
          finish = () => resolve(result);
        });
      },
      internal(hangingNow),
    );
    await enteredPromise;
    control(hanging.id, "disable", hangingNow);
    finish({} as WakeEvaluationResult);
    await judging;
    equal(
      schedule.one("SELECT 1 FROM continuation_delivery WHERE chat_id=?", hanging.id),
      undefined,
      "disable during external provider request fences the late result",
    );
    const carry = group();
    assigned(carry.id);
    const message = sendMessage(
      carry.id,
      { senderKind: "human", senderId: ctx.userId, body: "一次显式工作输入" },
      ctx,
    );
    const carrying = schedule.one<{ id: string }>(
      "SELECT id FROM agent_run WHERE chat_id=? AND status='queued'",
      carry.id,
    )!;
    const session = schedule.one<{ session_id: string }>(
      "SELECT session_id FROM agent_run WHERE id=?",
      carrying.id,
    )!.session_id;
    runs.transitionAgentRun(
      carrying.id,
      "running",
      {
        configSnapshot: {
          model: "fixture",
          provider: "fixture",
          thinking: "off",
          tools: [],
          extensions: [],
          sessionId: session,
          sessionFile: join(directory, "carry.jsonl"),
          cwd: directory,
          sdkVersion: "fixture",
          profile: {
            id: profiles[0].id,
            name: profiles[0].name,
            persona: profiles[0].persona,
            harness: "pi",
            updatedAt: profiles[0].updatedAt,
          },
        },
      },
      ctx,
    );
    control(carry.id, "disable", now);
    runs.completeAgentRun(carrying.id, "本轮正常结束。", "stop", ctx);
    equal(
      schedule.one<{ n: number }>("SELECT count(*) AS n FROM agent_run WHERE chat_id=?", carry.id)!
        .n,
      1,
      "normal completion cannot carry pending work into a new run while automation is off",
    );
    equal(
      schedule.one<{ disposition: string }>(
        "SELECT disposition FROM agent_run_input WHERE message_id=?",
        message.id,
      )!.disposition,
      "pending",
      "disable preserves unadmitted ordinary input without automatically reopening a run",
    );
    await landingFence();
  }
  if (suite === "integration") {
    const runtime = await import("../../src/server/runtime");
    await runtime.startRuntime();
    gateway = (await import("../../src/server/remote-agent-gateway")).remoteAgentResponse;
    const chat = group();
    const work = assigned(chat.id);
    const before = [count("message"), count("task_event")];
    await check(chat.id);
    delivery.bindPendingDeliveries(atDue(chat.id));
    equal(
      [count("message"), count("task_event")],
      before,
      "judge to delivery has no Task/message side effects",
    );
    const pending = runs.queuedRunWork().find((w) => w.run.chatId === chat.id)!;
    const { PiSessionProcess } = await import("../../src/server/pi-host/process");
    const { executeRun } = await import("../../src/server/pi-host/run");
    const { Effect } = await import("effect");
    const processHandle = new PiSessionProcess(
      pending.run.id,
      resolve("tests/fixtures/p6a-continuation-runner.mjs"),
    );
    await Effect.runPromise(
      executeRun(pending, processHandle, { isStopping: () => false }, () => new Date().getTime()),
    );
    const detail = task.getTaskDetail(work.task.id, ctx),
      item = schedule.one<DeliveryRow>(
        "SELECT * FROM continuation_delivery WHERE chat_id=?",
        chat.id,
      )!;
    equal(
      detail.task.status,
      "finished",
      "fixture runner finishes Task through real authorized HTTP gateway",
    );
    equal(
      detail.lastRecord?.visibility === "readable" ? detail.lastRecord.body : null,
      "真实 HTTP 施工记录：周期接续已完成。",
      "record persists from run identity through production task mutation",
    );
    equal(item.state, "delivered", "production host admission and independent ACK complete");
    equal(
      schedule.one<{ status: string }>("SELECT status FROM agent_run WHERE id=?", pending.run.id)!
        .status,
      "completed",
      "production executeRun completes run",
    );
    equal(row(chat.id), undefined, "Task completion removes periodic schedule");
    equal(
      detail.lastRecord?.visibility === "readable" ? detail.lastRecord.senderKind : null,
      "agent",
      "work record records Agent identity",
    );
    equal(
      detail.lastRecord?.visibility === "readable" ? detail.lastRecord.senderId : null,
      profiles[0].id,
      "record author is unique responsible Agent",
    );
    const runningChat = group();
    sendMessage(
      runningChat.id,
      { senderKind: "human", senderId: ctx.userId, body: "等待运行中接续" },
      ctx,
    );
    const runningWork = runs.queuedRunWork().find((w) => w.run.chatId === runningChat.id)!;
    let ready!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      ready = resolve;
      rejectReady = reject;
    });
    observedAutomationRead = ready;
    const deadline = setTimeout(
      () => rejectReady(new Error("running fixture never reached authorized automation read")),
      10000,
    );
    const runningProcess = new PiSessionProcess(
      runningWork.run.id,
      resolve("tests/fixtures/p6a-continuation-runner.mjs"),
    );
    const completed = Effect.runPromise(
      executeRun(runningWork, runningProcess, { isStopping: () => false }, () =>
        new Date().getTime(),
      ),
    );
    try {
      await readyPromise;
    } finally {
      clearTimeout(deadline);
    }
    const runningTask = assigned(runningChat.id);
    await check(runningChat.id);
    delivery.bindPendingDeliveries(atDue(runningChat.id));
    equal(
      schedule.one<DeliveryRow>(
        "SELECT * FROM continuation_delivery WHERE chat_id=?",
        runningChat.id,
      )!.run_id,
      runningWork.run.id,
      "running instance reuses its existing run for directed steer",
    );
    await completed;
    equal(
      task.getTaskDetail(runningTask.task.id, ctx).task.status,
      "finished",
      "production steer reaches a running process and completes through real HTTP",
    );
    equal(
      schedule.one<DeliveryRow>(
        "SELECT * FROM continuation_delivery WHERE chat_id=?",
        runningChat.id,
      )!.state,
      "delivered",
      "running steer receives its own delivery ACK",
    );
    await runtime.shutdownRuntime("p6a-integration-complete");
  }
  writeFileSync(
    join(directory, `${suite}-result.json`),
    JSON.stringify(
      { suite, assertions, status: "passed", database: process.env.DATABASE_URL },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS p6a-${suite}: ${assertions} assertions; real SQLite ${process.env.DATABASE_URL}`,
  );
} finally {
  if (http) await new Promise<void>((done) => http!.close(() => done()));
  if (sqlite.open) sqlite.close();
}
