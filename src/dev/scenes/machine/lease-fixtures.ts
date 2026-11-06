import type { LeaseView } from "../../../contracts/lease";
import type { LeaseMutationInput, LeaseMutationView } from "../../../contracts/lease";
import type { LeaseEscrowCommandInput, LeaseEscrowView } from "../../../contracts/lease";
import type {
  ExecutionCancellationView,
  ExecutionLogReadView,
  ExecutionView,
} from "../../../contracts/remote";
import type { MachineDetail } from "../../../contracts/machine";
import { demoMachineDetails, demoProject, secondProject } from "./fixtures";
import { ID_PREFIXES, newId } from "@/contracts/ids";

/**
 * 租约与远端操作的演示数据。冻结样例，不做时间推进；正式模块不导入本目录。
 * 代次与状态必须满足 `leaseViewSchema` / `executionViewSchema` 的交叉约束。
 */
export const demoInstanceIds = {
  /** 当前 Chat 的分身：同时持有两台 Machine。 */
  primary: "ins_aaaaaaaa",
  /** 同一 Project 的另一个分身。 */
  sibling: "ins_bbbbbbbb",
  /** 本 Project 之外的持有者：只用于验证租约按 Project 隔离。 */
  foreign: "ins_cccccccc",
} as const;

export const demoHolderNames: Record<string, string> = {
  [demoInstanceIds.primary]: "重构搭档",
  [demoInstanceIds.sibling]: "验收分身",
  [demoInstanceIds.foreign]: "其他 Project 的分身",
};

export const demoLeases: LeaseView[] = [
  {
    projectId: demoProject.id,
    machineId: demoMachineDetails[0].machine.id,
    generation: 4,
    state: "held",
    holderInstanceId: demoInstanceIds.primary,
    changedAt: "2026-10-18T07:02:00.000Z",
    pendingMutationId: null,
    escrow: null,
  },
  {
    projectId: demoProject.id,
    machineId: demoMachineDetails[2].machine.id,
    generation: 2,
    state: "held",
    holderInstanceId: demoInstanceIds.primary,
    changedAt: "2026-10-18T07:05:00.000Z",
    pendingMutationId: null,
    escrow: null,
  },
  {
    projectId: demoProject.id,
    machineId: demoMachineDetails[3].machine.id,
    generation: 7,
    state: "fencing",
    holderInstanceId: demoInstanceIds.sibling,
    changedAt: "2026-10-18T07:10:00.000Z",
    pendingMutationId: "lmu_12345678",
    escrow: null,
  },
  {
    projectId: secondProject.id,
    machineId: demoMachineDetails[0].machine.id,
    generation: 1,
    state: "held",
    holderInstanceId: demoInstanceIds.foreign,
    changedAt: "2026-10-18T07:08:00.000Z",
    pendingMutationId: null,
    escrow: null,
  },
];

/** 空闲租约：用于展示同一 Project 内第三种状态，不冒充「已释放记录」。 */
export const demoFreeLease: LeaseView = {
  projectId: demoProject.id,
  machineId: demoMachineDetails[1].machine.id,
  generation: 0,
  state: "free",
  holderInstanceId: null,
  changedAt: "2026-10-18T06:59:00.000Z",
  pendingMutationId: null,
  escrow: null,
};

/**
 * 挂靠演示：目标是本 Project 的 Group 或 Public Channel（DM 不被支持），
 * 可选指定 Group 内的一个 Agent profile。这些 Chat 与 Agent 只服务演示。
 */
export const demoEscrowTargets = {
  group: { chatId: "cnv_55555555", title: "发布协作组", kind: "group" as const },
  channel: { chatId: "cnv_66666666", title: "Public Channel", kind: "public_channel" as const },
  dm: { chatId: "cnv_77777777", title: "Human 私聊", kind: "dm" as const },
};

export const demoEscrowProfiles = {
  reviewer: "agp_aaaaaaaa",
  writer: "agp_bbbbbbbb",
} as const;

