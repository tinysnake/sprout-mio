import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { CreateAgentDialog } from "../../components/agent/create-agent-dialog";
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
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Agent</h1>
        <CreateAgentDialog onCreated={() => void router.invalidate()} />
      </div>
      {!result.ok && <ResultError error={result.error} testId="agents-error" />}
      {result.ok && profiles.length === 0 && (
        <p data-testid="agent-empty" className="text-muted-foreground">
          还没有 Agent profile，先创建一个。
        </p>
      )}
      <ul data-testid="agent-list" className="divide-y divide-border/60 rounded-lg border">
        {profiles.map((profile) => (
          <li key={profile.id} data-testid="agent-item" data-agent-profile-id={profile.id}>
            <Link
              to="/agents/$agentProfileId"
              params={{ agentProfileId: profile.id }}
              className="block px-4 py-3 hover:bg-muted/50"
            >
              <span data-testid="agent-item-name" className="font-medium">
                {profile.name}
              </span>
              {profile.jobTitle && (
                <span
                  data-testid="agent-item-job-title"
                  className="ml-2 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                >
                  {profile.jobTitle}
                </span>
              )}
              <span className="mt-1 block text-xs text-muted-foreground">
                {profile.persona ? profile.persona.slice(0, 60) : "（无人设）"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
