import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import { leaseMutationViewSchema, leaseViewSchema } from "../contracts/lease";
import { APP_ERROR_CODES } from "../contracts/result";
import type { AppResult } from "../contracts/result";
import {
  mcpCatalogViewSchema,
  mcpSessionCloseOutputSchema,
  mcpSessionExchangeOutputSchema,
  mcpSessionOpenOutputSchema,
} from "../contracts/mcp";
import {
  executionCancellationViewSchema,
  executionLogReadViewSchema,
  executionViewSchema,
  holderExecutionListViewSchema,
  remoteAgentRequestSchema,
  remoteToolGrantSchema,
  taskGetResponseSchema,
  taskListResponseSchema,
  taskMutateResponseSchema,
  chatGetResponseSchema,
  chatSendResponseSchema,
} from "../contracts/remote";
import type { RemoteAgentRequest, RemoteToolGrant } from "../contracts/remote";

const envelopeSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: z.unknown(), requestId: z.string() }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(APP_ERROR_CODES),
      message: z.string(),
      requestId: z.string(),
    }),
    requestId: z.string(),
  }),
]);
const leaseReadSchema = z.strictObject({
  lease: leaseViewSchema,
  mutation: leaseMutationViewSchema.nullable(),
});
type RemoteData =
  | z.infer<typeof taskGetResponseSchema>
  | z.infer<typeof taskListResponseSchema>
  | z.infer<typeof taskMutateResponseSchema>
  | z.infer<typeof chatGetResponseSchema>
  | z.infer<typeof chatSendResponseSchema>
  | z.infer<typeof executionViewSchema>
  | z.infer<typeof holderExecutionListViewSchema>
  | z.infer<typeof executionCancellationViewSchema>
  | z.infer<typeof executionLogReadViewSchema>
  | z.infer<typeof leaseMutationViewSchema>
  | z.infer<typeof leaseReadSchema>
  | z.infer<typeof mcpCatalogViewSchema>
  | z.infer<typeof mcpSessionOpenOutputSchema>
  | z.infer<typeof mcpSessionExchangeOutputSchema>;
export type RemoteToolResponse =
  | { outcome: "response"; result: AppResult<RemoteData> }
  | {
      outcome: "unknown";
      reason: "transport_timeout" | "cancelled" | "transport_error" | "invalid_response";
    };
export interface RemoteToolClient {
  readonly projectId: string;
  request(request: RemoteAgentRequest, signal?: AbortSignal): Promise<RemoteToolResponse>;
}

function readResponse(value: unknown, request: RemoteAgentRequest): RemoteToolResponse {
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) return { outcome: "unknown", reason: "invalid_response" };
  if (!envelope.data.ok) return { outcome: "response", result: envelope.data };
  const { call } = request;
  const taskResponse = readTaskChatResponse(envelope.data, request);
  if (taskResponse) return taskResponse;
  if (
    call.type === "task_get" ||
    call.type === "task_list" ||
    call.type === "task_mutate" ||
    call.type === "chat_get" ||
    call.type === "chat_send"
  )
    return { outcome: "unknown", reason: "invalid_response" };
  if (call.type.startsWith("mcp_")) return readMcpResponse(envelope.data, request);
  const input = call.input;
  const sameBinding = (data: { projectId: string; machineId: string }) =>
    data.projectId === input.projectId && data.machineId === input.machineId;
  const ok = (data: RemoteData): RemoteToolResponse => ({
    outcome: "response",
    result: { ok: true, data, requestId: envelope.data.requestId },
  });
  const bad: RemoteToolResponse = { outcome: "unknown", reason: "invalid_response" };
  const raw = envelope.data.data;
  if (call.type === "lease_get") {
    const parsed = leaseReadSchema.safeParse(raw);
    if (!parsed.success) return bad;
    const { lease, mutation } = parsed.data;
    if (!sameBinding(lease) || (mutation !== null && !sameBinding(mutation))) return bad;
    return ok(parsed.data);
  }
  if (call.type === "lease_mutate") {
    const parsed = leaseMutationViewSchema.safeParse(raw);
    if (!parsed.success || !sameBinding(parsed.data)) return bad;
    return ok(parsed.data);
  }
  if (call.type === "execution_list") {
    const parsed = holderExecutionListViewSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.executions.some((view) => !sameBinding(view) || view.authority === "history")
    )
      return bad;
    return ok(parsed.data);
  }
  if (call.type === "execution_cancel") {
    const parsed = executionCancellationViewSchema.safeParse(raw);
    if (!parsed.success || !sameBinding(parsed.data)) return bad;
    // 取消响应只接受本次请求的 execution；其余一律不可信。
    if (parsed.data.executionId !== call.input.executionId) return bad;
    return ok(parsed.data);
  }
  if (call.type === "execution_log_read") {
    const parsed = executionLogReadViewSchema.safeParse(raw);
    if (!parsed.success || !sameBinding(parsed.data)) return bad;
    if (parsed.data.executionId !== call.input.executionId) return bad;
    return ok(parsed.data);
  }
  const parsed = executionViewSchema.safeParse(raw);
  if (!parsed.success || !sameBinding(parsed.data)) return bad;
  if (
    (call.type === "execution_get" && parsed.data.executionId !== call.input.executionId) ||
    (call.type === "execution_submit" &&
      (parsed.data.requestId !== call.input.requestId ||
        parsed.data.authorizationGeneration !== call.input.authorizationGeneration ||
        parsed.data.operation.kind !== call.input.operation.kind))
  )
    return bad;
  return ok(parsed.data);
}

