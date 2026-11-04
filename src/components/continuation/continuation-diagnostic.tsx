import { useState } from "react";
import type { ContinuationPageData, ContinuationSubmit } from "./continuation-page-data";
import { Button } from "../ui/button";
import { ContinuationCard } from "./continuation-card";
import { continuationCheckHref } from "./continuation-panel";
import { WakeDiagnostic } from "./wake-diagnostic";
import {
  CONTINUATION_SOURCES as sources,
  CONTINUATION_STATES as states,
  continuationTime as time,
} from "./continuation-labels";

export function ContinuationDiagnostic({
  data,
  evaluationId,
  kind,
  chatTitle,
  onCommand,
}: {
  data: ContinuationPageData;
  evaluationId: string;
  kind: "wake" | "continuation";
  chatTitle: string;
  onCommand?: ContinuationSubmit;
}) {
  const { view, denials } = data;
  const [copyStatus, setCopyStatus] = useState("");
  const round = view.recentRounds.find((item) => item.evaluationId === evaluationId);
  const backHref = `/projects/${encodeURIComponent(view.projectId)}/chats/${encodeURIComponent(view.chatId)}`;
  return (
    <section
      className="continuation-diagnostic"
      data-testid="continuation-diagnostic"
      data-kind={kind}
    >
      <header className="diagnostic-context">
        <span>{chatTitle}</span>
        <a href={backHref}>返回对话 ↗</a>
      </header>
      <div className="diagnostic-page-head">
        <div>
          <a href={backHref}>← 返回{chatTitle}</a>
          <h1>{kind === "wake" ? "唤醒判定详情" : "对话接续详情"}</h1>
          <p>
            {kind === "wake"
              ? "按轮次查看模型评审、接收者结论与逐次尝试。"
              : "按轮次追踪投递结果；在此管理本 Chat 的接续策略。"}
          </p>
        </div>
        <div>
          <Button
            variant="secondary"
            disabled={!round}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                setCopyStatus("链接已复制");
              } catch {
                setCopyStatus("未能复制，请从地址栏复制链接。");
              }
            }}
          >
            复制此页链接
          </Button>
          {copyStatus && <p role="status">{copyStatus}</p>}
        </div>
      </div>
      <div className="diagnostic-workspace">
        <nav className="diagnostic-rail" aria-label="最近 5 轮">
          <h2>最近 5 轮</h2>
          {view.recentRounds.map((item) => (
            <a
              key={item.evaluationId}
              href={continuationCheckHref(view.projectId, view.chatId, item.evaluationId, kind)}
              aria-current={round?.evaluationId === item.evaluationId ? "step" : undefined}
            >
              <span className="flex items-center justify-between gap-3">
                <time>{time(item.evaluatedAt ?? item.attempts.at(-1)?.startedAt ?? null)}</time>
                <small>#{item.round}</small>
              </span>
              <strong>{sources[item.source]}</strong>
              <span>
                {round?.evaluationId === item.evaluationId ? "当前查看 ↓" : states[item.state]}
              </span>
            </a>
          ))}
          {!view.recentRounds.length && <p>尚无检查记录</p>}
          <p className="diagnostic-rail-foot">
            每轮以唤醒判定为起点。
            <br />
            投递记录属于该轮的接续结果。
          </p>
        </nav>
        <main className="diagnostic-content">
          {round ? (
            <>
              <header className="diagnostic-heading">
                <div>
                  <h2>检查轮次 #{round.round}</h2>
                  <span>{sources[round.source]}</span>
                </div>
                <time>{time(round.evaluatedAt)}</time>
              </header>
              {kind === "wake" ? (
                <WakeDiagnostic
                  key={round.round}
                  view={view}
                  round={round}
                  denials={denials}
                  onCommand={onCommand}
                />
              ) : (
                <ContinuationCard view={view} denials={denials} onCommand={onCommand} />
              )}
            </>
          ) : (
            <div role="status" data-testid="diagnostic-round-missing">
              <h2>这一轮不在最近 5 轮里</h2>
              <p>请从左侧选择最近轮次，或返回对话重新进入。</p>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
