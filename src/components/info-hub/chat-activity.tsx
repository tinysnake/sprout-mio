import type { ChatInfoView, InfoHubResult } from "../../contracts/info-hub";
import type { TurnContextReadResult } from "../../contracts/turn-context";
import { ChatErrorNotice } from "../chat/chat-error-notice";
import { RunFactsBlock, TurnStartContextBlock } from "./run-facts";

/**
 * 活动区：run 事实与轮初快照是两件事，各自独立表达。
 *
 * run 事实始终显示（宿主状态、活动 run、最近 run 聚合都不依赖快照是否存在）；
 * 轮初快照按明确 runId 读到持久化记录才渲染，`not_captured` 与「没有 run」都渲染
 * 明确的空态，不编造「已注入」，也不把读不到当成读失败。
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
  return (
    <div className="space-y-4">
      <RunFactsBlock runs={info.runs} testId="info-chat-runs" />
      {turnContext && !turnContext.ok ? (
        <ChatErrorNotice error={turnContext.error} testId="info-hub-turn-context-error" />
      ) : (
        <TurnStartContextBlock context={record} />
      )}
    </div>
  );
}
