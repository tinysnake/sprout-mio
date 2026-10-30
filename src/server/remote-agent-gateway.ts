import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { remoteAgentRequestSchema } from "../contracts/remote";
import type { RemoteToolGrant } from "../contracts/remote";
import { toAppError } from "../contracts/result";
import { db, sqlite } from "../db";
import { agentInstance, agentRun, chatMember, project, remoteToolGrant } from "../db/schema";
import { hashCredential } from "../domain/machine";
import { config } from "../lib/config";
import { acquireLease, getLease, handoffLease, releaseLease } from "./lease";
import type { AgentRemoteContext } from "./lease";
import {
  mcpCatalogGet,
  mcpSessionClose,
  mcpSessionExchange,
  mcpSessionOpen,
  parseMcpExchange,
} from "./mcp-relay";
import type { PiSessionProcess } from "./pi-host/process";
import {
  enqueueCancellation,
  getExecution,
  listHolderExecutions,
  readExecutionLog,
  requestExecution,
  RemoteError,
} from "./remote";
import { machineRuntimeContext, runtimeSnapshot } from "./runtime";

type RuntimeContext = { bootId: string; requestId: string; now: Date };
type LiveGrant = { runId: string; bootId: string; process: PiSessionProcess };
// Process-scoped, server-only identity registry. SQL alone cannot revive a grant after restart.
const scope = globalThis as typeof globalThis & { sproutRemoteGrants?: Map<string, LiveGrant> };
const registry = (scope.sproutRemoteGrants ??= new Map());
const GRANT_TTL_MS = 15 * 60 * 1000;
function actor(runId: string) {
  const run = db.select().from(agentRun).where(eq(agentRun.id, runId)).get();
  const instance =
    run && db.select().from(agentInstance).where(eq(agentInstance.id, run.instanceId)).get();
  const owner = run && db.select().from(project).where(eq(project.id, run.projectId)).get();
  if (
    !run ||
    !instance ||
    !owner ||
    instance.projectId !== run.projectId ||
    instance.chatId !== run.chatId ||
    !db
      .select()
      .from(chatMember)
      .where(
        and(
          eq(chatMember.chatId, run.chatId),
          eq(chatMember.memberKind, "agent"),
          eq(chatMember.memberId, instance.agentProfileId),
        ),
      )
      .get()
  )
    throw new RemoteError("remote_run_inactive");
  return { run, instance, owner };
}
export function issueRemoteToolGrant(
  runId: string,
  process: PiSessionProcess,
  ctx: RuntimeContext,
): RemoteToolGrant {
  const snapshot = runtimeSnapshot();
  if (!snapshot.ready || snapshot.bootId !== ctx.bootId || !process.pid)
    throw new RemoteError("remote_run_inactive");
  const secret = randomBytes(32).toString("base64url");
  const grant = sqlite
    .transaction(() => {
      const { run, owner } = actor(runId);
      if (run.status !== "queued" && run.status !== "running")
        throw new RemoteError("remote_run_inactive");
      if (db.select().from(remoteToolGrant).where(eq(remoteToolGrant.runId, runId)).get())
        throw new RemoteError("remote_request_conflict");
      const id = newId(ID_PREFIXES.remoteToolGrant),
        expiresAt = new Date(ctx.now.getTime() + GRANT_TTL_MS);
      db.insert(remoteToolGrant)
        .values({
          id,
          secretHash: hashCredential(secret),
          userId: owner.createdBy,
          projectId: run.projectId,
          chatId: run.chatId,
          instanceId: run.instanceId,
          runId,
          issuedAt: ctx.now,
          expiresAt,
        })
        .run();
      return { id, projectId: run.projectId, expiresAt };
    })
    .immediate();
  // The run adapter owns PiSessionProcess.onDispose and calls revoke synchronously
  // on failure/abort/close. Keeping the exact process here prevents a replacement
  // runner from sharing this run's grant.
  registry.set(grant.id, { runId, bootId: ctx.bootId, process });
  return {
    endpoint: new URL("/api/remote/agent", config.APP_ORIGIN).href,
    secret,
    expiresAt: grant.expiresAt.toISOString(),
    projectId: grant.projectId,
  };
}
export function revokeRemoteToolGrant(runId: string, ctx: RuntimeContext): void {
  // Close admission before persistence, including when persistence itself fails.
  for (const [id, live] of registry) if (live.runId === runId) registry.delete(id);
  sqlite
    .transaction(() => {
      const grant = db.select().from(remoteToolGrant).where(eq(remoteToolGrant.runId, runId)).get();
      if (grant && !grant.revokedAt)
        db.update(remoteToolGrant)
          .set({ revokedAt: new Date(Math.max(ctx.now.getTime(), grant.issuedAt.getTime())) })
          .where(eq(remoteToolGrant.id, grant.id))
          .run();
    })
    .immediate();
}
function authenticate(request: Request, ctx: RuntimeContext): AgentRemoteContext {
  const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  const grant =
    bearer &&
    db
      .select()
      .from(remoteToolGrant)
      .where(eq(remoteToolGrant.secretHash, hashCredential(bearer[1])))
      .get();
  if (!grant || grant.revokedAt || grant.expiresAt <= ctx.now)
    throw new RemoteError("remote_grant_invalid");
  const live = registry.get(grant.id);
  if (!live || live.runId !== grant.runId || live.bootId !== ctx.bootId || !live.process.pid)
    throw new RemoteError("remote_run_inactive");
  const { run, owner } = actor(grant.runId);
  if (
    run.status !== "running" ||
    run.instanceId !== grant.instanceId ||
    run.projectId !== grant.projectId ||
    run.chatId !== grant.chatId ||
    owner.createdBy !== grant.userId
  )
    throw new RemoteError("remote_run_inactive");
  return {
    ...ctx,
    userId: grant.userId,
    projectId: grant.projectId,
    chatId: grant.chatId,
    instanceId: grant.instanceId,
    runId: grant.runId,
    grantId: grant.id,
  };
}
async function body(request: Request) {
  const limit = 1024 * 1024;
  if (Number(request.headers.get("content-length")) > limit || !request.body)
    throw new RemoteError("validation_failed");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RemoteError("validation_failed");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RemoteError("validation_failed");
  }
}
export async function remoteAgentResponse(request: Request): Promise<Response> {
  const { getRequestContext, REQUEST_ID_HEADER } = await import("./request-context");
  const { requestId } = getRequestContext(request);
  const headers = { [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" };
  try {
    if (
      request.headers.has("origin") ||
      new URL(request.url).origin !== new URL(config.APP_ORIGIN).origin
    )
      throw new RemoteError("forbidden");
    const runtime = await machineRuntimeContext();
    const ctx = { ...runtime, requestId };
    // Fail missing/invalid credentials before consuming body, then recheck in the
    // immediate transaction after the asynchronous body read.
    sqlite.transaction(() => authenticate(request, ctx)).immediate();
    const raw = await body(request);
    const current = { ...(await machineRuntimeContext()), requestId };
    const data = sqlite
      .transaction(() => {
        const actorContext = authenticate(request, current);
        const parsed = remoteAgentRequestSchema.parse(raw);
        if (parsed.call.input.projectId !== actorContext.projectId)
          throw new RemoteError("not_found");
        switch (parsed.call.type) {
          case "lease_get":
            return getLease(parsed.call.input, actorContext);
          case "execution_submit":
            return requestExecution(parsed.call.input, actorContext);
          case "execution_get":
            return getExecution(parsed.call.input, actorContext);
          case "execution_list":
            return listHolderExecutions(parsed.call.input, actorContext);
          case "execution_cancel":
            // 入队意图，不代表进程已停。
            return enqueueCancellation(parsed.call.input, actorContext);
          case "execution_log_read":
            return readExecutionLog(parsed.call.input, actorContext);
          case "mcp_catalog_get":
            return mcpCatalogGet(parsed.call.input, actorContext);
          case "mcp_session_open":
            return mcpSessionOpen(parsed.call.input, actorContext);
          case "mcp_session_close":
            return mcpSessionClose(parsed.call.input, actorContext);
          case "mcp_session_exchange":
            // exchange 是唯一有界 hold 的 call，不能把等待塞进 immediate 事务：
            // 这里只把已验证的身份交出去，落盘与 hold 由 mcp-relay 自己开合事务。
            return { hold: parseMcpExchange(parsed.call.input), context: actorContext };
          case "lease_mutate": {
            const input = parsed.call.input;
            switch (input.action) {
              case "acquire":
                return acquireLease(input, actorContext);
              case "release":
                return releaseLease(input, actorContext);
              case "handoff":
                return handoffLease(input, actorContext);
            }
          }
        }
      })
      .immediate();
    const payload =
      "hold" in data && data.hold ? await mcpSessionExchange(data.hold, data.context) : data;
    const encoded = JSON.stringify({ ok: true, data: payload, requestId });
    if (Buffer.byteLength(encoded) > 512 * 1024) throw new RemoteError("too_many_requests");
    return new Response(encoded, { headers: { ...headers, "content-type": "application/json" } });
  } catch (error) {
    const appError = toAppError(error, requestId);
    const unauthorized =
      appError.code === "remote_grant_invalid" || appError.code === "remote_run_inactive";
    return Response.json(
      { ok: false, error: { ...appError, message: appError.code }, requestId },
      { status: unauthorized ? 401 : appError.code === "forbidden" ? 403 : 200, headers },
    );
  }
}
