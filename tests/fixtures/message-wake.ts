import { migrateDatabase } from "../../src/db/migrate";
import { newId, ID_PREFIXES } from "../../src/contracts/ids";

migrateDatabase();
const { sqlite } = await import("../../src/db");
const projectDomain = await import("../../src/domain/project");
const agentDomain = await import("../../src/domain/agent");
const chatDomain = await import("../../src/domain/chat");
const channel = await import("../../src/domain/channel");
const schedule = await import("../../src/domain/chat-schedule");
const delivery = await import("../../src/domain/continuation-delivery");
const mw = await import("../../src/domain/message-wake");

const ctx = { userId: "usr_mw", requestId: newId(ID_PREFIXES.request) };
const actor = { kind: "human" as const, userId: ctx.userId, ctx };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,0,1,1)",
  )
  .run(ctx.userId, "Message Wake", "message-wake@example.test");
const project = projectDomain.createProject({ name: "Message wake" }, ctx);
const agents = ["Alpha", "Beta"].map((name) => {
  const profile = agentDomain.createAgentProfile({ name, persona: "推进对话", harness: "pi" }, ctx);
  agentDomain.addProjectMember(project.id, profile.id, ctx);
  return profile;
});
const [alpha, beta] = agents;

function group(policy: "contextual" | "owner_led" = "contextual") {
  return chatDomain.createGroupChat(
    project.id,
    {
      projectId: project.id,
      title: `消息触发-${policy}-${newId(ID_PREFIXES.chat)}`,
      wakePolicy: policy,
      members: [
        { kind: "human", id: ctx.userId },
        ...agents.map((agent) => ({ kind: "agent" as const, id: agent.id })),
      ],
      initialOwner: { kind: "agent", id: alpha.id },
    },
    actor,
  );
}

function send(chatId: string, body: string) {
  return chatDomain.sendMessage(chatId, { body, senderKind: "human", senderId: ctx.userId }, ctx);
}

function runRows(chatId: string) {
  return schedule.all<{ id: string }>("SELECT id FROM agent_run WHERE chat_id=?", chatId);
}

function wakeRows(chatId: string) {
  return schedule.all<{
    chat_id: string;
    trigger_message_id: string;
    first_due_at: number;
    due_at: number;
    evaluation_id: string | null;
  }>("SELECT * FROM chat_message_wake WHERE chat_id=?", chatId);
}

function resultFor(
  input: any,
  selected: string[],
  decision: "continue" | "do_not_continue" = selected.length ? "continue" : "do_not_continue",
) {
  const selectedSet = new Set(selected);
  return {
    decision,
    reason: "fixture",
    reasonCode: "fixture",
    recipients: input.candidates.map((candidate: any) => ({
      recipient: candidate.recipient,
      decision: selectedSet.has(candidate.recipient.id) ? ("yes" as const) : ("no" as const),
      reason: "fixture",
      probability: null,
    })),
    selectedRecipients: input.candidates
      .filter((candidate: any) => selectedSet.has(candidate.recipient.id))
      .map((candidate: any) => candidate.recipient),
    probability: null,
    provider: input.policy.provider,
    model: input.policy.model,
    version: input.policy.thresholdVersion,
    snapshotHash: input.snapshotHash,
    errorCode: null,
  };
}

async function evaluate(selected: string[], at: Date) {
  const claimed = mw.claimDueMessageWake({
    now: at,
    requestId: newId(ID_PREFIXES.request),
    workerId: "fixture",
  })!;
  const prepared = mw.buildMessageEvaluation(claimed, at);
  if (prepared.kind !== "model") throw new Error(`unexpected ${prepared.kind}`);
  const input = prepared.input;
  await mw.evaluateMessageClaim(
    claimed,
    async () => ({
      result: resultFor(input, selected),
      usage: {
        inputTokens: 1200,
        outputTokens: 40,
        inputCharacters: JSON.stringify(input).length,
        durationMs: 4300,
        resolvedModel: "fixture/model",
      },
    }),
    { now: at, requestId: newId(ID_PREFIXES.request), workerId: "fixture" },
  );
  return { claimed, input };
}

const at = new Date(Date.now() + 120_000);
const evidence: Record<string, unknown> = {};
evidence.owner = alpha.id;

