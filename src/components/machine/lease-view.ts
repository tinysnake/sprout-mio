import type { LeaseMutationView, LeaseView } from "../../contracts/lease";
import type { ExecutionView, RemoteOperation } from "../../contracts/remote";
import type { StatusTone } from "./machine-view";

/**
 * 租约与远端操作的呈现映射。这里的函数只做投影：输入是
 * `leaseViewSchema` / `executionViewSchema` 已经校验过的事实，不推断空闲、
 * 释放或成功。租约状态与 run 状态是两个独立事实，不能相互推导。
 */

export type LeaseLabel = { label: string; detail: string; tone: StatusTone };

export const LEASE_STATE_LABELS: Record<LeaseView["state"], LeaseLabel> = {
  free: {
    label: "空闲",
    detail: "没有分身持有该 Machine。空闲不等于已释放记录，也不代表 Machine 可用。",
    tone: "muted",
  },
  held: {
    label: "持有中",
    detail: "持有者可以对该 Machine 发起远端操作；租约不会随 run 结束自动释放。",
    tone: "success",
  },
  fencing: {
    label: "等待 Worker 确认",
    detail:
      "正在等待该 Machine 的 Worker 确认旧授权已关闸；期间不接受新的远端操作。无法保证等待会结束：重连本身不代表已确认，若 Worker 已失联，需要 Human 介入才能继续。已启动的进程仍可能继续产生副作用。",
    tone: "warning",
  },
};

/**
 * 卡片正文只留一句可决策的简介；完整事实（时长、收据、未知执行）由问号按钮的
 * Dialog 呈现。文案不承诺等待会结束，也不写死「没有其他推进方式」。
 */
export const FENCING_SUMMARY = "等待 Worker 确认旧授权已关闸，期间不接受新的远端操作。";

/** run 不印裸 id：只保留可在工具提示里定位的短值。 */
export function shortRunId(runId: string): string {
  const hex = runId.replace(/^run_/, "").split("-")[0] ?? "";
  return `run_${hex.slice(0, 8)}`;
}

export const LEASE_MUTATION_LABELS: Record<LeaseMutationView["action"], string> = {
  acquire: "申请",
  release: "释放",
  handoff: "交接",
  reclaim: "收回",
};

export type LeaseHolder = {
  instanceId: string;
  leases: LeaseView[];
};

export function leaseStateLabel(state: LeaseView["state"]): LeaseLabel {
  return LEASE_STATE_LABELS[state];
}

/** 只投影本 Project 的租约：不同 Project 在同一物理 Machine 上的租约互不可见。 */
export function visibleLeases(leases: readonly LeaseView[], projectId: string): LeaseView[] {
  return leases.filter((lease) => lease.projectId === projectId);
}

export function leasesForMachine(
  leases: readonly LeaseView[],
  machineId: string,
  projectId?: string,
): LeaseView[] {
  return leases.filter(
    (lease) =>
      lease.machineId === machineId && (projectId === undefined || lease.projectId === projectId),
  );
}

/**
 * 一个分身持有多台 Machine：按 holderInstanceId 归并，持有者顺序按首次出现稳定排列。
 * 空闲没有 holder；fencing 保留原 holder，不能投影为无持有者。
 */
export function groupLeasesByHolder(leases: readonly LeaseView[]): LeaseHolder[] {
  const holders = new Map<string, LeaseView[]>();
  for (const lease of leases) {
    if (!lease.holderInstanceId) continue;
    const bucket = holders.get(lease.holderInstanceId);
    if (bucket) bucket.push(lease);
    else holders.set(lease.holderInstanceId, [lease]);
  }
  return [...holders].map(([instanceId, items]) => ({ instanceId, leases: items }));
}

/** 持有者呈现：分身名（可用时）+ instanceId 语义，两者都不是 run 或连接代次。 */
export function holderLabel(
  lease: LeaseView,
  holderNames: Readonly<Record<string, string>> = {},
): { name: string; instanceId: string | null } {
  // 只投影已有映射：取不到名称时说「未知分身」，不退回归属的 instance id。
  if (lease.holderInstanceId)
    return {
      name: holderNames[lease.holderInstanceId] ?? "未知分身",
      instanceId: lease.holderInstanceId,
    };
  return { name: "无持有者", instanceId: null };
}

