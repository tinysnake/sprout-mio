import { useState, type FormEvent } from "react";
import type { LeaseMutationInput, LeaseMutationView, LeaseView } from "../../contracts/lease";
import type { MachineDetail } from "../../contracts/machine";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import type { AppError, AppResult } from "../../contracts/result";
import { toAppError } from "../../contracts/result";
import type { LeaseMutationHandler, StatusTone } from "./machine-view";
import { formatMoment } from "./machine-view";
import {
  groupLeasesByHolder,
  holderLabel,
  leaseStateLabel,
  mutationStateLabel,
  pendingMutationLabel,
  runLeaseRelation,
  visibleLeases,
} from "./lease-view";
import { LeaseFencingFacts, type FencingSnapshot } from "../info-hub/lease-fencing-facts";
import { StatusLine } from "./machine-list";
import { ResultError } from "../project/result-error";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Select } from "../ui/select";

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
  testId = "lease-overview",
}: {
  projectId: string;
  machines: MachineDetail[];
  leases: readonly LeaseView[];
  holderNames?: Readonly<Record<string, string>>;
  /** 未提供时按既有约定显式标为未接入，不渲染成可点但无效果的按钮。 */
  onMutate?: LeaseMutationHandler;
  /** 窄栏（inspector）里只列事实，变更操作留在 Machine 详情与 Project settings。 */
  dense?: boolean;
  fencingSnapshot?: FencingSnapshot;
  testId?: string;
}) {
  const visible = visibleLeases(leases, projectId);
  const groups = groupLeasesByHolder(visible);
  const machineName = (machineId: string) =>
    machines.find((item) => item.machine.id === machineId)?.machine.name ?? machineId;

  return (
    <section data-testid={testId} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className={dense ? "text-xs font-medium" : "text-sm font-medium"}>Machine 租约</h4>
        {!dense && (
          <span className="text-[0.6875rem] text-muted-foreground">
            互斥单位是 Project × Machine；不同 Project 的租约互不可见
          </span>
        )}
      </div>
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
            const pending = pendingMutationLabel(lease);
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
                  <StatusLine
                    label={state.label}
                    detail={`代次 ${lease.generation}`}
                    tone={state.tone}
                    testId="lease-state"
                  />
                </dd>
                <dd className="break-all">
                  <span data-testid="lease-holder-name">
                    {lease.holderInstanceId ? holder.name : "无持有者"}
                  </span>
                  {holder.instanceId && (
                    <span data-testid="lease-holder-instance" className="text-muted-foreground">
                      {" "}
                      · {holder.instanceId}
                    </span>
                  )}
                </dd>
                <dd className="text-muted-foreground">取得/更新 {formatMoment(lease.changedAt)}</dd>
                {(!dense || lease.state === "fencing") && (
                  <dd className="text-muted-foreground">{state.detail}</dd>
                )}
                {lease.state === "fencing" && (
                  <dd>
                    <LeaseFencingFacts lease={lease} snapshot={fencingSnapshot} submit={onMutate} />
                  </dd>
                )}
                {pending && (
                  <dd data-testid="lease-pending" className="text-status-warning">
                    {pending}
                  </dd>
                )}
              </div>
            );
          })}
        </dl>
      )}
      {groups.length > 0 && (
        <div
          data-testid={`${testId}-holders`}
          className="space-y-1 rounded-lg border border-border-soft px-4 py-3"
        >
          <h5 className="text-xs font-medium">分身与它持有的 Machine</h5>
          {groups.map((group) => (
            <p
              key={group.instanceId}
              data-testid={`lease-holder-group-${group.instanceId}`}
              className="text-xs leading-6"
            >
              <span className="font-medium">{holderNames[group.instanceId] ?? "未知分身"}</span>
              <span className="break-all text-muted-foreground"> · {group.instanceId}</span>
              <span className="text-muted-foreground"> · 持有 {group.leases.length} 台：</span>
              <span data-testid="lease-holder-machines">
                {group.leases.map((lease) => machineName(lease.machineId)).join("、")}
              </span>
            </p>
          ))}
        </div>
      )}
      {onMutate ? (
        <LeaseMutationForm
          projectId={projectId}
          machines={machines}
          leases={visible}
          submit={onMutate}
          testId={`${testId}-mutation`}
        />
      ) : dense ? (
        <p
          data-testid={`${testId}-dense-note`}
          className="text-[0.6875rem] leading-5 text-muted-foreground"
        >
          租约的申请与释放（含交接、收回）在 Machine 详情与 Project settings
          进行；本处与它们读同一份租约事实。
        </p>
      ) : (
        <Notice
          testId={`${testId}-notice`}
          title="租约申请与释放"
          reason="租约变更尚未接入服务端入口，P4b 集成单元接入后可操作。此处只显示只读事实。"
        />
      )}
    </section>
  );
}

function Notice({ testId, title, reason }: { testId: string; title: string; reason: string }) {
  return (
    <section data-testid={testId} className="space-y-1 rounded-lg border border-dashed px-4 py-3">
      <p className="text-sm font-medium">
        {title}
        <span data-testid={`${testId}-badge`} className="ml-2 text-xs text-muted-foreground">
          未实现
        </span>
      </p>
      <p data-testid={`${testId}-reason`} className="text-sm text-muted-foreground">
        {reason}
      </p>
    </section>
  );
}

