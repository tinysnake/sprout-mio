import { useEffect, useState } from "react";
import type {
  ChatContinuationRoundView,
  ChatContinuationView,
} from "../../contracts/chat-continuation";
import { ContinuationAttempts } from "../chat/continuation-activity";
import { Button } from "../ui/button";
import { DiagnosticFacts, DiagnosticSection } from "./continuation-card";
import type { ContinuationDenials, ContinuationSubmit } from "./continuation-page-data";
import {
  CONTINUATION_DECISIONS as decisions,
  CONTINUATION_STATES as states,
  CONTINUATION_SOURCES as sources,
  CONTINUATION_RECIPIENT_DECISIONS as recipientDecisions,
  CONTINUATION_FAILURES,
  continuationFailureText as failureText,
  continuationTime as time,
  continuationDuration as duration,
  continuationTokens as tokens,
} from "./continuation-labels";
import { useContinuationCommand } from "./use-continuation-command";

export function WakeDiagnostic({
  view,
  round,
  denials = {},
  onCommand,
  clock = Date.now,
}: {
  view: ChatContinuationView;
  round: ChatContinuationRoundView;
  denials?: ContinuationDenials;
  onCommand?: ContinuationSubmit;
  clock?: () => number;
}) {
  const evaluation = view.latestEvaluation?.round === round.round ? view.latestEvaluation : null;
  const lastAttempt = round.attempts.at(-1);
  const usage = evaluation?.usage ?? lastAttempt?.usage;
  const startedAt = evaluation?.claimedAt ?? lastAttempt?.startedAt;
  const [now, setNow] = useState(clock);
  const running = round.state === "claimed";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(clock()), 1000);
    return () => clearInterval(timer);
  }, [running, clock]);
  const { pending, disabled, error, submit } = useContinuationCommand(view, denials, onCommand);
  const failed = round.state === "attention" || round.state === "retry_wait";
  return (
    <div className="diagnostic-body" data-testid="wake-diagnostic" aria-busy={pending}>
      <section
        className={`diagnostic-status ${failed ? "diagnostic-status-failed" : running ? "diagnostic-status-running" : ""}`}
        aria-label="本轮判定"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3>{states[round.state]}</h3>
          {evaluation && failed && !denials.retry && (
            <Button
              disabled={disabled}
              onClick={() => void submit("retry", evaluation.evaluationId)}
            >
              重试检查
            </Button>
          )}
        </div>
        <p>
          {round.result
            ? `${decisions[round.result.decision]} · ${round.result.reason}`
            : running
              ? "正在等待判定服务回应，尚未形成可靠结论。"
              : failed
                ? "判定失败不代表本轮无需接续。"
                : "本轮尚无判定结论。"}
        </p>
        {round.errorCode && (
          <div
            className="diagnostic-error"
            data-testid="continuation-failure"
            data-error-code={round.errorCode}
          >
            <strong>{failureText(round.errorCode)}</strong>
            <p>判定失败不代表本轮无需接续。</p>
            <code>errorCode: {round.errorCode}</code>
          </div>
        )}
        <div className="diagnostic-result-meta">
          <span>
            {running && startedAt ? (
              <span data-testid="wake-elapsed">
                已等待 {duration(Math.max(0, now - Date.parse(startedAt)))}
              </span>
            ) : (
              `耗时 ${usage?.durationMs != null ? duration(usage.durationMs) : "暂无记录"}`
            )}
          </span>
          <span>第 {evaluation?.attempt ?? round.attempts.length} 次尝试</span>
          {evaluation?.nextAttemptAt ? (
            <span data-testid="continuation-backoff">
              失败退避：下次重试 {time(evaluation.nextAttemptAt)}
            </span>
          ) : (
            <span>
              {running ? "下一步：等待判定结果" : failed ? "下一步：手动重试" : "本轮已结束"}
            </span>
          )}
        </div>
        {error && (
          <p role="alert" data-error-code={error.code}>
            {error.reason}
          </p>
        )}
      </section>
      <DiagnosticSection title="逐接收者结论">
        {round.result?.recipients.length ? (
          <>
            <div className="diagnostic-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>候选接收者</th>
                    <th>结论</th>
                    <th>命中概率</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {round.result.recipients.map((item) => (
                    <tr key={`${item.recipient.kind}:${item.recipient.id}`}>
                      <td>
                        {item.recipient.id}
                        <small>{item.recipient.kind}</small>
                      </td>
                      <td>
                        {recipientDecisions[item.decision]}
                        <small>{item.decision}</small>
                      </td>
                      <td>
                        {item.probability === null ? "—" : `${Math.round(item.probability * 100)}%`}
                      </td>
                      <td>{item.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="diagnostic-inline-note">
              选中接收者：
              {round.result.selectedRecipients.map((item) => item.id).join("、") || "无"}。仅 yes
              候选进入 selectedRecipients；unknown 不作为 no。
            </p>
          </>
        ) : (
          <p className="diagnostic-note">本轮尚未产出逐接收者结论，不代表任何接收者无需接续。</p>
        )}
      </DiagnosticSection>
      <div className="diagnostic-two-cols">
        <DiagnosticSection title="本轮信息">
          <DiagnosticFacts>
            <dt>触发来源</dt>
            <dd>{sources[round.source]}</dd>
            <dt>检查轮次</dt>
            <dd>#{round.round}</dd>
            <dt>开始检查</dt>
            <dd>{time(startedAt ?? null)}</dd>
            <dt>结束时间</dt>
            <dd>
              {running
                ? "尚未结束"
                : time(evaluation?.finishedAt ?? lastAttempt?.finishedAt ?? null)}
            </dd>
            <dt>判定时间</dt>
            <dd>{time(round.evaluatedAt)}</dd>
            <dt>下次重试</dt>
            <dd>
              {evaluation?.nextAttemptAt
                ? time(evaluation.nextAttemptAt)
                : running
                  ? "等待本次检查完成"
                  : failed
                    ? "需手动重试"
                    : "无本轮重试"}
            </dd>
          </DiagnosticFacts>
        </DiagnosticSection>
        <DiagnosticSection title="判定器与用量">
          <DiagnosticFacts>
            <dt>Provider</dt>
            <dd>{round.result?.provider ?? "未提供"}</dd>
            <dt>模型</dt>
            <dd>{round.result?.model ?? "未提供"}</dd>
            <dt>实际模型</dt>
            <dd>{usage?.resolvedModel ?? "未提供"}</dd>
            <dt>判定器版本</dt>
            <dd>{round.result?.version ?? "未提供"}</dd>
          </DiagnosticFacts>
          <div className="diagnostic-metrics">
            <div>
              <span>耗时</span>
              <strong>{usage?.durationMs != null ? duration(usage.durationMs) : "暂无记录"}</strong>
            </div>
            <div>
              <span>输入 token</span>
              <strong>{usage?.inputTokens != null ? tokens(usage.inputTokens) : "暂无记录"}</strong>
            </div>
            <div>
              <span>输出 token</span>
              <strong>
                {usage?.outputTokens != null ? tokens(usage.outputTokens) : "暂无记录"}
              </strong>
            </div>
          </div>
        </DiagnosticSection>
      </div>
      <DiagnosticSection title="逐次尝试">
        <ContinuationAttempts rounds={[round]} />
      </DiagnosticSection>
      <DiagnosticSection title="输入快照">
        <p className="diagnostic-note">
          当前读取契约未提供输入快照，无法展示触发消息、候选 Task、接收者名称或截断信息。
        </p>
        {round.result && (
          <DiagnosticFacts>
            <dt>snapshotHash</dt>
            <dd>{round.result.snapshotHash}</dd>
          </DiagnosticFacts>
        )}
        <details className="diagnostic-raw">
          <summary>技术标识与原始结论</summary>
          <DiagnosticFacts>
            <dt>evaluationId</dt>
            <dd>{evaluation?.evaluationId ?? "历史轮次未提供 evaluationId"}</dd>
            <dt>Chat</dt>
            <dd>{view.chatId}</dd>
            <dt>reasonCode</dt>
            <dd>{round.result?.reasonCode ?? "无"}</dd>
          </DiagnosticFacts>
          <pre>{JSON.stringify(round.result, null, 2)}</pre>
        </details>
        <details className="diagnostic-raw">
          <summary>失败码说明 · 11 种</summary>
          <DiagnosticFacts>
            {Object.entries(CONTINUATION_FAILURES).map(([code, label]) => (
              <div key={code} className="contents">
                <dt>
                  <code>{code}</code>
                </dt>
                <dd>{label}</dd>
              </div>
            ))}
          </DiagnosticFacts>
        </details>
      </DiagnosticSection>
    </div>
  );
}
