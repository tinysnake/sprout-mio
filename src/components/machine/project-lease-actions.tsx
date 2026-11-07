import { useId, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import type { ProjectInfoHub } from "../../contracts/info-hub";
import type { LeaseMutationInput, LeaseMutationView } from "../../contracts/lease";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { fail, toAppError } from "../../contracts/result";
import { reclaimLeaseFn } from "../../server/functions/lease";
import type { LeaseMutationHandler } from "./machine-view";
import { ResultError } from "../project/result-error";
import { StatusLine } from "./machine-list";
import { mutationStateLabel } from "./lease-view";
import { Button } from "../ui/button";
import type { AppError } from "../../contracts/result";
import { ProjectContextFacts } from "../info-hub/project-context-facts";

export const requestProjectLease = async (
  input: LeaseMutationInput,
  invalidate: () => Promise<unknown>,
): ReturnType<LeaseMutationHandler> => {
  // 界面只提交强制收回；申请、释放与交接由持有租约的分身经 Agent 工具发起。
  if (input.action !== "reclaim")
    return fail({
      code: "validation_failed",
      message: "租约界面只提供强制收回。",
      requestId: input.requestId,
    });
  const result = await reclaimLeaseFn({ data: input });
  await invalidate();
  return result;
};

/** Human 在租约上的唯一动作是强制收回；其余动作属于分身。 */
export function ProjectLeaseActions({
  info,
  machineId,
  children,
}: {
  info: ProjectInfoHub;
  /** 收回的目标就是当前这台 Machine：页面本身已经指定了它，不再要求重选。 */
  machineId: string;
  children: (mutate: LeaseMutationHandler) => ReactNode;
}) {
  const router = useRouter();
  const [error, setError] = useState<AppError | null>(null);
  const [receipt, setReceipt] = useState<LeaseMutationView | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const confirmId = useId();
  const mutate: LeaseMutationHandler = (input) =>
    requestProjectLease(input, () => router.invalidate());
  /** 只在本 Project 确实持有这台 Machine 的租约时可收回；没有租约就没有可收回的对象。 */
  const lease = info.leases.items.find((item) => item.machineId === machineId);
  const reclaimable = lease?.state === "held";

  async function reclaim() {
    if (!lease || lease.state !== "held" || pending) return;
    setPending(true);
    setError(null);
    setReceipt(null);
    try {
      const result = await mutate({
        action: "reclaim",
        projectId: info.projectId,
        machineId,
        expectedGeneration: lease.generation,
        confirm: true,
        requestId: newId(ID_PREFIXES.request),
      });
      if (result.ok) setReceipt(result.data);
      else setError(result.error);
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  const reclaimControls = (
    <div className="space-y-2" data-testid="lease-reclaim-controls">
      <label className="flex items-start gap-2 text-xs leading-5" htmlFor={confirmId}>
        <input
          id={confirmId}
          type="checkbox"
          className="mt-1 accent-destructive"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          data-testid="lease-reclaim-confirm"
        />
        我确认强制收回：这条租约立即置为 free，持有者手上的旧授权不再可用。
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={pending || !machineId || !confirmed}
        onClick={() => void reclaim()}
        data-testid="lease-reclaim"
      >
        {pending ? "正在收回…" : "强制收回"}
      </Button>
      {pending && (
        <p role="status" className="text-xs text-muted-foreground">
          等待服务端租约收据…
        </p>
      )}
    </div>
  );

  return (
    <div className="min-w-0 space-y-4" data-testid="project-lease-actions">
      <ProjectContextFacts info={info} machineId={machineId} />
      {children(mutate)}
      {reclaimable && reclaimControls}
      {receipt && (
        <div data-testid="lease-reclaim-receipt" className="space-y-1 text-xs leading-6">
          <StatusLine {...mutationStateLabel(receipt)} testId="lease-reclaim-receipt-state" />
          <p className="break-all text-muted-foreground">强制收据 {receipt.mutationId}</p>
        </div>
      )}
      {error && <ResultError error={error} />}
    </div>
  );
}

export function holderNames(info: ProjectInfoHub): Record<string, string> {
  return Object.fromEntries(
    info.agents.agents
      .filter((item) => item.instanceId)
      .map((item) => [item.instanceId!, item.name]),
  );
}

/** Chat 的权威显示名来自 Info Hub 摘要（挂靠目标展示与 lease holder 的 chatDisplayTitle 同源）。 */
export function chatNames(info: ProjectInfoHub): Record<string, string> {
  return Object.fromEntries(info.chats.map((chat) => [chat.chatId, chat.displayTitle]));
}

/** Chat 类型只影响挂靠目标是否合法：DM 不是合法的挂靠目标。 */
export function chatKinds(info: ProjectInfoHub): Record<string, "dm" | "group" | "public_channel"> {
  return Object.fromEntries(info.chats.map((chat) => [chat.chatId, chat.kind]));
}

export function agentNames(info: ProjectInfoHub): Record<string, string> {
  return Object.fromEntries(info.agents.agents.map((entry) => [entry.agentProfileId, entry.name]));
}
