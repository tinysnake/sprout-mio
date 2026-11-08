import { createFileRoute } from "@tanstack/react-router";
import { AutomationEditor } from "../../components/project/automation-settings";

export const Route = createFileRoute("/_authed/projects/$projectId/settings/webhooks/$ruleId")({
  component: EditRulePage,
});
function EditRulePage() {
  const { projectId, ruleId } = Route.useParams();
  return <AutomationEditor projectId={projectId} kind="webhooks" ruleId={ruleId} />;
}
