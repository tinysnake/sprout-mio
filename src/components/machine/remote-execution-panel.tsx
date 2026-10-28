import type { LeaseView } from "../../contracts/lease";
import type { ExecutionView } from "../../contracts/remote";
import type { ExecutionCancellationView } from "../../contracts/remote";
import type { MachineDetail } from "../../contracts/machine";
import { formatMoment } from "./machine-view";
import {
  cancellationDisplay,
  EXECUTION_STATE_LABELS,
  executionDetailLabel,
  HOST_TOOL_NOTE,
  OPERATION_KIND_LABELS,
  REMOTE_TARGET_NOTE,
  deadlineFacts,
  executionTarget,
  failureReasonLabel,
  recoveryReasonLabel,
  resultSummary,
  shortExecutionId,
  shortRunId,
  timeoutSourceLabel,
  uncertainResultNote,
} from "./lease-view";
import { StatusLine } from "./machine-list";
import { ExecutionLogViewer } from "./execution-log";
import { ExecutionCancelControl } from "./execution-cancel";
import {
  ExecutionAttentionList,
  ExecutionSummaryBlock,
  type AttentionItem,
} from "./execution-summary";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import {
  connectionCompletenessNote,
  executionAttention,
  executionSegmentKey,
  executionSegmentPresentation,
  executionSummary,
  type ExecutionCanceller,
  type ExecutionLogReader,
  type LeaseFacts,
  type LogConnection,
} from "./presentation";

const ONLINE: LogConnection = { online: true, detail: null };

const toneText = {
  success: "text-status-success",
  warning: "text-status-warning",
  muted: "text-muted-foreground",
  danger: "text-status-failed",
} as const;

/** 远端操作只来自 `executionViewSchema`；本地不推断执行位置，也不重试。 */
export function RemoteExecutionList({
  executions,
  machines,
  holderNames = {},
  logReader,
  canceller,
  connection = ONLINE,
  cancellations = {},
  leases = [],
  onCancelled,
  dense = false,
  /** 只读表面的原因：页面写清这里为什么没有日志读取与取消，不留一句「尚未接入」。 */
  readOnlyNote,
  testId = "remote-executions",
}: {
  executions: readonly ExecutionView[];
  machines: MachineDetail[];
  holderNames?: Readonly<Record<string, string>>;
  /** 日志读取与取消都是可选注入：没有接入时只显示已有事实，不自己造结果。 */
  logReader?: ExecutionLogReader;
  canceller?: ExecutionCanceller;
  connection?: LogConnection;
  cancellations?: Readonly<Record<string, ExecutionCancellationView>>;
  /** 租约事实只用于判定执行是否还归发起它的分身；缺省时不猜。 */
  leases?: readonly LeaseView[];
  onCancelled?: (view: ExecutionCancellationView) => void;
  /** 只读掠影：位点照常显示，日志与取消控件收起来（inspector、设置页）。 */
  dense?: boolean;
  readOnlyNote?: string;
  testId?: string;
}) {
  // 没有注入读取与取消入口时自动收成只读：不在每条执行上重复一行「尚未接入」。
  const wired = Boolean(logReader ?? canceller);
  const compact = dense || !wired;
  const now = new Date();
  const machineLabel = (machineId: string) =>
    machines.find((item) => item.machine.id === machineId)?.machine.name ?? machineId;
  const leaseFor = (execution: ExecutionView): LeaseFacts | null => {
    const lease = leases.find(
      (item) => item.projectId === execution.projectId && item.machineId === execution.machineId,
    );
    if (!lease) return null;
    return {
      state: lease.state,
      holderInstanceId: lease.holderInstanceId,
      generation: lease.generation,
    };
  };
  // 页面刚发出的取消事实比执行视图里的旧值新，判定与卡片都用同一份。
  const withCancellation = (execution: ExecutionView): ExecutionView => {
    const cancellation = cancellations[execution.executionId];
    if (!cancellation || cancellation === execution.cancellation) return execution;
    return { ...execution, cancellation };
  };
  const summarized = executionSummary(executions);
  const attentionItems: AttentionItem[] = executions.flatMap((execution) => {
    const view = withCancellation(execution);
    const attention = executionAttention(view, leaseFor(execution), now);
    return attention
      ? [{ execution: view, attention, machineLabel: machineLabel(execution.machineId) }]
      : [];
  });
  return (
    <section data-testid={testId} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium">远端操作</h4>
        <span className="text-[0.6875rem] text-muted-foreground">
          每条操作都指定 Machine，与宿主工具分开
        </span>
      </div>
      <p
        data-testid={`${testId}-target-note`}
        className="text-[0.6875rem] leading-5 text-muted-foreground"
      >
        {REMOTE_TARGET_NOTE}
      </p>
      {readOnlyNote ? (
        <p
          data-testid={`${testId}-read-only`}
          className="text-[0.6875rem] leading-5 text-muted-foreground"
        >
          {readOnlyNote}
        </p>
      ) : (
        !wired && (
          <p
            data-testid={`${testId}-not-wired`}
            className="text-[0.6875rem] leading-5 text-muted-foreground"
          >
            日志续读与取消入口尚未接入服务端：此处只显示已知的执行事实与日志位点，未接入前不提供读取与取消操作。
          </p>
        )
      )}
      {connectionCompletenessNote(connection) && (
        <p data-testid={`${testId}-offline`} className="text-xs text-status-warning">
          {connectionCompletenessNote(connection)}
        </p>
      )}
      {executions.length === 0 ? (
        <p data-testid={`${testId}-empty`} className="text-xs text-muted-foreground">
          还没有远端操作记录。
        </p>
      ) : (
        <div className="space-y-4">
          <ExecutionAttentionList
            items={attentionItems}
            {...(canceller ? { canceller } : {})}
            connection={connection}
            cancellations={cancellations}
            {...(onCancelled ? { onCancelled } : {})}
            testId={`${testId}-attention`}
          />
          <div data-testid={`${testId}-list`} className="space-y-3">
            {summarized.map((summary) => (
              <ExecutionSummaryBlock
                key={summary.machineId}
                summary={summary}
                machineLabel={machineLabel(summary.machineId)}
                debugSlot={
                  <ExecutionDebugDialog
                    machineLabel={machineLabel(summary.machineId)}
                    executions={executions.filter(
                      (execution) => execution.machineId === summary.machineId,
                    )}
                    machines={machines}
                    holderNames={holderNames}
                    {...(logReader ? { logReader } : {})}
                    {...(canceller ? { canceller } : {})}
                    {...(onCancelled ? { onCancelled } : {})}
                    connection={connection}
                    cancellations={cancellations}
                    dense={compact}
                    testId={`${testId}-debug-${summary.machineId}`}
                  />
                }
                testId={`${testId}-summary`}
              />
            ))}
          </div>
        </div>
      )}
      <p
        data-testid={`${testId}-host-note`}
        className="text-[0.6875rem] leading-5 text-muted-foreground"
      >
        {HOST_TOOL_NOTE}
      </p>
    </section>
  );
}