export const demoEscrowAgentNames: Record<string, string> = {
  [demoEscrowProfiles.reviewer]: "验收 Agent",
  [demoEscrowProfiles.writer]: "文档 Agent",
};

/** 每个演示 Chat 里的分身：领取范围按这里的 agentProfileId 判定。 */
export const demoEscrowInstances: Record<string, { instanceId: string; agentProfileId: string }[]> = {
  [demoEscrowTargets.group.chatId]: [
    { instanceId: demoInstanceIds.primary, agentProfileId: demoEscrowProfiles.reviewer },
    { instanceId: demoInstanceIds.sibling, agentProfileId: demoEscrowProfiles.writer },
  ],
  [demoEscrowTargets.channel.chatId]: [
    { instanceId: demoInstanceIds.sibling, agentProfileId: demoEscrowProfiles.writer },
  ],
  [demoEscrowTargets.dm.chatId]: [],
};

const demoEscrowBase = {
  state: "escrowed" as const,
  claimedByInstanceId: null,
  claimedAt: null,
  claimedGeneration: null,
};

export const demoGroupEscrow: LeaseEscrowView = {
  ...demoEscrowBase,
  projectId: demoProject.id,
  machineId: demoMachineDetails[4].machine.id,
  escrowId: "les_11111111",
  chatId: demoEscrowTargets.group.chatId,
  targetAgentProfileId: null,
  escrowedByInstanceId: demoInstanceIds.primary,
  escrowedAt: "2026-10-18T09:00:00.000Z",
  escrowGeneration: 5,
};

export const demoChannelEscrow: LeaseEscrowView = {
  ...demoEscrowBase,
  projectId: demoProject.id,
  machineId: demoMachineDetails[0].machine.id,
  escrowId: "les_22222222",
  chatId: demoEscrowTargets.channel.chatId,
  targetAgentProfileId: demoEscrowProfiles.writer,
  escrowedByInstanceId: demoInstanceIds.primary,
  escrowedAt: "2026-10-18T09:05:00.000Z",
  escrowGeneration: 4,
};

/**
 * 挂靠中的租约：Machine 仍被原持有者占用，操作权已经交给目标 Group。
 * 终端状态（已领取 / 已撤销 / 已被取代）不出现在 `LeaseView` 里，只在挂靠行的读取结果里。
 */
export const demoEscrowLeases: LeaseView[] = [
  {
    projectId: demoProject.id,
    machineId: demoMachineDetails[4].machine.id,
    generation: 5,
    state: "held",
    holderInstanceId: demoInstanceIds.primary,
    changedAt: "2026-10-18T09:00:00.000Z",
    pendingMutationId: null,
    escrow: demoGroupEscrow,
  },
  {
    projectId: demoProject.id,
    machineId: demoMachineDetails[0].machine.id,
    generation: 4,
    state: "held",
    holderInstanceId: demoInstanceIds.primary,
    changedAt: "2026-10-18T09:05:00.000Z",
    pendingMutationId: null,
    escrow: demoChannelEscrow,
  },
];

/** 已有挂靠行时的演示读取结果：终端状态只在这里出现。 */
export const demoEscrowResult: Record<string, LeaseEscrowView> = {
  [demoGroupEscrow.escrowId]: demoGroupEscrow,
  [demoChannelEscrow.escrowId]: demoChannelEscrow,
  les_33333333: {
    ...demoEscrowBase,
    projectId: demoProject.id,
    machineId: demoMachineDetails[2].machine.id,
    escrowId: "les_33333333",
    state: "claimed",
    chatId: demoEscrowTargets.group.chatId,
    targetAgentProfileId: null,
    escrowedByInstanceId: demoInstanceIds.primary,
    escrowedAt: "2026-10-18T08:00:00.000Z",
    escrowGeneration: 7,
    claimedByInstanceId: demoInstanceIds.sibling,
    claimedAt: "2026-10-18T08:06:00.000Z",
    claimedGeneration: 8,
  },
};

/**
 * 演示用的挂靠命令：只覆盖演示需要的分支，代次推进与服务端一致
 * （挂靠 / 领取 / 撤销各推进一代）。终端状态的挂靠不再留在 `LeaseView` 上。
 */
