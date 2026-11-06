import { useState, type FormEvent } from "react";
import type { Chat } from "../../contracts/chat";
import type { LeaseEscrowCommandInput, LeaseEscrowView, LeaseView } from "../../contracts/lease";
import type { MachineDetail } from "../../contracts/machine";
import type { AppError } from "../../contracts/result";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { ActionOutcomeNotice, type ActionOutcome } from "../ui/action-outcome";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Select } from "../ui/select";
import { chatDisplayName } from "../chat/chat-display";
import { chatAgentName, type ChatAgent } from "../chat/chat-list";
import { ResultError } from "../project/result-error";
import { runLeaseEscrowCommand, type LeaseEscrowHandler } from "./lease-escrow-command";
import {
  claimableEscrows,
  ESCROW_TARGET_NOTE,
  chatKindLabel,
  escrowClaimScope,
  escrowClaimerLabel,
  escrowCommandSucceeded,
  escrowReceiptNote,
  escrowStateLabel,
  escrowTargetLabel,
  leaseStateLabel,
  liveEscrowOf,
  outboundEscrows,
  type EscrowNames,
} from "./lease-view";
import { formatMoment } from "./machine-view";
import { StatusLine } from "./machine-list";

/**
 * 挂靠的产品面：Machine 详情里发起挂靠，Group / Public Channel 里领取与撤销。
 * 页面只发命令与展示服务端读回来的事实，范围判定用 `lease-view` 的纯投影。
 */

type RunState = {
  pending: boolean;
  outcome: ActionOutcome;
  detail: string | null;
  error: AppError | null;
};

const idleRun: RunState = { pending: false, outcome: null, detail: null, error: null };

/** 一个页面里可能同时有多个 Machine 的挂靠命令，按 key（machineId / escrowId）分开记状态。 */
function useEscrowRuns(handler: LeaseEscrowHandler) {
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [receipts, setReceipts] = useState<Record<string, LeaseEscrowView | null>>({});
  const run = async (key: string, input: LeaseEscrowCommandInput) => {
    setRuns((prev) => ({
      ...prev,
      [key]: { pending: true, outcome: "processing", detail: null, error: null },
    }));
    const result = await runLeaseEscrowCommand(handler, input);
    if (result.state === "success") {
      const escrow = result.receipt.escrow;
      setReceipts((prev) => ({ ...prev, [key]: escrow }));
      setRuns((prev) => ({
        ...prev,
        [key]: {
          pending: false,
          outcome: escrowCommandSucceeded(input.action, escrow) ? "success" : "failure",
          detail: escrowReceiptNote(input.action, escrow),
          error: null,
        },
      }));
      return;
    }
    setRuns((prev) => ({
      ...prev,
      [key]: {
        pending: false,
        outcome: result.state,
        detail: result.error.message,
        error: result.error,
      },
    }));
  };
  return { runs, receipts, run };
}

/**
 * 目标 Chat 的显示名沿用列表页的规则：人工 title 优先，其次参与分身名；
 * 裸 chat id 不作为人类可读文案（它只出现在 `title` 属性里）。
 */
function chatLabel(
  chat: EscrowChatChoice,
  chatAgents: readonly ChatAgent[],
  agentNames: Readonly<Record<string, string>>,
): string {
  return chatDisplayName(
    chat,
    chatAgentName(chat.id, [...chatAgents], new Map(Object.entries(agentNames))),
  );
}

function machineName(machines: readonly MachineDetail[], machineId: string): string {
  return machines.find((item) => item.machine.id === machineId)?.machine.name ?? machineId;
}

