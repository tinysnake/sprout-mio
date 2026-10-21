import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { AgentProfile, ProjectMember } from "../../contracts/agent";
import type { Chat } from "../../contracts/chat";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { createDirectChatFn } from "../../server/functions/chat";
import { Button } from "../ui/button";
import { ResultError } from "../project/result-error";

type ChatAgent = { chatId: string; agentProfileId?: string };

/** 发起按钮走 createDirectChat 的幂等语义：已有 DM 时直接导航到既有对话。 */
export function ChatList({
  projectId,
  chats,
  chatAgents,
  members,
  profiles,
}: {
  projectId: string;
  chats: Chat[];
  chatAgents: ChatAgent[];
  members: ProjectMember[];
  profiles: AgentProfile[];
}) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const names = new Map(profiles.map((profile) => [profile.id, profile.name]));
  const agentsByChat = new Map(chatAgents.map((entry) => [entry.chatId, entry.agentProfileId]));

  async function start(agentProfileId: string) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await createDirectChatFn({
        data: { projectId, agentProfileId },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await navigate({
        to: "/projects/$projectId/chats/$chatId",
        params: { projectId, chatId: result.data.chat.id },
      });
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  const nameOf = (profileId?: string) =>
    profileId ? (names.get(profileId) ?? profileId) : "Agent";

  return (
    <div className="space-y-6">
      {error && <ResultError error={error} testId="dm-start-error" />}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">已有对话</h3>
        {chats.length === 0 ? (
          <p data-testid="chats-empty" className="text-sm text-muted-foreground">
            还没有对话。从下面的 Agent 成员里发起第一条。
          </p>
        ) : (
          <ul data-testid="chat-list" className="divide-y divide-border/60 rounded-lg border">
            {chats.map((chat) => {
              const agentProfileId = agentsByChat.get(chat.id);
              return (
                <li
                  key={chat.id}
                  data-testid="chat-item"
                  data-chat-id={chat.id}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div>
                    <span data-testid="chat-item-name" className="font-medium">
                      与 {nameOf(agentProfileId)} 的对话
                    </span>
                    <span
                      data-testid="chat-item-id"
                      className="mt-1 block font-mono text-xs break-all text-muted-foreground"
                    >
                      {chat.id}
                    </span>
                  </div>
                  <Button
                    type="button"
                    data-testid="chat-open"
                    data-chat-id={chat.id}
                    disabled={pending}
                    onClick={() =>
                      void navigate({
                        to: "/projects/$projectId/chats/$chatId",
                        params: { projectId, chatId: chat.id },
                      })
                    }
                  >
                    打开
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">发起新对话</h3>
        {members.length === 0 ? (
          <p data-testid="dm-no-members" className="text-sm text-muted-foreground">
            这个 Project 还没有 Agent 成员，先到「Agent 成员」页添加。
          </p>
        ) : (
          <ul data-testid="dm-member-list" className="divide-y divide-border/60 rounded-lg border">
            {members.map((member) => (
              <li
                key={member.agentProfileId}
                data-testid="dm-member-item"
                data-agent-profile-id={member.agentProfileId}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <span data-testid="dm-member-name" className="font-medium">
                  {names.get(member.agentProfileId) ?? member.agentProfileId}
                </span>
                <Button
                  type="button"
                  data-testid="dm-start"
                  data-agent-profile-id={member.agentProfileId}
                  disabled={pending}
                  onClick={() => void start(member.agentProfileId)}
                >
                  发起对话
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
