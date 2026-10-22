import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { AgentProfile, ProjectMember } from "../../contracts/agent";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { createDirectChatFn } from "../../server/functions/chat";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Icon } from "../ui/icon";
import { ResultError } from "../project/result-error";

/**
 * 发起 DM：成员集合来自 Project，创建走 createDirectChat 的幂等语义，
 * 已有对话时直接进入既有对话而不是新建一条。
 */
export function DmStarter({
  projectId,
  members,
  profiles,
  heading = true,
  onStarted,
}: {
  projectId: string;
  members: ProjectMember[];
  profiles: AgentProfile[];
  heading?: boolean;
  /** 创建成功、即将导航时调用；嵌套在弹层里时用它关闭弹层。 */
  onStarted?: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const names = new Map(profiles.map((profile) => [profile.id, profile.name]));

  async function start(agentProfileId: string) {
    if (pending) return;
    setPending(agentProfileId);
    setError(null);
    try {
      const result = await createDirectChatFn({ data: { projectId, agentProfileId } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await router.invalidate({ sync: true });
      onStarted?.();
      await router.navigate({
        to: "/projects/$projectId/chats/$chatId",
        params: { projectId, chatId: result.data.chat.id },
      });
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="space-y-3">
      {heading && <h3 className="text-xs font-medium text-muted-foreground">发起新对话</h3>}
      {error && <ResultError error={error} testId="dm-start-error" />}
      {members.length === 0 ? (
        <p data-testid="dm-no-members" className="text-xs leading-6 text-muted-foreground">
          这个 Project 还没有 Agent 成员，先到 Members 页添加。
        </p>
      ) : (
        <ul data-testid="dm-member-list" className="divide-y divide-border rounded-lg border">
          {members.map((member) => (
            <li
              key={member.agentProfileId}
              data-testid="dm-member-item"
              data-agent-profile-id={member.agentProfileId}
              className="flex items-center justify-between gap-3 px-3 py-2.5"
            >
              <span data-testid="dm-member-name" className="min-w-0 truncate text-xs font-medium">
                {names.get(member.agentProfileId) ?? member.agentProfileId}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="dm-start"
                data-agent-profile-id={member.agentProfileId}
                disabled={pending !== null}
                loading={pending === member.agentProfileId}
                onClick={() => void start(member.agentProfileId)}
              >
                发起对话
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 新建 DM 的入口。触发按钮按设计放在列表搜索栏右侧，弹层里复用同一份
 * DmStarter，因此演示与真实页面没有第二套成员列表。
 */
export function NewChatDialog({
  projectId,
  members,
  profiles,
}: {
  projectId: string;
  members: ProjectMember[];
  profiles: AgentProfile[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        data-testid="new-chat"
        aria-label="新建 Chat"
        title="新建 Chat"
        className="-mr-px flex w-8.5 shrink-0 items-center justify-center self-stretch rounded-r-control border-l border-border text-foreground hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring max-desktop:min-h-11 max-desktop:min-w-11 max-desktop:self-center"
      >
        <Icon as={Plus} />
      </DialogTrigger>
      <DialogContent data-testid="new-chat-dialog">
        <DialogHeader>
          <DialogTitle>新建对话</DialogTitle>
          <DialogDescription>
            在当前 Project 中选择协作分身。同一成员始终对应同一条 DM 与同一个分身。
          </DialogDescription>
        </DialogHeader>
        <DmStarter
          projectId={projectId}
          members={members}
          profiles={profiles}
          heading={false}
          onStarted={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
