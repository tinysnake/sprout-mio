import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { ChatEmptyState } from "../../components/chat/chat-list";
import { DmStarter } from "../../components/chat/new-chat-dialog";
import type { ChatsLoaderData } from "../../components/chat/chat-loader";

/** 列表页的中栏：没有选中对话时给出选择提示与发起 DM 的入口。 */
export const Route = createFileRoute("/_authed/projects/$projectId/chats/")({
  component: ProjectChatsIndex,
});

function ProjectChatsIndex() {
  const { projectId } = Route.useParams();
  const loader = useLoaderData({ from: "/_authed/projects/$projectId/chats" }) as ChatsLoaderData;
  const members = loader.members.ok ? loader.members.data : [];
  const profiles = loader.profiles.ok ? loader.profiles.data : [];
  const hasChats = loader.chats.ok && loader.chats.data.length > 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-240 flex-col px-10 py-10 max-desktop:px-5 max-desktop:py-6">
        <header className="mb-6">
          <h1
            data-testid="chats-title"
            tabIndex={-1}
            className="text-2xl leading-8 font-semibold tracking-[-0.02em] outline-none"
          >
            对话
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            与 Project 内 Agent 成员的一对一 DM；同一成员始终对应同一条对话与同一个分身。
          </p>
        </header>
        {hasChats && (
          <ChatEmptyState
            title="选择一条 Chat"
            body="从左侧选择一条对话继续上下文，或从下面的 Agent 成员发起新的对话。"
          />
        )}
        <div className="mt-6 max-w-160">
          <DmStarter projectId={projectId} members={members} profiles={profiles} />
        </div>
      </div>
    </div>
  );
}
