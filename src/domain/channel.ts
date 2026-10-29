import { and, asc, eq, sql } from "drizzle-orm";
import type { ChatKind, ChatMember } from "../contracts/chat";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db } from "../db";
import { chat, chatEffectiveMember, project } from "../db/schema";
import { ChatError } from "./chat";

/**
 * 频道成员的唯一拒绝理由。错误文案要让人知道下一步去哪儿改：去 Project → Members，
 * 而不是在频道里找一个其实不存在的成员入口。
 */
export const CHANNEL_MEMBERSHIP_MANAGED_MESSAGE =
  "公共频道成员跟随 Project 成员自动同步，不可在频道内单独调整";

/**
 * 取得或创建 Project 的公共频道，返回频道 id。
 *
 * 幂等由部分唯一索引 `chat_public_channel_project_unique` 收敛：先读、读不到就插、
 * 插入被并发者抢先时再读一次。调用方要么已经在自己的事务里（`createProject` /
 * `createDefaultProjectForHuman`），要么像门禁一样直接调用——单条 INSERT 自身原子，
 * 两种用法都不会留下第二个频道。
 *
 * 频道是 Project 的派生事实（裁定 d8），所以：
 * - `title` 留空：没有命名者，页面显示固定文案「公共频道（Project 范围）」；
 * - `created_by` 与 `owner_id` 都取 `project.created_by`，`owner_kind` 恒为 `human`；
 * - `governance_revision` 从 0 起步，频道不参与成员治理，也不允许换 owner。
 *
 * 唤醒语义（wake_policy 保留 §4.1 的冻结值 `owner_led`，这里说明它在频道里的实际含义）：
 * 频道的 owner 一定是人类 Project 创建者，`owner_led` 的「所有者优先」规则要求
 * `owner_kind = 'agent'`，因此这条规则在频道里永远不产生候选。频道也绝不向全体成员广播：
 * 一条消息只会唤醒被点名的 Agent（`routeWakeCandidates` 的点名规则对所有对话一致）。
 * 也就是说，人把消息发进公共频道这个动作本身不会拉起任何 Agent。
 */
export function ensureProjectChannel(projectId: string): string {
  const existing = db
    .select({ id: chat.id })
    .from(chat)
    .where(and(eq(chat.projectId, projectId), eq(chat.kind, "public_channel")))
    .get();
  if (existing) return existing.id;
  const parent = db
    .select({ createdBy: project.createdBy })
    .from(project)
    .where(eq(project.id, projectId))
    .get();
  if (!parent) throw new ChatError("not_found", "Project 不存在");
  const inserted = db
    .insert(chat)
    .values({
      id: newId(ID_PREFIXES.chat),
      projectId,
      kind: "public_channel",
      title: null,
      ownerKind: "human",
      ownerId: parent.createdBy,
      createdBy: parent.createdBy,
    })
    .onConflictDoNothing()
    .returning({ id: chat.id })
    .get();
  if (inserted) return inserted.id;
  // 唯一索引把并发收敛到一行：另一个调用者刚插进去的那条就是答案。
  const settled = db
    .select({ id: chat.id })
    .from(chat)
    .where(and(eq(chat.projectId, projectId), eq(chat.kind, "public_channel")))
    .get();
  if (!settled) throw new ChatError("conflict", "公共频道创建失败");
  return settled.id;
}

/**
 * 对话当前有效成员的唯一读入口（裁定 d7）：直接读派生视图 `chat_effective_member`，
 * 不在应用层拼一份等价判定。三种来源分别是 DM/Group 的成员行、频道的 Project Agent 成员、
 * 频道的 Project 创建者；Project 级移除后 Agent 立即从这里消失，但它的历史消息与 run 仍保留。
 *
 * 视图没有 rowid，同一秒加入的成员需要稳定次序：先按加入时间，再让人类（DM 创建者、
 * Project 创建者）排在前面，最后按成员 id 收口。
 */
export function readChatEffectiveMembers(chatId: string, projectId: string): ChatMember[] {
  return db
    .select()
    .from(chatEffectiveMember)
    .where(
      and(eq(chatEffectiveMember.chatId, chatId), eq(chatEffectiveMember.projectId, projectId)),
    )
    .orderBy(
      asc(chatEffectiveMember.addedAt),
      asc(sql`${chatEffectiveMember.memberKind} <> 'human'`),
      asc(chatEffectiveMember.memberId),
    )
    .all()
    .map((row: typeof chatEffectiveMember.$inferSelect) => ({
      chatId: row.chatId,
      memberKind: row.memberKind,
      memberId: row.memberId,
      addedAt: row.addedAt.toISOString(),
    }));
}

/**
 * 「频道成员不可直接调整」的领域入口：加/减成员的调用点在写库之前经过这里，
 * 频道的成员集只随 Project 成员同步，独立增删一律 `channel_membership_managed`。
 * 数据库的 `chat_member_no_channel_insert` 触发器是同一事实的物理底线，两者不互相替代。
 */
export function assertChannelMemberChangeAllowed(target: { readonly kind: ChatKind }): void {
  if (target.kind === "public_channel")
    throw new ChatError("channel_membership_managed", CHANNEL_MEMBERSHIP_MANAGED_MESSAGE);
}
