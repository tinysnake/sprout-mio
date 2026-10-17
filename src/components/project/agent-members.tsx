import { useState } from "react";
import type { SubmitEvent } from "react";
import type { AgentProfile, ProjectMember } from "../../contracts/agent";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import { ResultError } from "./result-error";
import { addProjectMemberFn, removeProjectMemberFn } from "../../server/functions/agent";

/** 成员页把全局 profile 集合与 Project 成员集合对齐，两份列表都来自 server function。 */
export function AgentMembers({
  projectId,
  members,
  profiles,
  onChanged,
}: {
  projectId: string;
  members: ProjectMember[];
  profiles: AgentProfile[];
  onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const names = new Map(profiles.map((profile) => [profile.id, profile.name]));
  const memberIds = new Set(members.map((member) => member.agentProfileId));
  const available = profiles.filter((profile) => !memberIds.has(profile.id));

  async function add(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const agentProfileId = form.get("agentProfileId");
    if (typeof agentProfileId !== "string" || !agentProfileId) return;
    setPending(true);
    setError(null);
    try {
      const result = await addProjectMemberFn({ data: { projectId, agentProfileId } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onChanged();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  async function remove(profileId: string, name: string) {
    if (pending) return;
    if (!window.confirm(`确认把「${name}」移出这个 Project？`)) return;
    setPending(true);
    setError(null);
    try {
      const result = await removeProjectMemberFn({
        data: { projectId, agentProfileId: profileId },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onChanged();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="max-w-xl space-y-6">
      {error && <ResultError error={error} testId="members-error" />}
      <form onSubmit={add} aria-busy={pending} className="flex items-end gap-3">
        <label className="block flex-1 text-sm">
          添加 Agent 成员
          <select
            name="agentProfileId"
            data-testid="add-member-select"
            disabled={available.length === 0}
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2"
          >
            {available.length === 0 && <option value="">没有可添加的 Agent profile</option>}
            {available.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="submit"
          data-testid="add-member-submit"
          disabled={pending || available.length === 0}
        >
          加入
        </Button>
      </form>
      {members.length === 0 ? (
        <p data-testid="members-empty" className="text-muted-foreground">
          这个 Project 还没有 Agent 成员。
        </p>
      ) : (
        <ul data-testid="member-list" className="divide-y divide-border/60 rounded-lg border">
          {members.map((member) => {
            const name = names.get(member.agentProfileId) ?? member.agentProfileId;
            return (
              <li
                key={member.agentProfileId}
                data-testid="member-item"
                data-agent-profile-id={member.agentProfileId}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div>
                  <span data-testid="member-item-name" className="font-medium">
                    {name}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    加入于 {member.addedAt}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  data-testid="member-remove"
                  data-agent-profile-id={member.agentProfileId}
                  disabled={pending}
                  onClick={() => void remove(member.agentProfileId, name)}
                >
                  移除
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
