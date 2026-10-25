import type { ExecutionView } from "../../contracts/remote";
import type { MachineDetail } from "../../contracts/machine";
import { formatMoment } from "./machine-view";
import {
  EXECUTION_STATE_LABELS,
  HOST_TOOL_NOTE,
  OPERATION_KIND_LABELS,
  REMOTE_TARGET_NOTE,
  executionTarget,
  failureReasonLabel,
  resultSummary,
  shortRunId,
} from "./lease-view";
import { StatusLine } from "./machine-list";

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
  testId = "remote-executions",
}: {
  executions: readonly ExecutionView[];
  machines: MachineDetail[];
  holderNames?: Readonly<Record<string, string>>;
  testId?: string;
}) {
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
      {executions.length === 0 ? (
        <p data-testid={`${testId}-empty`} className="text-xs text-muted-foreground">
          还没有远端操作记录。
        </p>
      ) : (
        <ol data-testid={`${testId}-list`} className="min-w-0 divide-y divide-border">
          {executions.map((execution) => (
            <li key={execution.executionId} className="min-w-0 py-3">
              <RemoteExecutionCard
                execution={execution}
                machine={machines.find((item) => item.machine.id === execution.machineId)}
                holderNames={holderNames}
                testId={`${testId}-item`}
              />
            </li>
          ))}
        </ol>
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

export function RemoteExecutionCard({
  execution,
  machine,
  holderNames = {},
  testId = "remote-execution",
}: {
  execution: ExecutionView;
  machine: MachineDetail | undefined;
  holderNames?: Readonly<Record<string, string>>;
  testId?: string;
}) {
  const state = EXECUTION_STATE_LABELS[execution.state];
  const reason = failureReasonLabel(execution.failureReason);
  const summary = resultSummary(execution);
  const holderName = holderNames[execution.holderInstanceId] ?? "未知分身";
  return (
    <div data-testid={testId} data-execution-state={execution.state} className="min-w-0 space-y-1">
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
        <StatusLine label={state.label} tone={state.tone} testId={`${testId}-state`} />
      </div>
      <p className="text-muted-foreground">{state.detail}</p>
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
        提交 {formatMoment(execution.createdAt)} · 截止 {formatMoment(execution.deadlineAt)}
        {execution.terminalAt ? ` · 终态 ${formatMoment(execution.terminalAt)}` : ""}
      </p>
      {reason && (
        <p data-testid={`${testId}-reason`} className={toneText.danger}>
          {reason}
        </p>
      )}
      {summary.length > 0 && (
        <ul data-testid={`${testId}-result`} className="space-y-0.5 text-[0.6875rem] leading-5">
          {summary.map((line) => (
            <li key={line} className={state.terminal ? toneText[state.tone] : toneText.muted}>
              {line}
            </li>
          ))}
        </ul>
      )}
      {!state.terminal && (
        <p data-testid={`${testId}-unfinished`} className="text-[0.6875rem] text-muted-foreground">
          未到终态：不显示成功，也不提供隐式重跑。
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
