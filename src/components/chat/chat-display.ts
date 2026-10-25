import type { Chat } from "../../contracts/chat";

/** 分身名缺失时的通用兜底：不退回裸 profile id，也不退回裸 chat id。 */
export const CHAT_AGENT_FALLBACK = "Agent";

/**
 * Chat 的可见名称：人工命名的 title 优先，否则回落到参与分身名。
 *
 * 裸 chat id 不是人类可读文案，任何列表、标题或侧栏都不使用它；需要 id 时
 * 放在 `title` 属性或 inspector 的既有事实字段里。title 是人工命名的可选覆盖，
 * 本单元不做摘要生成，也没有自动写入路径。
 */
export function chatDisplayName(chat: Pick<Chat, "title">, agentName: string): string {
  const title = chat.title?.trim();
  if (title) return title;
  return agentName.trim() || CHAT_AGENT_FALLBACK;
}

/** 列表副行文案：名称已经是分身名时不再重复同一串字。 */
export function chatSubtitleLabel(chat: Pick<Chat, "title">, agentName: string): string {
  return chat.title?.trim() ? agentName.trim() || CHAT_AGENT_FALLBACK : "DM";
}