function escrowNamesOf(
  chats: readonly EscrowChatChoice[],
  agents: readonly { agentProfileId: string; name: string; chatId?: string | null }[],
  provided: Readonly<Record<string, string>> = {},
): EscrowNames {
  const agentNames = Object.fromEntries(agents.map((agent) => [agent.agentProfileId, agent.name]));
  const chatAgents: ChatAgent[] = agents.flatMap((agent) =>
    agent.chatId ? [{ chatId: agent.chatId, agentProfileId: agent.agentProfileId }] : [],
  );
  return {
    chats: Object.fromEntries(
      chats.map((chat) => [
        chat.id,
        provided[chat.id]?.trim() || chatLabel(chat, chatAgents, agentNames),
      ]),
    ),
    chatKinds: Object.fromEntries(chats.map((chat) => [chat.id, chat.kind])),
    agents: agentNames,
  };
}

/** 挂靠面板只需要 Chat 的身份与类型，不需要完整 Chat 行；演示与页面都能复用同一份形状。 */
export type EscrowChatChoice = Pick<Chat, "id" | "kind" | "title">;

/**
 * Machine 详情里的挂靠入口：把租约挂到本 Project 的 Group / Public Channel，
 * 或从发起挂靠的分身所在的 Chat 撤销。目标 Chat 列表由调用方按已有读模型传入。
 */
