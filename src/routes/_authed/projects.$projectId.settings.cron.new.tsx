import { createFileRoute } from "@tanstack/react-router";
import { AutomationEditor } from "../../components/project/automation-settings";

export const Route = createFileRoute("/_authed/projects/$projectId/settings/cron/new")({
  component: NewRulePage,
});
function NewRulePage() {
  const { projectId } = Route.useParams();
  return <AutomationEditor projectId={projectId} kind="cron" />;
}