export function applyEscrowCommand(
  leases: readonly LeaseView[],
  input: LeaseEscrowCommandInput,
  actor: { instanceId: string; now?: string },
): { leases: LeaseView[]; receipt: LeaseEscrowView } | { error: string } {
  const now = actor.now ?? "2026-10-18T09:30:00.000Z";
  const index = leases.findIndex(
    (lease) => lease.projectId === input.projectId && lease.machineId === input.machineId,
  );
  const lease = leases[index];
  if (!lease) return { error: "not_found" };
  const escrow = lease.escrow;
  if (input.action === "escrow") {
    if (lease.state !== "held" || lease.holderInstanceId !== actor.instanceId)
      return { error: "lease_not_holder" };
    if (escrow) return { error: "lease_conflict" };
    const generation = lease.generation + 1;
    const receipt: LeaseEscrowView = {
      ...demoEscrowBase,
      projectId: lease.projectId,
      machineId: lease.machineId,
      escrowId: newId(ID_PREFIXES.leaseEscrow),
      chatId: input.chatId,
      targetAgentProfileId: input.targetAgentProfileId ?? null,
      escrowedByInstanceId: actor.instanceId,
      escrowedAt: now,
      escrowGeneration: generation,
    };
    const next = [...leases];
    next[index] = { ...lease, generation, changedAt: now, escrow: receipt };
    return { leases: next, receipt };
  }
  if (!escrow || escrow.escrowId !== input.escrowId) return { error: "not_found" };
  if (input.action === "claim") {
    const generation = lease.generation + 1;
    const receipt: LeaseEscrowView = {
      ...escrow,
      state: "claimed",
      claimedByInstanceId: actor.instanceId,
      claimedAt: now,
      claimedGeneration: generation,
    };
    const next = [...leases];
    next[index] = { ...lease, generation, holderInstanceId: actor.instanceId, changedAt: now, escrow: null };
    return { leases: next, receipt };
  }
  const generation = lease.generation + 1;
  const receipt: LeaseEscrowView = { ...escrow, state: "cancelled" };
  const next = [...leases];
  next[index] = { ...lease, generation, changedAt: now, escrow: null };
  return { leases: next, receipt };
}

/**
 * 演示里的时间点与位点都是冻结值，不做时间推进。
 * 日志默认没有登记产出位点：`none` 不等于「没有输出」，需要日志的样例单独覆盖位点。
 */
const executionBase = {
  projectId: demoProject.id,
  machineId: demoMachineDetails[0].machine.id,
  authorizationGeneration: 4,
  holderInstanceId: demoInstanceIds.primary,
  authority: "history" as const,
  currentAuthorizationGeneration: null,
  runId: "run_12345678",
  chatId: "cnv_44444444",
  runtimeDeadlineAt: null,
  maxRuntimeMs: null,
  dispatchConnectionGeneration: 7,
  dispatchSeq: 12,
  dispatchedAt: "2026-10-18T07:14:01.000Z",
  drainedAt: "2026-10-18T07:14:42.000Z",
  payloadHash: "a".repeat(64),
  logState: "none" as const,
  recoveryReason: null,
  producedThroughSequence: null,
  acknowledgedThroughSequence: null,
  availableFromSequence: null,
  cancellation: null,
};

