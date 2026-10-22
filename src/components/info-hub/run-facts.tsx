import type { AgentRunsView, TurnStartContext } from "../../contracts/info-hub";

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  aborted: "已停止",
  interrupted: "已中断",
};

function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}

/** 历史 run 只做聚合：按状态计数，不逐条罗列每次开始与结束时间。 */
function statusCounts(runs: AgentRunsView["recent"]) {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  return [...counts].map(([status, count]) => `${statusLabel(status)} ${count}`).join("、");
}

/**
 * run 事实只消费视图对象；pending 输入一律显示为未投递，仓库依据显示来源、
 * ref、真实 commit 与 fresh。当前 run 与失败汇总常显，历史 run 的流水账
 * 收敛成计数；需要细节时可从失败项与轮初上下文继续追踪。
 */
export function RunFactsBlock({ runs, testId }: { runs: AgentRunsView; testId: string }) {
  const failures = runs.recent.filter((run) => run.errorCode);
  // recent 为最新优先：取最近一次带仓库依据的 run，代表当前工作副本来源。
  const latestRepo = runs.recent.find((run) => run.repo)?.repo;
  return (
    <section data-testid={testId} className="space-y-1.5 text-[11px]">
      <p className="font-medium">
        Agent 运行状态
        <span data-testid={`${testId}-host-status`} className="ml-2 text-muted-foreground">
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
              <span data-testid={`${testId}-active-status`}>{statusLabel(run.status)}</span>
              {run.pendingInputs > 0 && (
                <span data-testid={`${testId}-active-pending`}>
                  ，{run.pendingInputs} 条输入未投递
                </span>
              )}
            </li>
          ))
        )}
      </ul>
      <p
        data-testid={`${testId}-recent`}
        data-run-count={runs.recent.length}
        className="text-muted-foreground"
      >
        {runs.recent.length === 0
          ? "还没有历史 run。"
          : `最近 ${runs.recent.length} 个 run：${statusCounts(runs.recent)}`}
      </p>
      {failures.length > 0 && (
        <ul data-testid={`${testId}-failures`} className="space-y-1">
          {failures.map((run) => (
            <li
              key={run.runId}
              data-testid={`${testId}-recent-error`}
              data-run-id={run.runId}
              className="text-status-failed"
            >
              <span>
                {statusLabel(run.status)}：{run.errorCode}：{run.errorMessage ?? "未知失败原因"}
              </span>
              <span
                data-testid={`${testId}-recent-error-request`}
                className="block font-mono break-all text-muted-foreground"
              >
                requestId: {run.requestId}
              </span>
            </li>
          ))}
        </ul>
      )}
      {latestRepo && (
        <p data-testid={`${testId}-recent-repo`} className="text-muted-foreground">
          最近一次 run 的仓库依据：{latestRepo.source}（
          {latestRepo.sourceKind === "managed_clone" ? "宿主克隆" : "本地副本"}）·
          {latestRepo.ref} @ {latestRepo.commit} ·{" "}
          {latestRepo.fresh ? "宿主已更新工作树" : "未改写工作树"} ·{" "}
          {latestRepo.fetchedAt ? `获取于 ${latestRepo.fetchedAt}` : "宿主未取过"}
        </p>
      )}
    </section>
  );
}

/** 轮初必要上下文：不注入模型 prompt 的声明与各事实一并呈现。 */
export function TurnStartContextBlock({ context }: { context: TurnStartContext }) {
  return (
    <section data-testid="info-turn-context" className="space-y-1.5 text-[11px]">
      <p className="font-medium">轮初必要上下文</p>
      <p className="text-muted-foreground">
        分身 {context.profileName ?? "（缺少分身记录）"}（
        <span data-testid="info-turn-instance-id" className="font-mono">
          {context.instanceId ?? "无"}
        </span>
        ）· 宿主
        <span data-testid="info-turn-host-status">{context.hostEnabled ? "已启用" : "未启用"}</span>
      </p>
      <p data-testid="info-turn-workspace" className="text-muted-foreground">
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
      <p data-testid="info-turn-active-run" className="text-muted-foreground">
        {context.activeRun
          ? `已有活动 run（${statusLabel(context.activeRun.status)}），${context.activeRun.pendingInputs} 条输入未投递`
          : "尚无排队中或运行中的 run"}
      </p>
      <p data-testid="info-turn-previous-run" className="text-muted-foreground">
        {context.previousRun ? (
          <>
            上一次 run：{statusLabel(context.previousRun.status)}
            {context.previousRun.errorCode &&
              `（${context.previousRun.errorCode}：${context.previousRun.errorMessage ?? "未知失败原因"}）`}
            <span className="ml-2 font-mono break-all">
              requestId: {context.previousRun.requestId}
            </span>
          </>
        ) : (
          "上一次 run：还没有历史 run"
        )}
      </p>
      <p data-testid="info-turn-prompt-injection" className="text-[10px] text-muted-foreground">
        注入模型 prompt：否（本上下文只供人与后续 P6 查询使用）
      </p>
    </section>
  );
}
