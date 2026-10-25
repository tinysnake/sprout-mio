import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { CircleHelp } from "lucide-react";
import type { LeaseMutationView, LeaseView } from "../../contracts/lease";
import type { ExecutionView } from "../../contracts/remote";
import type { AppError } from "../../contracts/result";
import { toAppError } from "../../contracts/result";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { forceReclaimLeaseFn, getLeaseFn } from "../../server/functions/lease";
import { listProjectExecutionsFn } from "../../server/functions/remote";
import type { LeaseMutationHandler } from "../machine/machine-view";
import { formatMoment } from "../machine/machine-view";
import {
  fencingExecutions,
  fencingMutation,
  fencingWaitLabel,
  FENCING_SUMMARY,
  LEASE_MUTATION_LABELS,
  reclaimErrorNote,
} from "../machine/lease-view";
import { ResultError } from "../project/result-error";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Icon } from "../ui/icon";

/** 演示可传入已有投影，避免访问业务接口；正式页面通过现有 Fn 读取。 */
export type FencingSnapshot = {
  executions: readonly ExecutionView[];
  mutation: LeaseMutationView | null;
};

export function LeaseFencingFacts({
  lease,
  snapshot,
  submit,
  clock = Date.now,
}: {
  lease: LeaseView;
  snapshot?: FencingSnapshot;
  submit?: LeaseMutationHandler;
  clock?: () => number;
}) {
  const router = useRouter();
  const [now, setNow] = useState(clock);
  const [loaded, setLoaded] = useState<FencingSnapshot | null>(null);
  const [readError, setReadError] = useState<AppError | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [forceConfirmed, setForceConfirmed] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [receipt, setReceipt] = useState<LeaseMutationView | null>(null);

  useEffect(() => {
    let disposed = false;
    let reading = false;
    setLoaded(null);
    setReadError(null);
    setForceConfirmed(false);
    async function refresh() {
      setNow(clock());
      // /__dev/ui 是纯呈现路由，不能因共享卡片而触发业务查询。
      if (snapshot || window.location.pathname.startsWith("/__dev/") || reading) return;
      reading = true;
      try {
        const [leaseResult, executionsResult] = await Promise.all([
          getLeaseFn({
            data: {
              projectId: lease.projectId,
              machineId: lease.machineId,
              ...(lease.pendingMutationId ? { mutationId: lease.pendingMutationId } : {}),
            },
          }),
          listProjectExecutionsFn({
            data: { projectId: lease.projectId, machineId: lease.machineId, limit: 100 },
          }),
        ]);
        if (disposed) return;
        if (!leaseResult.ok) {
          setReadError(leaseResult.error);
        } else if (!executionsResult.ok) {
          setReadError(executionsResult.error);
        } else {
          setLoaded({ mutation: leaseResult.data.mutation, executions: executionsResult.data });
          setReadError(null);
        }
      } catch (cause) {
        if (!disposed) setReadError(toAppError(cause, newId(ID_PREFIXES.request)));
      } finally {
        reading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [
    lease.projectId,
    lease.machineId,
    lease.pendingMutationId,
    lease.generation,
    snapshot,
    clock,
  ]);

  const facts = snapshot ?? loaded;
  const mutation = fencingMutation(lease, facts?.mutation ?? null);
  const scopedExecutions = facts?.executions.filter(
    (execution) =>
      execution.projectId === lease.projectId && execution.machineId === lease.machineId,
  );
  const uncertain = facts ? fencingExecutions(lease, facts.executions) : null;

  async function reclaim() {
    if (!submit || !confirmed || pending) return;
    setPending(true);
    setError(null);
    setReceipt(null);
    try {
      const result = await submit({
        action: "reclaim",
        projectId: lease.projectId,
        machineId: lease.machineId,
        expectedGeneration: lease.generation,
        requestId: newId(ID_PREFIXES.request),
        confirm: true,
      });
      if (result.ok) setReceipt(result.data);
      else setError(result.error);
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  async function forceReclaim() {
    if (
      !forceConfirmed ||
      pending ||
      !lease.pendingMutationId ||
      lease.state !== "fencing" ||
      snapshot
    )
      return;
    setPending(true);
    setError(null);
    setReceipt(null);
    try {
      const result = await forceReclaimLeaseFn({
        data: {
          action: "force_reclaim",
          projectId: lease.projectId,
          machineId: lease.machineId,
          expectedGeneration: lease.generation,
          mutationId: lease.pendingMutationId,
          confirm: true,
        },
      });
      if (result.ok) {
        setReceipt(result.data);
        setForceConfirmed(false);
        await router.invalidate();
      } else setError(result.error);
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      data-testid="lease-fencing-facts"
      className="min-w-0 space-y-2 break-words text-xs leading-6"
    >
      {/* 卡片正文只留一句可决策的简介；完整事实在问号按钮后的 Dialog 里。 */}
      <div className="flex min-w-0 items-start gap-1.5">
        <p data-testid="lease-fencing-summary" className="min-w-0 flex-1 text-status-warning">
          {FENCING_SUMMARY}
        </p>
        <Dialog>
          <DialogTrigger
            render={<Button variant="ghost" size="icon-sm" />}
            aria-label="回收中状态的完整事实"
            data-testid="lease-fencing-details-trigger"
            className="shrink-0"
          >
            <Icon as={CircleHelp} />
          </DialogTrigger>
          <DialogContent data-testid="lease-fencing-details">
            <DialogHeader>
              <DialogTitle>等待 Worker 确认</DialogTitle>
              <DialogDescription>
                旧授权的关闸由该 Machine 的 Worker
                确认。下面是当前已加载的全部事实，不构成“已排空”或“已完成收回”的断言。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-xs leading-6">
              <p data-testid="lease-fencing-wait" className="text-status-warning">
                {fencingWaitLabel(lease.changedAt, now)} · 自 {formatMoment(lease.changedAt)} 起
              </p>
              <p>
                无法保证等待会结束：重连本身不代表已确认；若 Worker 已失联，需要 Human
                介入才能继续。已启动的进程仍可能继续产生副作用。
              </p>
              <p>被撤权的原持有者仍保留在租约记录中；尚未确认释放或收回。</p>
              <p data-testid="lease-fencing-mutation" className="break-all text-muted-foreground">
                {mutation
                  ? `待处理动作：${LEASE_MUTATION_LABELS[mutation.action]} · 授权代次 ${mutation.expectedGeneration} · ${mutation.mutationId}`
                  : `待处理收据：${lease.pendingMutationId ?? "未提供"}；动作与收据代次尚未读取确认。当前租约代次 ${lease.generation}。`}
              </p>
              {readError && (
                <div data-testid="lease-fencing-read-error">
                  <p>读取失败；下列已加载事实可能过期，不能据此确认已排空。</p>
                  <ResultError error={readError} />
                </div>
              )}
              <p data-testid="lease-fencing-unknown-count">
                {uncertain
                  ? `最近加载的 ${scopedExecutions!.length} 条执行中，结果未知或因 Worker 失联 / 截止时间结束的记录：${uncertain.length} 条（仅此 Project × Machine）。`
                  : "执行记录尚未读取确认，未知结果条数不可用。"}
                执行列表最多 100 条，不能据此断言历史记录已全部排空；现有执行记录未提供 Worker
                排空确认，无法确认这些记录是否已关闸。
              </p>
              {uncertain && uncertain.length > 0 && (
                <ul
                  data-testid="lease-fencing-executions"
                  className="space-y-1 text-muted-foreground"
                >
                  {uncertain.map((execution) => (
                    <li key={execution.executionId} className="break-all">
                      {execution.executionId} · 代次 {execution.authorizationGeneration} ·{" "}
                      {execution.state}
                      {execution.failureReason ? ` / ${execution.failureReason}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {submit && (
              <div className="space-y-2 border-t border-border-soft pt-2">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={pending}
                    onChange={(event) => setConfirmed(event.target.checked)}
                    data-testid="lease-fencing-reclaim-confirm"
                    className="mt-1.5"
                  />
                  <span>
                    确认请求收回此租约。收回仍需 Worker
                    确认，不会跳过关闸，也不会终止进程或删除文件。
                  </span>
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!confirmed || pending}
                  onClick={() => void reclaim()}
                  data-testid="lease-fencing-reclaim"
                >
                  {pending ? "正在请求收回…" : "请求收回"}
                </Button>
                {lease.state === "fencing" && !snapshot && (
                  <div
                    className="space-y-2 border-t border-border-soft pt-2"
                    data-testid="lease-force-reclaim-controls"
                  >
                    <p className="text-status-warning" data-testid="lease-force-reclaim-warning">
                      Human
                      可强制收回并允许新分身立即取得租约。旧副作用可能仍在落地，未知结果记为未知不记成功；这不代表
                      Worker 已确认排空，也不会终止进程或删除文件。
                    </p>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={forceConfirmed}
                        disabled={pending}
                        onChange={(event) => setForceConfirmed(event.target.checked)}
                        data-testid="lease-force-reclaim-confirm"
                        className="mt-1.5"
                      />
                      <span>
                        我理解旧副作用可能与新持有者的操作重叠，确认强制收回此 Project × Machine
                        的租约。
                      </span>
                    </label>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!forceConfirmed || pending || !lease.pendingMutationId}
                      onClick={() => void forceReclaim()}
                      data-testid="lease-force-reclaim"
                    >
                      {pending ? "正在提交…" : "强制收回"}
                    </Button>
                  </div>
                )}
                {error && (
                  <div data-testid="lease-fencing-reclaim-error" role="status">
                    <ResultError error={error} />
                    {reclaimErrorNote(error.code) && <p>{reclaimErrorNote(error.code)}</p>}
                  </div>
                )}
                {receipt && (
                  <p data-testid="lease-fencing-reclaim-receipt" role="status">
                    收据 {receipt.mutationId} · {receipt.state}；以刷新后的租约事实为准。
                  </p>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
