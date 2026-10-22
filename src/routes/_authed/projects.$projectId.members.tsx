import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AgentMembers } from "../../components/project/agent-members";
import { ResultError } from "../../components/project/result-error";
import { listAgentProfilesFn, listProjectMembersFn } from "../../server/functions/agent";

export const Route = createFileRoute("/_authed/projects/$projectId/members")({
  loader: async ({ params }) => {
    const [members, profiles] = await Promise.all([
      listProjectMembersFn({ data: { projectId: params.projectId } }),
      listAgentProfilesFn(),
    ]);
    return { members, profiles };
  },
  component: ProjectAgentsPage,
});

/** 成员集合与可添加的 profile 集合在同一个 loader 里取齐，写操作后整体刷新。 */
function ProjectAgentsPage() {
  const { members, profiles } = Route.useLoaderData();
  const { projectId } = Route.useParams();
  const router = useRouter();

  return (
    <section className="space-y-6">
      <h2 className="text-xl font-semibold">Agent 成员</h2>
      {!profiles.ok && <ResultError error={profiles.error} testId="profiles-error" />}
      {!members.ok ? (
        <ResultError error={members.error} testId="members-load-error" />
      ) : (
        profiles.ok && (
          <AgentMembers
            projectId={projectId}
            members={members.data}
            profiles={profiles.data}
            onChanged={() => void router.invalidate()}
          />
        )
      )}
    </section>
  );
}
