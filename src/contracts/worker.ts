import { z } from "zod";
import { mcpWorkerExchangeShape, mcpServerExchangeShape } from "./mcp";
import {
  remoteExchangeInputSchema,
  remoteExchangeOutputSchema,
  type ExecutionLogFact,
} from "./remote";
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

export const WORKER_PROTOCOL_VERSION = 3;
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
/** 日志帧与取消意图已经在 `remoteExchangeInputSchema` / `remoteExchangeOutputSchema` 里，
 * worker 只在其上叠加 MCP 字段，避免同一形状出现两份。预算与优先级见 docs/p4c/contracts.md。 */
export const workerExchangeRemoteSchema = remoteExchangeInputSchema.extend(mcpWorkerExchangeShape);
export const workerExchangeOutputRemoteSchema =
  remoteExchangeOutputSchema.extend(mcpServerExchangeShape);
const exchangeBase = {
  ...envelope,
  secret: workerSecretSchema,
  session: workerSessionSchema,
  seq: positiveSafeIntegerSchema,
  remote: workerExchangeRemoteSchema,
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
    for (const item of [...value.remote.results, ...value.remote.fenceAcks]) {
      const session: WorkerSession = item.dispatchSession;
      if (
        item.machineId !== value.session.machineId ||
        session.machineId !== value.session.machineId ||
        session.generation !== value.session.generation ||
        session.bootId !== value.session.bootId ||
        session.attemptId !== value.session.attemptId
      )
        ctx.addIssue({ code: "custom", path: ["remote"], message: "报告必须属于本 exchange 会话" });
    }
    const seenFrames = new Set<string>();
    (value.remote.logFrames ?? []).forEach((frame, index) => {
      const dedupe = `${frame.executionId}:${frame.sequence}`;
      if (
        frame.machineId !== value.session.machineId ||
        frame.dispatchSession.machineId !== value.session.machineId ||
        frame.dispatchSession.generation !== value.session.generation ||
        frame.dispatchSession.bootId !== value.session.bootId ||
        frame.dispatchSession.attemptId !== value.session.attemptId ||
        seenFrames.has(dedupe)
      )
        ctx.addIssue({
          code: "custom",
          path: ["remote", "logFrames", index],
          message: "日志帧必须属于本 exchange 会话且批内唯一",
        });
      seenFrames.add(dedupe);
    });
    const seenFacts = new Map<string, ExecutionLogFact>();
    (value.remote.logFacts ?? []).forEach((fact, index) => {
      if (fact.machineId !== value.session.machineId || seenFacts.has(fact.executionId))
        ctx.addIssue({
          code: "custom",
          path: ["remote", "logFacts", index],
          message: "日志位点事实必须属于本 exchange 会话且同一执行只出现一次",
        });
      seenFacts.set(fact.executionId, fact);
    });
    (value.remote.logFrames ?? []).forEach((frame, index) => {
      const fact = seenFacts.get(frame.executionId);
      if (
        fact &&
        (fact.projectId !== frame.projectId ||
          fact.authorizationGeneration !== frame.authorizationGeneration ||
          fact.holderInstanceId !== frame.holderInstanceId ||
          fact.producedThroughSequence === null ||
          fact.producedThroughSequence < Math.max(frame.sequence, frame.gapTo ?? frame.sequence))
      )
        ctx.addIssue({
          code: "custom",
          path: ["remote", "logFrames", index],
          message: "同一执行的日志位点事实不得低于本批帧覆盖的序号",
        });
    });
    for (const recovery of value.remote.recoveries ?? []) {
      if (recovery.machineId !== value.session.machineId)
        ctx.addIssue({
          code: "custom",
          path: ["remote", "recoveries"],
          message: "恢复事实必须属于本 Machine",
        });
    }
    for (const item of [...value.remote.mcp, ...value.remote.mcpCursors]) {
      const session = "workerSession" in item ? item.workerSession : null;
      const machineId =
        "registration" in item
          ? item.registration.machineId
          : "process" in item
            ? item.process.machineId
            : "machineId" in item
              ? item.machineId
              : value.session.machineId;
      if (
        machineId !== value.session.machineId ||
        (session !== null &&
          (session.generation !== value.session.generation ||
            session.bootId !== value.session.bootId ||
            session.attemptId !== value.session.attemptId))
      )
        ctx.addIssue({
          code: "custom",
          path: ["remote", "mcp"],
          message: "MCP 事实必须属于本 exchange 会话",
        });
    }
    if (
      value.mode === "drain" &&
      value.remote.mcp.some(
        (item) =>
          item.type === "registration_fact" ||
          item.type === "registration_retire" ||
          item.type === "process_fact",
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["remote", "mcp"],
        message: "drain 不能发布登记或进程",
      });
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
                  revision: positiveSafeIntegerSchema,
                }),
              )
              .max(1000),
          })
          .nullable(),
        remote: workerExchangeOutputRemoteSchema,
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
        for (const item of [...value.remote.mcp, ...value.remote.mcpCursors]) {
          const session = item.workerSession;
          if (
            item.machineId !== value.session.machineId ||
            session.generation !== value.session.generation ||
            session.bootId !== value.session.bootId ||
            session.attemptId !== value.session.attemptId
          )
            ctx.addIssue({
              code: "custom",
              path: ["remote", "mcp"],
              message: "MCP 投递必须属于本 exchange 会话",
            });
        }
        if (
          value.mode === "drain" &&
          value.remote.mcp.some(
            (item) =>
              item.type !== "session_detach" &&
              item.type !== "session_fence" &&
              !(item.type === "session_reconcile" && item.sessions.length === 0),
          )
        )
          ctx.addIssue({
            code: "custom",
            path: ["remote", "mcp"],
            message: "drain 只能接收 MCP detach、fence 或空 reconcile",
          });
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
export type WorkerExchangeRemoteInput = z.infer<typeof workerExchangeRemoteSchema>;
export type WorkerExchangeRemoteOutput = z.infer<typeof workerExchangeOutputRemoteSchema>;
export type WorkerCloseInput = z.infer<typeof workerCloseInput>;
export type WorkerEnrollResponse = z.infer<typeof workerEnrollResponseSchema>;
export type WorkerOpenResponse = z.infer<typeof workerOpenResponseSchema>;
export type WorkerExchangeResponse = z.infer<typeof workerExchangeResponseSchema>;
export type WorkerCloseResponse = z.infer<typeof workerCloseResponseSchema>;
