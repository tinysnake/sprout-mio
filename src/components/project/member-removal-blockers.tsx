import { Link } from "@tanstack/react-router";
import type {
  ProjectMemberRemovalBlockers,
  ProjectMemberRemovalChatRef,
} from "../../contracts/project-member-removal";

function ChatLink({ projectId, chat }: { projectId: string; chat: ProjectMemberRemovalChatRef }) {
  return (
    <Link
      to="/projects/$projectId/chats/$chatId"
      params={{ projectId, chatId: chat.chatId }}
      className="underline underline-offset-3"
    >
      {chat.title || chat.chatId}
    </Link>
  );
}

export function MemberRemovalBlockers({ details }: { details: ProjectMemberRemovalBlockers }) {
  return (
    <div
      data-testid="member-removal-blockers"
      className="min-w-0 space-y-4 text-xs leading-6 break-words"
    >
      <p>先处理以下事项，再重试移除。</p>
      {details.blockers.map((blocker) => (
        <section key={blocker.kind} data-testid={`member-blocker-${blocker.kind}`}>
          {blocker.kind === "active_runs" && (
            <>
              <h3 className="font-medium">活动运行</h3>
              <ul className="space-y-3">
                {blocker.items.map((item) => (
                  <li key={item.runId}>
                    <ChatLink projectId={details.projectId} chat={item.chat} />
                    <p className="break-all">
                      Run {item.runId} · {item.status} · 分身 {item.instanceId}
                    </p>
                    <p className="text-muted-foreground">先在该 Chat 停掉运行。</p>
                  </li>
                ))}
              </ul>
            </>
          )}
          {blocker.kind === "leases" && (
            <>
              <h3 className="font-medium">Machine 租约</h3>
              <ul className="space-y-3">
                {blocker.items.map((item) => (
                  <li key={item.key.machineId}>
                    <Link
                      to="/machines/$machineId/lease"
                      params={{ machineId: item.key.machineId }}
                      search={{ projectId: item.key.projectId }}
                      className="underline underline-offset-3"
                    >
                      {item.machineName}
                    </Link>
                    <p className="break-all">
                      {item.key.machineId} · generation {item.generation} · {item.state} · relation=
                      {item.relation}
                    </p>
                    <p className="break-all">
                      持有分身 {item.holderInstanceId}
                      {item.pendingMutationId ? ` · 待决变更 ${item.pendingMutationId}` : ""}
                    </p>
                    <p className="text-muted-foreground">
                      {item.relation === "handoff_target"
                        ? "先在该 Machine 处理指向此 Agent 的待决交接，再释放其租约。"
                        : "先在该 Machine 释放租约，并等待待决变更完成。"}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
          {blocker.kind === "owner_duties" && (
            <>
              <h3 className="font-medium">Chat 负责人职责</h3>
              <ul className="space-y-3">
                {blocker.items.map((item) => (
                  <li key={item.chat.chatId}>
                    <ChatLink projectId={details.projectId} chat={item.chat} />
                    <p className="break-all">
                      {item.chat.chatKind} · {item.chat.chatId}
                    </p>
                    <p className="text-muted-foreground">先在该 Chat 变更负责人。</p>
                  </li>
                ))}
              </ul>
            </>
          )}
          {blocker.kind === "dm_assigned_tasks" && (
            <>
              <h3 className="font-medium">DM 已分配 Task</h3>
              <ul className="space-y-3">
                {blocker.items.map((item) => (
                  <li key={item.taskId}>
                    <Link
                      to="/projects/$projectId/tasks/$taskId"
                      params={{ projectId: details.projectId, taskId: item.taskId }}
                      className="underline underline-offset-3"
                    >
                      {item.title}
                    </Link>
                    <p className="break-all">
                      {item.taskId} · {item.status}
                    </p>
                    <p>
                      DM：
                      <ChatLink projectId={details.projectId} chat={item.chat} />
                    </p>
                    <p className="text-muted-foreground">先在该 Task 改派、完成或取消任务。</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
    </div>
  );
}
