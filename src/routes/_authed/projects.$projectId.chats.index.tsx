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
      <div className="mx-auto flex w-full max-w-240 flex-col px-12 py-10 max-desktop:px-5 max-desktop:py-6">
        <header className="mb-6">
          <h1
            data-testid="chats-title"
            tabIndex={-1}
            className="text-2xl leading-8 font-semibold tracking-[-0.02em] outline-none"
          >
            对话
          </h1>
        </header>
        {hasChats && (
          <ChatEmptyState title="选择一条 Chat" body="从左侧列表选择，或用下面的入口新建。" />
        )}
        <div className="mt-6 max-w-160">
          <DmStarter projectId={projectId} members={members} profiles={profiles} />
        </div>
      </div>
    </div>
  );
}
