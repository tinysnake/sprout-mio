import type { AutomationPageData, AutomationSubmit } from "./automation-page-data";
import { AUTOMATION_UNAVAILABLE } from "./automation-page-data";
import { AutomationCard } from "./automation-card";

/** Full authorized read data must be supplied by the route; never infer it from Task state. */
export function AutomationPanel({
  data,
  onCommand,
}: {
  data?: AutomationPageData;
  onCommand?: AutomationSubmit;
}) {
  if (data) return <AutomationCard view={data.view} denials={data.denials} onCommand={onCommand} />;
  return (
    <section
      data-testid="automation-unavailable"
      className="min-w-0 space-y-2 rounded-container border border-border p-4 text-xs break-words"
    >
      <h3 className="text-sm font-medium">自动接续</h3>
      <p>{AUTOMATION_UNAVAILABLE.reason}</p>
      <p className="text-muted-foreground">
        暂时无法确认是否会接续、最近检查与下次检查。请刷新事实后确认。
      </p>
      <code>{AUTOMATION_UNAVAILABLE.code}</code>
    </section>
  );
}
