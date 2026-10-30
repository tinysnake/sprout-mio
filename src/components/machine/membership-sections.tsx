import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, FolderOpen } from "lucide-react";
import type { LeaseMutationView, LeaseView } from "../../contracts/lease";
import type { MembershipView, PendingFactView } from "../../contracts/membership";
import type { MachineDetail } from "../../contracts/machine";
import type { ExecutionView } from "../../contracts/remote";
import type { AppError } from "../../contracts/result";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import { forceReclaimLeaseFn } from "../../server/functions/lease";
import { holderLabel, leaseStateLabel } from "./lease-view";
import { bindingDirectory, observationLabel, formatMoment, type StatusTone } from "./machine-view";
import {
  historyMembershipSummary,
  membershipPresentation,
  pendingOrder,
  pendingPresentation,
  revocationPresentation,
  unfinishedExecutionCount,
} from "./membership-view";
import type { MachineRelationView, MembershipHistoryView } from "../../server/functions/membership";
import {
  detachMachineFn,
  membershipHistoryFn,
  rejoinProjectMachineFn,
} from "../../server/functions/membership";
import { listProjectExecutionsFn } from "../../server/functions/remote";
import { useExecutionWiring } from "../../lib/execution-wiring";
import { StatusLine } from "./machine-list";
import { ResultError } from "../project/result-error";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { RemoteExecutionList } from "./remote-execution-panel";
import { LeaseOverview } from "./lease-panel";

const toneText: Record<StatusTone, string> = {
  success: "text-status-success",
  warning: "text-status-warning",
  muted: "text-muted-foreground",
  danger: "text-status-failed",
};

type WriteGate = { allowed: boolean; reason: string };

/**
 * 写入口的唯一闸门：只看页面事实是否新鲜（上次刷新是否成功、是否仍在读取）。
 * 每个写入口都读它，而不各自缓存一个 disabled 布尔；已打开的对话框也读同一个闸门。
 * 被关闭时必须给出原因，让用户知道为什么现在不能写，而不是只看到一个点不动的按钮。
 */
function membershipWriteGate(loading: boolean, error: AppError | null): WriteGate {
  if (error) {
    return {
      allowed: false,
      reason:
        "当前状态未确认：上次刷新关系事实失败，暂停移出、重新加入与强制收回。刷新成功后才能提交。",
    };
  }
  if (loading) {
    return {
      allowed: false,
      reason: "正在读取关系事实，确认前不开放移出、重新加入与强制收回。",
    };
  }
  return { allowed: true, reason: "" };
}

const ACTION_LABELS: Record<MembershipHistoryView["receipts"][number]["action"], string> = {
  acquire: "申请",
  release: "释放",
  handoff: "交接",
  reclaim: "收回",
};

const ERROR_NOTES: Record<string, string> = {
  detach_pending: "移出尚未完成。刷新对应关系与待处理收据，不能显示成功移出。",
  membership_removed: "已移出，当前操作不可用。刷新到历史态后可显式重新加入。",
  lease_fencing: "租约交接中，当前不能发起移出。显示当前收据与允许的下一步。",
  conflict: "事实已变化或请求冲突。已保留本地确认范围，刷新事实后请重新确认。",
  remote_request_conflict: "同一请求对应不同事实，未自动覆盖。刷新后请重新确认。",
  lease_stale_generation: "代次已变化。刷新事实后请重新确认。",
  validation_failed: "确认输入有误或缺失，请重新确认移出范围。",
  lease_result_unconfirmed: "操作结果未确认，请刷新事实；不能改成失败或已完成。",
  remote_request_unconfirmed: "操作结果未确认，请刷新事实；不能改成失败或已完成。",
};

export function relationRows(
  relations: readonly MachineRelationView[],
  machines: readonly MachineDetail[],
  leases: readonly LeaseView[],
) {
  return relations.map((relation) => {
    const machine = machines.find((item) => item.machine.id === relation.machineId);
    const binding = machine?.bindings.find((item) => item.intent.projectId === relation.projectId);
    const lease = leases.find(
      (item) => item.projectId === relation.projectId && item.machineId === relation.machineId,
    );
    return { relation, machine, binding, lease };
  });
}

