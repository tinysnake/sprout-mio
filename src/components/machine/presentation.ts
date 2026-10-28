import type { LeaseView } from "../../contracts/lease";
import type { AppResult } from "../../contracts/result";
import type {
  ExecutionCancellationView,
  ExecutionLogReadView,
  ExecutionView,
} from "../../contracts/remote";
import { EXECUTION_STATE_LABELS } from "./lease-view";
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

export type LogCompleteness = {
  label: string;
  detail: string;
  tone: StatusTone;
  /** 已知前缀仍然成立，但不代表当前状态：Worker 离线或连接断开。 */
  stale: boolean;
};

/**
 * 日志完整性的呈现事实。完整性有两层：已知前缀完整（`logState`）与「现在是否新鲜」（Worker 在线 + 连接）。
 * Worker 离线时不得把已知前缀说成整体完整，必须明说「日志停在此处」。
 */
export function logCompleteness({
  logState,
  workerOnline,
  connection,
}: {
  logState: ExecutionLogReadView["logState"];
  /** `null` 表示这一页读视图没有给出 Worker 在线事实（如尚未读取）。 */
  workerOnline: boolean | null;
  connection: LogConnection;
}): LogCompleteness {
  const base = LOG_STATE_LABELS[logState];
  const stale = workerOnline === false || !connection.online;
  if (workerOnline !== false) return { ...base, stale };
  if (logState === "full")
    return {
      label: "日志停在此处",
      detail: "日志停在此处：Worker 离线，已显示的是已知前缀，不是 Worker 当前完整输出。",
      tone: "warning",
      stale,
    };
  return {
    ...base,
    detail: `${base.detail} Worker 当前离线，未收到的部分仍未知。`,
    stale,
  };
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

/**
 * 执行摘要与「需要处理」判定。
 *
 * 这里只投影 `executionViewSchema` 已经校验过的事实与页面已有的租约事实：
 * 不推断命令是否还在跑，也不把「超过确认窗口」写成「已停止」。
 */

/** 租约事实里判定执行归属只需要这三项；没有租约事实时不猜。 */
export type LeaseFacts = Pick<LeaseView, "state" | "holderInstanceId" | "generation">;

/** 取消与收尾各自的确认窗口。超过窗口仍无推进，就不再假设它会自己回来。 */
export const EXECUTION_CONFIRM_WINDOW_MS = 2 * 60 * 1000;

/** 摘要条与图例的固定顺序：同一台 Machine 的块在每次渲染里顺序一致。 */
export const EXECUTION_STATE_ORDER = [
  "queued",
  "dispatched",
  "running",
  "draining",
  "succeeded",
  "failed",
  "rejected",
  "timed_out",
  "unknown",
] as const satisfies readonly ExecutionView["state"][];

/**
 * 状态到语义色的映射。只用 `docs/frontend-design.md` 已定义的 `status-*` 令牌，
 * 不为摘要区另造颜色，颜色始终与图例文字一起出现。
 */
export const EXECUTION_STATE_FILL: Record<ExecutionView["state"], string> = {
  queued: "bg-status-queued",
  dispatched: "bg-status-warning",
  running: "bg-status-running",
  draining: "bg-status-warning",
  succeeded: "bg-status-success",
  failed: "bg-status-failed",
  rejected: "bg-status-failed",
  timed_out: "bg-status-failed",
  unknown: "bg-status-unknown",
};

export type ExecutionSummarySegment = {
  state: ExecutionView["state"];
  label: string;
  count: number;
  tone: StatusTone;
  fill: string;
};

export type ExecutionMachineSummary = {
  machineId: string;
  total: number;
  /** 只含非零状态：零值状态不出现，图例与分段条都不占位。 */
  segments: ExecutionSummarySegment[];
};

/**
 * 按 Machine 归并执行次数。机器顺序按首次出现稳定排列，状态按固定顺序排列；
 * 零值状态直接省略，条与图例都只描述真实存在的执行。
 */
export function executionSummary(views: readonly ExecutionView[]): ExecutionMachineSummary[] {
  const counts = new Map<string, Map<ExecutionView["state"], number>>();
  for (const view of views) {
    const bucket = counts.get(view.machineId) ?? new Map<ExecutionView["state"], number>();
    bucket.set(view.state, (bucket.get(view.state) ?? 0) + 1);
    counts.set(view.machineId, bucket);
  }
  return [...counts].map(([machineId, bucket]) => {
    const segments = EXECUTION_STATE_ORDER.filter((state) => (bucket.get(state) ?? 0) > 0).map(
      (state) => ({
        state,
        label: EXECUTION_STATE_LABELS[state].label,
        count: bucket.get(state) ?? 0,
        tone: EXECUTION_STATE_LABELS[state].tone,
        fill: EXECUTION_STATE_FILL[state],
      }),
    );
    return {
      machineId,
      total: segments.reduce((sum, segment) => sum + segment.count, 0),
      segments,
    };
  });
}

export type ExecutionAttention = {
  kind: "decision" | "pending";
  reason:
    | "dispatch_window_expired"
    | "lease_released"
    | "generation_mismatch"
    | "cancellation_unconfirmed"
    | "drain_unconfirmed";
  detail: string;
  /** 只有「需要你决定」才给取消入口；「等待自动收尾」最多给重试取消。 */
  needsCancel: boolean;
};

export const EXECUTION_ATTENTION_LABELS: Record<ExecutionAttention["reason"], string> = {
  dispatch_window_expired: "下发已过窗口",
  lease_released: "租约已释放",
  generation_mismatch: "授权代次已变化",
  cancellation_unconfirmed: "取消未确认",
  drain_unconfirmed: "收尾未确认",
};

/**
 * 一条执行是否需要人处理。终态永远返回 `null`：已确定的终态不会自己变化。
 *
 * 「需要你决定」只在 `running` 上判定，因为只有已经开始的执行才可能在租约
 * 失效后继续运行；没有租约事实时不做归属判断。`queued` / `dispatched` 过了
 * 下发窗口、`draining` 过了确认窗口、取消停在 `requested` 超过窗口，都属于
 * 「等待自动收尾」：不给取消按钮，只写清事实与后果。
 */
export function executionAttention(
  view: ExecutionView,
  lease: LeaseFacts | null,
  now: Date,
): ExecutionAttention | null {
  if (view.terminalAt !== null) return null;
  const at = now.getTime();

  if (view.state === "running" && lease) {
    if (lease.state !== "held" || lease.holderInstanceId !== view.holderInstanceId)
      return {
        kind: "decision",
        reason: "lease_released",
        needsCancel: true,
        detail:
          "租约已不再由发起这次执行的分身持有。执行不会自己走到终态，命令可能仍在机器上运行。",
      };
    if (lease.generation !== view.authorizationGeneration)
      return {
        kind: "decision",
        reason: "generation_mismatch",
        needsCancel: true,
        detail: `租约代次已推进到 ${lease.generation}，这次执行记录的授权代次是 ${view.authorizationGeneration}。Worker 不会再收尾这次执行，命令可能仍在机器上运行。`,
      };
  }

  if (
    (view.state === "queued" || view.state === "dispatched") &&
    at > Date.parse(view.dispatchDeadlineAt)
  )
    return {
      kind: "pending",
      reason: "dispatch_window_expired",
      needsCancel: false,
      detail: "已过下发窗口仍未投递完成。服务端会按超时收尾；命令不会开始，也不会自动重试。",
    };

  if (
    view.cancellation?.state === "requested" &&
    at - Date.parse(view.cancellation.requestedAt) > EXECUTION_CONFIRM_WINDOW_MS
  )
    return {
      kind: "pending",
      reason: "cancellation_unconfirmed",
      needsCancel: false,
      detail:
        "取消停在「已请求」超过确认窗口，没有送达记录。服务端不会自动把它推进到送达，命令可能仍在运行。",
    };

  if (view.state === "draining") {
    const since = Date.parse(view.dispatchedAt ?? view.createdAt);
    if (at - since > EXECUTION_CONFIRM_WINDOW_MS)
      return {
        kind: "pending",
        reason: "drain_unconfirmed",
        needsCancel: false,
        detail:
          "收尾超过确认窗口仍没有终态。授权已经撤回，但命令可能仍在机器上运行，结果不会自己回来。",
      };
  }

  return null;
}
