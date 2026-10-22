import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { AgentEditForm } from "../../components/agent/agent-edit-form";
import { PageFrame } from "../../components/layout/page-frame";
import { ThemeToggle } from "../../components/layout/theme-toggle";
import { ResultError } from "../../components/project/result-error";
import { Facts, SettingsSection } from "../../components/project/settings-section";
import { getAgentProfileFn } from "../../server/functions/agent";

export const Route = createFileRoute("/_authed/agents/$agentProfileId")({
  loader: ({ params }) => getAgentProfileFn({ data: { agentProfileId: params.agentProfileId } }),
  component: AgentDetailPage,
});

/** 详情页深链直接刷新时由 loader 重新取数，URL 与 profile id 永远一致。 */
function AgentDetailPage() {
  const result = Route.useLoaderData();
  const router = useRouter();

  if (!result.ok)
    return (
      <PageFrame
        title="Agent profile 不存在"
        description="请返回列表选择已有 profile。"
        back={<Link to="/agents">返回 Agents</Link>}
        actions={<ThemeToggle />}
        testId="agent-detail-page"
      >
        <ResultError error={result.error} testId="agent-error" />
      </PageFrame>
    );

  const profile = result.data;
  return (
    <PageFrame
      title={<span data-testid="agent-detail-name">{profile.name}</span>}
      description={
        <>
          <span data-testid="agent-detail-job-title">{profile.jobTitle || "未设置职位"}</span>
          {" · Agent profile"}
        </>
      }
      back={<Link to="/agents">返回 Agents</Link>}
      actions={<ThemeToggle />}
      testId="agent-detail-page"
    >
      <SettingsSection
        title="Profile 信息"
        description="profile 的身份与宿主的 harness；修改人设不会重建分身，也不会改写历史对话。"
      >
        <Facts
          items={[
            {
              label: "Profile ID",
              testId: "agent-detail-id",
              value: <code className="font-mono text-[0.6875rem]">{profile.id}</code>,
            },
            { label: "harness", testId: "agent-detail-harness", value: profile.harness },
            {
              label: "创建时间",
              testId: "agent-detail-created-at",
              value: (
                <time
                  dateTime={profile.createdAt}
                  title={profile.createdAt}
                  suppressHydrationWarning
                >
                  {new Date(profile.createdAt).toLocaleString("zh-CN", { hour12: false })}
                </time>
              ),
            },
            {
              label: "最近修改",
              testId: "agent-detail-updated-at",
              value: (
                <time
                  dateTime={profile.updatedAt}
                  title={profile.updatedAt}
                  suppressHydrationWarning
                >
                  {new Date(profile.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                </time>
              ),
            },
          ]}
        />
      </SettingsSection>
      <AgentEditForm profile={profile} onSaved={() => void router.invalidate()} />
    </PageFrame>
  );
}
