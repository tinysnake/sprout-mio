import type { AgentProfile } from "../../contracts/agent";
import { updateAgentProfileFn } from "../../server/functions/agent";
import { AgentProfileEditor } from "./agent-profile-editor";

/** 编辑走 updateAgentProfile，不改 id 也不重建分身。 */
export function AgentEditForm({
  profile,
  onSaved,
}: {
  profile: AgentProfile;
  onSaved: () => void;
}) {
  return (
    <AgentProfileEditor
      // 路由复用同一层组件时，profile 身份变化必须重建编辑状态。
      key={profile.id}
      profile={profile}
      onSaved={onSaved}
      submit={(draft) =>
        updateAgentProfileFn({
          data: {
            agentProfileId: profile.id,
            name: draft.name,
            jobTitle: draft.jobTitle.trim() || null,
            persona: draft.persona,
            model: draft.model.trim() || null,
            effort: draft.effort.trim() || null,
          },
        })
      }
    />
  );
}
