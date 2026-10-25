import { createHash } from "node:crypto";
import type { McpSession, SessionCursor } from "../../contracts/mcp";

export function mcpHash(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, val]) => [key, canonical(val)]),
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export const mcpPayloadHash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function mcpBound(
  session: McpSession,
): Omit<SessionCursor, "clientAcceptedThrough" | "serverAcceptedThrough"> {
  return {
    sessionId: session.id,
    projectId: session.projectId,
    machineId: session.machineId,
    authorizationGeneration: session.authorizationGeneration,
    holderInstanceId: session.holderInstanceId,
    processId: session.processId,
    workerSession: {
      machineId: session.machineId,
      generation: session.workerConnectionGeneration,
      bootId: session.serverBootId,
      attemptId: session.workerAttemptId,
    },
  };
}
export function mcpSameBound(a: ReturnType<typeof mcpBound>, b: ReturnType<typeof mcpBound>) {
  const identity = (value: ReturnType<typeof mcpBound>) => ({
    sessionId: value.sessionId,
    projectId: value.projectId,
    machineId: value.machineId,
    authorizationGeneration: value.authorizationGeneration,
    holderInstanceId: value.holderInstanceId,
    processId: value.processId,
    workerSession: value.workerSession,
  });
  return mcpHash(identity(a)) === mcpHash(identity(b));
}
