import type { AgentRunsView, TurnStartContext } from "../../contracts/info-hub";

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  aborted: "已停止",
  interrupted: "已中断",
};

/** run 事实只消费视图对象；pending 输入一律显示为未投递，仓库依据显示来源、ref、真实 commit 与 fresh。 */
export function RunFactsBlock({ runs, testId }: { runs: AgentRunsView; testId: string }) {
  return (
    <section
      data-testid={testId}
      className="space-y-2 rounded-lg border border-dashed px-4 py-3 text-sm"
    >
      <p className="font-medium">
        Agent 运行状态与活动 run
        <span data-testid={`${testId}-host-status`} className="ml-2 text-xs text-muted-foreground">
          {runs.hostEnabled ? "宿主已启用" : "宿主未启用"}
        </span>
      </p>
      <ul data-testid={`${testId}-active`} className="space-y-1">
        {runs.active.length === 0 ? (
          <li data-testid={`${testId}-active-empty`} className="text-muted-foreground">
            当前没有排队中或运行中的 run。
          </li>
        ) : (
          runs.active.map((run) => (
            <li key={run.runId} data-testid={`${testId}-active-item`} data-run-id={run.runId}>
              <span data-testid={`${testId}-active-status`}>
                {STATUS_LABELS[run.status] ?? run.status}
              </span>
              {run.pendingInputs > 0 && (
                <span data-testid={`${testId}-active-pending`}>
                  ，{run.pendingInputs} 条输入未投递
                </span>
              )}
            </li>
          ))
        )}
      </ul>
      <ul data-testid={`${testId}-recent`} className="space-y-1">
        {runs.recent.map((run) => (
          <li key={run.runId} data-testid={`${testId}-recent-item`} data-run-id={run.runId}>
            <span data-testid={`${testId}-recent-status`}>
              {STATUS_LABELS[run.status] ?? run.status}
            </span>
            <span className="text-muted-foreground">，开始于 {run.queuedAt}</span>
            {run.settledAt && (
              <span className="text-muted-foreground">，结束于 {run.settledAt}</span>
            )}
            {run.errorCode && (
              <span data-testid={`${testId}-recent-error`} className="block text-xs">
                {run.errorCode}：{run.errorMessage ?? "未知失败原因"}
              </span>
            )}
            {run.errorCode && (
              <span
                data-testid={`${testId}-recent-error-request`}
                className="block font-mono text-xs"
              >
                requestId: {run.requestId}
              </span>
            )}
            {run.repo && (
              <span data-testid={`${testId}-recent-repo`} className="block text-xs">
                来源 {run.repo.source}（
                {run.repo.sourceKind === "managed_clone" ? "宿主克隆" : "本地副本"}）·
                {run.repo.ref} @ {run.repo.commit} ·{" "}
                {run.repo.fresh ? "宿主已更新工作树" : "未改写工作树"} ·{" "}
                {run.repo.fetchedAt ? `获取于 ${run.repo.fetchedAt}` : "宿主未取过"}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 轮初必要上下文：不注入模型 prompt 的声明与各事实一并呈现。 */
export function TurnStartContextBlock({ context }: { context: TurnStartContext }) {
  return (
    <section
      data-testid="info-turn-context"
      className="space-y-1 rounded-lg border border-dashed px-4 py-3 text-sm"
    >
      <p className="font-medium">轮初必要上下文</p>
      <p className="text-muted-foreground">
        分身 {context.profileName ?? "（缺少分身记录）"}（
        <span data-testid="info-turn-instance-id" className="font-mono text-xs">
          {context.instanceId ?? "无"}
        </span>
        ）· 宿主
        <span data-testid="info-turn-host-status">{context.hostEnabled ? "已启用" : "未启用"}</span>
      </p>
      <p data-testid="info-turn-workspace">
        {context.workspace ? (
          <>
            本轮工作副本（
            {context.workspace.basis === "run_provenance"
              ? "活动 run 依据"
              : "Project 最近就绪副本"}
            ）：<span data-testid="info-turn-workspace-path">{context.workspace.path}</span> ·{" "}
            <span data-testid="info-turn-workspace-ref">{context.workspace.ref}</span> @{" "}
            <span data-testid="info-turn-workspace-commit">{context.workspace.commit}</span> ·{" "}
            <span data-testid="info-turn-workspace-fresh">
              {context.workspace.fresh === undefined
                ? "fresh 未知（本轮尚未运行）"
                : context.workspace.fresh
                  ? "宿主已更新工作树"
                  : "未改写工作树"}
            </span>
          </>
        ) : (
          "本轮工作副本：Project 未配置仓库，沿用分身实例目录。"
        )}
      </p>
      <p data-testid="info-turn-active-run">
        {context.activeRun
          ? `已有活动 run（${STATUS_LABELS[context.activeRun.status] ?? context.activeRun.status}），${context.activeRun.pendingInputs} 条输入未投递`
          : "尚无排队中或运行中的 run"}
      </p>
      <p data-testid="info-turn-previous-run">
        {context.previousRun ? (
          <>
            上一次 run：{STATUS_LABELS[context.previousRun.status] ?? context.previousRun.status}
            {context.previousRun.errorCode &&
              `（${context.previousRun.errorCode}：${context.previousRun.errorMessage ?? "未知失败原因"}）`}
            <span className="ml-2 font-mono text-xs">
              requestId: {context.previousRun.requestId}
            </span>
          </>
        ) : (
          "上一次 run：还没有历史 run"
        )}
      </p>
      <p data-testid="info-turn-prompt-injection" className="text-xs text-muted-foreground">
        注入模型 prompt：否（本上下文只供人与后续 P6 查询使用）
      </p>
    </section>
  );
}