export const demoExecutions: ExecutionView[] = [
  {
    ...executionBase,
    executionId: "exe_11111111",
    requestId: "req_11111111",
    operation: {
      kind: "shell",
      command: "pnpm test tests/lease.test.ts",
      cwd: "/Users/linche/workspace/prj-demo",
      waitMs: 1000,
    },
    state: "succeeded",
    createdAt: "2026-10-18T07:14:00.000Z",
    dispatchDeadlineAt: "2026-10-18T07:16:00.000Z",
    terminalAt: "2026-10-18T07:14:41.000Z",
    failureReason: null,
    result: {
      kind: "shell",
      pid: 4812,
      exited: true,
      exitCode: 0,
      stdout: "ok 12 tests\n",
      stderr: "",
      truncated: false,
    },
  },
  {
    ...executionBase,
    executionId: "exe_22222222",
    requestId: "req_22222222",
    machineId: demoMachineDetails[2].machine.id,
    authorizationGeneration: 2,
    operation: {
      kind: "file_read",
      path: "/Users/linche/workspace/prj-demo/package.json",
      maxBytes: 65536,
    },
    state: "failed",
    createdAt: "2026-10-18T07:18:00.000Z",
    dispatchDeadlineAt: "2026-10-18T07:20:00.000Z",
    terminalAt: "2026-10-18T07:18:03.000Z",
    failureReason: "directory_unavailable",
    result: { kind: "file_read", failureReason: "directory_unavailable" },
  },
  {
    ...executionBase,
    executionId: "exe_33333333",
    requestId: "req_33333333",
    operation: { kind: "process_list", limit: 100 },
    state: "timed_out",
    createdAt: "2026-10-18T07:22:00.000Z",
    dispatchDeadlineAt: "2026-10-18T07:23:00.000Z",
    terminalAt: "2026-10-18T07:23:00.000Z",
    failureReason: "deadline",
    result: { kind: "process_list", failureReason: "deadline" },
  },
  {
    ...executionBase,
    executionId: "exe_44444444",
    requestId: "req_44444444",
    operation: { kind: "shell", command: "say finish", waitMs: 1000 },
    state: "unknown",
    createdAt: "2026-10-18T07:26:00.000Z",
    dispatchDeadlineAt: "2026-10-18T07:28:00.000Z",
    terminalAt: "2026-10-18T07:28:00.000Z",
    failureReason: "worker_lost",
    result: { kind: "shell", failureReason: "worker_lost" },
  },
];

export const demoRemoteMachines: MachineDetail[] = demoMachineDetails;

export const demoRunFacts = [{ runId: "run_12345678", status: "completed" }];

/** 旧授权代次请求的反证样例：服务端拒绝，界面保留目标与原因。 */
export const demoLeaseConflictReason = {
  code: "lease_stale_generation" as const,
  message: "租约代次已变化，请先读取当前租约后重试。",
};

/**
 * 演示：把已完成的动作收据写回租约列表。演示里唯一的持有者是 primary 分身，
 * 申请即写入它；释放只清空持有者，不产生任何进程或文件副作用。
 */
export function applyLeaseMutation(
  leases: readonly LeaseView[],
  mutation: LeaseMutationView,
  holderInstanceId: string,
): LeaseView[] {
  const index = leases.findIndex(
    (lease) => lease.projectId === mutation.projectId && lease.machineId === mutation.machineId,
  );
  const base: LeaseView =
    index >= 0
      ? leases[index]!
      : {
          projectId: mutation.projectId,
          machineId: mutation.machineId,
          generation: 0,
          state: "free",
          holderInstanceId: null,
          changedAt: mutation.createdAt,
          pendingMutationId: null,
          escrow: null,
        };
  const next: LeaseView =
    mutation.action === "acquire"
      ? {
          ...base,
          generation: base.generation + 1,
          state: "held",
          holderInstanceId,
          changedAt: mutation.completedAt ?? mutation.createdAt,
          pendingMutationId: null,
          escrow: null,
        }
      : {
          ...base,
          generation: base.generation + 1,
          state: "free",
          holderInstanceId: null,
          changedAt: mutation.completedAt ?? mutation.createdAt,
          pendingMutationId: null,
          escrow: null,
        };
  const copy = [...leases];
  if (index >= 0) copy[index] = next;
  else copy.push(next);
  return copy;
}

/** 演示：由动作输入构造一条已完成收据（代次 +1，与契约一致）。 */
export function completedReceipt(
  input: LeaseMutationInput,
  createdAt = "2026-10-18T07:30:00.000Z",
  completedAt = "2026-10-18T07:31:00.000Z",
): LeaseMutationView {
  return {
    projectId: input.projectId,
    machineId: input.machineId,
    mutationId: newId(ID_PREFIXES.leaseMutation),
    action: input.action,
    state: "completed",
    expectedGeneration: input.expectedGeneration,
    completedGeneration: input.expectedGeneration + 1,
    targetInstanceId: input.action === "handoff" ? input.targetInstanceId : null,
    createdAt,
    completedAt,
  };
}

