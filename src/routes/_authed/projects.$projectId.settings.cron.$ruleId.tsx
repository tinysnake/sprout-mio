import { createFileRoute } from "@tanstack/react-router";
import { AutomationEditor, ruleEditorSearch } from "../../components/project/automation-settings";

export const Route = createFileRoute("/_authed/projects/$projectId/settings/cron/$ruleId")({
  validateSearch: ruleEditorSearch,
  component: EditRulePage,
});
function EditRulePage() {
  const { projectId, ruleId } = Route.useParams();
  const { chat } = Route.useSearch();
  return <AutomationEditor projectId={projectId} kind="cron" ruleId={ruleId} chat={chat} />;
}
