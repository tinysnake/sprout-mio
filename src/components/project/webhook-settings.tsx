import { AutomationSettings } from "./automation-settings";

export function WebhookSettings({ projectId }: { projectId: string }) {
  return <AutomationSettings key={projectId} projectId={projectId} kind="webhooks" />;
}