// 普通群消息：入队、判定、只投递被选中的成员。
const chat = group();
send(chat.id, "大家看一下这个方向");
evidence.groupWake = wakeRows(chat.id).length === 1;
const first = await evaluate([beta.id], at);
delivery.bindPendingDeliveries(new Date(at.getTime() + 1_000));
const firstDelivery = schedule.one<{
  recipient_id: string;
  state: string;
  run_id: string | null;
  envelope: string | null;
}>(
  "SELECT recipient_id,state,run_id,envelope FROM continuation_delivery WHERE chat_id=?",
  chat.id,
)!;
evidence.group = {
  candidates: first.input.candidates.length,
  recipient: firstDelivery.recipient_id,
  state: firstDelivery.state,
  bound: firstDelivery.state === "bound" && firstDelivery.run_id !== null,
  source: JSON.parse(firstDelivery.envelope!).source,
  taskIds: JSON.parse(firstDelivery.envelope!).taskIds,
};

// 多收件人：两条投递都能存在并各自绑定 run。
const multi = group();
send(multi.id, "两位都看看");
const both = await evaluate([alpha.id, beta.id], at);
delivery.bindPendingDeliveries(new Date(at.getTime() + 1_000));
evidence.multi = {
  selected: both.input.candidates
    .map((candidate) => candidate.recipient.id)
    .filter((id) => id === alpha.id || id === beta.id).length,
  deliveries: schedule.all(
    "SELECT recipient_id,state FROM continuation_delivery WHERE chat_id=? ORDER BY recipient_id",
    multi.id,
  ),
};

// 判定器 0 人：owner 回退。
const fallback = group();
send(fallback.id, "没人接吗");
const fallbackRun = await evaluate([], at);
const fallbackDelivery = schedule.one<{ recipient_id: string; state: string }>(
  "SELECT recipient_id,state FROM continuation_delivery WHERE chat_id=?",
  fallback.id,
)!;
evidence.fallback = {
  selected: JSON.parse(
    schedule.one<{ result: string }>(
      "SELECT result FROM wake_evaluation WHERE id=?",
      fallbackRun.claimed.id,
    )!.result,
  ).selectedRecipients,
  delivery: fallbackDelivery,
};

// 公共频道：新频道默认 contextual，普通消息会入队。
const publicChat = channel.ensureProjectChannel(project.id);
send(publicChat, "频道里也看看");
evidence.public = {
  policy: schedule.one<{ wake_policy: string }>(
    "SELECT wake_policy FROM chat WHERE id=?",
    publicChat,
  )!.wake_policy,
  wake: wakeRows(publicChat).length === 1,
};
schedule.write("DELETE FROM chat_message_wake WHERE chat_id=?", publicChat);

// 显式点名：即时硬路由，不再入队。
const mentioned = group();
send(mentioned.id, `@${beta.name} 看一下`);
evidence.mention = {
  wake: wakeRows(mentioned.id).length > 0,
  runs: runRows(mentioned.id).length,
};

// owner_led 与 DM 不进入判定器。
const ownerLed = group("owner_led");
send(ownerLed.id, "owner 看一下");
evidence.ownerLed = {
  wake: wakeRows(ownerLed.id).length > 0,
  runs: runRows(ownerLed.id).length,
};
const dm = chatDomain.createDirectChat(project.id, alpha.id, ctx);
send(dm.chat.id, "DM 看一下");
evidence.dm = { wake: wakeRows(dm.chat.id).length > 0, runs: runRows(dm.chat.id).length };

// 新消息在旧判定仍持租约时等待；旧判定进入重试后由新消息取代，不丢触发。
const raced = group();
const raceFirst = send(raced.id, "旧消息");
const raceClaim = mw.claimDueMessageWake({
  now: at,
  requestId: newId(ID_PREFIXES.request),
  workerId: "fixture",
})!;
const raceSecond = send(raced.id, "新消息");
const racePreempted = mw.claimDueMessageWake({
  now: at,
  requestId: newId(ID_PREFIXES.request),
  workerId: "fixture",
})!;
evidence.race = {
  claimedNew: racePreempted.trigger_message_id === raceSecond.id,
  trigger: racePreempted.trigger_message_id === raceSecond.id,
  oldState: schedule.one<{ state: string }>(
    "SELECT state FROM wake_evaluation WHERE id=?",
    raceClaim.id,
  )!.state,
  first: raceFirst.id,
};

