import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type {
  AgentRun,
  AgentRunInput,
  AgentRunStatus,
  RunConfigSnapshot,
} from "../contracts/agent-run";
import type { AgentInstance, Chat, ChatMember, ChatWakeDispatch, Message } from "../contracts/chat";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db, sqlite } from "../db";
import {
  agentInstance,
  agentProfile,
  agentRun,
  agentRunInput,
  chat,
  diagnosticEvent,
  message,
  projectMember,
  task,
} from "../db/schema";
import { ProjectAccessError } from "./access";
import type { ProjectContext } from "./access";
import { readChatEffectiveMembers } from "./channel";
import { getChat, ensureInstance, sendMessage } from "./chat";
import { routeWakeCandidates } from "./chat-wake";
import { taskResponsibilityFacts, TaskError } from "./task-capabilities";

export class AgentRunError extends Error {
  constructor(
    readonly code: "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "AgentRunError";
  }
}

const NEXT: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  queued: ["running", "failed", "aborted", "interrupted"],
  running: ["completed", "failed", "aborted", "interrupted"],
  completed: [],
  failed: [],
  aborted: [],
  interrupted: [],
};

function toRun(row: typeof agentRun.$inferSelect): AgentRun {
  return {
    id: row.id,
    instanceId: row.instanceId,
    chatId: row.chatId,
    projectId: row.projectId,
    requestId: row.requestId,
    status: row.status,
    queuedAt: row.queuedAt.toISOString(),
    sessionId: row.sessionId,
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.settledAt ? { settledAt: row.settledAt.toISOString() } : {}),
    ...(row.stopReason ? { stopReason: row.stopReason } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
    ...(row.configSnapshot ? { configSnapshot: row.configSnapshot } : {}),
    ...(row.assistantMessageId ? { assistantMessageId: row.assistantMessageId } : {}),
  };
}

function runRow(id: string, ctx: ProjectContext): typeof agentRun.$inferSelect {
  const found = db
    .select({ run: agentRun, owner: chat })
    .from(agentRun)
    .innerJoin(chat, and(eq(chat.id, agentRun.chatId), eq(chat.projectId, agentRun.projectId)))
    .where(eq(agentRun.id, id))
    .get();
  if (!found) throw new ProjectAccessError();
  const current = getChat(found.owner.id, ctx);
  if (current.projectId !== found.run.projectId) throw new ProjectAccessError();
  return found.run;
}

export function getAgentRun(id: string, ctx: ProjectContext): AgentRun {
  return toRun(runRow(id, ctx));
}

export function listAgentRuns(chatId: string, ctx: ProjectContext): AgentRun[] {
  const current = getChat(chatId, ctx);
  return db
    .select()
    .from(agentRun)
    .where(and(eq(agentRun.chatId, chatId), eq(agentRun.projectId, current.projectId)))
    .orderBy(asc(agentRun.queuedAt), asc(sql`rowid`))
    .all()
    .map(toRun);
}

export function listAgentRunInputs(id: string, ctx: ProjectContext): AgentRunInput[] {
  runRow(id, ctx);
  return db
    .select({ input: agentRunInput })
    .from(agentRunInput)
    .innerJoin(message, eq(message.id, agentRunInput.messageId))
    .where(eq(agentRunInput.runId, id))
    .orderBy(asc(message.createdAt), asc(sql`${message}.rowid`))
    .all()
    .map(({ input }: { input: typeof agentRunInput.$inferSelect }) => ({
      runId: input.runId,
      messageId: input.messageId,
      disposition: input.disposition,
      deliveredAt: input.deliveredAt?.toISOString(),
      cancelledAt: input.cancelledAt?.toISOString(),
      cancelReason: input.cancelReason ?? undefined,
    }));
}

function diagnostic(
  row: typeof agentRun.$inferSelect,
  event: string,
  detail: string,
  level: "info" | "warn" | "error" = "info",
) {
  db.insert(diagnosticEvent)
    .values({
      id: newId(ID_PREFIXES.diagnostic),
      at: new Date(),
      level,
      event,
      requestId: row.requestId,
      projectId: row.projectId,
      chatId: row.chatId,
      instanceId: row.instanceId,
      runId: row.id,
      message: detail,
    })
    .run();
}

