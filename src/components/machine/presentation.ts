import type { AppResult } from "../../contracts/result";
import type { ExecutionCancellationView, ExecutionLogReadView } from "../../contracts/remote";
import type { StatusTone } from "./machine-view";

/**
 * 远端执行的呈现输入与请求入口。
 *
 * `src/contracts/remote.ts` 只拥有服务端与 Worker 之间的事实形状（包括读日志返回
 * `executionLogReadViewSchema`）。这里补的是「界面需要、但传输层不需要随传输一起携带」
 * 的两个事实：读取时的分页上限与连接状态。放在组件侧的呈现契约里，不再往传输契约里
 * 塞展示字段。
 */

/** 读取请求只带游标与分页上限；服务端权威事实（可读起点、位点、gap）不在请求里。 */
export interface ExecutionLogReadRequest {
  executionId: string;
  cursor: { executionId: string; nextSequence: number } | null;
  limitBytes: number;
}

/** 一次日志读取的结果就是契约里的读视图，界面不另造形状。 */
export type ExecutionLogReadResult = AppResult<ExecutionLogReadView>;

/** 日志读取入口。正式页面接服务端函数，演示场景接固定回调。 */
export type ExecutionLogReader = (
  request: ExecutionLogReadRequest,
) => Promise<ExecutionLogReadResult>;

/** 显式取消入口。取消是否成功由返回值决定，界面不做乐观转换。 */
export type ExecutionCanceller = (
  executionId: string,
) => Promise<AppResult<ExecutionCancellationView>>;

/** 日志读取时的连接事实：读请求可能在没有连接时发出。 */
export type LogConnection = { online: boolean; detail: string | null };

/**
 * 断线时当前信息到底完整到什么程度：已知的事实仍然显示，但不能当作最新，
 * 也不能把位点当成已经推进。未断线时不需要多说一句。
 */
export function connectionCompletenessNote(connection: LogConnection): string | null {
  if (connection.online) return null;
  return `连接已断开：下面是最近一次已知事实，不能当作当前状态，位点也不会因断线前进。${
    connection.detail ? ` ${connection.detail}` : ""
  }`;
}

/**
 * 日志是否是「不完整」的。`none` 表示服务端没有登记任何产出位点，仍然不是
 * 「没有输出」——两者文案不同，任何情况下都不印成功或空。
 */
export function isIncompleteLogState(state: ExecutionLogReadView["logState"]): boolean {
  return state === "partial" || state === "gap" || state === "truncated";
}

export const LOG_STATE_LABELS: Record<
  ExecutionLogReadView["logState"],
  { label: string; detail: string; tone: StatusTone }
> = {
  none: {
    label: "尚无日志",
    detail: "服务端还没有登记该执行的日志产出位点。这不等于「没有输出」。",
    tone: "muted",
  },
  partial: {
    label: "日志不完整",
    detail: "Worker 已产出的日志尚未全部送达；已显示的部分不是完整输出。",
    tone: "warning",
  },
  full: {
    label: "日志完整",
    detail: "Worker 已确认送达全部产出的日志行。",
    tone: "success",
  },
  gap: {
    label: "日志存在缺口",
    detail: "区段之间缺失若干日志行。缺口处标「缺失」，不能当作跳过或空行。",
    tone: "warning",
  },
  truncated: {
    label: "日志已裁剪",
    detail: "早期日志已按保留限制删除，只能从新的可读起点开始读取。",
    tone: "warning",
  },
};
