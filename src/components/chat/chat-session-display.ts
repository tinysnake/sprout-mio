import { chatDisplayTitle } from "../../contracts/chat";
import type { ChatKind, ChatSession } from "../../contracts/chat";
import type { ChatInfoView } from "../../contracts/info-hub";

export const CHAT_KIND_LABELS: Record<ChatKind, string> = {
  dm: "DM",
  group: "Group",
  public_channel: "Public Channel",
};

/** 参与分身名：群与频道用实例快照，DM 用成员视图里的 Agent 展示名。 */
export function sessionAgentNames(session: ChatSession, info?: ChatInfoView): string[] {
  if (session.kind !== "dm") return session.instances.map((instance) => instance.profileName);
  if (!info) return [];
  return info.members
    .filter((member) => member.memberKind === "agent")
    .map((member) => member.displayName);
}

/** 列表、标题栏与详情共用 `chatDisplayTitle`，不各自维护回落链。 */
export function sessionDisplayTitle(session: ChatSession, info?: ChatInfoView): string {
  return chatDisplayTitle(session.chat, sessionAgentNames(session, info));
}

export function sessionSubtitle(session: ChatSession): string {
  if (session.kind === "dm") return "DM";
  if (session.kind === "group") return "Group";
  return "Public Channel";
}

export function senderKey(kind: "human" | "agent", id: string): string {
  return `${kind}:${id}`;
}

/**
 * 消息发送者逐条按 senderId 解析；失败或缺失时退回通用名，不用某个 profile
 * 代表整个会话。历史发送者是否可判定由调用方先确认成员查询成功。
 */
export function sessionSenderNames(
  session: ChatSession,
  info: ChatInfoView | undefined,
  humanName: string,
): Map<string, string> {
  const names = new Map<string, string>();
  const members = info?.members ?? [];
  for (const member of members) {
    if (member.memberKind === "human") {
      names.set(senderKey("human", member.memberId), member.displayName || humanName || "你");
    } else {
      names.set(senderKey("agent", member.memberId), member.displayName || "Agent");
    }
  }
  if (session.kind !== "dm") {
    for (const instance of session.instances) {
      names.set(senderKey("agent", instance.agentProfileId), instance.profileName);
    }
  }
  return names;
}
