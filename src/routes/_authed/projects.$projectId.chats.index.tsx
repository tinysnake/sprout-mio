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
      <div
        data-testid="chats-title"
        tabIndex={-1}
        className="mx-auto flex min-h-full w-full max-w-240 flex-col outline-none"
      >
        <ChatEmptyState
          title={hasChats ? "选择一条 Chat" : "发起新对话"}
          action={
            <div className="mt-3 w-full max-w-96 text-left">
              <DmStarter
                projectId={projectId}
                members={members}
                profiles={profiles}
                heading={false}
              />
            </div>
          }
        />
      </div>
    </div>
  );
}
