import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ContinuationPageData, ContinuationSubmit } from "./continuation-page-data";
import { Button } from "../ui/button";
import { ContinuationCard } from "./continuation-card";
import { continuationCheckLink, LATEST_CHECK_LINK } from "./continuation-panel";
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
  // 入口在没有判定时用 latest 占位，这里解析成当前最新一轮。
  const target =
    evaluationId === LATEST_CHECK_LINK ? (view.latestEvaluation?.evaluationId ?? "") : evaluationId;
  const round = view.recentRounds.find((item) => item.evaluationId === target);
  const back = {
    to: "/projects/$projectId/chats/$chatId" as const,
    params: { projectId: view.projectId, chatId: view.chatId },
    // 返回入口的目标是上层的对话页，不是本页的“当前位置”，不参与活动态匹配。
    activeOptions: { exact: true, includeSearch: false, includeHash: false },
  };
  return (
    <section
      className="continuation-diagnostic"
      data-testid="continuation-diagnostic"
      data-kind={kind}
    >
      <header className="diagnostic-context">
        <span>{chatTitle}</span>
        <Link {...back}>返回对话 ↗</Link>
      </header>
      <div className="diagnostic-page-head">
        <div>
          <Link {...back}>← 返回{chatTitle}</Link>
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
            <Link
              key={item.evaluationId}
              {...continuationCheckLink(view.projectId, view.chatId, item.evaluationId, kind)}
            >
              <span className="flex items-center justify-between gap-3">
                <time>{time(item.evaluatedAt ?? item.attempts.at(-1)?.startedAt ?? null)}</time>
                <small>#{item.round}</small>
              </span>
              <strong>{sources[item.source]}</strong>
              <span>
                {round?.evaluationId === item.evaluationId ? "当前查看 ↓" : states[item.state]}
              </span>
            </Link>
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
          ) : view.recentRounds.length === 0 ? (
            <>
              <div role="status" data-testid="diagnostic-round-missing" data-empty="true">
                <h2>本会话还没有检查轮次</h2>
                <p>
                  {kind === "wake"
                    ? "消息命中唤醒条件、或周期检查到点时会产出第一轮判定；这一轮还没有发生，所以没有可展示的评审记录。"
                    : "启用对话接续后，到期检查会产出第一轮判定。在生成之前，这里仍可管理策略与投递。"}
                </p>
              </div>
              {kind === "continuation" && (
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