/** 同一持有者在当前投影里持有的 Machine 台数，不新增查询。 */
export function holderMachineCount(
  leases: readonly LeaseView[],
  instanceId: string | null,
): number {
  if (!instanceId) return 0;
  return leases.filter((lease) => lease.holderInstanceId === instanceId).length;
}

/** pending 动作来自租约上唯一的 pending 收据；没有 pending 时返回 null。 */
export function pendingMutationLabel(lease: LeaseView): string | null {
  if (!lease.pendingMutationId) return null;
  return `有一个租约动作处理中（${lease.pendingMutationId}），结果尚未确认。`;
}

export function mutationStateLabel(mutation: LeaseMutationView): LeaseLabel {
  const completed = mutation.state === "completed";
  return {
    label: `${LEASE_MUTATION_LABELS[mutation.action]}${completed ? "已确认" : "等待 Worker 确认"}`,
    detail: `代次 ${mutation.completedGeneration ?? mutation.expectedGeneration}`,
    tone: completed ? "success" : "warning",
  };
}

/** 按同一 Project × Machine 核对 pending 收据，不能借其他租约的动作填空。 */
export function fencingMutation(lease: LeaseView, mutation: LeaseMutationView | null) {
  return mutation?.mutationId === lease.pendingMutationId &&
    mutation.projectId === lease.projectId &&
    mutation.machineId === lease.machineId &&
    mutation.state === "pending" &&
    mutation.expectedGeneration === lease.generation
    ? mutation
    : null;
}

/** ExecutionView 不含 drainedAt；这里只列结果不确定的记录，不宣称它们阻塞 drain。 */
export function fencingExecutions(lease: LeaseView, executions: readonly ExecutionView[]) {
  return executions.filter(
    (execution) =>
      execution.projectId === lease.projectId &&
      execution.machineId === lease.machineId &&
      (execution.state === "unknown" ||
        (execution.terminalAt !== null &&
          (execution.failureReason === "worker_lost" || execution.failureReason === "deadline"))),
  );
}