type MutationDraft = {
  machineId: string;
  lastAction: LeaseMutationInput["action"] | null;
};

/**
 * 申请与释放：pending 由等待真实结果产生，成功只来自返回的收据；
 * 失败保留选择的 Machine 与动作，并显示服务端错误码与 requestId。
 */
export function LeaseMutationForm({
  projectId,
  machines,
  leases,
  submit,
  testId = "lease-mutation-form",
}: {
  projectId: string;
  machines: MachineDetail[];
  leases: readonly LeaseView[];
  submit: LeaseMutationHandler;
  testId?: string;
}) {
  const firstMachine = machines.at(0)?.machine.id ?? "";
  const [draft, setDraft] = useState<MutationDraft>({ machineId: firstMachine, lastAction: null });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [receipt, setReceipt] = useState<LeaseMutationView | null>(null);

  const lease = leases.find((item) => item.machineId === draft.machineId) ?? null;
  const action: "acquire" | "release" | null =
    lease === null || lease.state === "free"
      ? "acquire"
      : lease.state === "held"
        ? "release"
        : null;

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !action || !draft.machineId) return;
    setError(null);
    setReceipt(null);
    const input: LeaseMutationInput =
      action === "acquire"
        ? {
            action,
            projectId,
            machineId: draft.machineId,
            requestId: newId(ID_PREFIXES.request),
            expectedGeneration: lease?.generation ?? 0,
          }
        : {
            action: "release",
            projectId,
            machineId: draft.machineId,
            requestId: newId(ID_PREFIXES.request),
            expectedGeneration: lease!.generation,
          };
    setPending(true);
    setDraft((current) => ({ ...current, lastAction: action }));
    try {
      const result: AppResult<LeaseMutationView> = await submit(input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReceipt(result.data);
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      data-testid={testId}
      aria-busy={pending}
      onSubmit={run}
      className="space-y-3 border-t border-border pt-4"
    >
      <h5 className="text-xs font-medium">申请与释放</h5>
      <p className="text-[0.6875rem] leading-5 text-muted-foreground">
        动作与期望代次一起提交；代次失效时服务端拒绝，界面不把拒绝显示为成功。租约变更不会终止进程或删除文件。
      </p>
      <div className="grid gap-3 desktop:grid-cols-[minmax(0,1fr)_auto] desktop:items-end">
        <Field label="目标 Machine" hint="必须显式选择；没有默认目标。">
          <Select
            data-testid={`${testId}-machine`}
            value={draft.machineId}
            disabled={pending}
            onChange={(event) => {
              setDraft({ machineId: event.target.value, lastAction: null });
              setError(null);
              setReceipt(null);
            }}
          >
            {machines.length === 0 && <option value="">没有可操作的 Machine</option>}
            {machines.map((item) => (
              <option key={item.machine.id} value={item.machine.id}>
                {item.machine.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-end gap-2">
          <Button
            type="submit"
            loading={pending}
            disabled={!action}
            data-testid={`${testId}-submit`}
          >
            {pending
              ? action === "release"
                ? "正在释放…"
                : "正在申请…"
              : action === "release"
                ? "释放租约"
                : "申请租约"}
          </Button>
          {!action && (
            <span
              data-testid={`${testId}-fencing`}
              className="text-[0.6875rem] text-muted-foreground"
            >
              租约回收中，等待 Worker 确认后再操作。
            </span>
          )}
        </div>
      </div>
      <p data-testid={`${testId}-context`} className="text-[0.6875rem] text-muted-foreground">
        {lease
          ? `当前：${leaseStateLabel(lease.state).label} · 代次 ${lease.generation} · ${
              draft.lastAction === "release" ? "再次提交将释放" : "申请/释放都会要求代次匹配"
            }`
          : "当前：该 Machine 在本 Project 还没有租约，提交将创建第一条。"}
      </p>
      {pending && (
        <p data-testid={`${testId}-pending`} className={`text-xs ${toneText.warning}`}>
          请求已提交，等待服务端返回结果。结果未知前不显示成功。
        </p>
      )}
      {error && <ResultError error={error} testId={`${testId}-error`} />}
      {receipt && (
        <div data-testid={`${testId}-receipt`} className="space-y-1 text-xs leading-6">
          <StatusLine
            {...mutationStateLabel(receipt)}
            testId={`${testId}-${receipt.state === "completed" ? "success" : "waiting"}`}
          />
          <p className="text-muted-foreground">
            动作收据 {receipt.mutationId} ·{" "}
            {receipt.state === "pending" ? "等待 Worker 确认" : "已由 Worker 确认"}
          </p>
        </div>
      )}
    </form>
  );
}

/** Machine 详情里的租约小节：同一台 Machine 在本 Project 的租约与 run 关系。 */
export function MachineLeaseSection({
  projectId,
  detail,
  leases,
  holderNames = {},
  runs,
  onMutate,
  testId = "machine-lease-section",
}: {
  projectId: string;
  detail: MachineDetail;
  leases: readonly LeaseView[];
  holderNames?: Readonly<Record<string, string>>;
  runs?: readonly { runId: string; status: string }[];
  onMutate?: LeaseMutationHandler;
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
        onMutate={onMutate}
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
