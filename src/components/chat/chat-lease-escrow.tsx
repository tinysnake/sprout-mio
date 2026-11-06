import { useRouter } from "@tanstack/react-router";
import { ChatLeaseEscrowPanel, type ChatLeaseEscrowPanelProps } from "../machine/lease-escrow";
import {
  requestLeaseEscrowCommand,
  type LeaseEscrowHandler,
} from "../machine/lease-escrow-command";

/** 演示场景需要不带 RPC 的呈现层，避免再搭一遍 props。 */
export { ChatLeaseEscrowPanel };

/**
 * Chat 页里的真实接线：领取与撤销都由本 Chat 的分身执行。
 * 领取者必须就是挂靠目标 Chat 的成员，撤销者是发起挂靠、仍在本 Chat 的分身，
 * 所以命令固定送进当前 Chat，不需要再选 Chat。
 */
export function ChatLeaseEscrowLive(props: Omit<ChatLeaseEscrowPanelProps, "handler">) {
  const router = useRouter();
  const handler: LeaseEscrowHandler = (input) =>
    requestLeaseEscrowCommand(input, props.chatId, () => router.invalidate());
  return <ChatLeaseEscrowPanel {...props} handler={handler} />;
}
