import { ChevronRight } from "lucide-react";
import type { ContinuationPageData } from "./continuation-page-data";
import { CONTINUATION_UNAVAILABLE } from "./continuation-page-data";
import { CONTINUATION_MODES } from "./continuation-labels";

export function continuationCheckHref(
  projectId: string,
  chatId: string,
  evaluationId: string,
  kind: "wake" | "continuation",
) {
  return `/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}/checks/${encodeURIComponent(evaluationId)}/${kind}`;
}

export function ContinuationPanel({ data }: { data?: ContinuationPageData }) {
  const view = data?.view;
  const evaluationId = view?.latestEvaluation?.evaluationId;
  const rows = [
    {
      kind: "wake" as const,
      label: "唤醒判定",
      value: evaluationId
        ? `最近 ${view?.recentRounds.length} 轮 · 查看诊断`
        : "尚无判定，暂不能查看",
    },
    {
      kind: "continuation" as const,
      label: "对话接续",
      value: view ? CONTINUATION_MODES[view.mode] : CONTINUATION_UNAVAILABLE.reason,
    },
  ];
  return (
    <section aria-label="对话自动化" data-testid="continuation-panel" className="min-w-0 text-xs">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h3 className="font-medium">对话自动化</h3>
        <span className="text-muted-foreground">摘要与详情</span>
      </header>
      <div className="overflow-hidden rounded-container border border-border">
        {rows.map(({ kind, label, value }) => {
          const content = (
            <>
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="shrink-0 font-medium">{label}</span>
              <span className="ml-auto text-right text-muted-foreground">{value}</span>
            </>
          );
          const className =
            "flex min-h-11 min-w-0 items-center gap-2 border-border px-3 py-2 not-first:border-t";
          return evaluationId && view ? (
            <a
              key={kind}
              className={`${className} hover:bg-hover focus-visible:outline-ring`}
              href={continuationCheckHref(view.projectId, view.chatId, evaluationId, kind)}
            >
              {content}
            </a>
          ) : (
            <div
              key={kind}
              className={className}
              aria-disabled="true"
              title="尚无检查轮次，无法打开诊断"
            >
              {content}
            </div>
          );
        })}
      </div>
      {evaluationId && (
        <p className="mt-2 text-[11px] text-muted-foreground">点开任一行进入完整诊断与逐轮记录。</p>
      )}
      {!view && (
        <p data-testid="continuation-unavailable" className="mt-2 text-muted-foreground">
          暂时无法确认最近检查与下次检查，请刷新事实后确认。
        </p>
      )}
    </section>
  );
}
