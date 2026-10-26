import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import type { ProjectInfoHub } from "../../contracts/info-hub";
import type { LeaseMutationInput } from "../../contracts/lease";
import type { Chat } from "../../contracts/chat";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { fail, toAppError } from "../../contracts/result";
import { listChatsFn, sendMessageFn } from "../../server/functions/chat";
import { getLeaseFn, getLeaseRequestFn, reclaimLeaseFn } from "../../server/functions/lease";
import type { LeaseMutationHandler } from "./machine-view";
import { ResultError } from "../project/result-error";
import { Select } from "../ui/select";
import { Button } from "../ui/button";
import type { AppError } from "../../contracts/result";
import { chatAgentName, type ChatAgent } from "../chat/chat-list";

export const requestProjectLease = async (
  input: LeaseMutationInput,
  chatId: string,
  invalidate: () => Promise<unknown>,
  now: () => number = Date.now,
): ReturnType<LeaseMutationHandler> => {
  if (input.action === "reclaim") {
    const result = await reclaimLeaseFn({ data: input });
    await invalidate();
    return result;
  }
  if (!chatId)
    return fail({
      code: "validation_failed",
      message: "请先选择执行租约操作的 Chat",
      requestId: input.requestId,
    });
  const { action, projectId: _projectId, ...parameters } = input;
  const sent = await sendMessageFn({
    data: {
      chatId,
      body: `请使用 sprout_lease_${action} 工具执行以下租约请求，参数必须保持一致。先读取当前租约，若代次已变化请报告冲突，不要自动重试。只操作这台明确指定的 Machine；不要运行 shell 或修改文件。参数：${JSON.stringify(parameters)}。完成后报告服务端收据。`,
    },
  });
  if (!sent.ok) return sent;
  const readReceipt = async () => {
    try {
      return await getLeaseRequestFn({
        data: {
          projectId: input.projectId,
          machineId: input.machineId,
          requestId: input.requestId,
          chatId,
        },
      });
    } catch (cause) {
      return fail(toAppError(cause, input.requestId));
    }
  };
  const isTemporary = (error: AppError) =>
    error.code === "internal" || error.code === "too_many_requests";
  const deadline = now() + 180_000;
  let delay = 500;
  while (now() < deadline) {
    const result = await readReceipt();
    if (!result.ok && !isTemporary(result.error)) return result;
    if (result.ok && result.data.mutation) {
      await invalidate();
      return { ok: true, data: result.data.mutation, requestId: input.requestId };
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
    delay = Math.min(delay * 2, 2000);
  }
  // A slow agent may commit between the last poll and the deadline. Reconcile both
  // current lease and this action's receipt before reporting an unknown outcome.
  try {
    const lease = await getLeaseFn({
      data: { projectId: input.projectId, machineId: input.machineId },
    });
    if (!lease.ok && !isTemporary(lease.error)) return lease;
  } catch (cause) {
    const error = toAppError(cause, input.requestId);
    if (!isTemporary(error)) return fail(error);
  }
  const final = await readReceipt();
  if (!final.ok && !isTemporary(final.error)) return final;
  await invalidate();
  if (final.ok && final.data.mutation)
    return { ok: true, data: final.data.mutation, requestId: input.requestId };
  return fail({
    code: "lease_result_unconfirmed",
    message:
      "请求已发送，结果未确认。请打开所选 Chat 核对服务端租约收据，动作 requestId：" +
      input.requestId +
      "。重新操作前请刷新租约。",
    requestId: input.requestId,
  });
};

export function holderNames(info: ProjectInfoHub): Record<string, string> {
  return Object.fromEntries(
    info.agents.agents
      .filter((item) => item.instanceId)
      .map((item) => [item.instanceId!, item.name]),
  );
}

/**
 * Chat 选项的显示依赖：Chat 的 title 目前没有写入方（contracts 只做 null 透传），
 * 所以显示层与 Chat 列表一致地退回分身名，而不是裸露的 chat id。
 * 这里只用既有 Fn 返回的 Project Info Hub 成员与 DM 链接，不新增契约字段。
 */
function chatNameResolver(info: ProjectInfoHub) {
  const chatAgents: ChatAgent[] = info.agents.agents.flatMap((entry) =>
    entry.chatId ? [{ chatId: entry.chatId, agentProfileId: entry.agentProfileId }] : [],
  );
  const agentNames = new Map(
    info.agents.agents.map((entry) => [entry.agentProfileId, entry.name] as const),
  );
  return (chat: Chat) => chat.title ?? chatAgentName(chat.id, chatAgents, agentNames);
}

/** Human requests a Chat turn; only the grant-bound agent can mutate a holder lease. */
export function ProjectLeaseActions({
  info,
  fixedMachineId,
  children,
}: {
  info: ProjectInfoHub;
  /**
   * 已经在单台 Machine 的页面上时传入：交接与收回的目标就是这台，不再要求重选。
   * 跨机器操作（Project settings 等）不传，保留显式选择。
   */
  fixedMachineId?: string;
  children: (mutate: LeaseMutationHandler) => ReactNode;
}) {
  const router = useRouter();
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState("");
  const [pickedMachineId, setPickedMachineId] = useState("");
  const machineId = fixedMachineId ?? pickedMachineId;
  const [targetInstanceId, setTargetInstanceId] = useState("");
  const [error, setError] = useState<AppError | null>(null);
  const [pending, setPending] = useState(false);
  const chatName = chatNameResolver(info);
  useEffect(() => {
    let live = true;
    void listChatsFn({ data: { projectId: info.projectId } }).then((result) => {
      if (!live) return;
      if (result.ok) setChats(result.data);
      else setError(result.error);
    });
    return () => {
      live = false;
    };
  }, [info.projectId]);

  const mutate: LeaseMutationHandler = (input) =>
    requestProjectLease(input, chatId, () => router.invalidate());

  async function extra(action: "reclaim" | "handoff") {
    const lease = info.leases.items.find((item) => item.machineId === machineId);
    if (!lease || lease.state !== "held" || pending) return;
    setPending(true);
    setError(null);
    try {
      const input: LeaseMutationInput =
        action === "reclaim"
          ? {
              action,
              projectId: info.projectId,
              machineId,
              expectedGeneration: lease.generation,
              confirm: true,
              requestId: newId(ID_PREFIXES.request),
            }
          : {
              action,
              projectId: info.projectId,
              machineId,
              expectedGeneration: lease.generation,
              targetInstanceId,
              requestId: newId(ID_PREFIXES.request),
            };
      const result = await mutate(input);
      if (!result.ok) setError(result.error);
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="space-y-4" data-testid="project-lease-actions">
      <div className="space-y-2 rounded-lg border border-border-soft p-4">
        <label className="text-xs font-medium" htmlFor={`lease-chat-${info.projectId}`}>
          执行租约请求的 Chat
        </label>
        <Select
          id={`lease-chat-${info.projectId}`}
          value={chatId}
          onChange={(event) => setChatId(event.target.value)}
          data-testid="lease-chat-select"
        >
          <option value="">请选择 Chat</option>
          {chats.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chatName(chat)}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">
          申请、释放与交接会发送给所选 Chat 的分身，收到服务端收据后才显示成功。租约与 run
          独立；释放和收回不会终止进程或删除文件。
        </p>
        {chatId ? (
          <Link
            to="/projects/$projectId/chats/$chatId"
            params={{ projectId: info.projectId, chatId }}
            className="text-xs underline"
          >
            打开所选 Chat
          </Link>
        ) : (
          <Link
            to="/projects/$projectId/chats"
            params={{ projectId: info.projectId }}
            className="text-xs underline"
          >
            打开对话列表
          </Link>
        )}
      </div>
      {children(mutate)}
      <div
        className="space-y-2 rounded-lg border border-border-soft p-4"
        data-testid="lease-transfer-controls"
      >
        <p className="text-xs font-medium">交接与收回</p>
        {fixedMachineId ? (
          <div data-testid="lease-transfer-machine" className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">目标 Machine</span>
            <p className="min-h-9.5 rounded-control border border-input bg-muted px-2.75 py-2 text-[13px]">
              {info.machines.find((item) => item.machine.id === fixedMachineId)?.machine.name ??
                fixedMachineId}
            </p>
          </div>
        ) : (
          <Select
            aria-label="交接或收回的 Machine"
            data-testid="lease-transfer-machine"
            value={pickedMachineId}
            onChange={(event) => setPickedMachineId(event.target.value)}
          >
            <option value="">请选择持有中的 Machine</option>
            {info.leases.items
              .filter((lease) => lease.state === "held")
              .map((lease) => (
                <option key={lease.machineId} value={lease.machineId}>
                  {info.machines.find((item) => item.machine.id === lease.machineId)?.machine
                    .name ?? lease.machineId}
                </option>
              ))}
          </Select>
        )}
        <Select
          aria-label="交接目标分身"
          data-testid="lease-transfer-target"
          value={targetInstanceId}
          onChange={(event) => setTargetInstanceId(event.target.value)}
        >
          <option value="">请选择交接目标分身</option>
          {info.agents.agents
            .filter((instance) => instance.instanceId)
            .map((instance) => (
              <option key={instance.instanceId} value={instance.instanceId}>
                {instance.name} · {instance.instanceId}
              </option>
            ))}
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !machineId || !targetInstanceId || !chatId}
            onClick={() => void extra("handoff")}
          >
            请求分身交接
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !machineId}
            onClick={() => void extra("reclaim")}
          >
            收回租约
          </Button>
        </div>
        {!chatId && machineId && targetInstanceId && (
          <p className="text-xs text-muted-foreground" data-testid="lease-handoff-chat-required">
            请先在上方选择执行请求的 Chat，再请求分身交接。
          </p>
        )}
        {pending && (
          <p role="status" className="text-xs text-muted-foreground">
            等待服务端租约收据…
          </p>
        )}
      </div>
      {error && <ResultError error={error} />}
    </div>
  );
}