export function LeaseEscrowEntry({
  projectId,
  lease,
  chats,
  agents = [],
  chatNames = {},
  holderChatId,
  holderChatName = null,
  handler,
  testId = "lease-escrow",
}: {
  projectId: string;
  lease: LeaseView;
  chats: readonly EscrowChatChoice[];
  agents?: readonly { agentProfileId: string; name: string; chatId?: string | null }[];
  /** 权威显示名（如 Info Hub 的 chat displayTitle）；缺省时按列表页规则推导。 */
  chatNames?: Readonly<Record<string, string>>;
  holderChatId: string | null;
  holderChatName?: string | null;
  handler: LeaseEscrowHandler;
  testId?: string;
}) {
  const { runs, receipts, run } = useEscrowRuns(handler);
  const [targetChatId, setTargetChatId] = useState("");
  const [targetProfileId, setTargetProfileId] = useState("");
  const live = liveEscrowOf(lease);
  const state = runs[lease.machineId] ?? idleRun;
  const receipt = receipts[lease.machineId] ?? null;
  const names = escrowNamesOf(chats, agents, chatNames);
  const targets = chats.filter((chat) => chat.kind !== "dm");
  const targetAgents = agents.filter((agent) => agent.chatId === targetChatId);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!targetChatId) return;
    void run(lease.machineId, {
      action: "escrow",
      projectId,
      machineId: lease.machineId,
      requestId: newId(ID_PREFIXES.request),
      expectedGeneration: lease.generation,
      chatId: targetChatId,
      ...(targetProfileId ? { targetAgentProfileId: targetProfileId } : {}),
    });
  };

  return (
    <section
      data-testid={testId}
      data-escrow-state={live?.state ?? "none"}
      className="min-w-0 space-y-3 rounded-lg border border-border-soft p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h5 className="text-xs font-medium text-foreground">租约挂靠与领取</h5>
        <span className="text-[11px] text-muted-foreground" data-testid={`${testId}-scope-note`}>
          {ESCROW_TARGET_NOTE}
        </span>
      </div>
      {live ? (
        <div className="space-y-2" data-testid={`${testId}-live`} data-escrow-id={live.escrowId}>
          <StatusLine
            label={escrowStateLabel(live.state).label}
            detail={`代次 ${live.escrowGeneration}`}
            tone={escrowStateLabel(live.state).tone}
            testId={`${testId}-state`}
          />
          <p className="text-xs text-muted-foreground" data-testid={`${testId}-target`}>
            挂靠目标：{escrowTargetLabel(live, names)}
          </p>
          <p className="text-xs text-muted-foreground" data-testid={`${testId}-since`}>
            发起 {formatMoment(live.escrowedAt)}
          </p>
          {lease.holderInstanceId === live.escrowedByInstanceId && holderChatId ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                撤销要由发起挂靠的分身执行，命令会送进
                {holderChatName ?? holderChatId}。
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid={`${testId}-cancel`}
                disabled={state.pending}
                onClick={() =>
                  void run(lease.machineId, {
                    action: "escrow_cancel",
                    projectId,
                    machineId: lease.machineId,
                    requestId: newId(ID_PREFIXES.request),
                    expectedGeneration: lease.generation,
                    escrowId: live.escrowId,
                  })
                }
              >
                撤销挂靠
              </Button>
            </div>
          ) : (
            <p
              className="text-xs text-muted-foreground"
              data-testid={`${testId}-cancel-unavailable`}
            >
              撤销入口只在发起挂靠的分身所在的 Chat 出现。
            </p>
          )}
        </div>
      ) : lease.state !== "held" ? (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-not-held`}>
          只有持有中的租约可以挂靠；当前租约
          {leaseStateLabel(lease.state).label}。
        </p>
      ) : !holderChatId ? (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-no-holder-chat`}>
          挂靠要由持有这台 Machine 的分身在自己的 Chat 里执行；当前持有者没有可用的 Chat
          分身，请先让 Agent 接管这台 Machine 的租约。
        </p>
      ) : (
        <form className="space-y-3" onSubmit={submit} data-testid={`${testId}-form`}>
          <Field
            label="挂靠目标（Group / Public Channel）"
            htmlFor={`escrow-target-${lease.machineId}`}
            hint="DM 与跨 Project 的目标不被支持。"
          >
            <Select
              id={`escrow-target-${lease.machineId}`}
              data-testid={`${testId}-chat`}
              value={targetChatId}
              onChange={(event) => {
                setTargetChatId(event.target.value);
                setTargetProfileId("");
              }}
            >
              <option value="">选择目标 Group / Public Channel</option>
              {targets.map((chat) => (
                <option key={chat.id} value={chat.id}>
                  {names.chats?.[chat.id] ?? chat.id}（{chatKindLabel(chat.kind)}）
                </option>
              ))}
            </Select>
          </Field>
          {targetAgents.length > 0 && (
            <Field
              label="指定 Agent（可选）"
              htmlFor={`escrow-agent-${lease.machineId}`}
              hint="指定后只有该 Agent 在该 Group 的分身能领取；不指定则 Group 内任意分身可领取。"
            >
              <Select
                id={`escrow-agent-${lease.machineId}`}
                data-testid={`${testId}-agent`}
                value={targetProfileId}
                onChange={(event) => setTargetProfileId(event.target.value)}
              >
                <option value="">不指定</option>
                {targetAgents.map((agent) => (
                  <option key={agent.agentProfileId} value={agent.agentProfileId}>
                    {agent.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <p className="text-xs text-muted-foreground" data-testid={`${testId}-holder-chat`}>
            命令会送进持有者所在的 {holderChatName ?? holderChatId}，由该分身用 run 授权执行。
          </p>
          <Button
            type="submit"
            size="sm"
            data-testid={`${testId}-submit`}
            disabled={state.pending || !targetChatId}
          >
            {state.pending ? "请求中…" : "挂靠租约"}
          </Button>
        </form>
      )}
      <ActionOutcomeNotice
        action="租约挂靠"
        state={state.outcome}
        detail={state.detail ?? undefined}
        testId={`${testId}-outcome`}
      />
      {receipt && (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`${testId}-receipt`}
          data-receipt-state={receipt.state}
        >
          收据：挂靠 {receipt.escrowId} · {escrowStateLabel(receipt.state).label}
          {escrowClaimerLabel(receipt, names.agents ?? {})
            ? ` · 领取者 ${escrowClaimerLabel(receipt, names.agents ?? {})}`
            : ""}
        </p>
      )}
      {state.error && <ResultError error={state.error} testId={`${testId}-error`} />}
    </section>
  );
}

/**
 * Chat 里的挂靠面板：本 Chat 是挂靠目标时给出领取入口，本 Chat 的分身发起过挂靠时给出撤销入口。
 * 领取范围只看分身身份，不判断分身是否正在跑。
 */
/** Chat 面板的展示与命令入口；Chat 内的实例事实由调用方按自己的读模型传入。 */
export type ChatLeaseEscrowPanelProps = {
  projectId: string;
  chatId: string;
  chatKind: "dm" | "group" | "public_channel";
  leases: readonly LeaseView[];
  machines?: readonly MachineDetail[];
  instances?: readonly { instanceId: string; agentProfileId: string }[];
  chatNames?: Readonly<Record<string, string>>;
  chatKinds?: Readonly<Record<string, "dm" | "group" | "public_channel">>;
  agentNames?: Readonly<Record<string, string>>;
  instanceNames?: Readonly<Record<string, string>>;
  handler: LeaseEscrowHandler;
  loading?: boolean;
  error?: AppError | null;
  testId?: string;
};

export function ChatLeaseEscrowPanel({
  projectId,
  chatId,
  chatKind,
  leases,
  machines = [],
  instances = [],
  chatNames = {},
  chatKinds = {},
  agentNames = {},
  instanceNames = {},
  handler,
  loading = false,
  error = null,
  testId = "chat-lease-escrow",
}: ChatLeaseEscrowPanelProps) {
  const { runs, receipts, run } = useEscrowRuns(handler);
  const names: EscrowNames = { chats: chatNames, chatKinds, agents: agentNames };
  const inbound = chatKind === "dm" ? [] : claimableEscrows(leases, projectId, chatId);
  const outbound =
    chatKind === "dm"
      ? []
      : outboundEscrows(
          leases,
          projectId,
          instances.map((item) => item.instanceId),
        );

  const settled = Object.entries(receipts).flatMap(([escrowId, receipt]) =>
    receipt &&
    !inbound.some((lease) => lease.escrow?.escrowId === escrowId) &&
    !outbound.some((lease) => lease.escrow?.escrowId === escrowId)
      ? [{ escrowId, receipt }]
      : [],
  );

  const claim = (lease: LeaseView, escrowId: string) =>
    void run(escrowId, {
      action: "claim",
      projectId,
      machineId: lease.machineId,
      requestId: newId(ID_PREFIXES.request),
      expectedGeneration: lease.generation,
      escrowId,
    });

  const cancel = (lease: LeaseView, escrowId: string) =>
    void run(escrowId, {
      action: "escrow_cancel",
      projectId,
      machineId: lease.machineId,
      requestId: newId(ID_PREFIXES.request),
      expectedGeneration: lease.generation,
      escrowId,
    });

  return (
    <section
      data-testid={testId}
      data-inbound={inbound.length}
      data-outbound={outbound.length}
      className="min-w-0 space-y-3 rounded-lg border border-border-soft p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h5 className="text-xs font-medium text-foreground">租约挂靠</h5>
        <span className="text-[11px] text-muted-foreground">{ESCROW_TARGET_NOTE}</span>
      </div>
      {error && <ResultError error={error} testId={`${testId}-error`} />}
      {loading ? (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-loading`}>
          读取挂靠事实…
        </p>
      ) : chatKind === "dm" ? (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-dm-note`}>
          DM 不能作为挂靠目标，也不会收到挂靠；领取只发生在 Group 或 Public Channel。
        </p>
      ) : inbound.length === 0 && outbound.length === 0 && settled.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-empty`}>
          本 Chat 没有待领取的挂靠，也没有挂靠出去的租约。
        </p>
      ) : (
        <div className="space-y-3">
          {inbound.map((lease) => {
            const escrow = liveEscrowOf(lease);
            if (!escrow) return null;
            const scope = escrowClaimScope(escrow, instances, names);
            const state = runs[escrow.escrowId] ?? idleRun;
            const receipt = receipts[escrow.escrowId] ?? null;
            return (
              <div
                key={escrow.escrowId}
                data-testid={`${testId}-inbound-${lease.machineId}`}
                data-escrow-id={escrow.escrowId}
                className="space-y-2 rounded-control border border-border-soft p-3"
              >
                <p className="text-xs text-foreground">
                  待领取：{machineName(machines, lease.machineId)} · 代次 {lease.generation}
                </p>
                <p
                  className="text-xs text-muted-foreground"
                  data-testid={`${testId}-inbound-target-${lease.machineId}`}
                >
                  {escrowTargetLabel(escrow, names)} · 发起 {formatMoment(escrow.escrowedAt)}
                </p>
                {scope.note && (
                  <p
                    className="text-xs text-status-warning"
                    data-testid={`${testId}-scope-${lease.machineId}`}
                  >
                    {scope.note}
                  </p>
                )}
                <Button
                  type="button"
                  size="sm"
                  data-testid={`${testId}-claim-${lease.machineId}`}
                  disabled={state.pending || !scope.claimable}
                  onClick={() => claim(lease, escrow.escrowId)}
                >
                  {state.pending ? "领取中…" : "领取租约"}
                </Button>
                <ActionOutcomeNotice
                  action="领取"
                  state={state.outcome}
                  detail={state.detail ?? undefined}
                  testId={`${testId}-claim-outcome-${lease.machineId}`}
                />
                {state.error && (
                  <ResultError
                    error={state.error}
                    testId={`${testId}-claim-error-${lease.machineId}`}
                  />
                )}
                {receipt && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid={`${testId}-claim-receipt-${lease.machineId}`}
                    data-receipt-state={receipt.state}
                  >
                    收据：{escrowStateLabel(receipt.state).label}
                    {escrowClaimerLabel(receipt, instanceNames)
                      ? ` · 领取者 ${escrowClaimerLabel(receipt, instanceNames)}`
                      : ""}
                  </p>
                )}
              </div>
            );
          })}
          {outbound.map((lease) => {
            const escrow = liveEscrowOf(lease);
            if (!escrow) return null;
            const state = runs[escrow.escrowId] ?? idleRun;
            const receipt = receipts[escrow.escrowId] ?? null;
            return (
              <div
                key={`out-${escrow.escrowId}`}
                data-testid={`${testId}-outbound-${lease.machineId}`}
                data-escrow-id={escrow.escrowId}
                className="space-y-2 rounded-control border border-border-soft p-3"
              >
                <p className="text-xs text-foreground">
                  本 Chat 挂靠中：{machineName(machines, lease.machineId)} · 代次 {lease.generation}
                </p>
                <p
                  className="text-xs text-muted-foreground"
                  data-testid={`${testId}-outbound-target-${lease.machineId}`}
                >
                  {escrowTargetLabel(escrow, names)} · 由{" "}
                  {instanceNames[escrow.escrowedByInstanceId] ?? escrow.escrowedByInstanceId} 发起
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid={`${testId}-cancel-${lease.machineId}`}
                  disabled={state.pending}
                  onClick={() => cancel(lease, escrow.escrowId)}
                >
                  {state.pending ? "撤销中…" : "撤销挂靠"}
                </Button>
                <ActionOutcomeNotice
                  action="撤销挂靠"
                  state={state.outcome}
                  detail={state.detail ?? undefined}
                  testId={`${testId}-cancel-outcome-${lease.machineId}`}
                />
                {state.error && (
                  <ResultError
                    error={state.error}
                    testId={`${testId}-cancel-error-${lease.machineId}`}
                  />
                )}
                {receipt && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid={`${testId}-cancel-receipt-${lease.machineId}`}
                    data-receipt-state={receipt.state}
                  >
                    收据：{escrowStateLabel(receipt.state).label}
                  </p>
                )}
              </div>
            );
          })}
          {settled.length > 0 && (
            <div className="space-y-1" data-testid={`${testId}-settled`}>
              {settled.map(({ escrowId, receipt }) => (
                <p
                  key={escrowId}
                  className="text-xs text-muted-foreground"
                  data-testid={`${testId}-settled-${receipt.machineId}`}
                  data-receipt-state={receipt.state}
                >
                  挂靠收据：{machineName(machines, receipt.machineId)} ·{" "}
                  {escrowStateLabel(receipt.state).label}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
