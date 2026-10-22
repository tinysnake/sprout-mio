import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { PageFrame } from "../../components/layout/page-frame";
import { ThemeToggle } from "../../components/layout/theme-toggle";
import { ProjectMembers } from "../../components/project/project-members";
import { ResultError } from "../../components/project/result-error";
import { Icon } from "../../components/ui/icon";
import {
  addProjectMemberFn,
  listAgentProfilesFn,
  listProjectMembersFn,
  removeProjectMemberFn,
} from "../../server/functions/agent";

export const Route = createFileRoute("/_authed/projects/$projectId/members")({
  loader: async ({ params, context }) => {
    const [members, profiles] = await Promise.all([
      listProjectMembersFn({ data: { projectId: params.projectId } }),
      listAgentProfilesFn(),
    ]);
    return { members, profiles, humanName: context.human?.name ?? "当前账号" };
  },
  component: ProjectMembersPage,
});

/** 成员集合与可添加的 profile 集合在同一个 loader 里取齐，写操作后整体刷新。 */
function ProjectMembersPage() {
  const { members, profiles, humanName } = Route.useLoaderData();
  const { projectId } = Route.useParams();
  const router = useRouter();

  return (
    <PageFrame
      title="Members"
      description="查看当前 Project 的 Human 与 Agent 成员，添加或移除 Agent。"
      back={
        <Link to="/projects/$projectId/chats" params={{ projectId }}>
          <Icon as={ArrowLeft} />
          返回 Chats
        </Link>
      }
      actions={<ThemeToggle />}
      testId="project-members-page"
    >
      {!members.ok && <ResultError error={members.error} testId="members-load-error" />}
      {!profiles.ok && <ResultError error={profiles.error} testId="profiles-error" />}
      {/*
        成员集合是页面主事实：profile 列表查询失败时仍然展示成员与移除入口，
        只是没有可添加的候选；成员行退回显示 profile ID。
      */}
      {members.ok && (
        <ProjectMembers
          members={members.data}
          profiles={profiles.ok ? profiles.data : []}
          humanName={humanName}
          add={(agentProfileId) => addProjectMemberFn({ data: { projectId, agentProfileId } })}
          remove={(agentProfileId) =>
            removeProjectMemberFn({ data: { projectId, agentProfileId } })
          }
          onChanged={() => void router.invalidate()}
        />
      )}
    </PageFrame>
  );
}
