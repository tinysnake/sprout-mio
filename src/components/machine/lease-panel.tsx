import { useState, type ReactNode } from "react";
import type { LeaseMutationView, LeaseView } from "../../contracts/lease";
import type { MachineDetail } from "../../contracts/machine";
import type { LeaseMutationHandler, StatusTone } from "./machine-view";
import { formatMoment } from "./machine-view";
import {
  escrowStateLabel,
  escrowTargetLabel,
  holderLabel,
  holderMachineCount,
  leaseStateLabel,
  leaseStatusLabel,
  liveEscrowOf,
  mutationStateLabel,
  runLeaseRelation,
  visibleLeases,
  type EscrowNames,
} from "./lease-view";
import { LeaseFencingFacts, type FencingSnapshot } from "../info-hub/lease-fencing-facts";
import { leaseTimeoutPhase } from "./lease-timeout-view";
import { StatusLine } from "./machine-list";

const toneText: Record<StatusTone, string> = {
  success: "text-status-success",
  warning: "text-status-warning",
  muted: "text-muted-foreground",
  danger: "text-status-failed",
};

/**
 * 租约事实只投影 `leaseViewSchema`：谁持有、哪台 Machine、状态与取得时间。
 * 组件不推断空闲原因，也不把 run 状态当作释放信号。
 */
export function LeaseOverview({
  projectId,
  machines,
  leases,
  holderNames = {},
  onMutate,
  dense = false,
  fencingSnapshot,
  manageLink,
  revision,
  escrowNames = {},
  showDenseNote = true,
  hideEmpty = false,
  testId = "lease-overview",
}: {
  projectId: string;
  machines: MachineDetail[];
  leases: readonly LeaseView[];
  holderNames?: Readonly<Record<string, string>>;
  /** 未提供时按既有约定显式标为未接入，不渲染成可点但无效果的按钮。 */
  onMutate?: LeaseMutationHandler;
  /** 窄栏（inspector）里只列事实，变更操作留在 Machine 详情。 */
  dense?: boolean;
  fencingSnapshot?: FencingSnapshot;
  /** 页面已有 Machine 范围的 revision 时传下来：fencing 事实只在 revision 变化时重读。 */
  revision?: string | null;
  /**
   * 本页不放管理表单时的入口：逐条租约给出到 Machine 详情租约区块的深链。
   * 租约数据仍属于 Project × Machine，这里只换入口位置。
   */
  manageLink?: (lease: LeaseView) => ReactNode;
  /** 挂靠目标与指定 Agent 的显示名；缺省时退回 id，不猜名字。 */
  escrowNames?: EscrowNames;
  /**
   * 窄栏里的补充说明：只在需要指路到 Machine 详情页时报这句。
   * Chat inspector 只呈现既有租约状态，关掉它。
   */
  showDenseNote?: boolean;
  /** 窄栏调用方可以要求空态整块不渲染：没有租约时那句说明没有可行动信息。 */
  hideEmpty?: boolean;
  testId?: string;
}) {
  const [forcedReceipts, setForcedReceipts] = useState<Record<string, LeaseMutationView>>({});
  const visible = visibleLeases(leases, projectId);
  if (hideEmpty && visible.length === 0) return null;
  const machineName = (machineId: string) =>
    machines.find((item) => item.machine.id === machineId)?.machine.name ?? machineId;

  return (
    <section data-testid={testId} className="space-y-3">
      <h4 className={dense ? "text-xs font-medium" : "text-sm font-medium"}>Machine 租约</h4>
      {visible.length === 0 ? (
        <p data-testid={`${testId}-empty`} className="text-xs text-muted-foreground">
          本 Project 还没有租约记录。
        </p>
      ) : (
        <dl
          data-testid={`${testId}-list`}
          className="min-w-0 divide-y divide-border text-xs leading-6"
        >
          {visible.map((lease) => {
            const state = leaseStateLabel(lease.state);
            const holder = holderLabel(lease, holderNames);
            // 挂靠行只投影 live 挂靠：LeaseView.escrow 只会是挂靠中的那一次。
            const escrow = liveEscrowOf(lease);
            // 持有台数取同一份租约投影，不为这一行新增查询。
            const heldCount = holderMachineCount(visible, lease.holderInstanceId);
            // 状态位互斥：挂靠中替代持有中。代次只在提交时匹配，界面不呈现。
            const status = leaseStatusLabel(lease);
            return (
              <div
                key={`${lease.projectId}:${lease.machineId}`}
                data-testid={`lease-row-${lease.machineId}`}
                data-lease-state={lease.state}
                data-holder-instance={lease.holderInstanceId ?? ""}
                className="min-w-0 py-3"
              >
                <dt className="font-medium">{machineName(lease.machineId)}</dt>
                <dd>
                  <StatusLine label={status.label} tone={status.tone} testId="lease-state" />
                </dd>
                <dd className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 break-all">
                  <span data-testid="lease-holder-name">
                    {lease.holderInstanceId ? holder.name : "无持有者"}
                  </span>
                  {heldCount > 1 && (
                    <span
                      data-testid="lease-holder-count"
                      className="text-[0.6875rem] text-muted-foreground"
                    >
                      持有 {heldCount} 台
                    </span>
                  )}
                  {holder.instanceId && (
                    <span data-testid="lease-holder-instance" className="text-muted-foreground">
                      · {holder.instanceId}
                    </span>
                  )}
                </dd>
                {escrow && (
                  <dd
                    data-testid={`lease-escrow-${lease.machineId}`}
                    data-escrow-state={escrow.state}
                    data-timeout-phase={leaseTimeoutPhase(escrow.timeout)}
                    className={toneText[escrowStateLabel(escrow.state).tone]}
                  >
                    {/* 发起挂靠的分身恒等于当时的持有者（leaseViewSchema 的 superRefine），所以名称直接用 holder。 */}
                    {escrowTargetLabel(escrow, escrowNames)} · 由 {holder.name} 发起
                  </dd>
                )}
                <dd className="text-muted-foreground">取得/更新 {formatMoment(lease.changedAt)}</dd>
                {/* fencing 的长说明已收进问号 Dialog；这里不再平铺同一段文字。
                    挂靠中也不再解释持有者能做什么：挂靠已经把操作权交出去了。 */}
                {lease.state !== "fencing" && !dense && !escrow && (
                  <dd className="text-muted-foreground">{state.detail}</dd>
                )}
                {lease.state === "fencing" && (
                  <dd>
                    <LeaseFencingFacts
                      lease={lease}
                      snapshot={fencingSnapshot}
                      submit={onMutate}
                      revision={revision}
                      onForced={(receipt) =>
                        setForcedReceipts((current) => ({
                          ...current,
                          [lease.machineId]: receipt,
                        }))
                      }
                    />
                  </dd>
                )}
                {/*
                  强制收回会把租约推出 fencing，fencing 子树随之卸载。收据因此留在这
                  一行上：它记录的是 Human 自己刚做过的动作，不能在 5 秒自动刷新后消失。
                */}
                {forcedReceipts[lease.machineId] && (
                  <dd
                    data-testid={`${testId}-forced-receipt-${lease.machineId}`}
                    className="space-y-1 pt-1 text-xs leading-6"
                  >
                    <StatusLine
                      {...mutationStateLabel(forcedReceipts[lease.machineId])}
                      testId={`${testId}-forced-receipt-state`}
                    />
                    <p className="text-muted-foreground break-all">
                      强制收据 {forcedReceipts[lease.machineId].mutationId}
                      {forcedReceipts[lease.machineId].forcedReclaim
                        ? ` · 覆盖了原动作 ${forcedReceipts[lease.machineId].forcedReclaim!.supersededMutationId}`
                        : ""}
                    </p>
                  </dd>
                )}
                {manageLink && (
                  <dd data-testid="lease-manage" className="min-w-0">
                    {manageLink(lease)}
                  </dd>
                )}
              </div>
            );
          })}
        </dl>
      )}
      {dense && showDenseNote && (
        <p
          data-testid={`${testId}-dense-note`}
          className="text-[0.6875rem] leading-5 text-muted-foreground"
        >
          租约的强制收回在对应 Machine 详情的租约区块进行。
        </p>
      )}
    </section>
  );
}

