import { AutomationSettings } from "./automation-settings";

export function CronSettings({ projectId }: { projectId: string }) {
  return <AutomationSettings key={projectId} projectId={projectId} kind="cron" />;
}