/**
 * 调试详情：默认不渲染，点开才挂载今天的执行卡片。
 * 日志读取仍走注入的 `logReader`；Dialog 关闭即卸载内容，日志请求状态不保留。
 */
function ExecutionDebugDialog({
  machineLabel,
  executions,
  machines,
  holderNames = {},
  logReader,
  canceller,
  connection,
  cancellations,
  onCancelled,
  dense,
  testId,
}: {
  machineLabel: string;
  executions: readonly ExecutionView[];
  machines: MachineDetail[];
  holderNames?: Readonly<Record<string, string>>;
  logReader?: ExecutionLogReader;
  canceller?: ExecutionCanceller;
  connection: LogConnection;
  cancellations: Readonly<Record<string, ExecutionCancellationView>>;
  onCancelled?: (view: ExecutionCancellationView) => void;
  dense: boolean;
  testId: string;
}) {
  return (
    <Dialog>
      <DialogTrigger
        render={<Button type="button" size="xs" variant="ghost" data-testid={`${testId}-open`} />}
      >
        调试详情
      </DialogTrigger>
      <DialogContent data-testid={`${testId}-dialog`} className="w-[min(760px,calc(100%-2.5rem))]">
        <DialogHeader>
          <DialogTitle>调试详情</DialogTitle>
          <DialogDescription>
            {machineLabel} ·
            今天的执行卡片：状态、退出结果、日志正文与游标、保留限制、恢复原因与取消事实。
            关闭抽屉后不保留日志请求。
          </DialogDescription>
        </DialogHeader>
        <ol className="min-w-0 divide-y divide-border">
          {executions.map((execution) => (
            <li key={execution.executionId} className="min-w-0 py-3">
              <RemoteExecutionCard
                execution={execution}
                machine={machines.find((item) => item.machine.id === execution.machineId)}
                holderNames={holderNames}
                {...(logReader ? { logReader } : {})}
                {...(canceller ? { canceller } : {})}
                {...(onCancelled ? { onCancelled } : {})}
                connection={connection}
                cancellation={cancellations[execution.executionId] ?? null}
                dense={dense}
                testId={`${testId}-item`}
              />
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  );
}

export function RemoteExecutionCard({
  execution,
  machine,
  holderNames = {},
  logReader,
  canceller,
  connection = ONLINE,
  cancellation = null,
  onCancelled,
  dense = false,
  testId = "remote-execution",
}: {
  execution: ExecutionView;
  machine: MachineDetail | undefined;
  holderNames?: Readonly<Record<string, string>>;
  logReader?: ExecutionLogReader;
  canceller?: ExecutionCanceller;
  connection?: LogConnection;
  cancellation?: ExecutionCancellationView | null;
  onCancelled?: (view: ExecutionCancellationView) => void;
  dense?: boolean;
  testId?: string;
}) {
  const state = EXECUTION_STATE_LABELS[execution.state];
  // 取消仍是终态 failed，但卡片展示的是分段语义：已取消不等于失败。
  const segment = executionSegmentPresentation(executionSegmentKey(execution));
  const reason = failureReasonLabel(execution.failureReason);
  const recoveryReason = recoveryReasonLabel(execution.recoveryReason);
  const summary = resultSummary(execution);
  const holderName = holderNames[execution.holderInstanceId] ?? "未知分身";
  const deadlines = deadlineFacts(execution);
  const timeoutSource = timeoutSourceLabel(execution);
  const uncertain = uncertainResultNote(execution);
  return (
    <div
      data-testid={testId}
      data-execution-id={execution.executionId}
      data-execution-state={execution.state}
      className="min-w-0 space-y-1"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 font-medium">
          <span data-testid={`${testId}-kind`}>
            {OPERATION_KIND_LABELS[execution.operation.kind]}
          </span>
          <span className="text-muted-foreground"> · </span>
          <span data-testid={`${testId}-target`} className="break-all">
            {executionTarget(execution, machine?.machine.name)}
          </span>
        </p>
        <span className="flex flex-none flex-wrap items-baseline gap-1.5">
          <StatusLine label={segment.label} tone={segment.tone} testId={`${testId}-state`} />
          {/* 状态与原因同一行：取消不能一边说失败、一边把原因另起一段。 */}
          {reason && (
            <span data-testid={`${testId}-reason`} className={toneText[segment.tone]}>
              · {reason}
            </span>
          )}
        </span>
      </div>
      <p className="text-muted-foreground">{executionDetailLabel(execution)}</p>
      {/*
        稳定定位：执行 id 在页面恢复、刷新与重连后不变，是继续查看同一条执行的唯一入口。
        它可与下发会话/序号区分：后者是投递事实，不是执行身份。
      */}
      <p data-testid={`${testId}-identity`} className="text-muted-foreground">
        执行{" "}
        <span title={execution.executionId} data-testid={`${testId}-execution`}>
          {shortExecutionId(execution.executionId)}
        </span>
        <span className="text-muted-foreground"> · </span>
        下发会话{" "}
        {execution.dispatchConnectionGeneration === null
          ? "无记录"
          : `代次 ${execution.dispatchConnectionGeneration}`}
        {execution.dispatchSeq === null ? "" : ` 序号 ${execution.dispatchSeq}`}
      </p>
      {/*
        命令正文、文件路径与远端输出都不上界面：一期没有审计产品，这些内容可能含密钥。
        人类可决策的事实仍然全部保留：操作类型、目标、状态、失败原因、结果元信息与时间。
      */}
      <p data-testid={`${testId}-authorization`} className="text-muted-foreground">
        授权代次 {execution.authorizationGeneration} · 持有者 {holderName} · 由该分身的一次运行发起{" "}
        <span title={execution.runId} data-testid={`${testId}-run`}>
          （{shortRunId(execution.runId)}）
        </span>
      </p>
      <p className="text-muted-foreground">
        提交 {formatMoment(execution.createdAt)}
        {execution.dispatchedAt ? ` · 下发 ${formatMoment(execution.dispatchedAt)}` : ""}
        {execution.terminalAt ? ` · 终态 ${formatMoment(execution.terminalAt)}` : ""}
      </p>
      {/*
        下发窗口与运行上限是两个不同的截止时间：分开列，不给它们一个共同的
        「截止」标签，也不拿其中一个冒充另一个。
      */}
      <dl data-testid={`${testId}-deadlines`} className="space-y-0.5 text-[0.6875rem] leading-5">
        {deadlines.map((fact) => (
          <div
            key={fact.key}
            data-testid={`${testId}-deadline-${fact.key}`}
            data-deadline-at={fact.at ?? "none"}
            className="min-w-0"
          >
            <dt className="inline font-medium">{fact.label}</dt>
            <dd className="inline text-muted-foreground">
              {" "}
              {fact.at ? formatMoment(fact.at) : "未登记"} · {fact.note}
            </dd>
          </div>
        ))}
      </dl>
      {timeoutSource && (
        <p data-testid={`${testId}-timeout-source`} className={toneText.danger}>
          {timeoutSource}
        </p>
      )}
      {/* 退出结果与失败原因分开：一条说命令自己怎么退出，一条说为什么没成功。 */}
      {summary.length > 0 && (
        <ul data-testid={`${testId}-result`} className="space-y-0.5 text-[0.6875rem] leading-5">
          <li className="text-muted-foreground">退出结果</li>
          {summary.map((line) => (
            <li key={line} className={state.terminal ? toneText[state.tone] : toneText.muted}>
              {line}
            </li>
          ))}
        </ul>
      )}
      {recoveryReason && (
        <p data-testid={`${testId}-recovery-reason`} className={toneText.warning}>
          未知的原因：{recoveryReason}
        </p>
      )}
      {uncertain && (
        <p data-testid={`${testId}-uncertain`} className={toneText.warning}>
          {uncertain}
        </p>
      )}
      {!state.terminal && (
        <p data-testid={`${testId}-unfinished`} className="text-[0.6875rem] text-muted-foreground">
          未到终态：不显示成功，也不提供隐式重跑。
        </p>
      )}
      <div className="space-y-3 pt-1">
        <ExecutionLogViewer
          execution={execution}
          read={logReader}
          connection={connection}
          dense={dense}
          testId={`${testId}-log`}
        />
        {!dense && (
          <ExecutionCancelControl
            execution={execution}
            cancel={canceller}
            connection={connection}
            cancellation={cancellation}
            {...(onCancelled ? { onCancelled } : {})}
            testId={`${testId}-cancel`}
          />
        )}
        {dense && cancellation && (
          <p
            data-testid={`${testId}-cancel-dense`}
            data-cancellation-state={cancellation.state}
            className="text-[0.6875rem] leading-5 text-muted-foreground"
          >
            {cancellationDisplay(cancellation).label} · {cancellationDisplay(cancellation).detail}
          </p>
        )}
      </div>
      {/* 只有不确定的执行点名「本页没有重跑」：确定的终态不需要一句重复的免责。 */}
      {uncertain && (
        <p
          data-testid={`${testId}-no-rerun`}
          className="text-[0.6875rem] leading-5 text-muted-foreground"
        >
          本页不提供重跑：要继续只能在新的显式操作里重新发起。
        </p>
      )}
    </div>
  );
}

/** 宿主与远端目标的对照：用于 Machine 详情与 inspector 的同一事实来源。 */
export function ExecutionTargetTable({
  executions,
  machines,
  testId = "execution-targets",
}: {
  executions: readonly ExecutionView[];
  machines: MachineDetail[];
  testId?: string;
}) {
  return (
    <table data-testid={testId} className="w-full table-fixed text-left text-xs leading-6">
      <caption className="sr-only">远端操作目标与结果</caption>
      <thead className="text-muted-foreground">
        <tr>
          <th scope="col" className="w-28 font-normal">
            操作
          </th>
          <th scope="col" className="font-normal">
            目标 Machine
          </th>
          <th scope="col" className="w-20 font-normal">
            状态
          </th>
        </tr>
      </thead>
      <tbody>
        {executions.map((execution) => {
          const state = EXECUTION_STATE_LABELS[execution.state];
          const machine = machines.find((item) => item.machine.id === execution.machineId);
          return (
            <tr key={execution.executionId} data-testid={`${testId}-row`}>
              <td className="align-top">{OPERATION_KIND_LABELS[execution.operation.kind]}</td>
              <td
                data-testid={`${testId}-row-target`}
                className="min-w-0 align-top break-all text-muted-foreground"
              >
                {executionTarget(execution, machine?.machine.name)}
              </td>
              <td className={`align-top ${toneText[state.tone]}`}>{state.label}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
