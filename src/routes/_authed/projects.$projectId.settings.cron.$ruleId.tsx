import { createFileRoute } from "@tanstack/react-router";
import { AutomationEditor } from "../../components/project/automation-settings";

export const Route = createFileRoute("/_authed/projects/$projectId/settings/cron/$ruleId")({
  component: EditRulePage,
});
function EditRulePage() {
  const { projectId, ruleId } = Route.useParams();
  return <AutomationEditor projectId={projectId} kind="cron" ruleId={ruleId} />;
}
