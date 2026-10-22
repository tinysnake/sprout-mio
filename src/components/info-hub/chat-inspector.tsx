import { Link } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, PanelRightClose, ShieldCheck } from "lucide-react";
import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { AgentInstance, Chat, ChatMember, ChatResult } from "../../contracts/chat";
import type { ChatInfoView, InfoHubResult, TurnStartContext } from "../../contracts/info-hub";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ResultError } from "../project/result-error";
import { ChatAvatar } from "../chat/chat-avatar";
import { ChatFactsBlock } from "./chat-info-panel";
import { RunFactsBlock, TurnStartContextBlock } from "./run-facts";

/**
 * Chat 的 Info Hub：摘要常显，运行事实与 Chat 事实按需展开。原有诊断字段
 * 只被折叠，不被删除；未实现的能力显式标出阶段，不用空值冒充。
 */
export function ChatInspector({
  chat,
  agentName,
  humanName,
  members,
  instances,
  profile,
  info,
  turnStart,
  onClose,
}: {
  chat: Chat;
  agentName: string;
  humanName: string;
  members: ChatResult<ChatMember[]>;
  instances: ChatResult<AgentInstance[]>;
  profile: AgentResult<AgentProfile> | null;
  info: ChatResult<ChatInfoView>;
  turnStart: InfoHubResult<TurnStartContext>;
  onClose: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-15.25 items-center gap-2 border-b border-border px-5 max-desktop:min-h-19 max-desktop:px-3 max-desktop:py-3.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="back-to-chat"
          aria-label="返回聊天"
          title="返回聊天"
          onClick={onClose}
          className="hidden max-desktop:inline-flex"
        >
          <Icon as={ArrowLeft} />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-[13px]">Info Hub</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="close-inspector"
          aria-label="收起 Info Hub 侧栏"
          title="收起 Info Hub 侧栏"
          onClick={onClose}
          className="max-desktop:hidden"
        >
          <Icon as={PanelRightClose} />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-6">
        <section className="border-b border-border py-5">
          <h3 className="mb-3.75 text-[10px] font-medium text-muted-foreground">分身上下文</h3>
          {!members.ok ? (
            <ResultError error={members.error} testId="chat-load-error" />
          ) : !instances.ok ? (
            <ResultError error={instances.error} testId="chat-load-error" />
          ) : (
            <div data-testid="chat-inspector-identity" className="space-y-2.5">
              {profile && !profile.ok && (
                <ResultError error={profile.error} testId="chat-profile-error" />
              )}
              <div className="flex items-center gap-2.5">
                <ChatAvatar name={agentName} />
                <div className="min-w-0 flex-1">
                  <strong className="block truncate text-xs font-semibold">{agentName}</strong>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {profile?.ok && profile.data.jobTitle ? profile.data.jobTitle : "未设置职位"}
                  </p>
                </div>
                {profile?.ok && (
                  <Link
                    to="/agents/$agentProfileId"
                    params={{ agentProfileId: profile.data.id }}
                    className="shrink-0 text-[10px] text-foreground underline decoration-input underline-offset-3 hover:decoration-foreground"
                  >
                    profile
                  </Link>
                )}
              </div>
              <p className="text-[11px] leading-6 break-words whitespace-pre-wrap">
                {profile?.ok ? profile.data.persona || "（空）" : ""}
              </p>
              <p className="text-[10px] leading-5 text-muted-foreground">
                profile 修改将在下一轮生效，当前轮与历史回复保留原上下文。
              </p>
              <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-y-1 text-[11px]">
                <dt className="text-muted-foreground">Chat ID</dt>
                <dd data-testid="chat-id" className="font-mono break-all">
                  {chat.id}
                </dd>
                <dt className="text-muted-foreground">分身 Instance ID</dt>
                <dd data-testid="chat-instance-id" className="font-mono break-all">
                  {instances.data[0]?.id ?? "（缺少分身记录）"}
                </dd>
                <dt className="text-muted-foreground">成员</dt>
                <dd data-testid="chat-member-list">
                  {members.data
                    .map((member) =>
                      member.memberKind === "human" ? humanName || "你" : agentName,
                    )
                    .join("、")}
                </dd>
              </dl>
            </div>
          )}
        </section>
        <section className="border-b border-border py-5">
          <h3 className="mb-3.75 text-[10px] font-medium text-muted-foreground">运行</h3>
          {!info.ok ? (
            <ResultError error={info.error} testId="info-hub-chat-error" />
          ) : !turnStart.ok ? (
            <ResultError error={turnStart.error} testId="info-hub-turn-context-error" />
          ) : (
            <details className="group" open>
              <summary className="flex min-h-9.5 cursor-pointer list-none items-center justify-between gap-2 text-[11px] hover:underline [&::-webkit-details-marker]:hidden">
                <span>运行事实与轮初上下文</span>
                <span className="flex items-center gap-2 text-muted-foreground">
                  <span>{info.data.runs.active.length} 个活动 run</span>
                  <Icon
                    as={ChevronRight}
                    size={12}
                    className="transition-transform group-open:rotate-90"
                  />
                </span>
              </summary>
              <div className="space-y-4 pt-2 pb-3">
                <RunFactsBlock runs={info.data.runs} testId="info-chat-runs" />
                <TurnStartContextBlock context={turnStart.data} />
              </div>
            </details>
          )}
        </section>
        <section className="border-b border-border py-5">
          <h3 className="mb-3.75 text-[10px] font-medium text-muted-foreground">关联信息</h3>
          {info.ok ? (
            <details className="group" open>
              <summary className="flex min-h-9.5 cursor-pointer list-none items-center justify-between gap-2 text-[11px] hover:underline [&::-webkit-details-marker]:hidden">
                <span>Chat 事实与成员</span>
                <Icon
                  as={ChevronRight}
                  size={12}
                  className="transition-transform group-open:rotate-90"
                />
              </summary>
              <div className="pt-2 pb-3">
                <ChatFactsBlock view={info.data} />
              </div>
            </details>
          ) : (
            <p className="text-[11px] text-muted-foreground">Chat 事实随上方错误一并不可用。</p>
          )}
          <div className="flex items-center justify-between gap-3 pt-3">
            <span className="text-[10px] text-muted-foreground">Machine / Worker</span>
            <span
              data-testid="chat-machines-notice"
              className="rounded-control border border-border px-1.75 py-0.75 text-[10px] text-muted-foreground"
            >
              未实现，P4
            </span>
          </div>
        </section>
        <p className="flex gap-2 pt-5 text-[10px] leading-5 text-muted-foreground">
          <Icon as={ShieldCheck} size={14} className="mt-0.5" />
          分析基于固定快照。分身可以读取仓库，本批不执行远端操作。
        </p>
      </div>
      <div className="border-t border-border px-5 py-3.5 text-[10px] text-muted-foreground max-desktop:pb-[max(14px,env(safe-area-inset-bottom))]">
        仅 Project 成员可见
      </div>
    </div>
  );
}