// 防抖：同一 chat 的连续消息只保留一条，触发消息更新，窗口有上限。
const debounce = group();
const m1 = send(debounce.id, "第一条");
const m2 = send(debounce.id, "第二条");
const debounceRow = wakeRows(debounce.id);
evidence.debounce = {
  rows: debounceRow.length,
  trigger: debounceRow[0]?.trigger_message_id === m2.id,
  immediate: debounceRow[0] ? debounceRow[0].due_at - debounceRow[0].first_due_at < 1_000 : false,
  first: m1.id,
};
schedule.write("DELETE FROM chat_message_wake WHERE chat_id=?", debounce.id);

// 已有 task 判定时，human message 抢占 active 槽位，task 让路并重新排期。
const waiting = group();
const waitingMessage = send(waiting.id, "先排队");
schedule.write(
  "INSERT INTO wake_evaluation(id,project_id,chat_id,source,trigger_message_id,round,control_epoch,fingerprint,state,attempt,request_id,created_at) VALUES(?,?,?,'task_periodic',NULL,1,1,'task-fixture','pending',0,?,?)",
  newId(ID_PREFIXES.wakeEvaluation),
  project.id,
  waiting.id,
  newId(ID_PREFIXES.request),
  at.getTime(),
);
const preempted = mw.claimDueMessageWake({
  now: at,
  requestId: newId(ID_PREFIXES.request),
  workerId: "fixture",
})!;
evidence.taskActive = {
  claimed: preempted.trigger_message_id === waitingMessage.id,
  messageTrigger: preempted.trigger_message_id === waitingMessage.id,
  taskState: schedule.one<{ state: string }>(
    "SELECT state FROM wake_evaluation WHERE chat_id=? AND source='task_periodic'",
    waiting.id,
  )!.state,
};
schedule.write(
  "DELETE FROM wake_evaluation WHERE chat_id=? AND source='task_periodic'",
  waiting.id,
);
schedule.write("DELETE FROM chat_message_wake WHERE chat_id=?", waiting.id);

// message 与 task 共用 round；message 判定活跃时 task claim 必须让路。
const sources = group();
send(sources.id, "消息和任务同时到期");
const sourceClaim = mw.claimDueMessageWake({
  now: at,
  requestId: newId(ID_PREFIXES.request),
  workerId: "fixture",
})!;
const sourceTaskId = newId(ID_PREFIXES.task);
sqlite
  .prepare(
    "INSERT INTO task(id,project_id,status,title,created_by,created_at,updated_at) VALUES(?,?,'proposed',?,?,?,?)",
  )
  .run(sourceTaskId, project.id, "来源共存", ctx.userId, at.getTime(), at.getTime());
sqlite
  .prepare(
    "UPDATE task SET status='assigned',chat_id=?,revision=2,assignment_revision=1,updated_at=? WHERE id=?",
  )
  .run(sources.id, at.getTime(), sourceTaskId);
schedule.write("UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?", at.getTime(), sources.id);
const taskBlocked = schedule.claimDueEvaluation({
  now: new Date(at.getTime() + 1_000),
  requestId: newId(ID_PREFIXES.request),
  workerId: "fixture",
});
const messageStillClaimed =
  schedule.one<{ state: string }>("SELECT state FROM wake_evaluation WHERE id=?", sourceClaim.id)!
    .state === "claimed";
const prepared = mw.buildMessageEvaluation(sourceClaim, at);
if (prepared.kind !== "model") throw new Error(`unexpected ${prepared.kind}`);
await mw.evaluateMessageClaim(
  sourceClaim,
  async () => ({
    result: resultFor(prepared.input, [alpha.id]),
    usage: {
      inputTokens: 1200,
      outputTokens: 40,
      inputCharacters: JSON.stringify(prepared.input).length,
      durationMs: 4300,
      resolvedModel: "fixture/model",
    },
  }),
  { now: at, requestId: newId(ID_PREFIXES.request), workerId: "fixture" },
);
const sourceDeliveryBefore = schedule.one<{ id: string; evaluation_id: string; state: string }>(
  "SELECT id,evaluation_id,state FROM continuation_delivery WHERE chat_id=? AND recipient_id=?",
  sources.id,
  alpha.id,
)!;
schedule.write("UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?", at.getTime(), sources.id);
const sourceTaskEval = schedule.claimDueEvaluation({
  now: new Date(at.getTime() + 2_000),
  requestId: newId(ID_PREFIXES.request),
  workerId: "fixture",
})!;
const sourceTaskInput = delivery.buildPeriodicInput(sourceTaskEval, new Date(at.getTime() + 2_000));
delivery.commitEvaluationResult(
  sourceTaskEval,
  sourceTaskInput,
  resultFor(sourceTaskInput, [alpha.id]),
  new Date(at.getTime() + 2_000),
);
const sourceDeliveryAfter = schedule.one<{ id: string; evaluation_id: string; state: string }>(
  "SELECT id,evaluation_id,state FROM continuation_delivery WHERE chat_id=? AND recipient_id=?",
  sources.id,
  alpha.id,
)!;
evidence.sources = {
  blocked: taskBlocked === undefined,
  messageStillClaimed,
  messageRound: sourceClaim.round,
  taskRound: sourceTaskEval.round,
  scheduleRound: schedule.one<{ round: number }>(
    "SELECT round FROM chat_schedule WHERE chat_id=?",
    sources.id,
  )!.round,
  preserved:
    sourceDeliveryAfter.id === sourceDeliveryBefore.id &&
    sourceDeliveryAfter.evaluation_id === sourceClaim.id &&
    sourceDeliveryAfter.state === sourceDeliveryBefore.state,
};

