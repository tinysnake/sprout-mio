import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";
import {
  capabilitySnapshotSchema,
  directoryObservationSchema,
  machineIdSchema,
  macosAbsolutePathSchema,
  positiveSafeIntegerSchema,
} from "./machine";

export const WORKER_PROTOCOL_VERSION = 1;
export const WORKER_POLL_INTERVAL_MS = 5000;
export const WORKER_STALE_AFTER_MS = 15000;
export const WORKER_ENROLLMENT_TTL_MS = 600000;
export const workerSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const workerSessionSchema = z.strictObject({
  machineId: machineIdSchema,
  generation: positiveSafeIntegerSchema,
  bootId: z.string().regex(appIdPattern(ID_PREFIXES.boot)),
  attemptId: z.uuidv4(),
});
export type WorkerSession = z.infer<typeof workerSessionSchema>;
const envelope = {
  version: z.literal(WORKER_PROTOCOL_VERSION),
  requestId: z.string().regex(appIdPattern(ID_PREFIXES.request)),
};
const identity = { machineId: machineIdSchema, secret: workerSecretSchema };
export const workerEnrollInput = z.strictObject({
  ...envelope,
  ...identity,
  ticket: workerSecretSchema,
});
export const workerOpenInput = z.strictObject({ ...envelope, ...identity, attemptId: z.uuidv4() });
export const workerExchangeInput = z
  .strictObject({
    ...envelope,
    secret: workerSecretSchema,
    session: workerSessionSchema,
    seq: positiveSafeIntegerSchema,
    capability: capabilitySnapshotSchema,
    observations: z.array(directoryObservationSchema).max(1000),
  })
  .superRefine((value, ctx) => {
    const keys = new Set<string>();
    value.observations.forEach((fact, index) => {
      if (
        fact.machineId !== value.session.machineId ||
        fact.generation !== value.session.generation ||
        fact.seq !== value.seq
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["observations", index],
          message: "观察必须属于当前会话和 seq",
        });
      }
      if (keys.has(fact.projectId))
        ctx.addIssue({
          code: "custom",
          path: ["observations", index],
          message: "Project 观察不能重复",
        });
      keys.add(fact.projectId);
    });
  });
export const workerCloseInput = z.strictObject({
  ...envelope,
  secret: workerSecretSchema,
  session: workerSessionSchema,
});
export const WORKER_ERROR_CODES = [
  "validation_failed",
  "unauthorized",
  "not_found",
  "conflict",
  "superseded",
  "stale",
  "unsupported_version",
  "stopping",
  "internal",
] as const;
const failureSchema = z.strictObject({
  ...envelope,
  ok: z.literal(false),
  error: z.strictObject({ code: z.enum(WORKER_ERROR_CODES), message: z.string().max(200) }),
});
export const workerEnrollResponseSchema = z.union([
  z.strictObject({
    ...envelope,
    ok: z.literal(true),
    data: z.strictObject({ machineId: machineIdSchema }),
  }),
  failureSchema,
]);
export const workerOpenResponseSchema = z.union([
  z.strictObject({
    ...envelope,
    ok: z.literal(true),
    data: z.strictObject({
      session: workerSessionSchema,
      pollIntervalMs: positiveSafeIntegerSchema,
      staleAfterMs: positiveSafeIntegerSchema,
    }),
  }),
  failureSchema,
]);
export const workerExchangeResponseSchema = z.union([
  z.strictObject({
    ...envelope,
    ok: z.literal(true),
    data: z.strictObject({
      session: workerSessionSchema,
      seq: positiveSafeIntegerSchema,
      root: macosAbsolutePathSchema.nullable(),
      rootRevision: positiveSafeIntegerSchema,
      bindings: z.array(
        z.strictObject({
          projectId: z.string().regex(appIdPattern(ID_PREFIXES.project)),
          description: z.string().max(500),
        }),
      ),
    }),
  }),
  failureSchema,
]);
export const workerCloseResponseSchema = z.union([
  z.strictObject({
    ...envelope,
    ok: z.literal(true),
    data: z.strictObject({ closed: z.literal(true) }),
  }),
  failureSchema,
]);
export type WorkerEnrollInput = z.infer<typeof workerEnrollInput>;
export type WorkerOpenInput = z.infer<typeof workerOpenInput>;
export type WorkerExchangeInput = z.infer<typeof workerExchangeInput>;
export type WorkerCloseInput = z.infer<typeof workerCloseInput>;
export type WorkerEnrollResponse = z.infer<typeof workerEnrollResponseSchema>;
export type WorkerOpenResponse = z.infer<typeof workerOpenResponseSchema>;
export type WorkerExchangeResponse = z.infer<typeof workerExchangeResponseSchema>;
export type WorkerCloseResponse = z.infer<typeof workerCloseResponseSchema>;
