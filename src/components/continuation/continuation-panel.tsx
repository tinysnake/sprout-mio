import type { ContinuationPageData, ContinuationSubmit } from "./continuation-page-data";
import { CONTINUATION_UNAVAILABLE } from "./continuation-page-data";
import { ContinuationCard } from "./continuation-card";

/** Full authorized read data must be supplied by the route; never infer it from Task state. */
export function ContinuationPanel({
  data,
  onCommand,
  showStatus = true,
}: {
  data?: ContinuationPageData;
  onCommand?: ContinuationSubmit;
  showStatus?: boolean;
}) {
  if (data)
    return (
      <ContinuationCard
        view={data.view}
        denials={data.denials}
        onCommand={onCommand}
        showStatus={showStatus}
      />
    );
  return (
    <section
      data-testid="continuation-unavailable"
      className="min-w-0 space-y-2 rounded-container border border-border p-4 text-xs break-words"
    >
      <h3 className="text-sm font-medium">对话接续</h3>
      <p>{CONTINUATION_UNAVAILABLE.reason}</p>
      <p className="text-muted-foreground">
        暂时无法确认是否会接续、最近检查与下次检查。请刷新事实后确认。
      </p>
    </section>
  );
}
