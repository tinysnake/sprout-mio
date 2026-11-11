import { ChevronRight } from "lucide-react";
import type { ChatInfoView, InfoHubResult } from "../../contracts/info-hub";
import type { TurnContextReadResult } from "../../contracts/turn-context";
import { ChatErrorNotice } from "../chat/chat-error-notice";
import { Icon } from "../ui/icon";
import { RunFactsBlock, TurnStartContextBlock } from "./run-facts";

/**
 * 活动区：run 事实与轮初快照是两件事，各自独立表达。
 *
 * run 事实始终显示（宿主状态、活动 run、最近 run 聚合都不依赖快照是否存在）；
 * 轮初快照与注入收据是排障用的内部事实，默认收在「本轮上下文与注入诊断」后面，
 * 只有真的已注入时在入口上点明——以免常态下把内部字段铺满面板。
 */
export function ChatActivityFacts({
  info,
  turnContext,
}: {
  info: ChatInfoView;
  turnContext: InfoHubResult<TurnContextReadResult> | null;
}) {
  const record =
    turnContext?.ok && turnContext.data.kind === "captured" ? turnContext.data.record : null;
  const injected = record?.deliveryState === "submitted";
  return (
    <div className="space-y-4">
      <RunFactsBlock runs={info.runs} testId="info-chat-runs" scope="chat" />
      <details data-testid="chat-turn-context-diagnostics" className="group">
        <summary className="flex min-h-7 cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
          <span>本轮上下文与注入诊断</span>
          <span className="flex items-center gap-2 text-[10px] font-normal">
            {injected && <span className="text-foreground">已注入</span>}
            <Icon
              as={ChevronRight}
              size={12}
              className="transition-transform group-open:rotate-90"
            />
          </span>
        </summary>
        <div className="pt-2">
          {turnContext && !turnContext.ok ? (
            <ChatErrorNotice error={turnContext.error} testId="info-hub-turn-context-error" />
          ) : (
            <TurnStartContextBlock context={record} />
          )}
        </div>
      </details>
    </div>
  );
}