export function readTaskChatResponse(
  envelope: Extract<z.infer<typeof envelopeSchema>, { ok: true }>,
  { call }: RemoteAgentRequest,
): RemoteToolResponse | undefined {
  const bad: RemoteToolResponse = { outcome: "unknown", reason: "invalid_response" };
  const ok = (data: RemoteData): RemoteToolResponse => ({
    outcome: "response",
    result: { ok: true, data, requestId: envelope.requestId },
  });
  switch (call.type) {
    case "task_get": {
      const parsed = taskGetResponseSchema.safeParse(envelope.data);
      return parsed.success &&
        parsed.data.task.projectId === call.input.projectId &&
        parsed.data.task.id === call.input.taskId
        ? ok(parsed.data)
        : bad;
    }
    case "task_mutate": {
      const parsed = taskMutateResponseSchema.safeParse(envelope.data);
      return parsed.success &&
        parsed.data.detail.task.projectId === call.input.projectId &&
        parsed.data.detail.task.id === call.input.taskId &&
        !parsed.data.startDelivery
        ? ok(parsed.data)
        : bad;
    }
    case "task_list": {
      const parsed = taskListResponseSchema.safeParse(envelope.data);
      return parsed.success && parsed.data.projectId === call.input.projectId
        ? ok(parsed.data)
        : bad;
    }
    case "chat_get": {
      const parsed = chatGetResponseSchema.safeParse(envelope.data);
      return parsed.success && parsed.data.projectId === call.input.projectId
        ? ok(parsed.data)
        : bad;
    }
    case "chat_send": {
      const parsed = chatSendResponseSchema.safeParse(envelope.data);
      return parsed.success &&
        parsed.data.projectId === call.input.projectId &&
        parsed.data.message.senderKind === "agent" &&
        parsed.data.message.body === call.input.body
        ? ok(parsed.data)
        : bad;
    }
    default:
      return undefined;
  }
}

/**
 * MCP 中继四个 call 的响应校验：只信 envelope 与身份字段，不解释 MCP 内容。
 * 每一层都把返回行的 Project/Machine/代次/目标与请求逐项对齐，任一不等即视为不可信响应。
 */