export function MembershipSections({
  scope,
  projectId,
  projectNames = {},
  relations,
  machines,
  leases,
  holderNames = {},
  executions = null,
  loading,
  error,
  lastSuccessAt,
  onChanged,
  showLeaseOverview = false,
  testId = "membership-sections",
}: {
  scope: "project" | "machine";
  projectId?: string;
  projectNames?: Readonly<Record<string, string>>;
  relations: readonly MachineRelationView[];
  machines: readonly MachineDetail[];
  leases: readonly LeaseView[];
  holderNames?: Readonly<Record<string, string>>;
  executions?: readonly ExecutionView[] | null;
  loading: boolean;
  error: AppError | null;
  lastSuccessAt: string | null;
  onChanged: () => void;
  /** Project settings 保留既有租约摘要与空态，不把租约管理搬回这里。 */
  showLeaseOverview?: boolean;
  testId?: string;
}) {
  const rows = useMemo(
    () => relationRows(relations, machines, leases),
    [relations, machines, leases],
  );
  const current = rows.filter(({ relation }) => relation.membership?.state === "active");
  const pending = rows
    .filter(({ relation }) => relation.pending !== null)
    .sort((left, right) => pendingOrder(left.relation.pending!, right.relation.pending!));
  const removed = rows.filter(({ relation }) => relation.membership?.state === "removed");
  const stale = error !== null;
  const writeGate = membershipWriteGate(loading, error);
  const [notice, setNotice] = useState("");

  return (
    <section data-testid={testId} className="space-y-6">
      {stale && (
        <div
          data-testid={`${testId}-stale`}
          className="rounded-container border border-status-warning/40 bg-status-warning/5 px-4 py-3 text-xs leading-6"
        >
          <StatusLine label="当前状态未确认" tone="warning" />
          <p className="mt-1 text-muted-foreground">
            上次成功读取：{lastSuccessAt ? formatMoment(lastSuccessAt) : "尚无"}。保留上次事实，
            暂停依赖新鲜事实的移出、重新加入与强制收回；可以刷新重试。
          </p>
          {error && <ResultError error={error} testId={`${testId}-stale-error`} />}
        </div>
      )}

      {notice && (
        <p
          data-testid={`${testId}-notice`}
          role="status"
          className="rounded-container border border-border px-4 py-3 text-xs leading-6"
        >
          {notice}
        </p>
      )}

      <section data-testid={`${testId}-current`} className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">当前资源</h3>
          <span className="text-[0.6875rem] text-muted-foreground">
            只显示最新 active 关系；active + fencing 仍在这里但暂不可用
          </span>
        </div>
        {loading && !lastSuccessAt ? (
          <p data-testid={`${testId}-current-loading`} className="text-xs text-muted-foreground">
            正在读取关系事实；未拿到事实前不显示“空闲／可用”，也不开放写操作。
          </p>
        ) : current.length === 0 ? (
          <p data-testid="machine-empty" className="text-xs leading-6 text-muted-foreground">
            还没有绑定 Machine。
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-container border border-border">
            {current.map(({ relation, machine, binding, lease }) => (
              <CurrentResourceRow
                key={`${relation.projectId}:${relation.machineId}`}
                scope={scope}
                projectNames={projectNames}
                relation={relation}
                machine={machine}
                binding={binding}
                lease={lease}
                holderNames={holderNames}
                writeGate={writeGate}
                onChanged={onChanged}
                onNotice={setNotice}
              />
            ))}
          </ul>
        )}
      </section>

      <section data-testid={`${testId}-pending`} className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">待处理</h3>
          <span className="text-[0.6875rem] text-muted-foreground">
            摘要常显，细节按需展开；优先级 membership_detaching &gt; lease_fencing &gt;
            notice_undelivered
          </span>
        </div>
        {loading && !lastSuccessAt ? (
          <p className="text-xs text-muted-foreground">正在读取待处理事实。</p>
        ) : pending.length === 0 ? (
          <p data-testid={`${testId}-pending-empty`} className="text-xs text-muted-foreground">
            没有待处理事实。
          </p>
        ) : (
          <ul className="space-y-3">
            {pending.map(({ relation, machine, lease, binding }) => (
              <PendingRow
                key={`${relation.projectId}:${relation.machineId}`}
                relation={relation}
                pending={relation.pending!}
                machineName={machine?.machine.name ?? relation.machineId}
                projectName={projectNames[relation.projectId] ?? relation.projectId}
                lease={lease}
                bindingRevision={binding?.intent.revision ?? null}
                executionCount={
                  executions === null
                    ? null
                    : unfinishedExecutionCount(executions, relation.projectId, relation.machineId)
                }
                writeGate={writeGate}
                onChanged={onChanged}
                onNotice={setNotice}
                testId={testId}
              />
            ))}
          </ul>
        )}
      </section>

      <section data-testid={`${testId}-removed`} className="space-y-3">
        <h3 className="text-sm font-medium">已移出记录与重新加入</h3>
        {removed.length === 0 ? (
          <p data-testid={`${testId}-removed-empty`} className="text-xs text-muted-foreground">
            还没有已移出的加入记录。
          </p>
        ) : (
          <ul className="space-y-3">
            {removed.map(({ relation, machine, binding, lease }) => (
              <RemovedRow
                key={`${relation.projectId}:${relation.machineId}`}
                relation={relation}
                membership={relation.membership!}
                machineName={machine?.machine.name ?? relation.machineId}
                projectName={projectNames[relation.projectId] ?? relation.projectId}
                lease={lease}
                bindingRevision={binding?.intent.revision ?? null}
                writeGate={writeGate}
                onChanged={onChanged}
                onNotice={setNotice}
                testId={testId}
              />
            ))}
          </ul>
        )}
      </section>

      {removed.length > 0 && (
        <section data-testid={`${testId}-history`} className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Human 只读历史</h3>
            <span className="text-[0.6875rem] text-muted-foreground">
              摘要常显，内容收起。不提供替 Agent 读日志或标记已读。
            </span>
          </div>
          {removed.map(({ relation, machine }) => (
            <MembershipHistory
              key={`${relation.projectId}:${relation.machineId}`}
              projectId={relation.projectId}
              machineId={relation.machineId}
              machineName={machine?.machine.name ?? relation.machineId}
              projectName={projectNames[relation.projectId] ?? relation.projectId}
              testId={`${testId}-history`}
            />
          ))}
        </section>
      )}

      {showLeaseOverview && (
        <LeaseOverview
          projectId={projectId ?? ""}
          machines={[...machines]}
          leases={leases.filter((lease) =>
            current.some(
              ({ relation }) =>
                relation.projectId === lease.projectId && relation.machineId === lease.machineId,
            ),
          )}
          holderNames={holderNames}
          dense
          manageLink={(lease) => (
            <LeaseManageLink projectId={lease.projectId} machineId={lease.machineId} />
          )}
          testId="info-hub-leases"
        />
      )}
    </section>
  );
}

