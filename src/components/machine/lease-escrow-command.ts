import type { LeaseEscrowCommandInput, LeaseEscrowView, LeaseView } from "../../contracts/lease";
import type { AppError, AppResult } from "../../contracts/result";
import { fail, toAppError } from "../../contracts/result";
import { sendMessageFn } from "../../server/functions/chat";
import { getLeaseEscrowFn, getLeaseFn } from "../../server/functions/lease";

/**
 * 挂靠 / 领取 / 撤销都由某个 Chat 里的 Agent 用 run 授权执行：领域层要求
 * `assertRunIdentity`（活着的 run 与未撤销的 grant），Human 会话没有这层身份，
 * 因此这里与一期租约动作一致，把命令发给 Chat 的 Agent，再轮询服务端收据。
 * 发送与轮询都只转发输入，判定只看服务端读回来的事实。
 */
export type LeaseEscrowCommandReceipt = { lease: LeaseView; escrow: LeaseEscrowView | null };

export type LeaseEscrowHandler = (
  input: LeaseEscrowCommandInput,
) => Promise<AppResult<LeaseEscrowCommandReceipt>>;

/** Agent 侧工具名；工具与 RPC 接线由 I-P8a 集成单元完成，UI 只负责把命令送进 Chat。 */
export const LEASE_ESCROW_TOOLS: Record<LeaseEscrowCommandInput["action"], string> = {
  escrow: "sprout_lease_escrow",
  claim: "sprout_lease_claim",
  escrow_cancel: "sprout_lease_escrow_cancel",
};

const ESCROW_ACTION_LABELS: Record<LeaseEscrowCommandInput["action"], string> = {
  escrow: "挂靠",
  claim: "领取",
  escrow_cancel: "撤销挂靠",
};

export function leaseEscrowInstruction(input: LeaseEscrowCommandInput): string {
  const { action, projectId: _projectId, ...parameters } = input;
  return `请使用 ${LEASE_ESCROW_TOOLS[action]} 工具执行以下租约${ESCROW_ACTION_LABELS[action]}请求，参数必须保持一致。先读取当前租约与挂靠事实，若代次或挂靠状态已经变化请报告冲突，不要自动重试，也不要改写参数。用你自己的身份执行，不要代替其他分身。只操作这台明确指定的 Machine；不要运行 shell 或修改文件。参数：${JSON.stringify(parameters)}。完成后报告服务端收据。`;
}

/** 一次挂靠命令的结果；UI 只按这里的状态渲染，不自己推断成功。 */
export type LeaseEscrowCommandOutcome =
  | { state: "success"; receipt: LeaseEscrowCommandReceipt }
  | { state: "failure" | "unknown"; error: AppError };

/** 跑一次命令并归一化结果：未确认结果不能当失败，也不能当成功。 */
export async function runLeaseEscrowCommand(
  handler: LeaseEscrowHandler,
  input: LeaseEscrowCommandInput,
): Promise<LeaseEscrowCommandOutcome> {
  try {
    const result = await handler(input);
    if (result.ok) return { state: "success", receipt: result.data };
    return {
      state: result.error.code === "lease_result_unconfirmed" ? "unknown" : "failure",
      error: result.error,
    };
  } catch (cause) {
    return { state: "failure", error: toAppError(cause, input.requestId) };
  }
}

/** 轮询到的收据是否已经落在终态；未落定时继续等。 */
function settleOf(input: LeaseEscrowCommandInput, receipt: LeaseEscrowCommandReceipt): boolean {
  if (input.action === "escrow")
    return receipt.escrow !== null && receipt.escrow.chatId === input.chatId;
  return receipt.escrow === null || receipt.escrow.state !== "escrowed";
}

export const requestLeaseEscrowCommand = async (
  input: LeaseEscrowCommandInput,
  chatId: string,
  invalidate: () => Promise<unknown>,
  now: () => number = Date.now,
): Promise<AppResult<LeaseEscrowCommandReceipt>> => {
  if (!chatId)
    return fail({
      code: "validation_failed",
      message: "无法确定执行挂靠请求的 Chat",
      requestId: input.requestId,
    });
  const sent = await sendMessageFn({
    data: { chatId, body: leaseEscrowInstruction(input) },
  });
  if (!sent.ok) return sent;
  const probe = async (): Promise<AppResult<LeaseEscrowCommandReceipt>> => {
    try {
      if (input.action === "escrow") {
        const result = await getLeaseFn({
          data: { projectId: input.projectId, machineId: input.machineId },
        });
        if (!result.ok) return result;
        return {
          ok: true,
          data: { lease: result.data.lease, escrow: result.data.lease.escrow },
          requestId: input.requestId,
        };
      }
      const result = await getLeaseEscrowFn({
        data: {
          projectId: input.projectId,
          machineId: input.machineId,
          escrowId: input.escrowId,
        },
      });
      if (!result.ok) return result;
      return {
        ok: true,
        data: { lease: result.data.lease, escrow: result.data.escrow },
        requestId: input.requestId,
      };
    } catch (cause) {
      return fail(toAppError(cause, input.requestId));
    }
  };
  const isTemporary = (error: AppError) =>
    error.code === "internal" || error.code === "too_many_requests";
  const deadline = now() + 180_000;
  let delay = 500;
  while (now() < deadline) {
    const result = await probe();
    if (!result.ok && !isTemporary(result.error)) return result;
    if (result.ok && settleOf(input, result.data)) {
      await invalidate();
      return result;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
    delay = Math.min(delay * 2, 2000);
  }
  // Agent 可能在最后一次轮询与截止之间完成。先核对当前租约与挂靠行，再报未确认。
  const final = await probe();
  if (!final.ok && !isTemporary(final.error)) return final;
  await invalidate();
  if (final.ok && settleOf(input, final.data)) return final;
  const reference = input.action === "escrow" ? input.chatId : input.escrowId;
  return fail({
    code: "lease_result_unconfirmed",
    message:
      "请求已发送，结果未确认。请打开目标 Chat 核对服务端挂靠收据，" +
      `参照 ${reference}；动作 requestId：${input.requestId}。重新操作前请刷新租约。`,
    requestId: input.requestId,
  });
};