function readMcpResponse(
  envelope: Extract<z.infer<typeof envelopeSchema>, { ok: true }>,
  request: RemoteAgentRequest,
): RemoteToolResponse {
  const { call } = request;
  const ok = (data: RemoteData): RemoteToolResponse => ({
    outcome: "response",
    result: { ok: true, data, requestId: envelope.requestId },
  });
  const bad: RemoteToolResponse = { outcome: "unknown", reason: "invalid_response" };
  if (call.type === "mcp_catalog_get") {
    const parsed = mcpCatalogViewSchema.safeParse(envelope.data);
    if (!parsed.success) return bad;
    if (
      parsed.data.registrations.some(
        (registration) =>
          registration.projectId !== call.input.projectId ||
          registration.machineId !== call.input.machineId,
      )
    )
      return bad;
    return ok(parsed.data);
  }
  if (call.type === "mcp_session_open") {
    const parsed = mcpSessionOpenOutputSchema.safeParse(envelope.data);
    if (!parsed.success) return bad;
    const session = parsed.data.session;
    if (
      session.projectId !== call.input.projectId ||
      session.machineId !== call.input.machineId ||
      session.authorizationGeneration !== call.input.authorizationGeneration ||
      session.processId !== call.input.processId ||
      session.registrationId !== call.input.registrationId ||
      session.registrationRevision !== call.input.registrationRevision ||
      session.workerIncarnationId !== call.input.expectedWorkerIncarnationId ||
      session.openRequestId !== call.input.requestId
    )
      return bad;
    return ok(parsed.data);
  }
  if (call.type === "mcp_session_close") {
    const parsed = mcpSessionCloseOutputSchema.safeParse(envelope.data);
    if (!parsed.success) return bad;
    const session = parsed.data.session;
    if (
      session.id !== call.input.sessionId ||
      session.projectId !== call.input.projectId ||
      session.machineId !== call.input.machineId ||
      session.authorizationGeneration !== call.input.authorizationGeneration
    )
      return bad;
    return ok(parsed.data);
  }
  if (call.type !== "mcp_session_exchange") return bad;
  const parsed = mcpSessionExchangeOutputSchema.safeParse(envelope.data);
  if (!parsed.success) return bad;
  const session = parsed.data.session;
  if (
    session.id !== call.input.sessionId ||
    session.projectId !== call.input.projectId ||
    session.machineId !== call.input.machineId ||
    session.authorizationGeneration !== call.input.authorizationGeneration ||
    parsed.data.acceptedClientSeq > session.clientHighWater
  )
    return bad;
  let previous = 0;
  for (const frame of parsed.data.frames) {
    // 服务端帧序号必须严格递增且不超出 session 水位。
    if (frame.seq <= previous || frame.seq > session.serverHighWater) return bad;
    previous = frame.seq;
  }
  return ok(parsed.data);
}

/** Direct HTTP deliberately bypasses environment/global fetch proxies and never follows redirects. */
export function createRemoteClient(
  config: RemoteToolGrant,
  { timeoutMs = 15000 }: { timeoutMs?: number } = {},
): RemoteToolClient {
  const { endpoint, secret, projectId } = remoteToolGrantSchema.parse(config);
  const url = new URL(endpoint);
  return {
    projectId,
    async request(input, signal) {
      const parsed = remoteAgentRequestSchema.safeParse(input);
      if (!parsed.success) return { outcome: "unknown", reason: "invalid_response" };
      const body = JSON.stringify(parsed.data);
      return new Promise<RemoteToolResponse>((resolve) => {
        let finished = false;
        const finish = (result: RemoteToolResponse) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(result);
        };
        const controller = new AbortController();
        const abort = () => {
          finish({ outcome: "unknown", reason: "cancelled" });
          controller.abort();
        };
        const timer = setTimeout(() => {
          finish({ outcome: "unknown", reason: "transport_timeout" });
          controller.abort();
        }, timeoutMs);
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
        const send = url.protocol === "https:" ? httpsRequest : httpRequest;
        const req = send(
          url,
          {
            method: "POST",
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 512 * 1024) {
                finish({ outcome: "unknown", reason: "invalid_response" });
                response.destroy();
              } else chunks.push(chunk);
            });
            response.on("error", () => finish({ outcome: "unknown", reason: "transport_error" }));
            response.on("end", () => {
              try {
                const taskChatCall = [
                  "task_get",
                  "task_list",
                  "task_mutate",
                  "chat_get",
                  "chat_send",
                ].includes(parsed.data.call.type);
                if (
                  response.statusCode !== 200 &&
                  response.statusCode !== 401 &&
                  !(taskChatCall && response.statusCode === 403)
                ) {
                  finish({ outcome: "unknown", reason: "invalid_response" });
                  return;
                }
                const result = readResponse(
                  JSON.parse(Buffer.concat(chunks).toString("utf8")),
                  parsed.data,
                );
                if (
                  (response.statusCode === 401 || response.statusCode === 403) &&
                  result.outcome === "response" &&
                  result.result.ok
                )
                  finish({ outcome: "unknown", reason: "invalid_response" });
                else finish(result);
              } catch {
                finish({ outcome: "unknown", reason: "invalid_response" });
              }
            });
          },
        );
        req.on("error", () => finish({ outcome: "unknown", reason: "transport_error" }));
        req.end(body);
      });
    },
  };
}