/**
 * 同一 instance 的活跃 run（数据库部分唯一索引保证至多一条）；没有就排一条新的 queued run。
 * 排队是 `attachMessageToRun` 与「上一轮的未投递输入交给下一轮」共用的唯一入口。
 */
function activeRunFor(
  scope: { instanceId: string; chatId: string; projectId: string },
  requestId: string,
): typeof agentRun.$inferSelect {
  const active = db
    .select()
    .from(agentRun)
    .where(
      and(
        eq(agentRun.instanceId, scope.instanceId),
        inArray(agentRun.status, ["queued", "running"]),
      ),
    )
    .get();
  if (active) {
    if (active.chatId !== scope.chatId || active.projectId !== scope.projectId) {
      throw new AgentRunError("conflict", "Run 归属不一致");
    }
    return active;
  }
  const created = db
    .insert(agentRun)
    .values({
      id: `run_${randomUUID()}`,
      instanceId: scope.instanceId,
      chatId: scope.chatId,
      projectId: scope.projectId,
      requestId,
      status: "queued",
      sessionId: scope.instanceId,
    })
    .returning()
    .get();
  diagnostic(created, "agent_run.queued", "Agent run 已排队");
  return created;
}

/** 这条消息是否已经属于该 instance 的某条 run（任何状态）。 */
function runIdOfMessage(messageId: string, instanceId: string): string | undefined {
  return db
    .select({ runId: agentRunInput.runId })
    .from(agentRunInput)
    .innerJoin(agentRun, eq(agentRun.id, agentRunInput.runId))
    .where(and(eq(agentRunInput.messageId, messageId), eq(agentRun.instanceId, instanceId)))
    .get()?.runId;
}

/**
 * 把一条人类消息挂到某个 instance 的活跃 run 上；没有活跃 run 就排队一条新 run。
 * DM 与群/频道派发共用这一步，保证「同一 instance 串行」只有一份实现。
 *
 * 幂等（N01）：同一 (message, agentProfile) 在整条生命周期里至多一条 run、一条输入
 * （instance 与 agent profile 在一条对话里一一对应，因此按 instance 判即可）。
 * 重复投递同一个已保存的消息——活跃 run 上重投、或两条 run 都已终结后重投——
 * 返回既有结果，既不抛 `SQLITE_CONSTRAINT_PRIMARYKEY`，也不为每个 Agent 再开第二条 run。
 */
function attachMessageToRun(
  saved: Message,
  current: Chat,
  instance: Pick<AgentInstance, "id">,
  ctx: ProjectContext,
): void {
  if (runIdOfMessage(saved.id, instance.id)) return;
  const run = activeRunFor(
    { instanceId: instance.id, chatId: current.id, projectId: current.projectId },
    ctx.requestId,
  );
  db.insert(agentRunInput)
    .values({ runId: run.id, messageId: saved.id, disposition: "pending" })
    .run();
}

/** Dedicated Task delivery: re-read persisted responsibility; never use chat wake routing. */
export function appendTaskStartRunInput(messageId: string, ctx: ProjectContext): string {
  return sqlite
    .transaction(() => {
      const saved = db.select().from(message).where(eq(message.id, messageId)).get();
      const currentTask = saved?.taskId
        ? db.select().from(task).where(eq(task.id, saved.taskId)).get()
        : undefined;
      if (
        !saved ||
        saved.taskRecordKind !== "start" ||
        saved.senderKind !== "human" ||
        ctx.agent ||
        saved.senderId !== ctx.userId ||
        !currentTask ||
        currentTask.status !== "assigned" ||
        currentTask.chatId !== saved.chatId ||
        currentTask.projectId !== saved.taskProjectId ||
        currentTask.assignmentRevision !== saved.taskAssignmentRevision
      )
        throw new TaskError("conflict", "开始消息的任务上下文已变化");
      const current = getChat(saved.chatId, ctx);
      const responsibility = taskResponsibilityFacts(current.id, ctx);
      const governance = db.select().from(chat).where(eq(chat.id, current.id)).get()!;
      if (
        responsibility.kind !== "agent" ||
        responsibility.agentProfileId !== saved.taskStartRecipientId ||
        governance.governanceRevision !== saved.taskGovernanceRevision
      )
        throw new TaskError("conflict", "开始消息的负责人已变化");
      const instance = ensureInstance(current.id, responsibility.agentProfileId, ctx);
      attachMessageToRun(
        {
          id: saved.id,
          chatId: saved.chatId,
          senderKind: saved.senderKind,
          senderId: saved.senderId,
          body: saved.body,
          createdAt: saved.createdAt.toISOString(),
        },
        current,
        instance,
        ctx,
      );
      return runIdOfMessage(saved.id, instance.id)!;
    })
    .immediate();
}

