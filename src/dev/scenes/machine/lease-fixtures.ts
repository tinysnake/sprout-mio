import type { LeaseView } from "../../../contracts/lease";
import type { LeaseMutationInput, LeaseMutationView } from "../../../contracts/lease";
import type { ExecutionView } from "../../../contracts/remote";
import type { MachineDetail } from "../../../contracts/machine";
import { demoMachineDetails, demoProject, secondProject } from "./fixtures";

/**
 * 租约与远端操作的演示数据。冻结样例，不做时间推进；正式模块不导入本目录。
 * 代次与状态必须满足 `leaseViewSchema` / `executionViewSchema` 的交叉约束。
 */
export const demoInstanceIds = {
  /** 当前 Chat 的分身：同时持有两台 Machine。 */
  primary: "ins_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  /** 同一 Project 的另一个分身。 */
  sibling: "ins_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  /** 本 Project 之外的持有者：只用于验证租约按 Project 隔离。 */
  foreign: "ins_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
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
  },
  {
    projectId: demoProject.id,
    machineId: demoMachineDetails[2].machine.id,
    generation: 2,
    state: "held",
    holderInstanceId: demoInstanceIds.primary,
    changedAt: "2026-10-18T07:05:00.000Z",
    pendingMutationId: null,
  },
  {
    projectId: demoProject.id,
    machineId: demoMachineDetails[3].machine.id,
    generation: 7,
    state: "fencing",
    holderInstanceId: demoInstanceIds.sibling,
    changedAt: "2026-10-18T07:10:00.000Z",
    pendingMutationId: "lmu_12345678-1234-4234-8234-1234567890ab",
  },
  {
    projectId: secondProject.id,
    machineId: demoMachineDetails[0].machine.id,
    generation: 1,
    state: "held",
    holderInstanceId: demoInstanceIds.foreign,
    changedAt: "2026-10-18T07:08:00.000Z",
    pendingMutationId: null,
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
};

const executionBase = {
  projectId: demoProject.id,
  machineId: demoMachineDetails[0].machine.id,
  authorizationGeneration: 4,
  holderInstanceId: demoInstanceIds.primary,
  runId: "run_12345678-1234-4234-8234-1234567890ab",
  chatId: "cnv_44444444-4444-4444-8444-444444444444",
  runtimeDeadlineAt: null,
  maxRuntimeMs: null,
  dispatchConnectionGeneration: 7,
  dispatchSeq: 12,
  dispatchedAt: "2026-10-18T07:14:01.000Z",
  drainedAt: "2026-10-18T07:14:42.000Z",
  payloadHash: "a".repeat(64),
  logState: "none" as const,
  producedThroughSequence: null,
  acknowledgedThroughSequence: null,
  availableFromSequence: null,
};

export const demoExecutions: ExecutionView[] = [
  {
    ...executionBase,
    executionId: "exe_11111111-1111-4111-8111-111111111111",
    requestId: "req_11111111-1111-4111-8111-111111111111",
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
    executionId: "exe_22222222-2222-4222-8222-222222222222",
    requestId: "req_22222222-2222-4222-8222-222222222222",
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
    executionId: "exe_33333333-3333-4333-8333-333333333333",
    requestId: "req_33333333-3333-4333-8333-333333333333",
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
    executionId: "exe_44444444-4444-4444-8444-444444444444",
    requestId: "req_44444444-4444-4444-8444-444444444444",
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

export const demoRunFacts = [
  { runId: "run_12345678-1234-4234-8234-1234567890ab", status: "completed" },
];

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
        }
      : {
          ...base,
          generation: base.generation + 1,
          state: "free",
          holderInstanceId: null,
          changedAt: mutation.completedAt ?? mutation.createdAt,
          pendingMutationId: null,
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
    mutationId: `lmu_${crypto.randomUUID()}`,
    action: input.action,
    state: "completed",
    expectedGeneration: input.expectedGeneration,
    completedGeneration: input.expectedGeneration + 1,
    targetInstanceId: input.action === "handoff" ? input.targetInstanceId : null,
    createdAt,
    completedAt,
  };
}
