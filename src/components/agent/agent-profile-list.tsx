import { ChevronRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { AgentProfile } from "../../contracts/agent";
import { Icon } from "../ui/icon";

function initial(name: string) {
  return name.slice(0, 1);
}

/**
 * Agent profile 列表：身份、职位与人设摘要。职位只是分工展示，没有权限语义，
 * 因此用与正文同色的行内文字，不做徽标。整行是 profile 的链接。
 */
export function AgentProfileList({ profiles }: { profiles: AgentProfile[] }) {
  return (
    <ul
      data-testid="agent-list"
      className="divide-y divide-border overflow-hidden rounded-container border border-border"
    >
      {profiles.map((profile) => (
        <li key={profile.id} data-testid="agent-item" data-agent-profile-id={profile.id}>
          <Link
            to="/agents/$agentProfileId"
            params={{ agentProfileId: profile.id }}
            className="flex min-h-22 items-center gap-3.5 px-5 py-5 hover:bg-hover max-desktop:gap-2.5 max-desktop:px-3 max-desktop:py-4"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-medium">
              {initial(profile.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-3">
                <span data-testid="agent-item-name" className="text-sm font-medium">
                  {profile.name}
                </span>
                {profile.jobTitle && (
                  <span
                    data-testid="agent-item-job-title"
                    className="text-xs text-muted-foreground max-desktop:basis-full"
                  >
                    {profile.jobTitle}
                  </span>
                )}
              </span>
              <span className="mt-1.5 block text-xs leading-6 text-muted-foreground">
                {profile.persona || "（无人设）"}
              </span>
            </span>
            <Icon as={ChevronRight} className="text-muted-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