/**
 * `completed` 的 run 把仍未投递的输入交给同一 instance 的下一轮
 * （`docs/communication-decisions.md` 的「当前一轮结束前仍未处理的消息进入下一轮」）。
 *
 * 这是 A01 的唯一解释点：交接靠**改挂输入行**（`run_id` 换成下一轮的 run），不是复制——
 * 一条消息在整条生命周期里只有一条 `agent_run_input`，否则「每条人类消息恰一条输入」就不再成立。
 *
 * 边界：只有 `completed` 交接。`failed` / `aborted` / `interrupted` 保持现状不动，
 * 因为（1）失败可能发生在输入投递之前，自动开下一轮会变成无限重试（A02 的必败 run 就是这种）；
 * （2）人类停止不能被自动开的下一轮抵消（d10/d11，`o-turn-semantics` 也钉住 aborted 后 pending 仍为 pending）。
 * 这两类的处置语义归后续阶段，不在这里用猜测的理由取消。
 */
function carryPendingInputsToNextRound(run: typeof agentRun.$inferSelect, requestId: string): void {
  const pending = db
    .select({ messageId: agentRunInput.messageId })
    .from(agentRunInput)
    .where(and(eq(agentRunInput.runId, run.id), eq(agentRunInput.disposition, "pending")))
    .all();
  if (pending.length === 0) return;
  // 下一轮就是「同 instance 没有活跃 run」时新排的那条 run；所有未投递输入共用它。
  const next = activeRunFor(
    { instanceId: run.instanceId, chatId: run.chatId, projectId: run.projectId },
    requestId,
  );
  for (const entry of pending) {
    db.update(agentRunInput)
      .set({ runId: next.id })
      .where(and(eq(agentRunInput.runId, run.id), eq(agentRunInput.messageId, entry.messageId)))
      .run();
  }
  diagnostic(
    next,
    "agent_run.inputs_carried",
    `上一轮结束时未投递的 ${pending.length} 条输入已交给下一轮`,
  );
}

/**
 * 候选 Agent 的 `agent_profile_id` → 展示名字典（契约 `chatWakeDispatchSchema`）。
 * `routeWakeCandidates` 的点名规则按名字匹配，成员视图只给 id，所以名字必须在这里补；
 * 读不到名字时字典项只有 id，点名退化为 `@<agent_profile_id>`。
 */
function profileDictionary(members: readonly ChatMember[]): ChatWakeDispatch["agentProfiles"] {
  const agentIds = members
    .filter((member) => member.memberKind === "agent")
    .map((member) => member.memberId);
  if (agentIds.length === 0) return [];
  const names = new Map<string, string>();
  for (const row of db
    .select({ id: agentProfile.id, name: agentProfile.name })
    .from(agentProfile)
    .where(inArray(agentProfile.id, agentIds))
    .all())
    names.set(row.id, row.name);
  return agentIds.map((agentProfileId) => {
    const profileName = names.get(agentProfileId);
    return profileName === undefined ? { agentProfileId } : { agentProfileId, profileName };
  });
}

