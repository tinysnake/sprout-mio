import type { ChatKind, ChatOwnerFacts } from "../../contracts/chat";

/**
 * 右栏治理段的说明文字。判定值全部来自领域层（裁定 d45）：`session.governance` 的
 * `canChangeMembers` / `canChangeOwner` 决定按钮与说法，这里不再抄能力表、也不比身份。
 * 成员治理放宽到 Human 成员后，第一句自动变成「人类成员都能调整成员」。
 */
export function governanceNote(kind: ChatKind, facts: ChatOwnerFacts): string {
  if (kind === "public_channel")
    return "公共频道 Owner 固定为 Project 创建者，成员跟随 Project 自动同步。";
  if (kind !== "group") return "";
  if (!facts.canChangeMembers)
    return `${facts.readOnlyReason ?? "当前身份不能修改成员与 Owner"}。Agent 不参与治理。`;
  return facts.canChangeOwner
    ? "Human 成员都能调整成员；Owner 变更需要当前 Human owner。Agent 不参与治理。"
    : "Human 成员都能调整成员；当前身份不能变更 Owner。Agent 不参与治理。";
}