/** Machine 详情里的租约小节：同一台 Machine 在本 Project 的租约与 run 关系。 */
export function MachineLeaseSection({
  projectId,
  detail,
  leases,
  holderNames = {},
  escrowNames = {},
  runs,
  onMutate,
  revision,
  testId = "machine-lease-section",
}: {
  projectId: string;
  detail: MachineDetail;
  leases: readonly LeaseView[];
  holderNames?: Readonly<Record<string, string>>;
  escrowNames?: EscrowNames;
  runs?: readonly { runId: string; status: string }[];
  onMutate?: LeaseMutationHandler;
  /** Machine 范围的活动 revision，由页面传入；不传就保持五秒定时读。 */
  revision?: string | null;
  testId?: string;
}) {
  // 详情页只投影这一台 Machine 的租约；同 Project 其他 Machine 的租约留在列表与 Project 视图。
  const scoped = visibleLeases(leases, projectId).filter(
    (lease) => lease.machineId === detail.machine.id,
  );
  return (
    <div data-testid={testId} className="space-y-4">
      <LeaseOverview
        projectId={projectId}
        machines={[detail]}
        leases={scoped}
        holderNames={holderNames}
        escrowNames={escrowNames}
        onMutate={onMutate}
        revision={revision}
        testId={`${testId}-overview`}
      />
      <RunHoldingNote leases={scoped} machines={[detail]} runs={runs} />
    </div>
  );
}

/**
 * run 与租约并列呈现：run 结束不改变租约，也不生成释放记录。
 * 这里读取 run 事实只为展示关系，不修改租约。
 */
export function RunHoldingNote({
  leases,
  machines = [],
  runs,
  testId = "lease-run-relation",
}: {
  leases: readonly LeaseView[];
  machines?: MachineDetail[];
  runs?: readonly { runId: string; status: string }[];
  testId?: string;
}) {
  if (leases.length === 0) return null;
  const latest = runs?.at(0)?.status ?? null;
  const known = ["running", "completed", "failed", "interrupted"].includes(latest ?? "")
    ? (latest as "running" | "completed" | "failed" | "interrupted")
    : null;
  return (
    <section data-testid={testId} className="space-y-1 text-xs leading-6">
      <h5 className="text-xs font-medium">run 与租约</h5>
      {leases.map((lease) => {
        const relation = runLeaseRelation(lease, known);
        return (
          <p
            key={`${lease.projectId}:${lease.machineId}`}
            data-testid={`${testId}-${lease.machineId}`}
            data-held={relation.held ? "true" : "false"}
            className={
              lease.state === "fencing"
                ? "text-status-warning"
                : relation.held
                  ? "text-status-success"
                  : "text-muted-foreground"
            }
          >
            <span className="text-foreground">
              {machines.find((item) => item.machine.id === lease.machineId)?.machine.name ??
                lease.machineId}
            </span>
            {" · "}
            {relation.note}
          </p>
        );
      })}
    </section>
  );
}