/**
 * 群与公共频道的人类消息派发（裁定 §3.3 / §4.5 / d18）：
 * - 候选只由 `routeWakeCandidates` 决定，这里不加 kind 分支，所以频道里只唤醒被点名的 Agent
 *   （owner 恒为人类，`owner_led` 在频道里本就不产生候选），绝不按成员广播；
 * - 每个候选在**自己的 instance** 上各得一条 run 与一条 `agent_run_input`，这就是扇出的物化
 *   （输入主键是 `(run_id, message_id)`）；
 * - 同一 instance 已有活跃 run 时输入挂到那条 run，不新建第二个（数据库部分唯一索引是底线）。
 */
function fanoutHumanMessage(saved: Message, current: Chat, ctx: ProjectContext): void {
  const members = readChatEffectiveMembers(current.id, current.projectId);
  // 派发契约只带 id → 名字的字典与消息内容；规则函数要的其余成员事实仍由视图给全。
  const dispatch: ChatWakeDispatch = {
    chatId: current.id,
    body: saved.body,
    agentProfiles: profileDictionary(members),
  };
  const names = new Map(
    dispatch.agentProfiles.map((entry) => [entry.agentProfileId, entry.profileName] as const),
  );
  const candidates = routeWakeCandidates({
    body: dispatch.body,
    chat: {
      id: dispatch.chatId,
      kind: current.kind,
      wakePolicy: current.wakePolicy,
      ownerKind: current.owner.kind,
      ownerId: current.owner.id,
    },
    effectiveMembers: members.map((member) => {
      const profileName = names.get(member.memberId);
      return {
        memberKind: member.memberKind,
        memberId: member.memberId,
        ...(profileName === undefined ? {} : { profileName }),
      };
    }),
  });
  for (const candidate of candidates) {
    const instance = ensureInstance(current.id, candidate.agentProfileId, ctx);
    attachMessageToRun(saved, current, instance, ctx);
  }
}

/**
 * DM 里唯一的 Agent 是否还在这条对话上（A02）：对话未归档，且该 Agent 仍是 Project 成员。
 *
 * 不能只靠 `chat_effective_member`：它的 DM 分支为了让历史可读，对历史成员放行、不查
 * `project_member`（d19 在 `sendMessage` 里已经补了同一层判定，这是排队入口的那一份）。
 * 少了它，Agent 移出 Project 后旧 DM 仍会接受 Human 消息、落库、排一条必败的 run——
 * 先成功再失败（`remote_run_inactive`），正是 A02 的缺陷。
 */
function assertDmAgentParticipates(current: Chat, agentProfileId: string): void {
  if (current.archivedAt) throw new AgentRunError("conflict", "对话已归档，不能继续发送消息");
  const membership = db
    .select({ addedBy: projectMember.addedBy })
    .from(projectMember)
    .where(
      and(
        eq(projectMember.projectId, current.projectId),
        eq(projectMember.agentProfileId, agentProfileId),
      ),
    )
    .get();
  if (!membership) throw new AgentRunError("conflict", "该 Agent 已不在 Project，对话不可继续");
}

/** 与 human message 共用事务，输入失败就回滚消息。 */
export function appendHumanRunInput(saved: Message, ctx: ProjectContext): void {
  const current = getChat(saved.chatId, ctx);
  if (saved.senderKind !== "human") return;
  // DM 保持「一条消息一条 run」的既有语义：对话里恰有一个 instance，不看唤醒规则。
  if (current.kind === "dm") {
    const instance = db
      .select()
      .from(agentInstance)
      .where(eq(agentInstance.chatId, current.id))
      .get();
    if (!instance) throw new AgentRunError("not_found", "Instance 不存在");
    // 参与权先于排队：拒绝发生在写入之前，不靠执行时再失败。
    assertDmAgentParticipates(current, instance.agentProfileId);
    attachMessageToRun(saved, current, instance, ctx);
    return;
  }
  fanoutHumanMessage(saved, current, ctx);
}

type TransitionData = {
  configSnapshot?: RunConfigSnapshot;
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
  assistantMessageId?: string;
};

