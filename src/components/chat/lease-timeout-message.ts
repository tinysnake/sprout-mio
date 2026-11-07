/**
 * 挂靠超时提醒消息的呈现约定。
 *
 * 提醒由 `sweepLeaseEscrowTimeouts()` 直接写库（`src/domain/lease-timeout.ts` 的
 * `writeReminderMessage`），所以它不是成员、没有 mention span：`senderKind` 只能是
 * `"agent"`，`senderId` 用保留值 `sprout.lease-timeout`。
 *
 * UI 侧不 import 域层（`src/domain/lease-timeout.ts` 会经 db 把 sqlite 拖进浏览器包），
 * 所以这里重声明一次；`tests/p8b-timeout-ui.test.ts` 读域层源文本守住这条一致性。
 */
export const LEASE_TIMEOUT_SENDER_ID = "sprout.lease-timeout";

export const LEASE_TIMEOUT_SENDER_NAME = "挂靠超时提醒";

/**
 * 这条提醒是 T4 的落点：它是这个 Chat 里的一条普通消息。
 *
 * 界面**不**替它声明唤醒与否——那取决于 owner 是谁（域层的 `deliverOwnerReminder` 对 agent owner
 * 会直接唤醒），这句话域层只写进人类 owner 的正文里。界面再加一条，就是「界面说的事和系统
 * 真做的事不一致」，所以这里只负责把它渲染成一条消息。
 */
export function isLeaseTimeoutSender(senderKind: string, senderId: string): boolean {
  return senderKind === "agent" && senderId === LEASE_TIMEOUT_SENDER_ID;
}
