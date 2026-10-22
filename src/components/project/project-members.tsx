import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Plus } from "lucide-react";
import type { AgentProfile, AgentResult, ProjectMember } from "../../contracts/agent";
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
  onChanged,
}: {
  members: ProjectMember[];
  profiles: AgentProfile[];
  humanName: string;
  add: (agentProfileId: string) => Promise<AgentResult<ProjectMember>>;
  remove: (agentProfileId: string) => Promise<AgentResult<null>>;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState("");
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<AppError | null>(null);

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

  return (
    <div className="max-w-[40rem]">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 max-desktop:flex-col max-desktop:items-stretch">
        <p data-testid="members-count" className="text-xs text-muted-foreground">
          {members.length} 位 Agent · 1 位 Human
        </p>
        <form
          onSubmit={handleAdd}
          aria-busy={pending}
          className="flex items-end gap-2.5 max-desktop:flex-col max-desktop:items-stretch"
        >
          <Field
            label="添加 Agent 成员"
            htmlFor="add-member-select"
            className="w-56 max-desktop:w-full"
          >
            <Select
              id="add-member-select"
              data-testid="add-member-select"
              value={chosen}
              disabled={pending || candidates.length === 0}
              onChange={(event) => setSelected(event.target.value)}
            >
              {candidates.length === 0 && <option value="">没有可添加的 Agent profile</option>}
              {candidates.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            type="submit"
            data-testid="add-member-submit"
            loading={pending}
            disabled={candidates.length === 0}
          >
            <Icon as={Plus} />
            加入
          </Button>
        </form>
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
          <div className="flex shrink-0 flex-col items-end gap-1.5 text-xs max-desktop:w-full max-desktop:flex-row max-desktop:justify-end max-desktop:pl-11.5">
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
              <div className="flex shrink-0 flex-col items-end gap-2 text-xs max-desktop:w-full max-desktop:flex-row max-desktop:items-center max-desktop:justify-end max-desktop:pl-11.5">
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
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next && !pending) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认移除 Agent？</DialogTitle>
            <DialogDescription>
              确认把「{removing?.name ?? ""}」移出这个 Project？移除后，该 Agent 不再是当前 Project
              成员；其全局 profile 仍保留。
            </DialogDescription>
          </DialogHeader>
          {error && <ResultError error={error} testId="members-error" />}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              data-testid="cancel-member-mutation"
              onClick={() => setRemoving(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={pending}
              data-testid="confirm-member-mutation"
              onClick={() => void handleRemove()}
            >
              {pending ? "正在提交…" : "确认移除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
