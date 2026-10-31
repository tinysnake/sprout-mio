import { useState } from "react";
import type { ChatAutomationCommand, ChatAutomationView } from "../../contracts/chat-automation";
import { newId } from "../../contracts/ids";
import { Button } from "../ui/button";
import type { AutomationAction, AutomationDenials, AutomationSubmit } from "./automation-page-data";

const modes = { enabled: "自动接续已启用", off: "自动接续已关闭" };
const decisions = {
  continue: "建议接续",
  do_not_continue: "本轮无需接续",
  indeterminate: "未能得出可靠结论",
};
const states = {
  pending: "等待检查",
  claimed: "正在检查",
  retry_wait: "检查失败 · 等待重试",
  decided: "已完成检查",
  attention: "检查失败 · 需要处理",
  stale: "检查已失效",
  canceled: "检查已取消",
};
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无记录";

export function AutomationCard({
  view,
  denials = {},
  onCommand,
}: {
  view: ChatAutomationView;
  denials?: AutomationDenials;
  onCommand?: AutomationSubmit;
}) {
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const evaluation = view.latestEvaluation;
  // 页面只隐藏服务端明确拒绝的动作；没接控制器（静态渲染、夹具）时控件保留但不可点。
  const denial = (action: AutomationAction) => denials[action];
  async function submit(
    action: "disable" | "enable" | "abort" | "retry" | "reissue",
    targetId?: string,
  ) {
    if (!onCommand || pending || denial(action)) return;
    const base = {
      projectId: view.projectId,
      chatId: view.chatId,
      expectedRevision: view.revision,
      requestId: newId("req"),
    };
    let command: ChatAutomationCommand;
    if (action === "abort")
      command = targetId ? { ...base, action, runId: targetId } : { ...base, action };
    else if (action === "retry") {
      if (!evaluation) return;
      command = { ...base, action, evaluationId: evaluation.evaluationId };
    } else if (action === "reissue") {
      if (!targetId) return;
      command = { ...base, action, deliveryId: targetId, confirmedUnknown: true };
    } else command = { ...base, action };
    setPending(true);
    setError(null);
    try {
      const result = await onCommand(command);
      if (!result.ok)
        setError(
          `${result.error.reason} (${result.error.code})${result.error.requestId ? ` · ${result.error.requestId}` : ""}`,
        );
      else setConfirmation(null);
    } catch {
      setError("请求未完成，操作结果未知。请刷新事实后再操作。");
    } finally {
      setPending(false);
    }
  }
  function actionButton(
    action: "disable" | "enable" | "abort" | "retry" | "reissue",
    label: string,
    click: () => void,
  ) {
    // 当前身份不可用的动作用不出现在页面上：置灰加一行原因只是噪音。
    if (denial(action)) return null;
    return (
      <div className="min-w-0 space-y-1">
        <Button
          type="button"
          variant={action === "abort" ? "destructive" : "secondary"}
          disabled={pending || !onCommand}
          onClick={click}
        >
          {label}
        </Button>
      </div>
    );
  }
  return (
    <section
      data-testid="automation-card"
      aria-label="自动接续"
      aria-busy={pending}
      className="min-w-0 space-y-4 rounded-container border border-border p-4 text-xs break-words"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">自动接续</h3>
        <span data-testid="automation-mode" className="text-muted-foreground">
          {modes[view.mode]}
        </span>
      </header>
      <p data-testid="automation-expectation">
        {view.mode === "off"
          ? "自动接续不会来：此 Chat 已关闭自动检查。"
          : view.nextDueAt
            ? "已安排下次自动检查，是否接续以检查结论为准。"
            : "当前没有安排下次自动检查。启用不代表马上接续。"}
      </p>
      <p data-testid="automation-scope" className="text-muted-foreground">
        范围：仅此 Chat 的自动接续。Task 状态、当前 run 与自动检查各自独立；关闭自动检查不会停止当前
        run。
      </p>
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">关联 Task</dt>
        <dd data-testid="automation-assigned">{view.assignedTaskIds.length} 个 assigned Task</dd>
        {view.owner.kind === "agent" && (
          <>
            <dt className="text-muted-foreground">活动 run</dt>
            <dd data-testid="automation-run-facts">
              {view.activeRunIds.length
                ? `${view.activeRunIds.length} 个活动 run`
                : "当前无活动 run"}
            </dd>
          </>
        )}
        {view.owner.kind === "human" && (
          <>
            <dt className="text-muted-foreground">Human owner</dt>
            <dd>{view.remindedHuman ? "已展示接续提醒" : "尚无接续提醒"}；由 Human 决定后续操作</dd>
          </>
        )}
        <dt className="text-muted-foreground">最近检查</dt>
        <dd data-testid="automation-last-check">
          {evaluation
            ? `${time(evaluation.evaluatedAt)} · ${states[evaluation.state]}`
            : "尚未检查"}
        </dd>
        <dt className="text-muted-foreground">检查结论</dt>
        <dd data-testid="automation-decision">
          {evaluation?.result ? (
            <>
              {decisions[evaluation.result.decision]}：{evaluation.result.reason}
            </>
          ) : (
            "暂无结论"
          )}
        </dd>
        <dt className="text-muted-foreground">下次检查</dt>
        <dd data-testid="automation-next-check">
          {view.nextDueAt ? time(view.nextDueAt) : "未安排"}
        </dd>
      </dl>
      {view.reason && <p>控制原因：{view.reason}</p>}
      {view.attention && (
        <div
          role="status"
          data-testid="automation-attention"
          className="space-y-1 border-l-2 border-destructive pl-3"
        >
          <p>需要处理：{view.attention.reason}</p>
          <code>{view.attention.errorCode}</code>
        </div>
      )}
      {evaluation?.errorCode && (
        <p data-testid="automation-failure" className="text-destructive">
          检查失败：{evaluation.errorCode}。判定失败不代表本轮无需接续。
        </p>
      )}
      {evaluation?.nextAttemptAt && (
        <p data-testid="automation-backoff">
          失败退避：下次重试 {time(evaluation.nextAttemptAt)}（已尝试 {evaluation.attempt} 次）
        </p>
      )}
      {view.deliveries.map((delivery) => (
        <div
          key={delivery.deliveryId}
          data-testid="automation-delivery"
          className="space-y-2 border-t border-border pt-3"
        >
          <p>
            {delivery.errorCode === "delivery_unknown"
              ? "投递未知：尚未确认送达，不会自动重投。当前 run 事实保持独立。"
              : delivery.recipient.kind === "human"
                ? `Human 提醒 · ${delivery.state}`
                : `接续输入 · ${delivery.state}`}
          </p>
          {delivery.errorCode && <code className="text-destructive">{delivery.errorCode}</code>}
          {delivery.nextAttemptAt && (
            <p>
              投递退避：{time(delivery.nextAttemptAt)}（已尝试 {delivery.attempt} 次）
            </p>
          )}
          {delivery.errorCode === "delivery_unknown" &&
            actionButton("reissue", "人工补发…", () => setConfirmation(delivery.deliveryId))}
          <details>
            <summary className="cursor-pointer text-muted-foreground">投递细节</summary>
            <dl className="mt-2 space-y-1 break-all">
              <dt>deliveryId</dt>
              <dd>{delivery.deliveryId}</dd>
              <dt>runId</dt>
              <dd>{delivery.runId ?? "无"}</dd>
              <dt>taskIds</dt>
              <dd>{delivery.taskIds.join("、") || "无"}</dd>
            </dl>
          </details>
        </div>
      ))}
      <div className="flex flex-wrap items-start gap-3">
        {view.mode === "enabled"
          ? actionButton("disable", "暂停自动接续", () => void submit("disable"))
          : actionButton("enable", "开启自动接续", () => void submit("enable"))}
        {actionButton("abort", "全部停止", () => setConfirmation("abort"))}
        {evaluation &&
          (evaluation.state === "attention" || evaluation.state === "retry_wait") &&
          actionButton("retry", "重试检查", () => void submit("retry"))}
      </div>
      {view.owner.kind === "agent" && view.activeRunIds.length > 0 && !denial("abort") && (
        <div className="space-y-2 border-t border-border pt-3" data-testid="automation-run-control">
          <p>停止这个运行只中止选定的 run，不改自动接续开关与 epoch；全部停止会关闭自动接续。</p>
          {view.activeRunIds.map((runId) => (
            <div key={runId} className="space-y-1">
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() => void submit("abort", runId)}
              >
                停止这个运行
                {view.activeRunIds.length > 1 ? ` · ${runId.slice(-8)}` : ""}
              </Button>
              <p className="text-xs text-muted-foreground">只停止此 run</p>
            </div>
          ))}
        </div>
      )}
      {confirmation !== null && (
        <div
          role="group"
          aria-label="确认自动接续操作"
          className="space-y-3 border-t border-border pt-3"
        >
          <p>
            {confirmation === "abort"
              ? "确认全部停止？此 Chat 所有 queued/running 的 run 会被中止，自动接续随之关闭；Task 不受影响。"
              : "投递结果未知，人工补发可能造成重复处理。确认后将创建新的接续输入。"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                void submit(
                  confirmation === "abort" ? "abort" : "reissue",
                  confirmation === "abort" ? undefined : confirmation,
                )
              }
            >
              确认{confirmation === "abort" ? "全部停止" : "补发"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => setConfirmation(null)}
            >
              取消
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-muted-foreground">检查细节与诊断</summary>
        <dl className="mt-3 space-y-1 break-all">
          <dt>Chat</dt>
          <dd>{view.chatId}</dd>
          <dt>最近控制</dt>
          <dd>
            {view.changedBy ?? "暂无"} · {time(view.changedAt)}
          </dd>
          <dt>revision / epoch</dt>
          <dd>
            {view.revision} / {view.epoch}
          </dd>
          {evaluation && (
            <>
              <dt>evaluationId</dt>
              <dd>{evaluation.evaluationId}</dd>
              <dt>触发来源</dt>
              <dd>{evaluation.source}</dd>
              <dt>检查轮次 / 尝试</dt>
              <dd>
                {evaluation.round} / {evaluation.attempt}
              </dd>
            </>
          )}
          {evaluation?.result && (
            <>
              <dt>判定器 / 模型</dt>
              <dd>
                {evaluation.result.provider} / {evaluation.result.model}
              </dd>
              <dt>reasonCode</dt>
              <dd>{evaluation.result.reasonCode}</dd>
              <dt>逐接收者结论</dt>
              <dd>
                {evaluation.result.recipients.map((item) => (
                  <p key={`${item.recipient.kind}:${item.recipient.id}`}>
                    {item.recipient.id} · {item.decision} · {item.reason}
                  </p>
                ))}
              </dd>
            </>
          )}
          {view.attention && (
            <>
              <dt>requestId</dt>
              <dd>{view.attention.requestId}</dd>
            </>
          )}
        </dl>
      </details>
    </section>
  );
}