/** 演示用日志校验和：形状必须是 64 位小写十六进制，内容不是真实哈希。 */
function demoChecksum(seed: string): string {
  const digits = "0123456789abcdef";
  let value = "";
  for (let index = 0; index < 64; index += 1)
    value += digits[(seed.charCodeAt(index % seed.length) + index) % 16];
  return value;
}

/**
 * 长命令样例的执行：日志位点齐全，但只送达了一部分。
 * `partial` 与 `succeeded` 正交：执行已经成功，日志仍然不完整。
 */
export const demoLongExecution: ExecutionView = {
  ...executionBase,
  executionId: "exe_55555555",
  requestId: "req_55555555",
  authorizationGeneration: 4,
  operation: { kind: "shell", command: "pnpm build", waitMs: 1000 },
  state: "succeeded",
  createdAt: "2026-10-18T07:32:00.000Z",
  dispatchDeadlineAt: "2026-10-18T07:34:00.000Z",
  runtimeDeadlineAt: "2026-10-18T07:42:00.000Z",
  maxRuntimeMs: 600000,
  dispatchedAt: "2026-10-18T07:32:05.000Z",
  drainedAt: null,
  terminalAt: "2026-10-18T07:36:20.000Z",
  failureReason: null,
  result: {
    kind: "shell",
    pid: 5101,
    exited: true,
    exitCode: 0,
    stdout: "build done\n",
    stderr: "",
    truncated: false,
  },
  logState: "partial",
  producedThroughSequence: 24,
  acknowledgedThroughSequence: 18,
  availableFromSequence: 1,
};

/** 保留裁剪样例：早期行已按保留限制删除，可读起点因此抬到 #31。 */
export const demoTruncatedExecution: ExecutionView = {
  ...demoLongExecution,
  executionId: "exe_66666666",
  requestId: "req_66666666",
  state: "running",
  createdAt: "2026-10-18T07:40:00.000Z",
  dispatchDeadlineAt: "2026-10-18T07:42:00.000Z",
  runtimeDeadlineAt: "2026-10-18T07:50:00.000Z",
  dispatchedAt: "2026-10-18T07:40:05.000Z",
  terminalAt: null,
  result: null,
  logState: "truncated",
  producedThroughSequence: 120,
  acknowledgedThroughSequence: 96,
  availableFromSequence: 31,
};

/** 缺少中间行并且连 Worker 也失联的执行：`gap` 与断线同时成立。 */
export const demoGapExecution: ExecutionView = {
  ...demoLongExecution,
  executionId: "exe_77777777",
  requestId: "req_77777777",
  machineId: demoMachineDetails[2].machine.id,
  authorizationGeneration: 2,
  operation: { kind: "shell", command: "tail -f app.log", waitMs: 1000 },
  state: "unknown",
  createdAt: "2026-10-18T07:44:00.000Z",
  dispatchDeadlineAt: "2026-10-18T07:46:00.000Z",
  runtimeDeadlineAt: "2026-10-18T07:54:00.000Z",
  dispatchedAt: "2026-10-18T07:44:03.000Z",
  drainedAt: null,
  terminalAt: "2026-10-18T07:52:00.000Z",
  failureReason: "worker_lost",
  recoveryReason: "child-exited-without-result",
  result: { kind: "shell", failureReason: "worker_lost" },
  logState: "gap",
  producedThroughSequence: 55,
  acknowledgedThroughSequence: 52,
  availableFromSequence: 1,
};

/** 长时间占用机器：仍在运行、租约仍归它，早已超过运行观察窗口。 */
export const demoLongRunningExecution: ExecutionView = {
  ...executionBase,
  executionId: "exe_88888888",
  requestId: "req_88888888",
  state: "running",
  operation: { kind: "process_list", limit: 100 },
  createdAt: "2026-10-18T07:39:00.000Z",
  dispatchDeadlineAt: "2026-10-18T07:41:00.000Z",
  dispatchedAt: "2026-10-18T07:39:05.000Z",
  drainedAt: null,
  terminalAt: null,
  failureReason: null,
  result: null,
};

