import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";
import type { AppId } from "./ids";
import type { AppResult } from "./result";

export type MachineId = AppId<typeof ID_PREFIXES.machine>;
export const machineIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.machine));
const projectIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.project));
export const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/**
 * Worker 侧绝对路径：POSIX（`/` 开头）、盘符（`C:\` / `C:/`）与 UNC（`\\server\share`）。
 * 契约不猜哪台机器会用哪种形式；具体路径是否可用由该 Machine 的目录探测与文件操作给出。
 */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}
export const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsolutePath, "必须是绝对路径")
  .refine((path) => !path.includes("\0"), "路径不能包含 NUL");
/** 历史名称：P8d 起契约接受 Windows 路径，等价于 `absolutePathSchema`。 */
export const macosAbsolutePathSchema = absolutePathSchema;
const timestampSchema = z.iso.datetime();
const nameSchema = z.string().trim().min(1).max(80);

export const machineSchema = z.strictObject({
  id: machineIdSchema,
  name: nameSchema,
  rootDirectory: absolutePathSchema.nullable(),
  rootRevision: positiveSafeIntegerSchema,
  createdBy: z.string().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Machine = z.infer<typeof machineSchema>;

export const MACHINE_OFFLINE_REASONS = [
  "never_connected",
  "closed",
  "stale",
  "host_restarted",
  "superseded",
] as const;
export const machineConnectionViewSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("online"),
    generation: positiveSafeIntegerSchema,
    lastSeenAt: timestampSchema,
  }),
  z.strictObject({
    kind: z.literal("connecting"),
    generation: positiveSafeIntegerSchema,
    lastSeenAt: timestampSchema,
  }),
  z.strictObject({
    kind: z.literal("offline"),
    generation: positiveSafeIntegerSchema.nullable(),
    lastSeenAt: timestampSchema.nullable(),
    reason: z.enum(MACHINE_OFFLINE_REASONS),
  }),
]);
export type MachineConnectionView = z.infer<typeof machineConnectionViewSchema>;

export const shellFactSchema = z.strictObject({
  path: absolutePathSchema,
  kind: z.enum(["zsh", "bash", "sh", "pwsh", "powershell", "cmd", "unknown"]),
  version: z.string().max(4096).nullable(),
  checkedAt: timestampSchema,
  probe: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("success") }),
    z.strictObject({
      kind: z.literal("failure"),
      reason: z.enum(["missing", "denied", "timeout", "unsupported", "failed", "output_limit"]),
    }),
  ]),
});
export type ShellFact = z.infer<typeof shellFactSchema>;
export const REMOTE_OPERATION_KINDS = [
  "shell",
  "file_read",
  "file_write",
  "process_list",
  "process_signal",
] as const;
/** 实际执行环境：Session 0 服务会话与交互桌面不是同一个环境，不能混成一句「Windows」。 */
export const EXECUTION_SESSION_KINDS = [
  "interactive_desktop",
  "service_session_0",
  "not_applicable",
  "unknown",
] as const;
export type ExecutionSessionKind = (typeof EXECUTION_SESSION_KINDS)[number];
export const executionEnvironmentSchema = z.strictObject({
  // 能读到就是真实 SessionId；读不到时诚实给 null，不猜 0。
  sessionId: nonnegativeSafeIntegerSchema.nullable(),
  sessionKind: z.enum(EXECUTION_SESSION_KINDS),
});
export type ExecutionEnvironment = z.infer<typeof executionEnvironmentSchema>;
export const capabilitySnapshotSchema = z.strictObject({
  mcpRelay: z
    .strictObject({
      version: z.literal(1),
      transports: z
        .array(z.enum(["stdio", "streamableHttp"]))
        .min(1)
        .max(2)
        .refine((values) => new Set(values).size === values.length),
      maxMessageBytes: z.literal(131072),
    })
    .nullable()
    .optional(),
  platform: z.enum(["darwin", "win32"]),
  arch: z.enum(["arm64", "x64"]),
  workerVersion: z.string().min(1).max(80),
  // 旧 Worker 不报执行环境；缺省表示未知，不是「等于桌面」。
  executionEnvironment: executionEnvironmentSchema.optional(),
  shells: z.array(shellFactSchema).max(16),
  remoteOperations: z
    .array(z.enum(REMOTE_OPERATION_KINDS))
    .max(5)
    .refine((kinds) => new Set(kinds).size === kinds.length, "远端操作能力不能重复"),
});
export type CapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>;

