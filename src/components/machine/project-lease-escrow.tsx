import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import type { Chat } from "../../contracts/chat";
import type { LeaseView } from "../../contracts/lease";
import type { AppError } from "../../contracts/result";
import { listChatsFn } from "../../server/functions/chat";
import { ResultError } from "../project/result-error";
import { LeaseEscrowEntry } from "./lease-escrow";
import { requestLeaseEscrowCommand, type LeaseEscrowHandler } from "./lease-escrow-command";

/**
 * Machine 租约页里的真实接线：Chat 列表来自服务端读模型，命令送进持有者分身所在的 Chat。
 * 目标列表只列本 Project 的 Group 与 Public Channel（DM 不是合法挂靠目标）。
 */
export function ProjectLeaseEscrow({
  projectId,
  lease,
  agents = [],
  holderChatId,
  holderChatName = null,
  testId = "project-lease-escrow",
}: {
  projectId: string;
  lease: LeaseView;
  agents?: readonly { agentProfileId: string; name: string; chatId?: string | null }[];
  holderChatId: string | null;
  holderChatName?: string | null;
  testId?: string;
}) {
  const router = useRouter();
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  useEffect(() => {
    let alive = true;
    void listChatsFn({ data: { projectId } }).then((result) => {
      if (!alive) return;
      if (result.ok) {
        setChats(result.data);
        setError(null);
      } else {
        setChats([]);
        setError(result.error);
      }
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  // 挂靠与撤销都由持有者分身执行，所以命令固定送进它所在的 Chat。
  const handler: LeaseEscrowHandler = (input) =>
    requestLeaseEscrowCommand(input, holderChatId ?? "", () => router.invalidate());

  if (error) return <ResultError error={error} testId={`${testId}-error`} />;
  if (!chats)
    return (
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-loading`}>
        读取 Project 的 Chat…
      </p>
    );
  return (
    <LeaseEscrowEntry
      projectId={projectId}
      lease={lease}
      chats={chats}
      agents={agents}
      holderChatId={holderChatId}
      holderChatName={holderChatName}
      handler={handler}
      testId={testId}
    />
  );
}
