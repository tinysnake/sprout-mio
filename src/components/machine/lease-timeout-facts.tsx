import type { LeaseEscrowView } from "../../contracts/lease";
import type { LeaseWaitFailure } from "../../contracts/lease-timeout";
import { StatusLine } from "./machine-list";
import {
  LEASE_TIMEOUT_LABELS,
  LEASE_WAIT_FAILURE_LABELS,
  durationText,
  leaseEscalationMs,
  leaseTimeoutMs,
  leaseTimeoutPhase,
  leaseWaitReason,
  timeoutNoticeText,
} from "./lease-timeout-view";
import type { LeaseTimeoutLabel } from "./lease-timeout-view";
import { formatMoment } from "./machine-view";

/**
 * 状态位 + 一句说明。
 *
 * 说明不能塞进 `StatusLine` 的 detail：那是单行截断（nowrap）的样式，长句在窄屏会把整行
 * 撑出内容列——视觉核查在 390px 下量到过 131px 的溢出。这里让说明自己换行：
 * `flex-wrap` 下它是独立的 flex 项，宽度不够就整体落到下一行再逐字折行。
 */
function FactStatusLine({ label, detail, tone, testId }: LeaseTimeoutLabel & { testId: string }) {
  return (
    <p data-testid={testId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <StatusLine label={label} tone={tone} />
      <span className="min-w-0 text-muted-foreground">{detail}</span>
    </p>
  );
}

/**
 * 挂靠超时事实。三件事分层呈现，且都不产生新状态：
 * 1. 相位（超时未处理 / 已升级）——超时只加只读标记，租约占用与权限不变，绝不显示成空闲；
 * 2. 时限与提醒投递事实——时限由 `escrowedAt` 与 `deadlineAt` 反推，不假定默认 30 分钟；
 * 3. 人类入口的边界——只指向既有的强制收回与撤销挂靠，界面上不新增任何按钮。
 */
export function LeaseTimeoutFacts({
  escrow,
  machineName,
  initiatorName,
  testId,
}: {
  escrow: LeaseEscrowView;
  machineName: string;
  /** 挂靠发起者，恒等于当时的持有者；这里只用来把「谁在等」说清楚。 */
  initiatorName: string;
  testId: string;
}) {
  const phase = leaseTimeoutPhase(escrow.timeout);
  const escalation = leaseEscalationMs(escrow);
  const escalatedAt = escrow.timeout.escalatedAt;
  const label = phase === "none" ? null : LEASE_TIMEOUT_LABELS[phase];
  return (
    <dd
      data-testid={testId}
      data-timeout-phase={phase}
      className="space-y-1 pt-1 text-[0.6875rem] leading-5"
    >
      {label && <FactStatusLine {...label} testId={`${testId}-state`} />}
      <p data-testid={`${testId}-deadline`} className="text-muted-foreground">
        挂靠时限 {durationText(leaseTimeoutMs(escrow))}
        {"（可按 Project 覆盖）"}：{formatMoment(escrow.timeout.deadlineAt)} 截止 ·{" "}
        {timeoutNoticeText(escrow.timeout)}
      </p>
      {phase === "escalated" && escalation !== null && escalatedAt !== null && (
        <div data-testid={`${testId}-escalation`} className="space-y-1">
          <p>
            升级时限 {durationText(escalation)}：{formatMoment(escalatedAt)}{" "}
            已升级给人类（挂靠发起者与 Project owner）。
          </p>
          <p data-testid={`${testId}-paused`}>
            该 owner 在这个挂靠上的自动尝试已暂停，等人类决定归还还是继续占用。
          </p>
          <p className="text-muted-foreground">
            处理沿用既有的租约动作（强制收回或撤销挂靠），这条路径不新增入口。
          </p>
        </div>
      )}
      {/*
        T11：等待中的申请方看到的是「等待中 + 保留原因」。原因来自租约自身的挂靠事实，
        不是猜谁在等——所以这里写成平台会给出的口径，而不是断言此刻真的有人排队。
      */}
      <LeaseWaitFacts escrow={escrow} initiatorName={initiatorName} machineName={machineName} />
    </dd>
  );
}

/**
 * 申请遇阻等待的状态与保留原因（T11 / N1–N3）。
 * 等待期间零写入，所以它的时长只出现在发起等待的那个分身自己的口径里：
 * 建议 5 分钟、上限 1 小时，与挂靠的 30 分钟时限不是同一个倒计时。
 */
export function LeaseWaitFacts({
  escrow,
  initiatorName,
  machineName,
  testId = "lease-wait-facts",
  failure,
}: {
  escrow: Pick<LeaseEscrowView, "state" | "timeout">;
  initiatorName: string;
  machineName: string;
  testId?: string;
  /** 等待已结束的到点结果；只有申请方那条路径能拿到，所以缺省时不渲染。 */
  failure?: LeaseWaitFailure;
}) {
  const reason = leaseWaitReason(escrow);
  if (!reason) return null;
  return (
    <div data-testid={testId} className="space-y-1">
      <FactStatusLine {...reason} testId={`${testId}-reason`} />
      <p className="text-muted-foreground">
        {initiatorName} 拿不到 Machine「{machineName}
        」时看到的就是这条原因。等待时长由发起等待的分身自己指定（建议 5 分钟、上限 1
        小时），与挂靠时限不是同一个倒计时。
      </p>
      {failure && <LeaseWaitFailureFacts failure={failure} testId={`${testId}-failure`} />}
    </div>
  );
}

/** 等待到点的两种结果（N4/N6）：都由发起等待的 agent 自决下一步。 */
export function LeaseWaitFailureFacts({
  failure,
  testId,
}: {
  failure: LeaseWaitFailure;
  testId: string;
}) {
  return (
    <div data-testid={testId} data-wait-failure={failure}>
      <FactStatusLine {...LEASE_WAIT_FAILURE_LABELS[failure]} testId={`${testId}-state`} />
    </div>
  );
}
