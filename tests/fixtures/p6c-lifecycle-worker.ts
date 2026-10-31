// P6c 集成门禁的进程边界：并发移除、事务中断、重启后核对。
// 每个模式都只调生产函数（removeProjectMember / 真实 SQLite 读），不 mock 领域层。
// 状态通过文件标记 + SIGKILL 传递，避免 IPC 在同步阻塞时空转：
//   remove    两个进程同时移除同一 Agent（第 7 条）
//   interrupt 移除事务写到一半时把标记落盘，然后永久阻塞，等父进程 SIGKILL（第 8 条）
//   restart   新进程打开同一个库，核对被中断的移除没有留下痕迹，再重试并汇报事实（第 8 条）
import { writeFileSync } from "node:fs";
import { and, eq, ne } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { db } from "../../src/db";
import {
  agentRun,
  chat,
  chatEffectiveMember,
  chatMember,
  diagnosticEvent,
  projectMember,
} from "../../src/db/schema";
import { collectProjectMemberRemovalBlockers, removeProjectMember } from "../../src/domain/agent";

type Payload = {
  mode: "remove" | "interrupt" | "restart";
  projectId: string;
  agentProfileId: string;
  userId: string;
  /** 只给 interrupt：进入事务后落这个文件，父进程看见它才 SIGKILL。 */
  marker?: string;
  groupChatId?: string;
  dmChatId?: string;
};
const send = (value: unknown) => process.send?.(value);

process.on("message", (raw: Payload) => {
  if (raw.mode === "interrupt") return interrupt(raw);
  if (raw.mode === "restart") return restart(raw);
  return remove(raw);
});

function remove(input: Payload) {
  try {
    removeProjectMember(input.projectId, input.agentProfileId, {
      userId: input.userId,
      requestId: newId(ID_PREFIXES.request),
    });
    send({ mode: "remove", ok: true });
  } catch (error) {
    send({
      mode: "remove",
      ok: false,
      code: (error as { code?: string }).code ?? null,
      name: (error as Error).name,
      message: String(error),
    });
    process.exitCode = 1;
  }
  process.disconnect();
}

/**
 * 事务内中断：`afterWrite` 在成员行、DM 归档、群成员删除都写完、诊断与 COMMIT 之前触发。
 * 此刻把标记同步落盘，然后同步永久阻塞——父进程 SIGKILL 掉本进程，
 * 数据库里只剩未提交的 WAL 帧，重启时由 SQLite 回滚。
 */
function interrupt(input: Payload) {
  const marker = input.marker;
  if (!marker) throw new Error("interrupt mode requires a marker path");
  removeProjectMember(
    input.projectId,
    input.agentProfileId,
    { userId: input.userId, requestId: newId(ID_PREFIXES.request) },
    {
      afterWrite: () => {
        writeFileSync(marker, "mid-transaction");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      },
    },
  );
  send({ mode: "interrupt", ok: true });
  process.disconnect();
}

/** 重启后的核对与重试：先证明中断没有落任何一行，再用正常移除收敛。 */
function restart(input: Payload) {
  const projectId = input.projectId;
  const agentProfileId = input.agentProfileId;
  const ctx = { userId: input.userId, requestId: newId(ID_PREFIXES.request) };
  const member = db
    .select()
    .from(projectMember)
    .where(
      and(eq(projectMember.projectId, projectId), eq(projectMember.agentProfileId, agentProfileId)),
    )
    .get();
  const dm = input.dmChatId
    ? db.select().from(chat).where(eq(chat.id, input.dmChatId)).get()
    : null;
  const groupMember = input.groupChatId
    ? db
        .select()
        .from(chatMember)
        .where(
          and(
            eq(chatMember.chatId, input.groupChatId),
            eq(chatMember.memberKind, "agent"),
            eq(chatMember.memberId, agentProfileId),
          ),
        )
        .get()
    : null;
  const before = {
    memberPresent: Boolean(member),
    dmArchived: Boolean(dm?.archivedAt),
    groupMemberPresent: Boolean(groupMember),
    blockerKinds: collectProjectMemberRemovalBlockers(projectId, agentProfileId).map(
      (blocker) => blocker.kind,
    ),
    removedEvents: removedEvents(projectId),
  };
  const removeError = (() => {
    try {
      removeProjectMember(projectId, agentProfileId, ctx);
      return null;
    } catch (error) {
      return String(error);
    }
  })();
  const after = {
    memberPresent: Boolean(
      db
        .select()
        .from(projectMember)
        .where(
          and(
            eq(projectMember.projectId, projectId),
            eq(projectMember.agentProfileId, agentProfileId),
          ),
        )
        .get(),
    ),
    dmArchived: Boolean(
      input.dmChatId
        ? db.select().from(chat).where(eq(chat.id, input.dmChatId)).get()?.archivedAt
        : null,
    ),
    groupMemberPresent: input.groupChatId
      ? Boolean(
          db
            .select()
            .from(chatMember)
            .where(
              and(
                eq(chatMember.chatId, input.groupChatId),
                eq(chatMember.memberKind, "agent"),
                eq(chatMember.memberId, agentProfileId),
              ),
            )
            .get(),
        )
      : null,
    // 只数普通 Group 与 Public Channel：DM 分支按 d14 保留历史成员行，不算参与权。
    effectiveGroupAndChannel: db
      .select({ chatId: chatEffectiveMember.chatId })
      .from(chatEffectiveMember)
      .innerJoin(chat, eq(chat.id, chatEffectiveMember.chatId))
      .where(
        and(
          eq(chatEffectiveMember.projectId, projectId),
          eq(chatEffectiveMember.memberKind, "agent"),
          eq(chatEffectiveMember.memberId, agentProfileId),
          ne(chat.kind, "dm"),
        ),
      )
      .all().length,
    removedEvents: removedEvents(projectId),
    activeRuns: db
      .select()
      .from(agentRun)
      .where(and(eq(agentRun.projectId, projectId), eq(agentRun.status, "running")))
      .all().length,
  };
  send({ mode: "restart", ok: removeError === null, error: removeError, before, after });
  process.disconnect();
}

function removedEvents(projectId: string) {
  return db
    .select()
    .from(diagnosticEvent)
    .where(
      and(
        eq(diagnosticEvent.projectId, projectId),
        eq(diagnosticEvent.event, "project_member.removed"),
      ),
    )
    .all().length;
}
