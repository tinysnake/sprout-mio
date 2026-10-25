import { useRef, useState } from "react";
import type { LeaseMutationInput, LeaseMutationView, LeaseView } from "../../../contracts/lease";
import type { AppError, AppResult } from "../../../contracts/result";
import { PageFrame } from "../../../components/layout/page-frame";
import { Button } from "../../../components/ui/button";
import { Select } from "../../../components/ui/select";
import { LeaseOverview, RunHoldingNote } from "../../../components/machine/lease-panel";
import {
  ExecutionTargetTable,
  RemoteExecutionList,
} from "../../../components/machine/remote-execution-panel";
import { DEMO_REQUEST_ID } from "../management/fixtures";
import { demoProject, secondProject, demoMachineDetails } from "./fixtures";
import {
  demoExecutions,
  demoFreeLease,
  demoHolderNames,
  demoInstanceIds,
  demoLeases,
  demoRunFacts,
  applyLeaseMutation,
  completedReceipt,
} from "./lease-fixtures";

/**
 * 租约与远端操作的演示场景。所有结果都由演示控件显式结算，不使用计时器
 * 把 pending 变成成功；正式模块不导入本目录。
 */

type Outcome = "success" | "stale" | "conflict" | "network" | "hold";

type Attempt = {
  input: LeaseMutationInput;
  resolve: (result: AppResult<LeaseMutationView>) => void;
  reject: (cause: unknown) => void;
};

const fail = (error: AppError): AppResult<never> => ({
  ok: false,
  error,
  requestId: DEMO_REQUEST_ID,
});

