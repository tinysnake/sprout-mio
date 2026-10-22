import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { AgentProfileList } from "../../components/agent/agent-profile-list";
import { CreateAgentDialog } from "../../components/agent/create-agent-dialog";
import { PageFrame } from "../../components/layout/page-frame";
import { ResultError } from "../../components/project/result-error";
import { listAgentProfilesFn } from "../../server/functions/agent";

export const Route = createFileRoute("/_authed/agents/")({
  loader: () => listAgentProfilesFn(),
  component: AgentsIndexPage,
});

/** 全局 Agent profile 列表只含当前用户创建的 profile。 */
function AgentsIndexPage() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const profiles = result.ok ? result.data : [];

  return (
    <PageFrame
      title="Agents"
      description="当前账号创建的 Agent profile。选择一个查看或修改人设。"
      back={<Link to="/projects">返回 Projects</Link>}
      actions={<CreateAgentDialog onCreated={() => void router.invalidate()} />}
      testId="agents-page"
    >
      {!result.ok && <ResultError error={result.error} testId="agents-error" />}
      {result.ok && profiles.length === 0 && (
        <p data-testid="agent-empty" className="text-xs text-muted-foreground">
          还没有 Agent profile，先创建一个。
        </p>
      )}
      {profiles.length > 0 && <AgentProfileList profiles={profiles} />}
      <p className="mt-4 text-xs leading-6 text-muted-foreground">
        职位是人设的展示标签；没有额外的权限含义。
      </p>
    </PageFrame>
  );
}