export function fencingWaitLabel(changedAt: string, now: number): string {
  const elapsed = now - Date.parse(changedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "当前时间早于状态更新时间，无法计算等待时长";
  const seconds = Math.floor(elapsed / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `已等待 ${days > 0 ? `${days} 天 ` : ""}${hours} 小时 ${minutes} 分 ${seconds % 60} 秒`;
}

export function reclaimErrorNote(code: string): string | null {
  return code === "lease_fencing" ? "等待 Worker 确认后才能完成收回。" : null;
}

/**
 * run 结束不改变租约状态：这里只并列两个事实，不把 run 的终态投影成释放。
 * runStatus 为 null 表示没有可用 run 事实，仍然不推断释放。
 */
export function runLeaseRelation(
  lease: LeaseView,
  runStatus: "running" | "completed" | "failed" | "interrupted" | null,
): { held: boolean; note: string } {
  const held = lease.state === "held" || lease.state === "fencing";
  if (!held) {
    return {
      held,
      note: "当前没有持有者；这是租约自身的状态，不由 run 状态推出。",
    };
  }
  if (lease.state === "fencing") {
    return {
      held,
      note: "租约记录仍由该分身持有；旧授权正在等待 Worker 确认已关闸，run 状态不代表租约动作已完成。",
    };
  }
  if (runStatus === null) {
    return {
      held,
      note: "租约持有中。没有可用的 run 事实，仍然不推断为已释放。",
    };
  }
  if (runStatus === "running") {
    return { held, note: "租约持有中，与所在 run 并行存在。" };
  }
  return {
    held,
    note: `最近一次 run 已结束（${runStatus}），租约仍由该分身持有，直到显式释放。`,
  };
}

export const OPERATION_KIND_LABELS: Record<RemoteOperation["kind"], string> = {
  shell: "Shell 命令",
  file_read: "读取文件",
  file_write: "写入文件",
  process_list: "进程列表",
  process_signal: "发送信号",
};

/** 远端操作的显式目标：由操作自身携带，不从当前页面或默认 Machine 猜测。 */
export function operationTarget(operation: RemoteOperation): string {
  switch (operation.kind) {
    case "shell":
      return operation.cwd ? `cwd ${operation.cwd}` : "使用 Worker 工作目录";
    case "file_read":
    case "file_write":
      return operation.path;
    case "process_list":
      return `最多 ${operation.limit} 个进程`;
    case "process_signal":
      return `pid ${operation.pid} · ${operation.signal}`;
  }
}

export type ExecutionLabel = {
  label: string;
  detail: string;
  tone: StatusTone;
  terminal: boolean;
};

export const EXECUTION_STATE_LABELS: Record<ExecutionView["state"], ExecutionLabel> = {
  queued: {
    label: "排队中",
    detail: "已登记，等待 Worker 取走。",
    tone: "warning",
    terminal: false,
  },
  dispatched: {
    label: "已投递",
    detail: "Worker 已收到命令，尚未报告开始执行。",
    tone: "warning",
    terminal: false,
  },
  running: { label: "运行中", detail: "Worker 已报告开始执行。", tone: "success", terminal: false },
  draining: {
    label: "收尾中",
    detail: "授权正在撤回，Worker 正在处理已投递的命令。",
    tone: "warning",
    terminal: false,
  },
  succeeded: { label: "成功", detail: "Worker 报告执行成功。", tone: "success", terminal: true },
  failed: { label: "失败", detail: "Worker 报告执行失败。", tone: "danger", terminal: true },
  rejected: {
    label: "被拒绝",
    detail: "服务端或 Worker 在执行前拒绝了该操作。",
    tone: "danger",
    terminal: true,
  },
  timed_out: {
    label: "超时",
    detail: "超过截止时间，Worker 未给出成功结果。",
    tone: "danger",
    terminal: true,
  },
  unknown: {
    label: "结果未知",
    detail: "没有确认到终态；不能当作成功，也不提供隐式重跑。",
    tone: "muted",
    terminal: true,
  },
};

export const REMOTE_FAILURE_REASON_LABELS: Record<string, string> = {
  stale_generation: "授权代次已失效，命令未执行",
  not_holder: "请求方不是该租约的持有者",
  authorization_revoked: "授权已被撤回，在途操作被拒绝",
  deadline: "超过截止时间",
  worker_lost: "Worker 连接丢失，结果未能确认",
  executor_error: "Worker 执行器报错",
  capability_unavailable: "Worker 未宣告该操作能力",
  directory_unavailable: "目标目录不可用",
};

export function failureReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return REMOTE_FAILURE_REASON_LABELS[reason] ?? reason;
}

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;

/**
 * 结果摘要只给结构化元信息：退出码、字节数、截断标记。
 * 不呈现 stdout / stderr / 文件内容——远端输出可能含密钥，不能进入截图与报告。
 */
export function resultSummary(execution: ExecutionView): string[] {
  const { result } = execution;
  if (!result) return [];
  if ("failureReason" in result) {
    // 失败原因由 `-reason` 单独呈现；这里只补部分结果，避免同一句原因重复两过。
    if (!result.partial) return [];
    return [`已收到的部分结果：${partialSummary(result.partial)}`];
  }
  return [partialSummary(result)];
}

function partialSummary(payload: NonNullable<ExecutionView["result"]>): string {
  if ("failureReason" in payload)
    return failureReasonLabel(payload.failureReason) ?? payload.failureReason;
  switch (payload.kind) {
    case "shell":
      return payload.exited
        ? `退出码 ${payload.exitCode} · stdout ${bytes(payload.stdout)} bytes · stderr ${bytes(
            payload.stderr,
          )} bytes${payload.truncated ? " · 输出已截断" : ""}`
        : `仍在运行（pid ${payload.pid}）· stdout ${bytes(payload.stdout)} bytes`;
    case "file_read":
      return `已读取 ${bytes(payload.content)} bytes${payload.truncated ? " · 已截断" : ""}（内容不在此呈现）`;
    case "file_write":
      return `已写入 ${payload.bytesWritten} bytes`;
    case "process_list":
      return `${payload.items.length} 个进程${payload.truncated ? " · 已截断" : ""}`;
    case "process_signal":
      return `信号 ${payload.signal} 已投递给 pid ${payload.pid}`;
  }
}

/** 目标 Machine 与宿主工具必须分开表达：远端操作的执行位置是 Worker 所在 Machine。 */
export function executionTarget(execution: ExecutionView, machineName: string | undefined): string {
  return `${machineName ?? execution.machineId} · 远端 Worker`;
}

export const HOST_TOOL_NOTE =
  "宿主工具（如 sprout_status、本机文件读写）运行在 Pi 宿主进程所在机器上，与远端操作分开记录。";

export const REMOTE_TARGET_NOTE =
  "每条远端操作都显式指定 Machine；不存在默认目标，也不会猜测目标。结果状态来自 Worker 报告，未确认时显示未知。";