export function LeasesScene({ go }: { go: (to: string) => void }) {
  const [leases, setLeases] = useState<LeaseView[]>([...demoLeases, demoFreeLease]);
  const [outcome, setOutcome] = useState<Outcome>("success");
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const attemptsRef = useRef<Attempt[]>([]);
  attemptsRef.current = attempts;

  function apply(mutation: LeaseMutationView, current: LeaseView[]): LeaseView[] {
    return applyLeaseMutation(current, mutation, demoInstanceIds.primary);
  }

  function settled(input: LeaseMutationInput): AppResult<LeaseMutationView> {
    return {
      ok: true,
      data: completedReceipt(input),
      requestId: DEMO_REQUEST_ID,
    };
  }

  /** 演示：返回一个等待显式结算的请求。提交本身不会自己变成成功。 */
  function submit(input: LeaseMutationInput): Promise<AppResult<LeaseMutationView>> {
    if (input.action === "reclaim")
      return Promise.resolve(
        fail({
          code: "lease_fencing",
          message: "租约仍在等待 Worker 确认旧授权已关闸。",
          requestId: input.requestId,
        }),
      );
    if (outcome === "stale")
      return Promise.resolve(
        fail({
          code: "lease_stale_generation",
          message: "租约代次已变化，请读取当前租约后重试。目标与动作已保留。",
          requestId: DEMO_REQUEST_ID,
        }),
      );
    if (outcome === "conflict")
      return Promise.resolve(
        fail({
          code: "lease_conflict",
          message: "该 Machine 在本 Project 已被另一个分身持有，申请被拒绝。",
          requestId: DEMO_REQUEST_ID,
        }),
      );
    if (outcome === "network")
      return Promise.reject(new Error("DEMO_NETWORK_FAILURE secret-stack-detail"));
    if (outcome === "success") {
      const result = settled(input);
      if (result.ok) setLeases((current) => apply(result.data, current));
      return Promise.resolve(result);
    }
    return new Promise<AppResult<LeaseMutationView>>((resolve, reject) => {
      const attempt: Attempt = { input, resolve, reject };
      setAttempts((current) => [...current, attempt]);
      attemptsRef.current = [...attemptsRef.current, attempt];
    });
  }

  function settle(index: number, kind: "success" | "stale" | "network") {
    const attempt = attemptsRef.current[index];
    if (!attempt) return;
    setAttempts((current) => current.filter((_, position) => position !== index));
    attemptsRef.current = attemptsRef.current.filter((_, position) => position !== index);
    if (kind === "network") {
      attempt.reject(new Error("DEMO_NETWORK_FAILURE secret-stack-detail"));
      return;
    }
    if (kind === "stale") {
      attempt.resolve(
        fail({
          code: "lease_stale_generation",
          message: "租约代次已变化，请读取当前租约后重试。目标与动作已保留。",
          requestId: DEMO_REQUEST_ID,
        }),
      );
      return;
    }
    const result = settled(attempt.input);
    if (result.ok) setLeases((current) => apply(result.data, current));
    attempt.resolve(result);
  }

  return (
    <PageFrame
      title="租约与远端操作"
      description="演示场景：租约事实来自固定 fixture，变更结果由控件显式结算；不连接业务服务。"
      back={
        <a
          href="/machines"
          data-testid="lease-scene-back"
          onClick={(event) => {
            event.preventDefault();
            go("/machines");
          }}
        >
          返回 Machines
        </a>
      }
      testId="lease-scene"
    >
      <div className="space-y-8">
        <section
          data-testid="lease-scene-controls"
          className="rounded-container border border-border p-3"
        >
          <h2 className="text-sm font-medium">演示控制 · 租约变更结果</h2>
          <label className="mt-2 block text-xs" htmlFor="lease-demo-outcome">
            提交后的结果
          </label>
          <Select
            id="lease-demo-outcome"
            data-testid="lease-demo-outcome"
            className="mt-1 max-w-80"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as Outcome)}
          >
            <option value="success">成功（写回租约事实）</option>
            <option value="stale">拒绝：旧授权代次</option>
            <option value="conflict">拒绝：已被其他分身持有</option>
            <option value="network">抛错：网络/异常</option>
            <option value="hold">挂起，等待手动结算</option>
          </Select>
          {attempts.length > 0 && (
            <ul data-testid="lease-demo-attempts" className="mt-3 space-y-2 text-xs">
              {attempts.map((attempt, index) => (
                <li key={`${attempt.input.requestId}:${index}`} className="flex flex-wrap gap-2">
                  <span className="break-all">
                    {attempt.input.action} · {attempt.input.machineId}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    data-testid={`lease-demo-settle-success-${index}`}
                    onClick={() => settle(index, "success")}
                  >
                    结算成功
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    data-testid={`lease-demo-settle-stale-${index}`}
                    onClick={() => settle(index, "stale")}
                  >
                    结算失败（旧代次）
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    data-testid={`lease-demo-settle-network-${index}`}
                    onClick={() => settle(index, "network")}
                  >
                    结算抛错
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[0.6875rem] leading-5 text-muted-foreground">
            申请与释放按钮在等待期间保持 pending；只有显式结算或即时拒绝才会结束等待。
          </p>
        </section>

        <section data-testid="lease-scene-project-a" className="space-y-3">
          <h2 className="text-sm font-medium">当前 Project：{demoProject.name}</h2>
          <LeaseOverview
            projectId={demoProject.id}
            machines={demoMachineList()}
            leases={leases}
            holderNames={demoHolderNames}
            onMutate={submit}
            fencingSnapshot={{ executions: demoExecutions, mutation: null }}
            testId="lease-scene-overview"
          />
          <RunHoldingNote
            leases={leases.filter((lease) => lease.projectId === demoProject.id)}
            machines={demoMachineDetails}
            runs={demoRunFacts}
            testId="lease-scene-run-relation"
          />
        </section>

        <section data-testid="lease-scene-project-b" className="space-y-3">
          <h2 className="text-sm font-medium">
            另一个 Project：{secondProject.name}
            <span className="ml-2 text-xs text-muted-foreground">
              同一台物理 Machine 的租约在此 Project 中单独成立
            </span>
          </h2>
          <LeaseOverview
            projectId={secondProject.id}
            machines={demoMachineList()}
            leases={leases}
            holderNames={demoHolderNames}
            testId="lease-scene-other-project"
          />
        </section>

        <section data-testid="lease-scene-executions" className="space-y-4">
          <h2 className="text-sm font-medium">远端操作：目标与结果</h2>
          <ExecutionTargetTable executions={demoExecutions} machines={demoMachineList()} />
          <RemoteExecutionList executions={demoExecutions} machines={demoMachineList()} />
        </section>
      </div>
    </PageFrame>
  );
}

function demoMachineList() {
  // 演示只需要 machine.id 与 name；完整 detail 由 fixtures 提供。
  return demoMachineDetails;
}