export const projectMachineIntentSchema = z.strictObject({
  projectId: projectIdSchema,
  machineId: machineIdSchema,
  description: z.string().max(500),

  revision: positiveSafeIntegerSchema,
});
export type ProjectMachineIntent = z.infer<typeof projectMachineIntentSchema>;
export const directoryObservationResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("accessible"), realPath: absolutePathSchema }),
  z.strictObject({
    kind: z.literal("unavailable"),
    reason: z.enum(["missing", "not_directory", "denied", "io_error"]),
  }),
]);
export const directoryObservationSchema = z.strictObject({
  machineId: machineIdSchema,
  generation: positiveSafeIntegerSchema,
  projectId: projectIdSchema,
  bindingRevision: positiveSafeIntegerSchema,
  revision: positiveSafeIntegerSchema,
  seq: positiveSafeIntegerSchema,
  checkedAt: timestampSchema,
  result: directoryObservationResultSchema,
});
export type DirectoryObservation = z.infer<typeof directoryObservationSchema>;
export const machineDetailSchema = z.strictObject({
  machine: machineSchema,
  enrollmentStatus: z.enum(["pending", "active"]),
  connection: machineConnectionViewSchema,
  capability: z
    .strictObject({
      generation: positiveSafeIntegerSchema,
      current: z.boolean(),
      snapshot: capabilitySnapshotSchema,
    })
    .nullable(),
  bindings: z.array(
    z.strictObject({
      intent: projectMachineIntentSchema,
      observation: z
        .strictObject({ current: z.boolean(), fact: directoryObservationSchema })
        .nullable(),
    }),
  ),
});
export type MachineDetail = z.infer<typeof machineDetailSchema>;
export type MachineResult<T> = AppResult<T> & { fieldErrors?: Record<string, string> };

export const createMachineInput = z.strictObject({ name: nameSchema });
export const machineIdInput = z.strictObject({ machineId: machineIdSchema });
export const getMachineInput = machineIdInput.extend({ projectId: projectIdSchema.optional() });
export const renewMachineEnrollmentInput = machineIdInput;
export const listMachinesInput = z.strictObject({});
export const listProjectMachinesInput = z.strictObject({ projectId: projectIdSchema });
export const saveProjectMachineBindingInput = z.strictObject({
  machineId: machineIdSchema,
  projectId: projectIdSchema,
  description: z.string().max(500),
  expectedRevision: positiveSafeIntegerSchema.nullable(),
});
export const saveMachineRootDirectoryInput = z.strictObject({
  machineId: machineIdSchema,
  directory: absolutePathSchema.nullable(),
  expectedRevision: positiveSafeIntegerSchema.nullable(),
});
export const machineRootDirectorySchema = z.strictObject({
  machineId: machineIdSchema,
  directory: absolutePathSchema.nullable(),
  revision: positiveSafeIntegerSchema,
});
export type MachineRootDirectory = z.infer<typeof machineRootDirectorySchema>;

// Project IDs are already prj_<uuid> values and cannot contain a separator.
export function projectWorkingPath(root: string, projectId: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.endsWith("/") || root.endsWith("\\")
    ? `${root}${projectId}`
    : `${root}${separator}${projectId}`;
}
export const machineEnrollmentSchema = z.strictObject({
  detail: machineDetailSchema,
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: timestampSchema,
});
export type MachineEnrollment = z.infer<typeof machineEnrollmentSchema>;
export type CreateMachineInput = z.infer<typeof createMachineInput>;
export type GetMachineInput = z.infer<typeof getMachineInput>;
export type RenewMachineEnrollmentInput = z.infer<typeof renewMachineEnrollmentInput>;
export type ListMachinesInput = z.infer<typeof listMachinesInput>;
export type ListProjectMachinesInput = z.infer<typeof listProjectMachinesInput>;
export type SaveMachineRootDirectoryInput = z.infer<typeof saveMachineRootDirectoryInput>;
export type SaveProjectMachineBindingInput = z.infer<typeof saveProjectMachineBindingInput>;

export interface MachineOperations {
  createMachine(input: CreateMachineInput): Promise<MachineResult<MachineEnrollment>>;
  renewMachineEnrollment(
    input: RenewMachineEnrollmentInput,
  ): Promise<MachineResult<MachineEnrollment>>;
  listMachines(input: ListMachinesInput): Promise<MachineResult<MachineDetail[]>>;
  getMachine(input: GetMachineInput): Promise<MachineResult<MachineDetail>>;
  listProjectMachines(input: ListProjectMachinesInput): Promise<MachineResult<MachineDetail[]>>;
  saveMachineRootDirectory(
    input: SaveMachineRootDirectoryInput,
  ): Promise<MachineResult<MachineRootDirectory>>;
  saveProjectMachineBinding(
    input: SaveProjectMachineBindingInput,
  ): Promise<MachineResult<ProjectMachineIntent>>;
}