// 判定器最终不可用时，第 6 次失败进入 attention。
// 先清掉前面场景留下的 due wake/active eval，避免全局 claim 抢到别的 chat。
schedule.write("DELETE FROM chat_message_wake");
schedule.write(
  "UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE source='message' AND state IN ('pending','claimed','retry_wait')",
);
const failed = group();
send(failed.id, "判定器挂了");
const failCtx = (now: Date) => ({
  now,
  requestId: newId(ID_PREFIXES.request),
  workerId: "fixture",
});
const failing = async () => {
  throw new Error("provider_unavailable");
};
const fail1 = mw.claimDueMessageWake(failCtx(at))!;
await mw.evaluateMessageClaim(fail1, failing, failCtx(at));
const wakeBefore = schedule.one<{ evaluation_id: string }>(
  "SELECT evaluation_id FROM chat_message_wake WHERE chat_id=?",
  failed.id,
)!;
schedule.write("DELETE FROM chat_message_wake WHERE chat_id=?", failed.id);
const fail2 = mw.claimDueMessageWake(failCtx(new Date(at.getTime() + 5_000)))!;
evidence.orphan = {
  queued: Boolean(wakeBefore),
  requeued: Boolean(fail2) && fail2.attempt === 2,
  attempt: fail2?.attempt ?? 0,
};
await mw.evaluateMessageClaim(fail2, failing, failCtx(new Date(at.getTime() + 5_000)));
const fail3 = mw.claimDueMessageWake(failCtx(new Date(at.getTime() + 15_000)))!;
await mw.evaluateMessageClaim(fail3, failing, failCtx(new Date(at.getTime() + 15_000)));
const fail4 = mw.claimDueMessageWake(failCtx(new Date(at.getTime() + 45_000)))!;
await mw.evaluateMessageClaim(fail4, failing, failCtx(new Date(at.getTime() + 45_000)));
const fail5 = mw.claimDueMessageWake(failCtx(new Date(at.getTime() + 105_000)))!;
await mw.evaluateMessageClaim(fail5, failing, failCtx(new Date(at.getTime() + 105_000)));
const fail6 = mw.claimDueMessageWake(failCtx(new Date(at.getTime() + 225_000)))!;
await mw.evaluateMessageClaim(fail6, failing, failCtx(new Date(at.getTime() + 225_000)));
const failState = schedule.one<{ state: string; attempt: number; error_code: string | null }>(
  "SELECT state,attempt,error_code FROM wake_evaluation WHERE id=?",
  fail6.id,
)!;
evidence.failureFallback = {
  attempts: failState.attempt,
  state: failState.state,
  errorCode: failState.error_code,
  deliveries: schedule.one<{ n: number }>(
    "SELECT count(*) AS n FROM continuation_delivery WHERE chat_id=?",
    failed.id,
  )!.n,
};
const newer = send(failed.id, "更新的消息");
const retried = mw.retryMessageWake(fail6, new Date(at.getTime() + 300_000));
const queued = schedule.one<{ trigger_message_id: string }>(
  "SELECT trigger_message_id FROM chat_message_wake WHERE chat_id=?",
  failed.id,
)!;
evidence.retry = { retried, trigger: queued.trigger_message_id, newer: newer.id };
schedule.write("DELETE FROM chat_message_wake WHERE chat_id=?", failed.id);

