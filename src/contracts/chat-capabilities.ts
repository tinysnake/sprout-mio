/**
 * 对话治理能力表：领域层判定与页面渲染的唯一来源。
 *
 * 放在 contracts 是因为它是纯数据，浏览器与服务端都要读；领域层与页面各抄一份
 * 已经漂移过两次（`title_change` 页面更严、`member_add` 改档后页面滞后），
 * 判定值与按钮可见性必须来自同一个常量。
 */
export const CHAT_ACTIONS = [
  "group_create",
  "group_dissolve",
  "member_add",
  "member_remove",
  "owner_change",
  "wake_policy_change",
  // 标题写入与成员、owner 同类：它改的是「这段对话是什么」，不是「谁在说话」。
  // 冻结形状只列了七项，验收 A03 证明八项之外的写入路径等于没有边界。
  "title_change",
  "message_send",
] as const;

export type ChatAction = (typeof CHAT_ACTIONS)[number];

/** 放行门槛：never 直接拒绝，member 只看身份类别，owner 还必须是当前所有者。 */
export type AccessLevel = "never" | "member" | "owner";

/**
 * 静态封闭能力表：Agent 在所有治理动作上都是 `never`。
 * 成员增删对任何 Human 有效成员开放：群是人协作的地方，让非 owner 只能旁观
 * 会把每次加人都变成对 owner 的请求。参与权本身仍由 `chat_effective_member` 判定。
 */
export const CHAT_CAPABILITIES: Record<ChatAction, { human: AccessLevel; agent: AccessLevel }> = {
  group_create: { human: "member", agent: "never" },
  group_dissolve: { human: "owner", agent: "never" },
  member_add: { human: "member", agent: "never" },
  member_remove: { human: "member", agent: "never" },
  owner_change: { human: "owner", agent: "never" },
  wake_policy_change: { human: "owner", agent: "never" },
  // Human 档是 member 而不是 owner：标题没有 `expectedRevision`，不属于 d15 的三类治理写入，
  // 现有行为是「能进这个 Project 的 Human 就能改名」，收成 owner 会改变 Human 行为。
  title_change: { human: "member", agent: "never" },
  message_send: { human: "member", agent: "member" },
};
