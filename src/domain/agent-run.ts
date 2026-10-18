import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type {
  AgentRun,
  AgentRunInput,
  AgentRunStatus,
  RunConfigSnapshot,
} from "../contracts/agent-run";
import type { Message } from "../contracts/conversation";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db, sqlite } from "../db";
import {
  agentInstance,
  agentProfile,
  agentRun,
  agentRunInput,
  conversation,
  diagnosticEvent,
  message,
} from "../db/schema";
import { ProjectAccessError } from "./access";
import type { ProjectContext } from "./access";
import { getConversation, sendMessage } from "./conversation";

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
    conversationId: row.conversationId,
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
    .select({ run: agentRun, owner: conversation })
    .from(agentRun)
    .innerJoin(
      conversation,
      and(
        eq(conversation.id, agentRun.conversationId),
        eq(conversation.projectId, agentRun.projectId),
      ),
    )
    .where(eq(agentRun.id, id))
    .get();
  if (!found) throw new ProjectAccessError();
  const current = getConversation(found.owner.id, ctx);
  if (current.projectId !== found.run.projectId) throw new ProjectAccessError();
  return found.run;
}

export function getAgentRun(id: string, ctx: ProjectContext): AgentRun {
  return toRun(runRow(id, ctx));
}

export function listAgentRuns(conversationId: string, ctx: ProjectContext): AgentRun[] {
  const current = getConversation(conversationId, ctx);
  return db
    .select()
    .from(agentRun)
    .where(
      and(eq(agentRun.conversationId, conversationId), eq(agentRun.projectId, current.projectId)),
    )
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
      ...input,
      deliveredAt: input.deliveredAt?.toISOString(),
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
      conversationId: row.conversationId,
      instanceId: row.instanceId,
      runId: row.id,
      message: detail,
    })
    .run();
}

/** 与 human message 共用事务，输入失败就回滚消息。 */
export function appendHumanRunInput(saved: Message, ctx: ProjectContext): void {
  const current = getConversation(saved.conversationId, ctx);
  if (saved.senderKind !== "human" || current.kind !== "dm") return;
  const instance = db
    .select()
    .from(agentInstance)
    .where(eq(agentInstance.conversationId, current.id))
    .get();
  if (!instance) throw new AgentRunError("not_found", "Instance 不存在");
  let run = db
    .select()
    .from(agentRun)
    .where(
      and(eq(agentRun.instanceId, instance.id), inArray(agentRun.status, ["queued", "running"])),
    )
    .get();
  if (run && (run.conversationId !== current.id || run.projectId !== current.projectId)) {
    throw new AgentRunError("conflict", "Run 归属不一致");
  }
  if (!run) {
    run = db
      .insert(agentRun)
      .values({
        id: `run_${randomUUID()}`,
        instanceId: instance.id,
        conversationId: current.id,
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
            eq(agentInstance.conversationId, row.conversationId),
            eq(agentInstance.projectId, row.projectId),
          ),
        )
        .get();
      if (!instance) throw new AgentRunError("not_found", "Instance 不存在");
      const reply = sendMessage(
        row.conversationId,
        {
          senderKind: "agent",
          senderId: instance.agentProfileId,
          body: body.trim(),
        },
        ctx,
      );
      return transitionAgentRun(id, "completed", { stopReason, assistantMessageId: reply.id }, ctx);
    })
    .immediate();
}

/** 只供受管宿主调用。actor 与 project 归属从 conversation 推导。 */
export function queuedRunWork(): {
  run: typeof agentRun.$inferSelect;
  profile: typeof agentProfile.$inferSelect;
  ownerId: string;
}[] {
  return db
    .select({ run: agentRun, profile: agentProfile, ownerId: conversation.createdBy })
    .from(agentRun)
    .innerJoin(
      conversation,
      and(
        eq(conversation.id, agentRun.conversationId),
        eq(conversation.projectId, agentRun.projectId),
      ),
    )
    .innerJoin(
      agentInstance,
      and(
        eq(agentInstance.id, agentRun.instanceId),
        eq(agentInstance.conversationId, conversation.id),
      ),
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
      and(eq(message.id, agentRunInput.messageId), eq(message.conversationId, row.conversationId)),
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
        eq(agentRun.conversationId, current.conversationId),
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
