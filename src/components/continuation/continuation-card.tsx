import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import "./continuation-diagnostic.css";
import type { ChatContinuationView } from "../../contracts/chat-continuation";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import type { ContinuationDenials, ContinuationSubmit } from "./continuation-page-data";
import {
  CONTINUATION_MODES as modes,
  CONTINUATION_DELIVERY_STATES as deliveryStates,
  continuationFailureText as failureText,
  continuationTime as time,
} from "./continuation-labels";
import { useContinuationCommand } from "./use-continuation-command";
import { continuationCheckLink } from "./continuation-panel";

export function DiagnosticSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="diagnostic-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function DiagnosticFacts({ children }: { children: ReactNode }) {
  return <dl className="diagnostic-facts">{children}</dl>;
}

export function ContinuationCard({
  view,
  denials = {},
  onCommand,
}: {
  view: ChatContinuationView;
  denials?: ContinuationDenials;
  onCommand?: ContinuationSubmit;
}) {
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const { pending, error, submit, disabled } = useContinuationCommand(view, denials, onCommand);
  return (
    <div
      data-testid="continuation-card"
      aria-label="对话接续"
      aria-busy={pending}
      className="diagnostic-body"
    >
      <section className="diagnostic-status">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 data-testid="continuation-mode">{modes[view.mode]}</h3>
          <span className="text-xs text-muted-foreground">仅此 Chat</span>
        </div>
        <p data-testid="continuation-expectation">
          {view.mode === "enabled"
            ? view.nextDueAt
              ? "已安排下次自动检查，是否接续以检查结论为准。启用不代表马上接续。"
              : "当前没有安排下次自动检查。启用不代表马上接续。"
            : "对话接续不会来：此 Chat 已关闭自动检查。"}
        </p>
        <p data-testid="continuation-scope" className="diagnostic-note">
          范围：仅此 Chat 的对话接续。Task 状态、当前 run
          与自动检查各自独立；关闭自动检查不会停止当前 run。
        </p>
      </section>
      <p className="diagnostic-note mt-4">
        以下为此 Chat 当前的调度、运行、投递与控制事实，不是所选历史轮次的快照。
      </p>
      <DiagnosticSection title="上下文与调度">
        <DiagnosticFacts>
          <dt>关联 Task</dt>
          <dd data-testid="continuation-assigned">
            {view.assignedTaskIds.length} 个 assigned Task
          </dd>
          {view.owner.kind === "agent" && (
            <>
              <dt>活动 run</dt>
              <dd data-testid="continuation-run-facts">
                {view.activeRunIds.length
                  ? `${view.activeRunIds.length} 个活动 run`
                  : "当前无活动 run"}
              </dd>
            </>
          )}
          <dt>下次检查</dt>
          <dd data-testid="continuation-next-check">
            {view.nextDueAt ? time(view.nextDueAt) : "未安排"}
          </dd>
          <dt>控制版本</dt>
          <dd>
            revision {view.revision} / epoch {view.epoch}
          </dd>
        </DiagnosticFacts>
        {view.latestEvaluation && (
          <Link
            className="mt-4 block border-t border-border pt-4 text-xs"
            {...continuationCheckLink(
              view.projectId,
              view.chatId,
              view.latestEvaluation.evaluationId,
              "wake",
            )}
          >
            查看最近一轮唤醒判定 →
          </Link>
        )}
      </DiagnosticSection>
      <DiagnosticSection title="人类控制">
        <div className="diagnostic-controls">
          <div>
            <h4>当前运行</h4>
            <p>只停止选定的 run，不改对话接续开关与 epoch。</p>
            {view.owner.kind === "agent" && view.activeRunIds.length > 0 ? (
              <div data-testid="continuation-run-control" className="space-y-2">
                {!denials.abort &&
                  view.activeRunIds.map((runId) => (
                    <div key={runId}>
                      <Button
                        variant="destructive"
                        disabled={disabled}
                        onClick={() => void submit("abort", runId)}
                      >
                        只停止此 run{view.activeRunIds.length > 1 ? ` · ${runId}` : ""}
                      </Button>
                    </div>
                  ))}
              </div>
            ) : (
              <p>当前没有可停止的 Agent run。</p>
            )}
          </div>
          <div>
            <h4>对话接续</h4>
            <p>暂停不会停止当前 run；重新启用会重新安排检查。</p>
            {view.mode === "enabled"
              ? !denials.disable && (
                  <Button
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => void submit("disable")}
                  >
                    暂停对话接续
                  </Button>
                )
              : !denials.enable && (
                  <Button
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => void submit("enable")}
                  >
                    重新启用
                  </Button>
                )}
          </div>
          <div>
            <h4>全部停止</h4>
            <p>中止本 Chat 的全部 queued/running run，并关闭对话接续；Task 不受影响。</p>
            {!denials.abort && (
              <Button
                variant="destructive"
                disabled={disabled}
                onClick={() => setConfirmation("abort")}
              >
                全部停止
              </Button>
            )}
          </div>
        </div>
      </DiagnosticSection>
      <DiagnosticSection title="投递与 Human 提醒">
        {view.owner.kind === "human" && (
          <p>{view.remindedHuman ? "已展示接续提醒" : "尚无接续提醒"}；由 Human 决定后续操作</p>
        )}
        {!view.deliveries.length && <p className="diagnostic-note">暂无接续输入或 Human 提醒。</p>}
        {view.deliveries.map((delivery) => (
          <div
            key={delivery.deliveryId}
            data-testid="continuation-delivery"
            className="diagnostic-delivery"
          >
            <p>
              {delivery.errorCode === "delivery_unknown"
                ? "投递未知：尚未确认送达，不会自动重投。当前 run 事实保持独立。"
                : `${delivery.recipient.kind === "human" ? "Human 提醒" : "接续输入"} · ${deliveryStates[delivery.state]}`}
            </p>
            {delivery.errorCode && (
              <p data-error-code={delivery.errorCode} className="text-destructive">
                {failureText(delivery.errorCode)}
              </p>
            )}
            {delivery.nextAttemptAt && (
              <p>
                投递退避：{time(delivery.nextAttemptAt)}（已尝试 {delivery.attempt} 次）
              </p>
            )}
            {delivery.errorCode === "delivery_unknown" && !denials.reissue && (
              <Button
                variant="secondary"
                disabled={disabled}
                onClick={() => setConfirmation(delivery.deliveryId)}
              >
                人工补发…
              </Button>
            )}
            <details>
              <summary>投递细节</summary>
              <DiagnosticFacts>
                <dt>deliveryId</dt>
                <dd>{delivery.deliveryId}</dd>
                <dt>evaluationId</dt>
                <dd>{delivery.evaluationId}</dd>
                <dt>runId</dt>
                <dd>{delivery.runId ?? "无"}</dd>
                <dt>taskIds</dt>
                <dd>{delivery.taskIds.join("、") || "无"}</dd>
              </DiagnosticFacts>
            </details>
          </div>
        ))}
        {view.attention && (
          <div role="status" data-testid="continuation-attention" className="diagnostic-error">
            <p>需要处理：{view.attention.reason}</p>
            <p data-error-code={view.attention.errorCode}>
              {failureText(view.attention.errorCode)}
            </p>
          </div>
        )}
      </DiagnosticSection>
      <DiagnosticSection title="控制与变更审计">
        <DiagnosticFacts>
          <dt>最近控制</dt>
          <dd>
            {view.changedBy ?? "暂无"} · {time(view.changedAt)}
          </dd>
          <dt>控制原因</dt>
          <dd>{view.reason ?? "未提供"}</dd>
          <dt>Chat</dt>
          <dd>{view.chatId}</dd>
          <dt>requestId</dt>
          <dd>{view.attention?.requestId ?? "无"}</dd>
        </DiagnosticFacts>
      </DiagnosticSection>
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmation(null);
        }}
      >
        <DialogContent showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>确认{confirmation === "abort" ? "全部停止" : "人工补发"}</DialogTitle>
            <DialogDescription>
              {confirmation === "abort"
                ? "此 Chat 所有 queued/running 的 run 会被中止，对话接续随之关闭；Task 不受影响。"
                : "投递结果未知，人工补发可能造成重复处理。确认后将创建新的接续输入。"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" disabled={pending} onClick={() => setConfirmation(null)}>
              取消
            </Button>
            <Button
              variant={confirmation === "abort" ? "destructive" : "default"}
              disabled={disabled}
              onClick={async () => {
                if (
                  confirmation !== null &&
                  (await submit(
                    confirmation === "abort" ? "abort" : "reissue",
                    confirmation === "abort" ? undefined : confirmation,
                  ))
                )
                  setConfirmation(null);
              }}
            >
              确认{confirmation === "abort" ? "全部停止" : "补发"}
            </Button>
          </DialogFooter>
          {error && (
            <p role="alert" className="text-destructive">
              {error.reason}
            </p>
          )}
        </DialogContent>
      </Dialog>
      {error && (
        <p role="alert" data-error-code={error.code} className="text-destructive">
          {error.reason}
        </p>
      )}
    </div>
  );
}
