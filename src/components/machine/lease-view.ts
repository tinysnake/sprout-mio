import type { LeaseMutationView, LeaseView } from "../../contracts/lease";
import type {
  ExecutionCancellationView,
  ExecutionRecoveryReason,
  ExecutionView,
  RemoteOperation,
} from "../../contracts/remote";
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
      "正在等待该 Machine 的 Worker 确认旧授权已关闸；期间不接受新的远端操作。若 Worker 已失联，该状态可能持续；重连本身不代表已确认，不强制收回时也无法保证等待会结束。Human 可明确确认后强制收回并推进代次，但这不代表已排空；旧副作用可能仍在落地，未知结果记为未知不记成功。已启动的进程仍可能继续产生副作用。",
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

/** 执行 id 是稳定定位：短值上界面，完整值放工具提示；刷新或重连后指向同一条执行。 */
export function shortExecutionId(executionId: string): string {
  const hex = executionId.replace(/^exe_/, "").split("-")[0] ?? "";
  return `exe_${hex.slice(0, 8)}`;
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
  if (mutation.forcedReclaim) {
    return {
      label: "Human 已强制收回",
      detail: `代次 ${mutation.completedGeneration}；原动作已由强制收回覆盖，未确认 Worker 排空。`,
      tone: "warning",
    };
  }
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
  running: { label: "运行中", detail: "Worker 已报告开始执行。", tone: "warning", terminal: false },
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

/**
 * unknown 的两种来源不能混成一句：一个是子进程退出了但没留下结果，一个是从未兑现 spawn。
 * 原因字符串由 Worker 归约磁盘事实得出，页面只负责把它说清楚。
 */
export const RECOVERY_REASON_LABELS: Record<ExecutionRecoveryReason, string> = {
  "child-exited-without-result": "子进程已退出，但没有留下结果文件",
  "no-fence-record": "没有找到这次执行的 fence 记录，命令可能从未启动",
};

export function recoveryReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return RECOVERY_REASON_LABELS[reason as ExecutionRecoveryReason] ?? reason;
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

/**
 * 下发窗口与运行上限是两个不同的截止时间：前者限定 Worker 何时之前取走命令，
 * 后者限定取走后能跑多久。这里分成两条事实返回，界面与测试都不允许合成一个 deadline。
 */
export type DeadlineFact = {
  key: "dispatch" | "runtime";
  label: string;
  at: string | null;
  note: string;
};

export function deadlineFacts(execution: ExecutionView): DeadlineFact[] {
  const facts: DeadlineFact[] = [
    {
      key: "dispatch",
      label: "下发窗口",
      at: execution.dispatchDeadlineAt,
      note: "Worker 必须在这个时刻之前取走命令；过期后不会再下发。",
    },
  ];
  if (execution.runtimeDeadlineAt === null) {
    facts.push({
      key: "runtime",
      label: "运行上限",
      at: null,
      note: "本次执行没有登记运行上限，只有下发窗口到期才会写成超时。",
    });
  } else {
    facts.push({
      key: "runtime",
      label: "运行上限",
      at: execution.runtimeDeadlineAt,
      note: `Worker 取走后最多运行 ${formatRuntime(execution.maxRuntimeMs)}；到期由 Worker 侧终止。`,
    });
  }
  return facts;
}

export function formatRuntime(maxRuntimeMs: number | null): string {
  if (maxRuntimeMs === null) return "未登记时长";
  const seconds = Math.round(maxRuntimeMs / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds % 60} 秒`;
}

/**
 * 超时的两种来源靠 `runtimeDeadlineAt` 区分：没有运行上限的执行只可能因下发窗口到期超时。
 * 界面如实点名来源，不把两种超时说成同一个 deadline。
 */
export function timeoutSourceLabel(execution: ExecutionView): string | null {
  if (execution.state !== "timed_out") return null;
  return execution.runtimeDeadlineAt === null
    ? "因下发窗口到期写为超时：没有登记运行上限。"
    : "因运行上限到期写为超时：Worker 侧按登记的运行上限终止。";
}

/**
 * `unknown` 与 `timed_out` 都是「不知道命令最后做了什么」。界面只说这一件事，
 * 并明确不在本页重发原命令：重跑必须是 Human 重新发起的显式动作。
 */
export function uncertainResultNote(execution: ExecutionView): string | null {
  if (execution.state === "unknown")
    return "结果未知：没有确认到终态。已有的副作用无法从本页判断，也不会在这里重发原命令。";
  if (execution.state === "timed_out")
    return "超时：Worker 没给出结果，命令是否已停止无法从本页确认。也不会在这里重发原命令。";
  return null;
}

/** 取消六态各自一句话；`delivered` 不是「已停止」，六态都不冒充执行终态。 */
export const CANCELLATION_STATE_LABELS: Record<
  ExecutionCancellationView["state"],
  { label: string; detail: string; tone: StatusTone; stopped: boolean }
> = {
  requested: {
    label: "取消已请求",
    detail: "请求已登记，尚未送达 Worker；命令可能仍在运行。",
    tone: "warning",
    stopped: false,
  },
  delivered: {
    label: "取消已送达",
    detail: "Worker 收到了信号请求。送达不等于已停止，进程可能仍在运行。",
    tone: "warning",
    stopped: false,
  },
  exited_observed: {
    label: "已观察到退出",
    detail: "Worker 报告进程已退出。退出是否由本次取消引起，以执行终态为准。",
    tone: "muted",
    stopped: true,
  },
  already_exited: {
    label: "此前已结束",
    detail: "取消到达前进程已经结束，本次取消没有改变状态。",
    tone: "muted",
    stopped: true,
  },
  failed: {
    label: "取消失败",
    detail: "取消没有成功送达或投递失败；命令可能仍在运行。",
    tone: "danger",
    stopped: false,
  },
  unknown: {
    label: "取消结果未知",
    detail: "没有确认到取消的结果；不能当作已停止。",
    tone: "warning",
    stopped: false,
  },
};

/**
 * 是否算「已停止」只看 durable 退出证据。`exited_observed` 由 runner 落盘的结果触发；
 * 只是「进程不见了但没有结果」是 `failed/exit_not_observed`，不是已停止，也不显示退出码。
 */
export function cancellationDisplay(cancellation: ExecutionCancellationView): {
  label: string;
  detail: string;
  tone: StatusTone;
  stopped: boolean;
} {
  const base = CANCELLATION_STATE_LABELS[cancellation.state];
  if (cancellation.state !== "failed" || cancellation.failureReason !== "exit_not_observed")
    return base;
  return {
    label: "取消失败：退出未被记录",
    detail:
      "Worker 报告进程已不再运行，但 runner 没有落盘退出结果。不能当作已观测到退出，也不能推断退出码。",
    tone: "warning",
    stopped: false,
  };
}

/** 只有 Worker 真的观察到退出才算停止；其余状态一律不写「已停止」。 */
export function cancellationSignalFacts(cancellation: ExecutionCancellationView): string[] {
  const outcome =
    cancellation.signalOutcome === "term_delivered"
      ? "SIGTERM 调用已投递"
      : cancellation.signalOutcome === "kill_delivered"
        ? "SIGKILL 调用已投递"
        : "尚未投递信号";
  const facts = [outcome];
  facts.push(cancellation.deliveredAt ? `送达时间 ${cancellation.deliveredAt}` : "没有送达记录");
  facts.push(
    cancellation.exitedAt ? `观察到退出 ${cancellation.exitedAt}` : "没有观察到退出的记录",
  );
  if (cancellation.failureReason === "signal_failed") facts.push("信号调用失败");
  if (cancellation.failureReason === "delivery_unconfirmed") facts.push("送达未确认");
  if (cancellation.failureReason === "exit_not_observed")
    facts.push("进程已不再运行，但退出没有被记录");
  return facts;
}

export const HOST_TOOL_NOTE =
  "宿主工具（如 sprout_status、本机文件读写）运行在 Pi 宿主进程所在机器上，与远端操作分开记录。";

export const REMOTE_TARGET_NOTE =
  "每条远端操作都显式指定 Machine；不存在默认目标，也不会猜测目标。结果状态来自 Worker 报告，未确认时显示未知。";
