import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";
import type { AppId } from "./ids";
import type { AppResult } from "./result";

export type MachineId = AppId<typeof ID_PREFIXES.machine>;
export const machineIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.machine));
const projectIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.project));
export const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const macosAbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .startsWith("/")
  .refine((path) => !path.includes("\0"), "路径不能包含 NUL");
const timestampSchema = z.iso.datetime();
const nameSchema = z.string().trim().min(1).max(80);

export const machineSchema = z.strictObject({
  id: machineIdSchema,
  name: nameSchema,
  rootDirectory: macosAbsolutePathSchema.nullable(),
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
  path: macosAbsolutePathSchema,
  kind: z.enum(["zsh", "bash", "sh", "unknown"]),
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
export const capabilitySnapshotSchema = z.strictObject({
  platform: z.literal("darwin"),
  arch: z.enum(["arm64", "x64"]),
  workerVersion: z.string().min(1).max(80),
  shells: z.array(shellFactSchema).max(16),
  remoteOperations: z.literal("not_implemented"),
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
  z.strictObject({ kind: z.literal("accessible"), realPath: macosAbsolutePathSchema }),
  z.strictObject({
    kind: z.literal("unavailable"),
    reason: z.enum(["missing", "not_directory", "denied", "io_error"]),
  }),
]);
export const directoryObservationSchema = z.strictObject({
  machineId: machineIdSchema,
  generation: positiveSafeIntegerSchema,
  projectId: projectIdSchema,
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
  directory: macosAbsolutePathSchema.nullable(),
  expectedRevision: positiveSafeIntegerSchema.nullable(),
});
export const machineRootDirectorySchema = z.strictObject({
  machineId: machineIdSchema,
  directory: macosAbsolutePathSchema.nullable(),
  revision: positiveSafeIntegerSchema,
});
export type MachineRootDirectory = z.infer<typeof machineRootDirectorySchema>;

// Project IDs are already prj_<uuid> values and cannot contain '/'.
export function projectWorkingPath(root: string, projectId: string): string {
  return `${root}/${projectId}`;
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
