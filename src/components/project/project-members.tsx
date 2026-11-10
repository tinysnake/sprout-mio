import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Plus } from "lucide-react";
import type { AgentProfile, AgentResult, ProjectMember } from "../../contracts/agent";
import type {
  ProjectMemberRemovalBlockedError,
  ProjectMemberRemovalBlockers,
  ProjectMemberRemovalOutcome,
} from "../../contracts/project-member-removal";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Field } from "../ui/field";
import { Icon } from "../ui/icon";
import { Select } from "../ui/select";
import { ResultError } from "./result-error";
import { MemberRemovalBlockers } from "./member-removal-blockers";
import { MemberRemovalOutcome } from "./member-removal-outcome";

function initial(name: string) {
  return name.slice(0, 1);
}

/** 移除确认只需要身份与名称；profile 查询失败时也不会因此失去确认对象。 */
type RemoveTarget = Pick<AgentProfile, "id" | "name">;

/**
 * Project 成员呈现：Human 一行只读事实，Agent 行可打开 profile。
 * 成员集合由服务端事实决定，写入结果只通过调用方刷新，不在本地推断成功。
 */
export function ProjectMembers({
  members,
  profiles,
  humanName,
  add,
  remove,
  forceRemove,
  onChanged,
}: {
  members: ProjectMember[];
  profiles: AgentProfile[];
  humanName: string;
  add: (agentProfileId: string) => Promise<AgentResult<ProjectMember>>;
  remove: (agentProfileId: string) => Promise<AgentResult<null>>;
  /** 常规移除被阻塞后的强制通道：一次确认，善后结果由服务端返回，页面不推断。 */
  forceRemove: (agentProfileId: string) => Promise<AgentResult<ProjectMemberRemovalOutcome>>;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState("");
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<AppError | null>(null);
  // 善后结果连同产生它的阻塞快照一起留住：结果面板需要它们解释「未处理的租约」。
  const [outcome, setOutcome] = useState<{
    result: ProjectMemberRemovalOutcome;
    blockers: ProjectMemberRemovalBlockers | null;
  } | null>(null);
  // 阻塞快照独立于当前 error 存活：强制移除再次失败时，前置说明与一次确认入口不能消失。
  const [blockedError, setBlockedError] = useState<ProjectMemberRemovalBlockedError | null>(null);

  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const memberIds = new Set(members.map((member) => member.agentProfileId));
  const candidates = profiles.filter((profile) => !memberIds.has(profile.id));
  const chosen = candidates.some((profile) => profile.id === selected)
    ? selected
    : (candidates[0]?.id ?? "");

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !chosen) return;
    setPending(true);
    setError(null);
    setFeedback("");
    try {
      const result = await add(chosen);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAdding(false);
      setFeedback("Agent 已添加到 Project。");
      onChanged();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  async function handleRemove() {
    if (pending || !removing) return;
    setPending(true);
    setError(null);
    setFeedback("");
    try {
      const result = await remove(removing.id);
      if (!result.ok) {
        setError(result.error);
        setBlockedError(
          result.error.code === "project_member_removal_blocked" ? result.error : null,
        );
        return;
      }
      setRemoving(null);
      setFeedback("Agent 已从 Project 移除。");
      onChanged();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  /**
   * 强制移除：只把已拿到的服务端阻塞事实当作展示快照，不做任何可用性判断；
   * 结果、租约去向与未处理占用全部以服务端返回为准。
   */
  async function handleForceRemove() {
    if (pending || !removing) return;
    // 阻塞快照已经在本地；请求期间保留它，确认框不会在提交中退回普通态。
    const blocked = blockedError;
    setPending(true);
    setError(null);
    setFeedback("");
    try {
      const result = await forceRemove(removing.id);
      if (!result.ok) {
        setError(result.error);
        if (result.error.code === "project_member_removal_blocked") setBlockedError(result.error);
        return;
      }
      setRemoving(null);
      setError(null);
      setBlockedError(null);
      setOutcome({ result: result.data, blockers: blocked?.details ?? null });
      onChanged();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  const blocked = blockedError;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <p data-testid="members-count" className="text-xs text-muted-foreground">
          {members.length} 位 Agent · 1 位 Human
        </p>
        {/* 没有可添加的 profile 时不显示入口，避免一个点了也无事可做的按钮。 */}
        {candidates.length > 0 && (
          <Button
            type="button"
            variant="secondary"
            data-testid="add-member-trigger"
            onClick={() => {
              setError(null);
              setFeedback("");
              setAdding(true);
            }}
          >
            <Icon as={Plus} />
            添加 Agent 成员
          </Button>
        )}
      </div>

      {feedback && (
        <p
          role="status"
          data-testid="members-feedback"
          className="mt-4 text-xs text-muted-foreground"
        >
          {feedback}
        </p>
      )}
      {/* 移除失败的错误在确认框内呈现，列表上方只在没有确认框时显示，避免重复诊断节点。 */}
      {error && !removing && (
        <div className="mt-4">
          <ResultError error={error} testId="members-error" />
        </div>
      )}

      {outcome && (
        <MemberRemovalOutcome
          outcome={outcome.result}
          blockers={outcome.blockers}
          agentName={byId.get(outcome.result.agentProfileId)?.name ?? outcome.result.agentProfileId}
          onDismiss={() => setOutcome(null)}
        />
      )}

      <ul data-testid="member-list" className="mt-5">
        <li className="flex flex-wrap items-start gap-3.5 border-t border-border py-5 last:border-b">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-medium">
            {initial(humanName)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <strong data-testid="member-human-name" className="text-sm font-medium">
                {humanName}
              </strong>
              <span className="text-[0.6875rem] text-muted-foreground">Human</span>
            </div>
            <p className="mt-1.5 text-xs leading-6 text-muted-foreground">
              Project 所有者 · 管理项目设置与协作成员
            </p>
          </div>
          <div className="flex shrink-0 items-center text-xs max-desktop:w-full max-desktop:justify-end max-desktop:pl-11.5">
            <span className="text-muted-foreground">当前账号 · 只读</span>
          </div>
        </li>

        {members.map((member) => {
          const profile = byId.get(member.agentProfileId);
          return (
            <li
              key={member.agentProfileId}
              data-testid="member-item"
              data-agent-profile-id={member.agentProfileId}
              className="flex flex-wrap items-start gap-3.5 border-t border-border py-5 last:border-b hover:bg-hover"
            >
              <Link
                to="/agents/$agentProfileId"
                params={{ agentProfileId: member.agentProfileId }}
                className="flex min-w-0 flex-1 items-start gap-3.5"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-medium">
                  {initial(profile?.name ?? member.agentProfileId)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <strong data-testid="member-item-name" className="text-sm font-medium">
                      {profile?.name ?? member.agentProfileId}
                    </strong>
                    <span className="text-[0.6875rem] text-muted-foreground">Agent</span>
                  </span>
                  <span className="mt-1.5 block text-xs leading-6 text-muted-foreground">
                    {profile?.persona || "（无人设）"}
                  </span>
                </span>
                <Icon as={ChevronRight} className="mt-1.5 text-muted-foreground" />
              </Link>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-2 text-xs max-desktop:w-full max-desktop:pl-11.5">
                {profile?.jobTitle && (
                  <span className="text-muted-foreground">{profile.jobTitle}</span>
                )}
                <span className="text-muted-foreground">
                  <time dateTime={member.addedAt} title={member.addedAt} suppressHydrationWarning>
                    加入于 {new Date(member.addedAt).toLocaleDateString("zh-CN")}
                  </time>
                </span>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  data-testid="member-remove"
                  data-agent-profile-id={member.agentProfileId}
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    setFeedback("");
                    setOutcome(null);
                    setBlockedError(null);
                    setRemoving({
                      id: member.agentProfileId,
                      name: profile?.name ?? member.agentProfileId,
                    });
                  }}
                >
                  移除
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {members.length === 0 && (
        <p data-testid="members-empty" className="mt-4 text-xs text-muted-foreground">
          这个 Project 还没有 Agent 成员，添加一个 Agent 开始协作。
        </p>
      )}

      <Dialog
        open={adding}
        onOpenChange={(next) => {
          if (!next && !pending) setAdding(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加 Agent 成员</DialogTitle>
            <DialogDescription>选择要加入当前 Project 的 Agent profile。</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAdd} aria-busy={pending} className="space-y-4">
            <Field label="Agent profile" htmlFor="add-member-select">
              <Select
                id="add-member-select"
                data-testid="add-member-select"
                value={chosen}
                disabled={pending}
                onChange={(event) => setSelected(event.target.value)}
              >
                {candidates.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </Select>
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                data-testid="cancel-add-member"
                onClick={() => setAdding(false)}
              >
                取消
              </Button>
              <Button type="submit" data-testid="add-member-submit" loading={pending}>
                {pending ? "正在加入…" : "加入"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next && !pending) {
            setRemoving(null);
            setBlockedError(null);
          }
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{blocked ? "无法直接移除 Agent" : "确认移除 Agent？"}</DialogTitle>
            <DialogDescription>
              {blocked ? (
                <>
                  「{removing?.name ?? ""}
                  」仍有未结责任，常规移除被下列事项阻塞。你可以先逐项处理，也可以
                  一次确认强制移除：强制移除会自动中止运行、尝试收回租约、把 Chat
                  负责人转接给你，并把 Task 退回
                  proposed；无法确认撤销的租约保留为占用待处理，不会显示为空闲。
                </>
              ) : (
                <>
                  确认把「{removing?.name ?? ""}」移出这个 Project？移除后，该 Agent 不再是当前
                  Project 成员；其全局 profile 仍保留。
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {error && error.code !== "project_member_removal_blocked" && (
            <ResultError error={error} testId="members-error" />
          )}
          {/* 阻塞不是意外失败：用安静的事实说明代替红色告警，避免与标题、阻止清单重复。 */}
          {blockedError && (
            <p
              data-testid="members-blocked-note"
              className="rounded-lg border border-border-soft bg-secondary px-4 py-3 text-xs text-muted-foreground"
            >
              {blockedError.message}
              <span className="ml-2 font-mono opacity-80">{blockedError.code}</span>
            </p>
          )}
          {blocked && <MemberRemovalBlockers details={blocked.details} mode="force" />}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              data-testid="cancel-member-mutation"
              onClick={() => {
                setRemoving(null);
                setBlockedError(null);
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              loading={pending && !blocked}
              data-testid="confirm-member-mutation"
              onClick={() => void handleRemove()}
            >
              {pending && !blocked ? "正在提交…" : "确认移除"}
            </Button>
            {blocked && (
              <Button
                type="button"
                variant="secondary"
                loading={pending}
                data-testid="force-remove-member"
                onClick={() => void handleForceRemove()}
              >
                {pending ? "正在强制移除…" : "强制移除并自动善后"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
