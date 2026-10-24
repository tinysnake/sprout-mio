import { z } from "zod";
import { remoteExchangeInputSchema, remoteExchangeOutputSchema } from "./remote";
import { workerSecretSchema, workerSessionSchema } from "./worker-session";
import type { WorkerSession } from "./worker-session";
import { appIdPattern, ID_PREFIXES } from "./ids";
import {
  capabilitySnapshotSchema,
  directoryObservationSchema,
  machineIdSchema,
  macosAbsolutePathSchema,
  positiveSafeIntegerSchema,
} from "./machine";

export const WORKER_PROTOCOL_VERSION = 2;
export const WORKER_POLL_INTERVAL_MS = 5000;
export const WORKER_STALE_AFTER_MS = 15000;
export const WORKER_ENROLLMENT_TTL_MS = 600000;
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
const exchangeBase = {
  ...envelope,
  secret: workerSecretSchema,
  session: workerSessionSchema,
  seq: positiveSafeIntegerSchema,
  remote: remoteExchangeInputSchema,
};
export const workerExchangeInput = z
  .discriminatedUnion("mode", [
    z.strictObject({
      ...exchangeBase,
      mode: z.literal("normal"),
      capability: capabilitySnapshotSchema,
      observations: z.array(directoryObservationSchema).max(1000),
    }),
    z.strictObject({ ...exchangeBase, mode: z.literal("drain") }),
  ])
  .superRefine((value, ctx) => {
    if (value.mode === "normal") {
      const projects = new Set<string>();
      value.observations.forEach((fact, index) => {
        if (
          fact.machineId !== value.session.machineId ||
          fact.generation !== value.session.generation ||
          fact.seq !== value.seq ||
          projects.has(fact.projectId)
        )
          ctx.addIssue({
            code: "custom",
            path: ["observations", index],
            message: "观察必须属于当前会话/seq 且 Project 不重复",
          });
        projects.add(fact.projectId);
      });
    }
    for (const report of [...value.remote.results, ...value.remote.fenceAcks]) {
      const session: WorkerSession = report.dispatchSession;
      if (
        report.machineId !== value.session.machineId ||
        session.machineId !== value.session.machineId ||
        session.generation !== value.session.generation ||
        session.bootId !== value.session.bootId ||
        session.attemptId !== value.session.attemptId
      )
        ctx.addIssue({ code: "custom", path: ["remote"], message: "报告必须属于本 exchange 会话" });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1048576)
      ctx.addIssue({ code: "custom", message: "exchange 批次超过 1 MiB" });
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
  "remote_conflict",
  "remote_limit",
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
    data: z
      .strictObject({
        mode: z.enum(["normal", "drain"]),
        session: workerSessionSchema,
        seq: positiveSafeIntegerSchema,
        configuration: z
          .strictObject({
            root: macosAbsolutePathSchema.nullable(),
            rootRevision: positiveSafeIntegerSchema,
            bindings: z
              .array(
                z.strictObject({
                  projectId: z.string().regex(appIdPattern(ID_PREFIXES.project)),
                  description: z.string().max(500),
                }),
              )
              .max(1000),
          })
          .nullable(),
        remote: remoteExchangeOutputSchema,
      })
      .superRefine((value, ctx) => {
        if (
          (value.mode === "normal") !== (value.configuration !== null) ||
          (value.mode === "drain" &&
            (value.remote.authorizations.length > 0 || value.remote.commands.length > 0))
        )
          ctx.addIssue({ code: "custom", message: "drain 不能获取配置、授权或命令" });
        for (const item of [
          ...value.remote.authorizations,
          ...value.remote.commands,
          ...value.remote.fences,
        ]) {
          if (item.machineId !== value.session.machineId)
            ctx.addIssue({
              code: "custom",
              path: ["remote"],
              message: "远端事实必须属于当前 Machine",
            });
        }
        for (const command of value.remote.commands) {
          if (
            command.dispatchSession.generation !== value.session.generation ||
            command.dispatchSession.bootId !== value.session.bootId ||
            command.dispatchSession.attemptId !== value.session.attemptId ||
            command.dispatchSeq !== value.seq
          )
            ctx.addIssue({
              code: "custom",
              path: ["remote", "commands"],
              message: "命令必须属于当前投递会话/seq",
            });
        }
        if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1048576)
          ctx.addIssue({ code: "custom", message: "exchange data 超过 1 MiB" });
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
