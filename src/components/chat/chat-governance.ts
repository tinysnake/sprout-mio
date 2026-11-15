import type { ChatKind, ChatOwnerFacts } from "../../contracts/chat";

/**
 * 右栏治理段的说明文字。判定值全部来自领域层：`session.governance` 的
 * `canChangeMembers` / `canChangeLead` 决定按钮与说法，这里不再抄能力表、也不比身份。
 * 成员规则归成员段，这里只说 lead 变更的条件。
 */
export function governanceNote(kind: ChatKind, facts: ChatOwnerFacts): string {
  if (kind !== "crew") return "";
  if (!facts.canChangeMembers)
    return `${facts.readOnlyReason ?? "当前身份不能修改成员与 lead"}。Agent 不参与治理。`;
  return facts.canChangeLead
    ? "lead 变更需要当前 Human owner。Agent 不参与治理。"
    : "当前身份不能变更 lead。Agent 不参与治理。";
}