export function transitionAgentRun(
  id: string,
  status: AgentRunStatus,
  data: TransitionData,
  ctx: ProjectContext,
): AgentRun {
  return sqlite
    .transaction(() => {
      const row = runRow(id, ctx);
      if (!NEXT[row.status].includes(status))
        throw new AgentRunError("conflict", `Run 不能从 ${row.status} 变为 ${status}`);
      if (
        status === "running" &&
        (!data.configSnapshot || data.configSnapshot.sessionId !== row.sessionId)
      ) {
        throw new AgentRunError("conflict", "Run 缺少实际执行配置");
      }
      if (status === "completed" && (data.stopReason !== "stop" || !data.assistantMessageId)) {
        throw new AgentRunError("conflict", "Run 缺少正常完成结果");
      }
      if (status === "failed" && (!data.errorCode || !data.errorMessage?.trim())) {
        throw new AgentRunError("conflict", "Run 缺少失败原因");
      }
      const updated = db
        .update(agentRun)
        .set({
          ...data,
          status,
          ...(status === "running" ? { startedAt: new Date() } : { settledAt: new Date() }),
        })
        .where(and(eq(agentRun.id, id), eq(agentRun.status, row.status)))
        .returning()
        .get();
      if (!updated) throw new AgentRunError("conflict", "Run 状态已变更");
      diagnostic(
        updated,
        `agent_run.${status}`,
        `Agent run ${status}`,
        status === "failed" ? "error" : status === "interrupted" ? "warn" : "info",
      );
      return toRun(updated);
    })
    .immediate();
}

export function markRunInputDelivered(id: string, messageId: string, ctx: ProjectContext): void {
  const run = runRow(id, ctx);
  if (run.status !== "running") throw new AgentRunError("conflict", "Run 未运行");
  const changed = db
    .update(agentRunInput)
    .set({ disposition: "delivered", deliveredAt: new Date() })
    .where(
      and(
        eq(agentRunInput.runId, id),
        eq(agentRunInput.messageId, messageId),
        eq(agentRunInput.disposition, "pending"),
      ),
    )
    .run();
  if (!changed.changes) throw new AgentRunError("conflict", "Run 输入不存在或已投递");
}

export function pendingRunInputs(
  id: string,
  ctx: ProjectContext,
): { messageId: string; text: string }[] {
  const row = runRow(id, ctx);
  return db
    .select({ messageId: agentRunInput.messageId, text: message.body })
    .from(agentRunInput)
    .innerJoin(
      message,
      and(eq(message.id, agentRunInput.messageId), eq(message.chatId, row.chatId)),
    )
    .where(and(eq(agentRunInput.runId, id), eq(agentRunInput.disposition, "pending")))
    .orderBy(asc(message.createdAt), asc(sql`${message}.rowid`))
    .all();
}

export function recordRunInputDeliveryFailure(
  runId: string,
  messageId: string,
  reason: string,
  ctx: ProjectContext,
): void {
  diagnostic(
    runRow(runId, ctx),
    "agent_run.input_delivery_failed",
    `Run 输入 ${messageId} 投递失败：${reason}`,
    "warn",
  );
}

export function abortAgentRun(id: string, ctx: ProjectContext): AgentRun {
  return transitionAgentRun(id, "aborted", { stopReason: "aborted" }, ctx);
}

export function completeAgentRun(
  id: string,
  body: string,
  stopReason: string,
  ctx: ProjectContext,
): AgentRun {
  return sqlite
    .transaction(() => {
      const row = runRow(id, ctx);
      if (row.status !== "running" || stopReason !== "stop" || !body.trim() || body.length > 8000) {
        throw new AgentRunError("conflict", "Run 未返回有效的正常回复");
      }
      const instance = db
        .select()
        .from(agentInstance)
        .where(
          and(
            eq(agentInstance.id, row.instanceId),
            eq(agentInstance.chatId, row.chatId),
            eq(agentInstance.projectId, row.projectId),
          ),
        )
        .get();
      if (!instance) throw new AgentRunError("not_found", "Instance 不存在");
      // 回复由 run 自己的 instance 分身发出；带上 run 身份，让发送资格判定与宿主执行同一套。
      const reply = sendMessage(
        row.chatId,
        {
          senderKind: "agent",
          senderId: instance.agentProfileId,
          body: body.trim(),
        },
        {
          ...ctx,
          agent: {
            agentProfileId: instance.agentProfileId,
            instanceId: row.instanceId,
            runId: id,
          },
        },
      );
      const settled = transitionAgentRun(
        id,
        "completed",
        { stopReason, assistantMessageId: reply.id },
        ctx,
      );
      // 正常结束时仍未投递的输入交给下一轮（A01）。先落终态再交接：交接要找「同 instance
      // 的活跃 run」，自己刚变成 completed 才算离开活跃集合，否则会把输入改挂回自己。
      carryPendingInputsToNextRound(row, ctx.requestId);
      return settled;
    })
    .immediate();
}

