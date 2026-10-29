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
} from "../db/schema";
import { ProjectAccessError } from "./access";
import type { ProjectContext } from "./access";
import { readChatEffectiveMembers } from "./channel";
import { getChat, ensureInstance, sendMessage } from "./chat";
import { routeWakeCandidates } from "./chat-wake";

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
 * 把一条人类消息挂到某个 instance 的活跃 run 上；没有活跃 run 就排队一条新 run。
 * DM 与群/频道派发共用这一步，保证「同一 instance 串行」只有一份实现。
 */
function attachMessageToRun(
  saved: Message,
  current: Chat,
  instance: Pick<AgentInstance, "id">,
  ctx: ProjectContext,
): void {
  let run = db
    .select()
    .from(agentRun)
    .where(
      and(eq(agentRun.instanceId, instance.id), inArray(agentRun.status, ["queued", "running"])),
    )
    .get();
  if (run && (run.chatId !== current.id || run.projectId !== current.projectId)) {
    throw new AgentRunError("conflict", "Run 归属不一致");
  }
  if (!run) {
    run = db
      .insert(agentRun)
      .values({
        id: `run_${randomUUID()}`,
        instanceId: instance.id,
        chatId: current.id,
        projectId: current.projectId,
        requestId: ctx.requestId,
        status: "queued",
        sessionId: instance.id,
      })
      .returning()
      .get();
    diagnostic(run, "agent_run.queued", "Agent run 已排队");
  }
  db.insert(agentRunInput)
    .values({ runId: run.id, messageId: saved.id, disposition: "pending" })
    .run();
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
      return transitionAgentRun(id, "completed", { stopReason, assistantMessageId: reply.id }, ctx);
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
