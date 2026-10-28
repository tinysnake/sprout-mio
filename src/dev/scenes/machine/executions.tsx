import { useState } from "react";
import type { ExecutionCancellationView, ExecutionLogReadView } from "../../../contracts/remote";
import type { AppError, AppResult } from "../../../contracts/result";
import { PageFrame } from "../../../components/layout/page-frame";
import { Button } from "../../../components/ui/button";
import { Select } from "../../../components/ui/select";
import { RemoteExecutionList } from "../../../components/machine/remote-execution-panel";
import { DEMO_REQUEST_ID } from "../management/fixtures";
import { demoMachineDetails } from "./fixtures";
import {
  demoCancellationStates,
  demoCancellations,
  demoExecutionRecords,
  demoHolderNames,
  demoLeases,
  demoLogPageResumed,
  demoLogPages,
} from "./lease-fixtures";

/**
 * 长命令、日志与取消的演示场景。所有结果都由演示控件显式结算：
 * 读取只返回固定的一页，取消只返回选定的那一种状态，没有计时器把请求变成成功。
 */

type CancellationState = ExecutionCancellationView["state"];
type LogFailure = "none" | "gap" | "cursor_stale" | "network";

const fail = (error: AppError): AppResult<never> => ({
  ok: false,
  error,
  requestId: DEMO_REQUEST_ID,
});

export function ExecutionsScene({ go }: { go: (to: string) => void }) {
  const [cancellations, setCancellations] =
    useState<Record<string, ExecutionCancellationView>>(demoCancellations);
  const [nextState, setNextState] = useState<CancellationState>("delivered");
  const [logFailure, setLogFailure] = useState<LogFailure>("none");
  const [online, setOnline] = useState(true);

  /** 读取返回固定页：第一次给首屏，之后给续读页；失败按演示下拉结算。 */
  function read(request: { executionId: string; cursor: { nextSequence: number } | null }) {
    if (logFailure === "network")
      return Promise.reject(new Error("DEMO_LOG_NETWORK_FAILURE secret-stack-detail"));
    if (logFailure !== "none")
      return Promise.resolve(
        fail({
          code: logFailure === "gap" ? "execution_log_gap" : "execution_log_cursor_stale",
          message:
            logFailure === "gap"
              ? "日志区段已被裁剪，请从新的可读起点重新读取"
              : "日志游标已过期，请重新读取",
          requestId: DEMO_REQUEST_ID,
        }),
      );
    const page = demoLogPages[request.executionId];
    if (!page)
      return Promise.resolve(
        fail({
          code: "execution_log_unavailable",
          message: "该执行还没有可读日志",
          requestId: DEMO_REQUEST_ID,
        }),
      );
    const view: ExecutionLogReadView =
      request.cursor === null
        ? { ...page, workerOnline: online }
        : { ...demoLogPageResumed, workerOnline: online };
    return Promise.resolve({ ok: true as const, data: view, requestId: DEMO_REQUEST_ID });
  }

  /** 取消只返回演示下拉选定的状态；返回什么就显示什么，不做乐观转换。 */
  function cancel(executionId: string) {
    const base = cancellations[executionId] ?? demoCancellationStates.requested;
    const next: ExecutionCancellationView = {
      ...demoCancellationStates[nextState],
      projectId: base.projectId,
      machineId: base.machineId,
      executionId,
    };
    setCancellations((current) => ({ ...current, [executionId]: next }));
    return Promise.resolve<AppResult<ExecutionCancellationView>>({
      ok: true,
      data: next,
      requestId: DEMO_REQUEST_ID,
    });
  }

  return (
    <PageFrame
      title="长命令与不确定结果"
      description="演示场景：执行记录、日志位点与取消事实都来自固定 fixture；读取与取消由控件显式结算，不连接业务服务。"
      back={
        <a
          href="/machines"
          data-testid="executions-scene-back"
          onClick={(event) => {
            event.preventDefault();
            go("/machines");
          }}
        >
          返回 Machines
        </a>
      }
      testId="executions-scene"
    >
      <div className="space-y-8">
        <section
          data-testid="executions-scene-controls"
          className="rounded-container border border-border p-3"
        >
          <h2 className="text-sm font-medium">演示控制</h2>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <label className="block text-xs" htmlFor="executions-demo-cancel-state">
              取消请求的返回状态
              <Select
                id="executions-demo-cancel-state"
                data-testid="executions-demo-cancel-state"
                className="mt-1 w-full"
                value={nextState}
                onChange={(event) => setNextState(event.target.value as CancellationState)}
              >
                <option value="requested">requested：已请求，未送达</option>
                <option value="delivered">delivered：已送达，不等于已停止</option>
                <option value="exited_observed">exited_observed：已观察到退出</option>
                <option value="already_exited">already_exited：此前已结束</option>
                <option value="failed">failed：取消失败</option>
                <option value="unknown">unknown：取消结果未知</option>
              </Select>
            </label>
            <label className="block text-xs" htmlFor="executions-demo-log-failure">
              日志读取结果
              <Select
                id="executions-demo-log-failure"
                data-testid="executions-demo-log-failure"
                className="mt-1 w-full"
                value={logFailure}
                onChange={(event) => setLogFailure(event.target.value as LogFailure)}
              >
                <option value="none">正常返回一页</option>
                <option value="gap">拒绝：游标早于可读起点</option>
                <option value="cursor_stale">拒绝：游标已过期</option>
                <option value="network">抛错：网络异常</option>
              </Select>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant="secondary"
              data-testid="executions-demo-go-offline"
              onClick={() => setOnline(false)}
            >
              断开 Worker 连接
            </Button>
            <Button
              type="button"
              size="xs"
              variant="secondary"
              data-testid="executions-demo-go-online"
              onClick={() => setOnline(true)}
            >
              重新连接
            </Button>
            <span
              data-testid="executions-demo-connection"
              className="text-xs text-muted-foreground"
            >
              {online ? "当前：在线" : "当前：断线"}
            </span>
          </div>
          <p className="mt-2 text-[0.6875rem] leading-5 text-muted-foreground">
            断线不清空已读到的日志页：页面保留已知位点，并明确说这些不是当前状态。重新连接后仍指向同一条执行。
          </p>
        </section>

        <section data-testid="executions-scene-list" className="space-y-3">
          <h2 className="text-sm font-medium">执行详情、日志续读与取消</h2>
          <RemoteExecutionList
            executions={demoExecutionRecords}
            machines={demoMachineDetails}
            holderNames={demoHolderNames}
            leases={demoLeases}
            logReader={read}
            canceller={cancel}
            connection={
              online ? { online: true, detail: null } : { online: false, detail: "Worker 心跳超时" }
            }
            cancellations={cancellations}
            testId="executions-demo"
          />
        </section>
      </div>
    </PageFrame>
  );
}