/** 只供受管宿主调用。actor 与 project 归属从 chat 推导；执行身份另取 run 自己的记录。 */
export function queuedRunWork(): {
  run: typeof agentRun.$inferSelect;
  profile: typeof agentProfile.$inferSelect;
  ownerId: string;
  agentProfileId: string;
}[] {
  return db
    .select({
      run: agentRun,
      profile: agentProfile,
      ownerId: chat.createdBy,
      agentProfileId: agentInstance.agentProfileId,
    })
    .from(agentRun)
    .innerJoin(chat, and(eq(chat.id, agentRun.chatId), eq(chat.projectId, agentRun.projectId)))
    .innerJoin(
      agentInstance,
      and(eq(agentInstance.id, agentRun.instanceId), eq(agentInstance.chatId, chat.id)),
    )
    .innerJoin(agentProfile, eq(agentProfile.id, agentInstance.agentProfileId))
    .where(eq(agentRun.status, "queued"))
    .orderBy(asc(agentRun.queuedAt))
    .all();
}

export function firstPendingRunInput(id: string, ctx: ProjectContext) {
  const row = runRow(id, ctx);
  return db
    .select({ input: agentRunInput, message })
    .from(agentRunInput)
    .innerJoin(
      message,
      and(eq(message.id, agentRunInput.messageId), eq(message.chatId, row.chatId)),
    )
    .where(and(eq(agentRunInput.runId, id), eq(agentRunInput.disposition, "pending")))
    .orderBy(asc(message.createdAt), asc(sql`${message}.rowid`))
    .get();
}

export function previousSessionFile(runId: string, ctx: ProjectContext): string | undefined {
  const current = runRow(runId, ctx);
  const snapshots: { snapshot: RunConfigSnapshot | null }[] = db
    .select({ snapshot: agentRun.configSnapshot })
    .from(agentRun)
    .where(
      and(
        eq(agentRun.instanceId, current.instanceId),
        eq(agentRun.chatId, current.chatId),
        eq(agentRun.projectId, current.projectId),
      ),
    )
    .orderBy(sql`${agentRun}.rowid desc`)
    .all();
  return snapshots.find(({ snapshot }) => snapshot !== null)?.snapshot?.sessionFile;
}

/** 在 runtime 的恢复事务里执行，诊断失败必须回滚恢复。 */
export function recoverAgentRuns(): void {
  sqlite
    .transaction(() => {
      const rows = db
        .select()
        .from(agentRun)
        .where(inArray(agentRun.status, ["queued", "running"]))
        .all();
      for (const row of rows) {
        db.update(agentRun)
          .set({
            status: "interrupted",
            settledAt: new Date(),
            errorCode: "host_interrupted",
            errorMessage: "宿主上次未正常关闭",
          })
          .where(eq(agentRun.id, row.id))
          .run();
        diagnostic(row, "agent_run.interrupted", "恢复上次未正常关闭的 Agent run", "warn");
      }
    })
    .immediate();
}

export function interruptActiveAgentRuns(): void {
  sqlite
    .transaction(() => {
      for (const row of db
        .select()
        .from(agentRun)
        .where(inArray(agentRun.status, ["queued", "running"]))
        .all()) {
        db.update(agentRun)
          .set({
            status: "interrupted",
            settledAt: new Date(),
            errorCode: "host_stopping",
            errorMessage: "宿主正在关闭",
          })
          .where(eq(agentRun.id, row.id))
          .run();
        diagnostic(row, "agent_run.interrupted", "宿主关闭中断 Agent run", "warn");
      }
    })
    .immediate();
}
