import { useState } from "react";
import type { ContinuationPageData, ContinuationSubmit } from "./continuation-page-data";
import { Button } from "../ui/button";
import { ContinuationCard } from "./continuation-card";
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
  const routeRound =
    view.latestEvaluation?.evaluationId === evaluationId ? view.latestEvaluation.round : null;
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const round =
    routeRound === null
      ? undefined
      : view.recentRounds.find((item) => item.round === (selectedRound ?? routeRound));
  const historical = selectedRound !== null && selectedRound !== routeRound;
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
            disabled={historical || !round}
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
            <button
              type="button"
              key={item.round}
              aria-current={round?.round === item.round ? "step" : undefined}
              disabled={routeRound === null}
              onClick={() => {
                setSelectedRound(item.round);
                setCopyStatus("");
              }}
            >
              <span className="flex items-center justify-between gap-3">
                <time>{time(item.evaluatedAt ?? item.attempts.at(-1)?.startedAt ?? null)}</time>
                <small>#{item.round}</small>
              </span>
              <strong>{sources[item.source]}</strong>
              <span>{round?.round === item.round ? "当前查看 ↓" : states[item.state]}</span>
            </button>
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
              {historical && (
                <p className="diagnostic-note mb-5">
                  当前查看历史轮次。读取契约未提供其
                  evaluationId，地址仍为入口轮次，不能作为本轮的独立链接。
                </p>
              )}
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
              <p>
                当前契约仅提供最新轮次的
                evaluationId，无法定位该地址。请返回对话，从最新轮次重新进入。
              </p>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
