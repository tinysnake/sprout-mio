import { useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { AgentProfile, ProjectMember } from "../../contracts/agent";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { createDirectChatFn, createGroupChatFn } from "../../server/functions/chat";
import type { ChatWakePolicy } from "../../contracts/chat";
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
import { ChatErrorNotice } from "./chat-error-notice";

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
      {error && <ChatErrorNotice error={error} testId="dm-start-error" />}
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

/** 群创建表单：默认 Human 创建者 owner，wake policy 默认 owner_led。 */
function GroupCreateForm({
  projectId,
  members,
  profiles,
  humanUserId,
  humanName,
  onCreated,
}: {
  projectId: string;
  members: ProjectMember[];
  profiles: AgentProfile[];
  humanUserId: string;
  humanName: string;
  onCreated: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [wakePolicy, setWakePolicy] = useState<ChatWakePolicy>("owner_led");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  // 名称为空是本地校验：不发请求，也不让 domain 用「未命名」替名字。
  const [titleError, setTitleError] = useState<string | null>(null);
  const names = new Map(profiles.map((profile) => [profile.id, profile.name]));

  function toggle(agentProfileId: string) {
    setSelected((current) =>
      current.includes(agentProfileId)
        ? current.filter((id) => id !== agentProfileId)
        : [...current, agentProfileId],
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const titleMessage = title.trim().length === 0 ? "群名称不能为空，请输入后再创建。" : null;
    setTitleError(titleMessage);
    if (selected.length === 0) {
      setError({
        code: "validation_failed",
        message: "至少选择 1 位 Agent。",
        requestId: newId(ID_PREFIXES.request),
      });
      return;
    }
    if (titleMessage) return;
    setPending(true);
    setError(null);
    try {
      const result = await createGroupChatFn({
        data: {
          projectId,
          ...(title.trim() ? { title: title.trim() } : {}),
          members: [
            { kind: "human", id: humanUserId },
            ...selected.map((id) => ({ kind: "agent" as const, id })),
          ],
          initialOwner: { kind: "human", id: humanUserId },
          wakePolicy,
        },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await router.invalidate({ sync: true });
      onCreated();
      await router.navigate({
        to: "/projects/$projectId/chats/$chatId",
        params: { projectId, chatId: result.data.id },
      });
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="group-create-form">
      <div>
        <label htmlFor="group-title" className="mb-1.5 block text-xs font-medium">
          群名称
        </label>
        <input
          id="group-title"
          data-testid="group-title-input"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            if (titleError) setTitleError(null);
          }}
          maxLength={80}
          placeholder="例如：发布协作"
          aria-invalid={titleError ? true : undefined}
          aria-describedby={titleError ? "group-title-error" : undefined}
          className="min-h-8.5 w-full rounded-control border border-input bg-background px-2.5 text-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive max-desktop:min-h-11"
        />
        {titleError && (
          <p
            id="group-title-error"
            data-testid="group-title-error"
            role="alert"
            className="mt-1.5 text-xs leading-6 text-destructive"
          >
            {titleError}
          </p>
        )}
      </div>
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium">成员</legend>
        <p className="mb-2 text-[10px] leading-5 text-muted-foreground">
          当前 Human：{humanName || "你"}（创建者，默认 Owner）。至少选择 1 位 Agent。
        </p>
        {members.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Project 还没有 Agent 成员。</p>
        ) : (
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-control border border-border p-2">
            {members.map((member) => {
              const name = names.get(member.agentProfileId) ?? member.agentProfileId;
              return (
                <li key={member.agentProfileId}>
                  <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded px-1.5 text-xs hover:bg-hover max-desktop:min-h-11">
                    <input
                      type="checkbox"
                      data-testid="group-member-checkbox"
                      data-agent-profile-id={member.agentProfileId}
                      checked={selected.includes(member.agentProfileId)}
                      onChange={() => toggle(member.agentProfileId)}
                      className="size-3.5 accent-primary"
                    />
                    <span className="min-w-0 truncate">{name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>
      <div>
        <label htmlFor="group-wake-policy" className="mb-1.5 block text-xs font-medium">
          唤醒策略
        </label>
        <select
          id="group-wake-policy"
          data-testid="group-wake-policy"
          value={wakePolicy}
          onChange={(event) => setWakePolicy(event.target.value as ChatWakePolicy)}
          className="min-h-8.5 w-full rounded-control border border-input bg-background px-2.5 text-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-desktop:min-h-11"
        >
          <option value="owner_led">owner_led（默认）</option>
          <option value="mention_only">mention_only</option>
          <option value="contextual">contextual（P5a 按 owner_led 回退）</option>
        </select>
        <p className="mt-1.5 text-[10px] leading-5 text-muted-foreground">
          初始 Owner 是 Human 创建者：没有点名时不会唤醒 Agent；Agent owner 不获得治理权。
        </p>
      </div>
      <p data-testid="group-owner-default" className="text-[10px] text-muted-foreground">
        Owner：{humanName || "你"}（Human）
      </p>
      {error && <ChatErrorNotice error={error} testId="group-error" />}
      <div className="flex justify-end gap-2">
        <Button type="submit" data-testid="group-submit" loading={pending}>
          创建群组
        </Button>
      </div>
    </form>
  );
}

/**
 * 新建对话入口：DM 与群组共用同一个弹层。触发按钮按设计放在列表搜索栏右侧，
 * DM 复用 DmStarter，群组表单直接调用已冻结的 createGroupChatFn。
 */
export function NewChatDialog({
  projectId,
  members,
  profiles,
  humanUserId,
  humanName,
}: {
  projectId: string;
  members: ProjectMember[];
  profiles: AgentProfile[];
  humanUserId: string;
  humanName: string;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"dm" | "group">("dm");
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
            在当前 Project 中发起 DM，或创建一个由 Human 担任 Owner 的群组。
          </DialogDescription>
        </DialogHeader>
        <div role="tablist" aria-label="对话类型" className="flex gap-1 border-b border-border">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "dm"}
            data-testid="new-chat-mode-dm"
            onClick={() => setMode("dm")}
            className={
              mode === "dm"
                ? "border-b-2 border-foreground px-3 py-2 text-xs"
                : "border-b-2 border-transparent px-3 py-2 text-xs text-muted-foreground"
            }
          >
            DM
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "group"}
            data-testid="new-chat-mode-group"
            onClick={() => setMode("group")}
            className={
              mode === "group"
                ? "border-b-2 border-foreground px-3 py-2 text-xs"
                : "border-b-2 border-transparent px-3 py-2 text-xs text-muted-foreground"
            }
          >
            群组
          </button>
        </div>
        {mode === "dm" ? (
          <DmStarter
            projectId={projectId}
            members={members}
            profiles={profiles}
            heading={false}
            onStarted={() => setOpen(false)}
          />
        ) : (
          <GroupCreateForm
            projectId={projectId}
            members={members}
            profiles={profiles}
            humanUserId={humanUserId}
            humanName={humanName}
            onCreated={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
