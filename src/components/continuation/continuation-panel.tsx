import { Link, type LinkProps } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import type { ChatKind } from "../../contracts/chat";
import type { ContinuationPageData } from "./continuation-page-data";
import { CONTINUATION_UNAVAILABLE } from "./continuation-page-data";
import { CONTINUATION_MODES } from "./continuation-labels";

/** 还没有任何判定时，入口指向「最新一轮」这条路，由页面解析并给出空态。 */
export const LATEST_CHECK_LINK = "latest";

export function continuationCheckLink(
  projectId: string,
  chatId: string,
  evaluationId: string,
  kind: "wake" | "continuation",
): LinkProps {
  const params = { projectId, chatId, evaluationId };
  return kind === "wake"
    ? { to: "/projects/$projectId/chats/$chatId/checks/$evaluationId/wake", params }
    : { to: "/projects/$projectId/chats/$chatId/checks/$evaluationId/continuation", params };
}

export function ContinuationPanel({
  data,
  chatKind,
}: {
  data?: ContinuationPageData;
  chatKind?: ChatKind;
}) {
  const view = data?.view;
  const latest = view?.latestEvaluation?.evaluationId;
  // 没有判定记录时不再把入口做成不可点：指向 latest，页面给出空态与依赖条件。
  const target = latest ?? (view ? LATEST_CHECK_LINK : undefined);
  // DM 的判定由规则分支直接派发给唯一 Agent，没有候选选择的诊断可看。
  const showWakeEntry = chatKind !== "dm";
  const rows = [
    ...(showWakeEntry
      ? [
          {
            kind: "wake" as const,
            label: "唤醒判定",
            value: !view
              ? CONTINUATION_UNAVAILABLE.reason
              : latest
                ? `最近 ${view.recentRounds.length} 轮 · 查看诊断`
                : "尚无判定 · 查看诊断",
          },
        ]
      : []),
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
      {/* 导航行不加外框：整组不是可展开的盒子，每行直接进诊断页。 */}
      <div className="flex flex-col">
        {rows.map(({ kind, label, value }, index) => {
          const content = (
            <>
              <span className="shrink-0 font-medium">{label}</span>
              <span className="ml-auto text-right text-muted-foreground">{value}</span>
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            </>
          );
          const className = "flex min-h-11 min-w-0 items-center gap-2 rounded-control px-3 py-2";
          return (
            <Fragment key={kind}>
              {index > 0 && (
                <div aria-hidden="true" className="mx-3 h-px shrink-0 bg-border-soft" />
              )}
              {view && target ? (
                <Link
                  {...continuationCheckLink(view.projectId, view.chatId, target, kind)}
                  className={`${className} hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring`}
                >
                  {content}
                </Link>
              ) : (
                <div className={className} aria-disabled="true" title="尚无检查轮次，无法打开诊断">
                  {content}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      {view && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {rows.length > 1 ? "点开任一行进入完整诊断与逐轮记录。" : "点开进入完整诊断与逐轮记录。"}
        </p>
      )}
      {!view && (
        <p data-testid="continuation-unavailable" className="mt-2 text-muted-foreground">
          暂时无法确认最近检查与下次检查，请刷新事实后确认。
        </p>
      )}
    </section>
  );
}