/**
 * 租约已不归它、却仍在运行的执行：这台 Machine 的租约已经进入 fencing，
 * 持有者是另一个分身。服务端会按恢复事实收尾，页面不该再给取消入口。
 */
export const demoReleasedLeaseExecution: ExecutionView = {
  ...executionBase,
  executionId: "exe_99999999",
  requestId: "req_99999999",
  machineId: demoMachineDetails[3].machine.id,
  authorizationGeneration: 7,
  state: "running",
  operation: { kind: "process_list", limit: 100 },
  createdAt: "2026-10-18T07:09:00.000Z",
  dispatchDeadlineAt: "2026-10-18T07:11:00.000Z",
  dispatchedAt: "2026-10-18T07:09:10.000Z",
  drainedAt: null,
  terminalAt: null,
  failureReason: null,
  result: null,
};

export const demoExecutionRecords: ExecutionView[] = [
  ...demoExecutions,
  demoLongExecution,
  demoTruncatedExecution,
  demoGapExecution,
  demoLongRunningExecution,
  demoReleasedLeaseExecution,
];

/*
 * 日志正文在演示里是中性样例文本：真实远端输出可能含密钥，
 * 所以演示与截图里都不放任何像真实命令输出的内容（standing order #14）。
 * 行号、流与字节位点仍然齐全，续读与缺口因此可核对。
 */
function demoLogLine(sequence: number): string {
  return `demo line ${sequence}\n`;
}

function frame(
  sequence: number,
  stream: "stdout" | "stderr",
  byteStart: number,
): ExecutionLogReadView["frames"][number] {
  const text = demoLogLine(sequence);
  return {
    sequence,
    stream,
    byteStart,
    byteEnd: byteStart + text.length,
    text,
    checksum: demoChecksum(`frame${sequence}`),
  };
}

/**
 * 一页日志：只送达了一部分（`partial`）。执行本身已经成功，日志仍然不完整，
 * 两个事实正交；位点停在已知值，不冒充最新。
 */
export const demoLogPage: ExecutionLogReadView = {
  projectId: demoProject.id,
  machineId: demoLongExecution.machineId,
  executionId: demoLongExecution.executionId,
  frames: [
    frame(16, "stdout", 0),
    frame(17, "stdout", 13),
    frame(18, "stderr", 26),
    frame(20, "stdout", 39),
    frame(21, "stdout", 52),
    frame(22, "stdout", 65),
  ],
  nextCursor: { executionId: demoLongExecution.executionId, nextSequence: 23 },
  availableFromSequence: 1,
  acknowledgedThroughSequence: 18,
  producedThroughSequence: 24,
  gapRanges: [],
  logState: "partial",
  hasMore: true,
  workerOnline: true,
};

/** 续读页：同一执行的下一批行，接上次的下一游标继续。 */
export const demoLogPageResumed: ExecutionLogReadView = {
  ...demoLogPage,
  frames: [frame(23, "stdout", 78), frame(24, "stdout", 91)],
  nextCursor: { executionId: demoLongExecution.executionId, nextSequence: 25 },
  acknowledgedThroughSequence: 24,
  producedThroughSequence: 24,
  gapRanges: [],
  logState: "partial",
  hasMore: false,
  workerOnline: true,
};

/** 裁剪态读取：可读起点已经抬到 #31，早期行按保留限制删除。 */
export const demoTruncatedLogPage: ExecutionLogReadView = {
  ...demoLogPage,
  executionId: demoTruncatedExecution.executionId,
  machineId: demoTruncatedExecution.machineId,
  frames: [frame(31, "stdout", 0), frame(32, "stdout", 13)],
  nextCursor: { executionId: demoTruncatedExecution.executionId, nextSequence: 33 },
  availableFromSequence: 31,
  acknowledgedThroughSequence: 96,
  producedThroughSequence: 120,
  gapRanges: [],
  logState: "truncated",
  hasMore: true,
  workerOnline: true,
};