// 旧的 message 投递处于 delivery_unknown 时，不应永久挡住同一成员的新消息。
const unknown = group();
send(unknown.id, "旧消息");
await evaluate([beta.id], at);
delivery.bindPendingDeliveries(new Date(at.getTime() + 1_000));
schedule.write(
  "UPDATE continuation_delivery SET state='attention',error_code='delivery_unknown',admitted_at=?,attempt=1,next_attempt_at=NULL WHERE chat_id=?",
  at.getTime(),
  unknown.id,
);
send(unknown.id, "新消息");
await evaluate([beta.id], new Date(at.getTime() + 61_000));
const unknownDeliveries = schedule.all<{ state: string; error_code: string | null }>(
  "SELECT state,error_code FROM continuation_delivery WHERE chat_id=? ORDER BY created_at",
  unknown.id,
);
evidence.unknown = {
  count: unknownDeliveries.length,
  first: unknownDeliveries[0],
  latest: unknownDeliveries.at(-1),
};

// 中断恢复：bound 但未 admitted 的投递按渐进重试，首次等待 5 秒。
const recovery = group();
send(recovery.id, "恢复后继续");
await evaluate([alpha.id], at);
delivery.bindPendingDeliveries(new Date(at.getTime() + 1_000));
const recoveryBound = schedule.one<{ id: string; run_id: string | null }>(
  "SELECT id,run_id FROM continuation_delivery WHERE chat_id=?",
  recovery.id,
)!;
schedule.write(
  "UPDATE agent_run SET status='interrupted',settled_at=? WHERE id=?",
  at.getTime() + 2_000,
  recoveryBound.run_id,
);
const recoveryAt = new Date(at.getTime() + 3_000);
schedule.recoverSchedules(recoveryAt);
const recoveryPending = schedule.one<{ state: string; next_attempt_at: number | null }>(
  "SELECT state,next_attempt_at FROM continuation_delivery WHERE id=?",
  recoveryBound.id,
)!;
const recoveryRetryAt = new Date(recoveryAt.getTime() + 5_000);
delivery.bindPendingDeliveries(recoveryRetryAt);
const recoveryRebound = schedule.one<{ state: string; run_id: string | null }>(
  "SELECT state,run_id FROM continuation_delivery WHERE id=?",
  recoveryBound.id,
)!;
schedule.write(
  "UPDATE agent_run SET status='interrupted',settled_at=? WHERE id=?",
  at.getTime() + 4_000,
  recoveryRebound.run_id,
);
const liveInterruptedAt = new Date(recoveryRetryAt.getTime() + 2_000);
delivery.settleContinuationRun(recoveryRebound.run_id!, "interrupted", liveInterruptedAt);
delivery.bindPendingDeliveries(new Date(liveInterruptedAt.getTime() + 10_000));
const liveRebound = schedule.one<{ state: string; run_id: string | null }>(
  "SELECT state,run_id FROM continuation_delivery WHERE id=?",
  recoveryBound.id,
)!;
evidence.recovery = {
  stateAfterRecover: recoveryPending.state,
  nextAttemptAt: recoveryPending.next_attempt_at,
  recoveredAt: recoveryAt.getTime(),
  reboundState: recoveryRebound.state,
  reboundRun: recoveryRebound.run_id !== recoveryBound.run_id,
  liveReboundState: liveRebound.state,
  liveReboundRun: liveRebound.run_id !== recoveryRebound.run_id,
};