function CurrentResourceRow({
  scope,
  projectNames,
  relation,
  machine,
  binding,
  lease,
  holderNames,
  writeGate,
  onChanged,
  onNotice,
}: {
  scope: "project" | "machine";
  projectNames: Readonly<Record<string, string>>;
  relation: MachineRelationView;
  machine: MachineDetail | undefined;
  binding: MachineDetail["bindings"][number] | undefined;
  lease: LeaseView | undefined;
  holderNames: Readonly<Record<string, string>>;
  writeGate: WriteGate;
  onChanged: () => void;
  onNotice: (text: string) => void;
}) {
  const status = membershipPresentation(relation.membership, lease);
  const observation = observationLabel(binding?.observation);
  const leaseFacts = lease ? leaseStateLabel(lease.state) : null;
  const holder = lease ? holderLabel(lease, holderNames) : null;
  const projectName = projectNames[relation.projectId] ?? relation.projectId;
  const rowTestId = scope === "machine" ? "machine-binding-item" : "info-hub-machine-binding";
  return (
    <li
      data-testid={scope === "machine" ? "machine-binding-item" : "machine-item"}
      data-machine-id={relation.machineId}
      data-project-id={relation.projectId}
      className="min-w-0 px-5 py-4 max-desktop:px-3"
    >
      <div data-testid={rowTestId} data-project-id={relation.projectId} className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="min-w-0 text-sm font-medium break-all">
            {machine?.machine.name ?? relation.machineId}
          </p>
          {scope === "machine" && (
            <span className="text-xs text-muted-foreground">
              {projectName}
              {binding ? ` · revision ${binding.intent.revision}` : ""}
            </span>
          )}
        </div>
        <p className="mt-1 text-xs leading-6">
          <StatusLine label={status.label} detail={status.detail} tone={status.tone} />
        </p>
        {scope === "project" && (
          <>
            <p className="mt-1 text-xs leading-6">{binding?.intent.description || "（无说明）"}</p>
            <p
              data-testid="info-hub-machine-binding-path"
              className="mt-1 flex min-w-0 items-start gap-1.5 text-xs leading-6 text-muted-foreground"
            >
              <Icon as={FolderOpen} />
              <span className="min-w-0 break-all">
                {bindingDirectory(machine?.machine.rootDirectory ?? null, relation.projectId)}
              </span>
            </p>
            <p className="mt-1 text-xs">
              <StatusLine
                label={observation.label}
                detail={observation.detail}
                tone={observation.tone}
              />
            </p>
          </>
        )}
        {scope === "machine" && binding && (
          <>
            <p data-testid="machine-binding-description-value" className="mt-1.5 text-xs leading-6">
              {binding.intent.description || "（无说明）"}
            </p>
            <p
              data-testid="machine-binding-path"
              className="mt-1 flex min-w-0 items-start gap-1.5 text-xs leading-6 text-muted-foreground"
            >
              <Icon as={FolderOpen} />
              <span className="min-w-0 break-all">
                {bindingDirectory(machine?.machine.rootDirectory ?? null, relation.projectId)}
              </span>
            </p>
            <p data-testid="machine-binding-observation" className="mt-1 text-xs leading-6">
              <StatusLine
                label={observation.label}
                detail={observation.detail}
                tone={observation.tone}
              />
            </p>
          </>
        )}
        {leaseFacts && (
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
            <StatusLine label={leaseFacts.label} tone={leaseFacts.tone} />
            {holder?.instanceId && <span>{holder.name}</span>}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <LeaseManageLink projectId={relation.projectId} machineId={relation.machineId} />
          {relation.membership && !relation.pending && (
            <DetachControl
              relation={relation}
              bindingsRevision={binding?.intent.revision ?? null}
              lease={lease}
              writeGate={writeGate}
              onChanged={onChanged}
              onNotice={onNotice}
            />
          )}
          {relation.pending && (
            <span className="text-[0.6875rem] text-status-warning">
              {relation.pending.kind === "lease_fencing"
                ? "租约交接中，移出入口已禁用"
                : "移出尚未完成，移出入口已禁用"}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

function DetachControl({
  relation,
  bindingsRevision,
  lease,
  writeGate,
  onChanged,
  onNotice,
}: {
  relation: MachineRelationView;
  bindingsRevision: number | null;
  lease: LeaseView | undefined;
  writeGate: WriteGate;
  onChanged: () => void;
  onNotice: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState("");
  const membership = relation.membership;
  const disabledReason =
    bindingsRevision === null ? "没有读到绑定版本，无法提交移出。" : writeGate.reason;
  async function submit() {
    if (!membership || bindingsRevision === null || pending || !writeGate.allowed) return;
    setPending(true);
    setError(null);
    setNotice("");
    try {
      const result = await detachMachineFn({
        data: {
          projectId: relation.projectId,
          machineId: relation.machineId,
          requestId: newId(ID_PREFIXES.request),
          expectedEpoch: membership.epoch,
          expectedRevision: bindingsRevision,
          expectedGeneration: lease?.generation ?? 0,
          confirm: true,
        },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setConfirmed(false);
      const message =
        result.data.state === "removed"
          ? "已移出。旧执行、日志与租约收据保留在 Human 只读历史。"
          : "移出尚未完成：关系进入待处理，等待 Worker 确认后才完成移出。";
      setNotice(message);
      onNotice(message);
      onChanged();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="min-w-0">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={<Button variant="outline" size="sm" />}
          disabled={Boolean(disabledReason)}
          data-testid="membership-detach-trigger"
        >
          移出 Project
        </DialogTrigger>
        <DialogContent data-testid="membership-detach-dialog">
          <DialogHeader>
            <DialogTitle>移出这个 Project × Machine 关系</DialogTitle>
            <DialogDescription>
              移出会撤销当前 Project × Machine 的租约授权；不会终止进程或删除文件。
              只作用于当前关系，不影响其他 Project。
            </DialogDescription>
          </DialogHeader>
          {error && (
            <div data-testid="membership-detach-error">
              <ResultError error={error} />
              {ERROR_NOTES[error.code] && (
                <p className="mt-2 text-xs leading-6 text-muted-foreground">
                  {ERROR_NOTES[error.code]}
                </p>
              )}
            </div>
          )}
          {notice && (
            <p data-testid="membership-detach-notice" role="status" className="text-xs leading-6">
              {notice}
            </p>
          )}
          <label className="flex items-start gap-2 text-xs leading-6">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={pending}
              onChange={(event) => setConfirmed(event.target.checked)}
              data-testid="membership-detach-confirm"
              className="mt-1.5"
            />
            <span>
              我确认移出此 Project × Machine；若仍有在途执行，关系会停在待处理并等待 Worker
              确认，不显示为已移出。
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void submit()}
              disabled={!confirmed || pending || Boolean(disabledReason)}
              data-testid="membership-detach-submit"
            >
              {pending ? "正在提交移出…" : "确认移出"}
            </Button>
          </div>
          {disabledReason && (
            <p className="text-xs leading-6 text-status-warning">{disabledReason}</p>
          )}
          {notice && (
            <p className="text-[0.6875rem] leading-5 text-muted-foreground">
              结果以刷新后的关系、租约与待处理事实为准。
            </p>
          )}
        </DialogContent>
      </Dialog>
      {notice && !open && (
        <p data-testid="membership-detach-result" role="status" className="mt-1 text-xs leading-6">
          {notice}
        </p>
      )}
    </div>
  );
}

function PendingRow({
  relation,
  pending,
  machineName,
  projectName,
  lease,
  bindingRevision,
  executionCount,
  writeGate,
  onChanged,
  onNotice,
  testId,
}: {
  relation: MachineRelationView;
  pending: PendingFactView;
  machineName: string;
  projectName: string;
  lease: LeaseView | undefined;
  bindingRevision: number | null;
  executionCount: number | null;
  writeGate: WriteGate;
  onChanged: () => void;
  onNotice: (text: string) => void;
  testId: string;
}) {
  const presentation = pendingPresentation(pending, executionCount);
  return (
    <li
      data-testid={`${testId}-pending-item`}
      data-pending-kind={pending.kind}
      data-overdue={pending.overdue ? "true" : "false"}
      className={`min-w-0 rounded-container border px-4 py-3 ${
        pending.overdue ? "border-status-warning/60" : "border-border"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 text-sm font-medium break-all">
          {machineName} <span className="font-normal text-muted-foreground">· {projectName}</span>
        </p>
        <span className="text-[0.6875rem] text-muted-foreground">
          {lease ? `租约${leaseStateLabel(lease.state).label}` : "无租约行"}
        </span>
      </div>
      <p className="mt-1 text-xs leading-6">
        <StatusLine
          label={presentation.title}
          detail={presentation.summary}
          tone={presentation.tone}
        />
      </p>
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[0.6875rem] leading-5 text-muted-foreground">
        <span data-testid={`${testId}-pending-age`}>{presentation.ageText}</span>
        <span data-testid={`${testId}-pending-worker`}>{presentation.workerText}</span>
        <span>
          下一步：
          {pending.canForceReclaim ? "可确认强制收回，或继续等待。" : "继续等待服务端事实推进。"}
        </span>
      </p>
      <details data-testid={`${testId}-pending-detail`} className="group mt-1">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-[0.6875rem] text-muted-foreground">
          <Icon as={ChevronRight} size={12} className="transition-transform group-open:rotate-90" />
          查看待处理细节
        </summary>
        <p className="mt-1 text-xs leading-6 text-muted-foreground">{presentation.detail}</p>
        <p className="text-[0.6875rem] leading-5 text-muted-foreground">
          {presentation.evidenceText}
        </p>
      </details>
      {pending.overdue && (
        <p
          data-testid={`${testId}-pending-overdue`}
          className={`mt-1 text-xs font-medium ${toneText.warning}`}
        >
          等待过久；overdue 只提高紧急程度，不改变事实或权限。
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {pending.kind === "notice_undelivered" ? (
          <span className="text-[0.6875rem] text-muted-foreground">
            无“标记已读”、无“替 Agent 读日志”，也不会启动新 Run 以投递。
          </span>
        ) : (
          <span className="text-[0.6875rem] text-muted-foreground">
            不提供新增使用、保存绑定或再次移出；等待不会自动完成。
          </span>
        )}
        {pending.canForceReclaim && (
          <ForceReclaimControl
            relation={relation}
            pending={pending}
            bindingRevision={bindingRevision}
            lease={lease}
            writeGate={writeGate}
            onChanged={onChanged}
            onNotice={onNotice}
          />
        )}
      </div>
    </li>
  );
}

function ForceReclaimControl({
  relation,
  pending,
  bindingRevision,
  lease,
  writeGate,
  onChanged,
  onNotice,
}: {
  relation: MachineRelationView;
  pending: PendingFactView;
  bindingRevision: number | null;
  lease: LeaseView | undefined;
  writeGate: WriteGate;
  onChanged: () => void;
  onNotice: (text: string) => void;
}) {
  void bindingRevision;
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [receipt, setReceipt] = useState<LeaseMutationView | null>(null);
  const mutationId =
    pending.kind === "membership_detaching"
      ? (relation.membership?.removalMutationId ?? null)
      : (lease?.pendingMutationId ?? null);
  const blockedReason = !writeGate.allowed
    ? writeGate.reason
    : mutationId
      ? ""
      : "没有可确认的待处理收据，不能强制收回。";
  async function submit() {
    if (!mutationId || pendingSubmit || !writeGate.allowed) return;
    setPendingSubmit(true);
    setError(null);
    setReceipt(null);
    try {
      const result = await forceReclaimLeaseFn({
        data: {
          action: "force_reclaim",
          projectId: relation.projectId,
          machineId: relation.machineId,
          mutationId,
          expectedGeneration: lease?.generation ?? 0,
          confirm: true,
        },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReceipt(result.data);
      onNotice(
        `强制收回已提交；撤权未确认，无法确认远端执行已停止。收据 ${result.data.mutationId}。`,
      );
      setOpen(false);
      setConfirmed(false);
      onChanged();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPendingSubmit(false);
    }
  }
  return (
    <div className="min-w-0">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={<Button variant="outline" size="sm" />}
          disabled={Boolean(blockedReason)}
          data-testid="membership-force-trigger"
        >
          强制收回
        </DialogTrigger>
        <DialogContent data-testid="membership-force-dialog">
          <DialogHeader>
            <DialogTitle>强制收回当前 Project × Machine</DialogTitle>
            <DialogDescription>
              只作用于当前 Project × Machine，不影响其他 Project。无法确认远端执行已停止；
              旧副作用可能继续落地，未知结果记为未知，不记成功。这不代表 Worker 已确认排空，
              也不会终止进程或删除文件。
            </DialogDescription>
          </DialogHeader>
          {error && <ResultError error={error} />}
          <label className="flex items-start gap-2 text-xs leading-6">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={pendingSubmit}
              onChange={(event) => setConfirmed(event.target.checked)}
              data-testid="membership-force-confirm"
              className="mt-1.5"
            />
            <span>我理解旧副作用可能与新持有者的操作重叠，确认强制收回。</span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pendingSubmit}>
              取消
            </Button>
            <Button
              variant="outline"
              onClick={() => void submit()}
              disabled={!confirmed || pendingSubmit || !writeGate.allowed}
              data-testid="membership-force-submit"
            >
              {pendingSubmit ? "正在提交…" : "确认强制收回"}
            </Button>
          </div>
          {blockedReason && (
            <p
              data-testid="membership-force-blocked"
              className="text-xs leading-6 text-status-warning"
            >
              {blockedReason}
            </p>
          )}
        </DialogContent>
      </Dialog>
      {blockedReason && !open && (
        <p
          data-testid="membership-force-blocked-hint"
          className="mt-1 text-[0.6875rem] leading-5 text-status-warning"
        >
          {blockedReason}
        </p>
      )}
      {receipt && (
        <p
          data-testid="membership-force-receipt"
          role="status"
          className="mt-1 text-xs leading-6 text-status-warning"
        >
          强制收据 {receipt.mutationId} · 代次 {receipt.completedGeneration}；
          撤权未确认，无法确认远端执行已停止。
        </p>
      )}
    </div>
  );
}

function RemovedRow({
  relation,
  membership,
  machineName,
  projectName,
  lease,
  bindingRevision,
  writeGate,
  onChanged,
  onNotice,
  testId,
}: {
  relation: MachineRelationView;
  membership: MembershipView;
  machineName: string;
  projectName: string;
  lease: LeaseView | undefined;
  bindingRevision: number | null;
  writeGate: WriteGate;
  onChanged: () => void;
  onNotice: (text: string) => void;
  testId: string;
}) {
  const revocation = revocationPresentation(membership.revocation);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState("");
  async function rejoin() {
    if (bindingRevision === null || pending || !writeGate.allowed) return;
    setPending(true);
    setError(null);
    setNotice("");
    try {
      const result = await rejoinProjectMachineFn({
        data: {
          projectId: relation.projectId,
          machineId: relation.machineId,
          requestId: newId(ID_PREFIXES.request),
          expectedEpoch: membership.epoch,
          expectedRevision: bindingRevision,
          confirm: true,
        },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const message = "已重新加入，产生新的加入记录；旧执行、日志与租约收据仍保留在历史。";
      setNotice(message);
      onNotice(message);
      onChanged();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }
  return (
    <li
      data-testid={`${testId}-removed-item`}
      className="min-w-0 rounded-container border border-border px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 text-sm font-medium break-all">
          {machineName} <span className="font-normal text-muted-foreground">· {projectName}</span>
        </p>
        <span className="text-xs text-muted-foreground">
          {lease ? "无当前租约持有" : "无租约行"}
        </span>
      </div>
      <p className="mt-1 text-xs leading-6">
        <StatusLine label="已移出 · 历史" detail="不再是当前项目资源" tone="muted" />
      </p>
      {revocation && (
        <p
          data-testid={`${testId}-removed-revocation`}
          className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs leading-6"
        >
          <StatusLine label={revocation.label} detail={revocation.detail} tone={revocation.tone} />
          {membership.revokedGeneration !== null && (
            <span className="text-muted-foreground">撤权代次 {membership.revokedGeneration}</span>
          )}
        </p>
      )}
      {error && (
        <div data-testid={`${testId}-rejoin-error`} className="mt-2">
          <ResultError error={error} />
          {ERROR_NOTES[error.code] && (
            <p className="mt-1 text-xs leading-6 text-muted-foreground">
              {ERROR_NOTES[error.code]}
            </p>
          )}
        </div>
      )}
      {notice && (
        <p data-testid={`${testId}-rejoin-notice`} role="status" className="mt-2 text-xs leading-6">
          {notice}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!writeGate.allowed || pending || bindingRevision === null}
          onClick={() => void rejoin()}
          data-testid={`${testId}-rejoin`}
        >
          {pending ? "正在重新加入…" : "重新加入"}
        </Button>
        <span className="text-[0.6875rem] text-muted-foreground">
          只对最新 removed 生效；冲突时刷新事实，不自动覆盖新关系。
        </span>
      </div>
      {!writeGate.allowed && (
        <p
          data-testid={`${testId}-rejoin-blocked`}
          className="mt-1 text-xs leading-6 text-status-warning"
        >
          {writeGate.reason}
        </p>
      )}
    </li>
  );
}

function MembershipHistory({
  projectId,
  machineId,
  machineName,
  projectName,
  testId,
}: {
  projectId: string;
  machineId: string;
  machineName: string;
  projectName: string;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const attempted = useRef(false);
  const [history, setHistory] = useState<MembershipHistoryView | null>(null);
  const [executions, setExecutions] = useState<ExecutionView[]>([]);
  const [listError, setListError] = useState<AppError | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [reading, setReading] = useState(false);
  const wiring = useExecutionWiring({ projectId, executions, listError });

  useEffect(() => {
    if (!open || loaded || attempted.current) return;
    let disposed = false;
    attempted.current = true;
    setReading(true);
    setError(null);
    async function load() {
      try {
        const [historyResult, executionResult] = await Promise.all([
          membershipHistoryFn({ data: { projectId, machineId } }),
          listProjectExecutionsFn({ data: { projectId, machineId, limit: 100 } }),
        ]);
        if (disposed) return;
        if (!historyResult.ok) setError(historyResult.error);
        else setHistory(historyResult.data);
        if (!executionResult.ok) setListError(executionResult.error);
        else {
          setExecutions(executionResult.data);
          setListError(null);
        }
        setLoaded(historyResult.ok && executionResult.ok);
      } catch (cause) {
        if (!disposed) setError(toAppError(cause, newId(ID_PREFIXES.request)));
      } finally {
        if (!disposed) setReading(false);
      }
    }
    void load();
    return () => {
      disposed = true;
    };
  }, [open, loaded, reload, projectId, machineId]);

  const latest = history?.memberships[0];
  const summary = latest ? historyMembershipSummary(latest, history.memberships) : null;
  return (
    <details
      data-testid={`${testId}-entry`}
      className="group rounded-container border border-border px-4 py-3"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs leading-6">
        <Icon as={ChevronRight} size={12} className="transition-transform group-open:rotate-90" />
        <span className="font-medium">{machineName}</span>
        <span className="text-muted-foreground">
          · {projectName} · 已移出记录与执行、日志、租约收据
        </span>
      </summary>
      <div className="mt-3 space-y-3 border-t border-border-soft pt-3 text-xs leading-6">
        <p className="text-muted-foreground">
          Human 只读历史：读取结果不会交给被撤权 Agent；没有“标记已读”或“替 Agent 读日志”。
        </p>
        {reading && !loaded && <p className="text-muted-foreground">正在读取只读历史…</p>}
        {error && (
          <div data-testid={`${testId}-error`}>
            <ResultError error={error} />
            <p className="mt-1 text-muted-foreground">
              历史查询失败只影响本区，不改变关系、租约或通知状态。
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => {
                attempted.current = false;
                setLoaded(false);
                setReload((value) => value + 1);
              }}
              data-testid={`${testId}-retry`}
            >
              重试读取历史
            </Button>
          </div>
        )}
        {summary && (
          <div data-testid={`${testId}-summary`}>
            <p>{summary.label}</p>
            <p className="text-muted-foreground">{summary.detail}</p>
          </div>
        )}
        {history && (
          <div data-testid={`${testId}-receipts`}>
            <h4 className="text-xs font-medium">加入记录与租约收据</h4>
            <p className="text-muted-foreground">
              共 {history.memberships.length} 段加入记录、{history.receipts.length} 条租约收据。
            </p>
            {history.receipts.length > 0 && (
              <ul className="mt-1 space-y-1">
                {history.receipts.map((receipt) => (
                  <li key={receipt.mutationId} className="break-all text-muted-foreground">
                    {ACTION_LABELS[receipt.action]} ·{" "}
                    {receipt.state === "completed" ? "已完成" : "待确认"} · 代次{" "}
                    {receipt.completedGeneration ?? receipt.expectedGeneration} ·{" "}
                    {formatMoment(receipt.completedAt ?? receipt.createdAt)}
                    {receipt.forced
                      ? ` · 强制收回，覆盖 ${receipt.supersededMutationId ?? "原动作"}`
                      : receipt.supersededBy
                        ? " · 已被强制收回覆盖"
                        : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {executions.length > 0 && (
          <div data-testid={`${testId}-executions`}>
            <h4 className="text-xs font-medium">历史执行与日志</h4>
            <RemoteExecutionList
              executions={executions}
              machines={[]}
              leases={[]}
              logReader={wiring.logReader}
              connection={wiring.connection}
              dense={false}
              readOnlyNote="Human 只读历史；这里是历史执行，不提供取消，也不替 Agent 读日志。"
              testId={`${testId}-execution-list`}
            />
          </div>
        )}
      </div>
    </details>
  );
}

export function LeaseManageLink({
  projectId,
  machineId,
}: {
  projectId: string;
  machineId: string;
}): ReactNode {
  return (
    <Link
      to="/machines/$machineId/lease"
      params={{ machineId }}
      search={{ projectId }}
      data-testid="lease-manage-link"
      className="inline-flex min-h-6 items-center gap-1 text-[0.6875rem] text-foreground underline decoration-input underline-offset-3 hover:decoration-foreground"
    >
      管理租约与执行
    </Link>
  );
}