/** 缺口与断线并存：中间行缺失，Worker 已离线，位点停在最后的已知值。 */
export const demoGapLogPage: ExecutionLogReadView = {
  ...demoLogPage,
  executionId: demoGapExecution.executionId,
  machineId: demoGapExecution.machineId,
  frames: [frame(50, "stdout", 0), frame(51, "stdout", 13)],
  nextCursor: { executionId: demoGapExecution.executionId, nextSequence: 53 },
  availableFromSequence: 1,
  acknowledgedThroughSequence: 52,
  producedThroughSequence: 55,
  gapRanges: [{ fromSequence: 52, toSequence: 55 }],
  logState: "gap",
  hasMore: true,
  workerOnline: false,
};

export const demoLogPages: Record<string, ExecutionLogReadView> = {
  [demoLongExecution.executionId]: demoLogPage,
  [demoTruncatedExecution.executionId]: demoTruncatedLogPage,
  [demoGapExecution.executionId]: demoGapLogPage,
};

/** 取消六态样例：与执行状态独立，`delivered` 不是已停止。 */
export const demoCancellations: Record<string, ExecutionCancellationView> = {
  [demoLongExecution.executionId]: {
    projectId: demoProject.id,
    machineId: demoLongExecution.machineId,
    cancelId: "cnl_11111111",
    executionId: demoLongExecution.executionId,
    state: "delivered",
    requestedAt: "2026-10-18T07:35:00.000Z",
    deliveredAt: "2026-10-18T07:35:01.000Z",
    exitedAt: null,
    signalOutcome: "term_delivered",
    failureReason: null,
  },
  [demoTruncatedExecution.executionId]: {
    projectId: demoProject.id,
    machineId: demoTruncatedExecution.machineId,
    cancelId: "cnl_22222222",
    executionId: demoTruncatedExecution.executionId,
    state: "requested",
    requestedAt: "2026-10-18T07:41:30.000Z",
    deliveredAt: null,
    exitedAt: null,
    signalOutcome: "none",
    failureReason: null,
  },
  [demoGapExecution.executionId]: {
    projectId: demoProject.id,
    machineId: demoGapExecution.machineId,
    cancelId: "cnl_33333333",
    executionId: demoGapExecution.executionId,
    state: "unknown",
    requestedAt: "2026-10-18T07:50:00.000Z",
    deliveredAt: null,
    exitedAt: null,
    signalOutcome: "none",
    failureReason: "delivery_unconfirmed",
  },
};

/** 其余四态用于演示下拉：只影响演示里刚发出的那条取消。 */
export const demoCancellationStates: Record<
  ExecutionCancellationView["state"],
  ExecutionCancellationView
> = {
  requested: demoTruncatedExecutionCancellation(),
  delivered: demoCancellations[demoLongExecution.executionId]!,
  exited_observed: withoutExited(
    demoCancellations[demoLongExecution.executionId]!,
    "exited_observed",
  ),
  already_exited: withoutExited(
    demoCancellations[demoLongExecution.executionId]!,
    "already_exited",
  ),
  failed: {
    ...demoCancellations[demoLongExecution.executionId]!,
    state: "failed",
    deliveredAt: null,
    signalOutcome: "none",
    failureReason: "signal_failed",
  },
  unknown: demoCancellations[demoGapExecution.executionId]!,
};

function demoTruncatedExecutionCancellation(): ExecutionCancellationView {
  return demoCancellations[demoTruncatedExecution.executionId]!;
}

function withoutExited(
  base: ExecutionCancellationView,
  state: "exited_observed" | "already_exited",
): ExecutionCancellationView {
  return {
    ...base,
    cancelId: `cnl_${state === "exited_observed" ? "44444444" : "55555555"}`,
    state,
    exitedAt: state === "exited_observed" ? "2026-10-18T07:35:09.000Z" : null,
    signalOutcome: "term_delivered",
  };
}
