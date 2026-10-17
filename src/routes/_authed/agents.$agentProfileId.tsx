import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { AgentEditForm } from "../../components/agent/agent-edit-form";
import { ResultError } from "../../components/project/result-error";
import { getAgentProfileFn } from "../../server/functions/agent";

export const Route = createFileRoute("/_authed/agents/$agentProfileId")({
  loader: ({ params }) => getAgentProfileFn({ data: { agentProfileId: params.agentProfileId } }),
  component: AgentDetailPage,
});

/** 详情页深链直接刷新时由 loader 重新取数，URL 与 profile id 永远一致。 */
function AgentDetailPage() {
  const result = Route.useLoaderData();
  const router = useRouter();

  return (
    <section className="space-y-6">
      <Link to="/agents" className="text-sm underline">
        返回列表
      </Link>
      {!result.ok && <ResultError error={result.error} testId="agent-error" />}
      {result.ok && (
        <article className="space-y-6">
          <header className="space-y-2">
            <h1 data-testid="agent-detail-name" className="text-2xl font-semibold">
              {result.data.name}
            </h1>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
              <dt className="text-muted-foreground">Profile ID</dt>
              <dd data-testid="agent-detail-id" className="font-mono text-xs break-all">
                {result.data.id}
              </dd>
              <dt className="text-muted-foreground">harness</dt>
              <dd data-testid="agent-detail-harness">{result.data.harness}</dd>
              <dt className="text-muted-foreground">创建时间</dt>
              <dd data-testid="agent-detail-created-at">{result.data.createdAt}</dd>
            </dl>
          </header>
          <AgentEditForm profile={result.data} onSaved={() => void router.invalidate()} />
        </article>
      )}
    </section>
  );
}