// 人类 owner 的上下文群：owner 提醒与 Agent 接续不得同时成立。
const automation = await import("../../src/domain/chat-automation");
const taskDomain = await import("../../src/domain/task");
function humanGroup() {
  return chatDomain.createGroupChat(
    project.id,
    {
      projectId: project.id,
      title: `人类负责-${newId(ID_PREFIXES.chat)}`,
      wakePolicy: "contextual",
      members: [
        { kind: "human", id: ctx.userId },
        ...agents.map((agent) => ({ kind: "agent" as const, id: agent.id })),
      ],
      initialOwner: { kind: "human", id: ctx.userId },
    },
    actor,
  );
}
function assignTask(chatId: string) {
  const created = taskDomain.createTask(
    { projectId: project.id, title: "人类负责的周期推进" },
    ctx,
  ).detail;
  taskDomain.assignTask(
    { taskId: created.task.id, expectedRevision: created.task.revision, targetChatId: chatId },
    ctx,
  );
}
const periodicYes = async (input: any) => ({
  result: resultFor(
    input,
    input.candidates.map((candidate: any) => candidate.recipient.id),
  ),
  usage: {
    inputTokens: 900,
    outputTokens: 32,
    inputCharacters: JSON.stringify(input).length,
    durationMs: 4200,
    resolvedModel: "fixture/model",
  },
});
function onlyDue(chatId: string, now: Date) {
  schedule.write("UPDATE chat_schedule SET next_due_at=NULL WHERE chat_id<>?", chatId);
  schedule.write(
    "UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE state IN ('pending','claimed','retry_wait')",
  );
  schedule.write("UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?", now.getTime(), chatId);
}
async function periodicCheck(chatId: string, now: Date) {
  onlyDue(chatId, now);
  schedule.reconcileChatSchedule(chatId, now);
  schedule.write("UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?", now.getTime(), chatId);
  const claimed = schedule.claimDueEvaluation({
    now,
    requestId: newId(ID_PREFIXES.request),
    workerId: "fixture",
  })!;
  await delivery.evaluateClaim(claimed, periodicYes, {
    now,
    requestId: newId(ID_PREFIXES.request),
    workerId: "fixture",
  });
}
function viewOf(chatId: string) {
  try {
    const view = automation.getChatAutomation(project.id, chatId, ctx).view;
    return { readable: true, remindedHuman: view.remindedHuman, activeRuns: view.activeRunIds };
  } catch (error) {
    return {
      readable: false,
      remindedHuman: null,
      activeRuns: [] as never[],
      error: String(error),
    };
  }
}

// 顺序一：先展示 owner 提醒，随后群消息唤醒 Agent 接续，提醒随接管作废。
const coexist = humanGroup();
assignTask(coexist.id);
await periodicCheck(coexist.id, at);
const reminder = schedule.one<{ id: string; state: string; recipient_kind: string }>(
  "SELECT id,state,recipient_kind FROM continuation_delivery WHERE chat_id=?",
  coexist.id,
)!;
const reminderViewBefore = viewOf(coexist.id);
schedule.write("DELETE FROM chat_message_wake WHERE chat_id<>?", coexist.id);
send(coexist.id, "这条线需要人接一下");
await evaluate([alpha.id], at);
delivery.bindPendingDeliveries(new Date(at.getTime() + 1_000));
const reminderViewAfter = viewOf(coexist.id);
evidence.coexistence = {
  reminderBefore: reminder.state,
  reminderKind: reminder.recipient_kind,
  remindedHumanBefore: reminderViewBefore.remindedHuman,
  viewReadableBefore: reminderViewBefore.readable,
  reminderAfter: schedule.one<{ state: string }>(
    "SELECT state FROM continuation_delivery WHERE id=?",
    reminder.id,
  )!.state,
  remindedHumanAfter: reminderViewAfter.remindedHuman,
  viewReadableAfter: reminderViewAfter.readable,
  activeRuns: reminderViewAfter.activeRuns.length,
  boundDeliveries: schedule.one<{ n: number }>(
    "SELECT count(*) AS n FROM continuation_delivery WHERE chat_id=? AND state='bound'",
    coexist.id,
  )!.n,
};

// 顺序二：Agent 接续已绑定 run 时，周期判定不得再展示 owner 提醒。
const taken = humanGroup();
assignTask(taken.id);
schedule.write("DELETE FROM chat_message_wake WHERE chat_id<>?", taken.id);
send(taken.id, "先交给 Agent 接续");
await evaluate([alpha.id], at);
delivery.bindPendingDeliveries(new Date(at.getTime() + 1_000));
const takenBound = schedule.one<{ n: number }>(
  "SELECT count(*) AS n FROM continuation_delivery WHERE chat_id=? AND state='bound' AND run_id IS NOT NULL",
  taken.id,
)!.n;
await periodicCheck(taken.id, new Date(at.getTime() + 2_000));
const takenView = viewOf(taken.id);
evidence.takenOver = {
  boundDeliveries: takenBound,
  humanDeliveries: schedule.one<{ n: number }>(
    "SELECT count(*) AS n FROM continuation_delivery WHERE chat_id=? AND recipient_kind='human'",
    taken.id,
  )!.n,
  remindedHuman: takenView.remindedHuman,
  viewReadable: takenView.readable,
  activeRuns: takenView.activeRuns.length,
};

console.log(JSON.stringify(evidence));
sqlite.close();
