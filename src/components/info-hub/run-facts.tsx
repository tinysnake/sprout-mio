import {
  turnStartContextSchema,
  type AgentRunsView,
  type TurnStartContext,
} from "../../contracts/info-hub";

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

export const SUMMARY_TONE: Record<string, string> = {
  completed: "text-status-success",
  failed: "text-destructive",
};

/** 历史 run 只做聚合：按状态计数，不逐条罗列每次开始与结束时间。完成在前、失败在后。 */
export function orderedCounts(runs: readonly { status: string }[]) {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  const order = [
    "completed",
    ...[...counts.keys()].filter((status) => status !== "completed" && status !== "failed"),
    "failed",
  ];
  return order
    .filter((status) => counts.has(status))
    .map((status) => ({ status, count: counts.get(status) ?? 0 }));
}

/**
 * run 事实只消费视图对象；pending 输入一律显示为未投递，仓库依据显示来源、
 * ref、真实 commit 与 fresh。当前 run 与状态汇总常显，历史 run 的流水账收敛成计数：
 * 逐条错误串既没有上下文也没有可做的事，Human 评审要求不再平铺。
 */
export function RunFactsBlock({ runs, testId }: { runs: AgentRunsView; testId: string }) {
  // recent 为最新优先：取最近一次带仓库依据的 run，代表当前工作副本来源。
  const latestRepo = runs.recent.find((run) => run.repo)?.repo;
  return (
    <section data-testid={testId} className="space-y-1.5 text-[11px]">
      <p className="font-medium">
        活动 run
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
              <p className="break-all text-muted-foreground">
                run {run.runId} · Chat {run.chatId} · 分身 {run.instanceId}
              </p>
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
        {runs.recent.length === 0 ? (
          "还没有历史 run。"
        ) : (
          <>
            最近 {runs.recent.length} 个 run：
            {orderedCounts(runs.recent).map(({ status, count }, index) => (
              <span key={status}>
                {index > 0 && "、"}
                <span data-testid={`${testId}-recent-${status}`} className={SUMMARY_TONE[status]}>
                  {statusLabel(status)} {count}
                </span>
              </span>
            ))}
          </>
        )}
      </p>
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

/**
 * 注入事实的唯一表达：只有持久化的 submitted 收据能说明这次上下文跨过了 SDK 提交边界。
 * prepared、failed 与「还没有快照」都只能读作「未注入」，并且不能说成「已注入」。
 */
function TurnPromptInjectionFact({ injected }: { injected: boolean }) {
  return (
    <p data-testid="info-turn-prompt-injection" className="text-[10px] text-muted-foreground">
      {injected
        ? "已注入；本次上下文已跨过 SDK 提交边界，收据只确认提交，不表示模型已理解。"
        : "注入模型 prompt：否 · 本次上下文尚无提交收据。"}
    </p>
  );
}

/** 持久化的轮初快照；只有 submitted 收据能够证明已跨过 SDK 提交边界。 */
export function TurnStartContextBlock({ context }: { context: TurnStartContext | null }) {
  if (!context)
    return (
      <section data-testid="info-turn-context-none" className="space-y-1.5 text-[11px]">
        <p data-testid="info-turn-context-empty" className="text-muted-foreground">
          还没有本轮上下文快照。
        </p>
        <TurnPromptInjectionFact injected={false} />
      </section>
    );
  if (!turnStartContextSchema.safeParse(context).success)
    return (
      <p role="alert" className="text-[11px] text-destructive">
        轮初快照读取失败：返回数据不符合 Info Hub 契约。
      </p>
    );
  const deliveryLabels = {
    prepared: "已准备，待提交",
    submitted: "已注入（已提交至 SDK）",
    failed: "提交失败",
  };
  return (
    <section
      data-testid="info-turn-context"
      className="min-w-0 space-y-1.5 text-[11px] [overflow-wrap:anywhere]"
    >
      <p className="font-medium">轮初必要上下文</p>
      <p data-testid="info-turn-run-id" className="break-all text-muted-foreground">
        本次快照所属 run：{context.runId}
      </p>
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-y-1">
        <dt className="text-muted-foreground">捕获时间</dt>
        <dd data-testid="info-turn-captured-at">{context.capturedAt}</dd>
        <dt className="text-muted-foreground">快照字节数</dt>
        <dd data-testid="info-turn-bytes">
          {new TextEncoder().encode(context.serializedText).byteLength} bytes
        </dd>
        <dt className="text-muted-foreground">deliveryState</dt>
        <dd data-testid="info-turn-delivery-state" data-state={context.deliveryState}>
          {context.deliveryState} · {deliveryLabels[context.deliveryState]}
        </dd>
        <dt className="text-muted-foreground">submittedAt</dt>
        <dd data-testid="info-turn-submitted-at">{context.submittedAt ?? "尚无提交收据"}</dd>
      </dl>
      {context.failureCode && <p className="text-destructive">失败原因：{context.failureCode}</p>}
      {context.truncated && (
        <p className="text-muted-foreground">快照经过裁剪，完整当前事实请查看对应视角。</p>
      )}
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
      <TurnPromptInjectionFact injected={context.injectedIntoPrompt} />
    </section>
  );
}
