import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  workerCloseInput,
  workerEnrollInput,
  workerExchangeInput,
  workerOpenInput,
  WORKER_POLL_INTERVAL_MS,
  WORKER_PROTOCOL_VERSION,
  WORKER_STALE_AFTER_MS,
} from "../contracts/worker";
import type { WorkerExchangeResponse, WORKER_ERROR_CODES } from "../contracts/worker";
import type { WorkerSession } from "../contracts/worker-session";
import { db, sqlite } from "../db";
import {
  directoryObservation,
  machine,
  machineConnection,
  machineConnectionCounter,
  machineCredential,
  projectMachine,
  workerExchangeFrame,
} from "../db/schema";
import { hashCredential, machineBindings, matchesCredential } from "../domain/machine";
import { getRequestContext, REQUEST_ID_HEADER } from "./request-context";
import { machineRuntimeContext, runtimeSnapshot } from "./runtime";
import { applyRemoteExchange, drainRemoteResponse, RemoteError } from "./remote";
import { LeaseError } from "./lease";

type WorkerCode = (typeof WORKER_ERROR_CODES)[number];
export class WorkerError extends Error {
  constructor(readonly code: WorkerCode) {
    super(code);
    this.name = "WorkerError";
  }
}
export type WorkerContext = { bootId: string; now: Date };
function authenticate(machineId: string, secret: string) {
  const credential = db
    .select()
    .from(machineCredential)
    .where(eq(machineCredential.machineId, machineId))
    .get();
  if (!credential || !matchesCredential(secret, credential.secretHash))
    throw new WorkerError("unauthorized");
}
function latest(session: WorkerSession, ctx: WorkerContext, allowClosed = false) {
  const counter = db
    .select()
    .from(machineConnectionCounter)
    .where(eq(machineConnectionCounter.machineId, session.machineId))
    .get();
  const row = db
    .select()
    .from(machineConnection)
    .where(
      and(
        eq(machineConnection.machineId, session.machineId),
        eq(machineConnection.generation, session.generation),
      ),
    )
    .get();
  if (
    !row ||
    counter?.highWater !== session.generation ||
    session.bootId !== ctx.bootId ||
    row.bootId !== ctx.bootId ||
    row.attemptId !== session.attemptId
  )
    throw new WorkerError("superseded");
  if (allowClosed && row.status === "closed") return row;
  if (
    row.status !== "open" ||
    ctx.now.getTime() - row.lastSeenAt.getTime() >= WORKER_STALE_AFTER_MS
  )
    throw new WorkerError("stale");
  return row;
}
export function canonicalPayload(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalPayload((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export function enrollWorker(input: z.infer<typeof workerEnrollInput>, ctx: WorkerContext) {
  return sqlite
    .transaction(() => {
      const credential = db
        .select()
        .from(machineCredential)
        .where(eq(machineCredential.machineId, input.machineId))
        .get();
      if (
        !credential ||
        !matchesCredential(input.ticket, credential.ticketHash) ||
        credential.ticketExpiresAt.getTime() <= ctx.now.getTime()
      )
        throw new WorkerError("unauthorized");
      if (credential.secretHash && !matchesCredential(input.secret, credential.secretHash))
        throw new WorkerError("unauthorized");
      if (!credential.secretHash)
        db.update(machineCredential)
          .set({ secretHash: hashCredential(input.secret), activatedAt: ctx.now })
          .where(eq(machineCredential.machineId, input.machineId))
          .run();
      return { machineId: input.machineId };
    })
    .immediate();
}
export function openWorker(input: z.infer<typeof workerOpenInput>, ctx: WorkerContext) {
  return sqlite
    .transaction(() => {
      authenticate(input.machineId, input.secret);
      const old = db
        .select()
        .from(machineConnection)
        .where(
          and(
            eq(machineConnection.machineId, input.machineId),
            eq(machineConnection.attemptId, input.attemptId),
          ),
        )
        .get();
      let session: WorkerSession;
      if (old) {
        session = {
          machineId: input.machineId,
          generation: old.generation,
          bootId: old.bootId,
          attemptId: old.attemptId,
        };
        latest(session, ctx);
      } else {
        const counter = db
          .select()
          .from(machineConnectionCounter)
          .where(eq(machineConnectionCounter.machineId, input.machineId))
          .get()!;
        if (counter.highWater >= Number.MAX_SAFE_INTEGER) throw new WorkerError("conflict");
        const generation = counter.highWater + 1;
        db.update(machineConnectionCounter)
          .set({ highWater: generation })
          .where(eq(machineConnectionCounter.machineId, input.machineId))
          .run();
        db.insert(machineConnection)
          .values({
            machineId: input.machineId,
            generation,
            bootId: ctx.bootId,
            attemptId: input.attemptId,
            status: "open",
            openedAt: ctx.now,
            lastSeenAt: ctx.now,
            seq: 0,
          })
          .run();
        session = {
          machineId: input.machineId,
          generation,
          bootId: ctx.bootId,
          attemptId: input.attemptId,
        };
      }
      return {
        session,
        pollIntervalMs: WORKER_POLL_INTERVAL_MS,
        staleAfterMs: WORKER_STALE_AFTER_MS,
      };
    })
    .immediate();
}
export function exchangeWorker(input: z.infer<typeof workerExchangeInput>, ctx: WorkerContext) {
  return sqlite
    .transaction(() => {
      authenticate(input.session.machineId, input.secret);
      return input.mode === "drain" ? drainExchange(input, ctx) : normalExchange(input, ctx);
    })
    .immediate();
}

type NormalExchange = Extract<z.infer<typeof workerExchangeInput>, { mode: "normal" }>;
type DrainExchange = Extract<z.infer<typeof workerExchangeInput>, { mode: "drain" }>;
type ExchangeData = Extract<WorkerExchangeResponse, { ok: true }>["data"];

/** 原帧只按会话语义字段哈希：secret 与 requestId 不入哈希，同 seq 异语义必须 conflict。 */
function frameHash(input: NormalExchange | DrainExchange) {
  return createHash("sha256")
    .update(
      canonicalPayload(
        input.mode === "normal"
          ? {
              mode: input.mode,
              session: input.session,
              seq: input.seq,
              capability: input.capability,
              observations: input.observations,
              remote: input.remote,
            }
          : { mode: input.mode, session: input.session, seq: input.seq, remote: input.remote },
      ),
    )
    .digest("hex");
}
function committedFrame(session: WorkerSession, seq: number) {
  return db
    .select()
    .from(workerExchangeFrame)
    .where(
      and(
        eq(workerExchangeFrame.machineId, session.machineId),
        eq(workerExchangeFrame.connectionGeneration, session.generation),
        eq(workerExchangeFrame.seq, seq),
      ),
    )
    .get();
}
function frameHighWater(session: WorkerSession, fallback: number) {
  const row = db
    .select({ seq: workerExchangeFrame.seq })
    .from(workerExchangeFrame)
    .where(
      and(
        eq(workerExchangeFrame.machineId, session.machineId),
        eq(workerExchangeFrame.connectionGeneration, session.generation),
      ),
    )
    .orderBy(desc(workerExchangeFrame.seq))
    .limit(1)
    .get();
  return Math.max(fallback, row?.seq ?? 0);
}

/** normal：credential → latest(session) → 原帧去重 → 事实推进 → 固定原帧。 */
function normalExchange(input: NormalExchange, ctx: WorkerContext): ExchangeData {
  const row = latest(input.session, ctx);
  const { session, seq } = input;
  const payloadHash = frameHash(input);
  const highWater = frameHighWater(session, row.seq);
  if (seq < highWater) {
    const frame = committedFrame(session, seq);
    if (frame?.payloadHash === payloadHash) return frame.responseJson;
    throw new WorkerError("conflict");
  }
  if (seq > highWater + 1) throw new WorkerError("conflict");
  const frame = committedFrame(session, seq);
  if (frame) {
    if (frame.payloadHash !== payloadHash) throw new WorkerError("conflict");
    return frame.responseJson;
  }
  const root = db.select().from(machine).where(eq(machine.id, session.machineId)).get()!;
  for (const observation of input.observations) {
    const binding = db
      .select()
      .from(projectMachine)
      .where(
        and(
          eq(projectMachine.projectId, observation.projectId),
          eq(projectMachine.machineId, session.machineId),
        ),
      )
      .get();
    if (!binding || root.rootRevision !== observation.revision || root.rootDirectory === null)
      throw new WorkerError("conflict");
    const values = {
      machineId: session.machineId,
      generation: session.generation,
      projectId: observation.projectId,
      revision: observation.revision,
      seq,
      checkedAt: new Date(observation.checkedAt),
      kind: observation.result.kind,
      realPath: observation.result.kind === "accessible" ? observation.result.realPath : null,
      reason: observation.result.kind === "unavailable" ? observation.result.reason : null,
    };
    db.insert(directoryObservation)
      .values(values)
      .onConflictDoUpdate({
        target: [
          directoryObservation.machineId,
          directoryObservation.generation,
          directoryObservation.projectId,
          directoryObservation.revision,
        ],
        set: values,
      })
      .run();
  }
  db.update(machineConnection)
    .set({ seq, capability: input.capability, lastPayloadHash: payloadHash, lastSeenAt: ctx.now })
    .where(
      and(
        eq(machineConnection.machineId, session.machineId),
        eq(machineConnection.generation, session.generation),
      ),
    )
    .run();
  const data: ExchangeData = {
    mode: "normal",
    session,
    seq,
    configuration: {
      root: root.rootDirectory,
      rootRevision: root.rootRevision,
      bindings: machineBindings(session.machineId).map(({ projectId, description }) => ({
        projectId,
        description,
      })),
    },
    remote: applyRemoteExchange(input.remote, { ...ctx, session, seq, mode: "normal" }),
  };
  db.insert(workerExchangeFrame)
    .values({
      machineId: session.machineId,
      connectionGeneration: session.generation,
      seq,
      payloadHash,
      responseJson: data,
      createdAt: ctx.now,
    })
    .run();
  return data;
}

/**
 * drain：只确认原 session 的会话与已投递记录，不更新 lastSeen/capability/seq，
 * 不写 observation，不领取命令；因此 drain 不会让断联 Machine 变 online。
 */
function drainExchange(input: DrainExchange, ctx: WorkerContext): ExchangeData {
  const row = db
    .select()
    .from(machineConnection)
    .where(
      and(
        eq(machineConnection.machineId, input.session.machineId),
        eq(machineConnection.generation, input.session.generation),
      ),
    )
    .get();
  // drain 只要求原 session 与已存连接行完全一致（generation/bootId/attemptId），
  // 允许 boot 过时、closed 或非 latest 的 session 只走 drain 而不重新获得 normal 权。
  if (!row || row.bootId !== input.session.bootId || row.attemptId !== input.session.attemptId)
    throw new WorkerError("superseded");
  const { session, seq } = input;
  const payloadHash = frameHash(input);
  const highWater = frameHighWater(session, row.seq);
  if (seq < highWater) {
    const frame = committedFrame(session, seq);
    if (frame?.payloadHash === payloadHash) return frame.responseJson;
    throw new WorkerError("conflict");
  }
  if (seq > highWater + 1) throw new WorkerError("conflict");
  const existing = committedFrame(session, seq);
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new WorkerError("conflict");
    return existing.responseJson;
  }
  const data: ExchangeData = {
    mode: "drain",
    session,
    seq,
    configuration: null,
    remote: drainRemoteResponse(
      applyRemoteExchange(input.remote, { ...ctx, session, seq, mode: "drain" }),
    ),
  };
  db.insert(workerExchangeFrame)
    .values({
      machineId: session.machineId,
      connectionGeneration: session.generation,
      seq,
      payloadHash,
      responseJson: data,
      createdAt: ctx.now,
    })
    .run();
  return data;
}
export function closeWorker(input: z.infer<typeof workerCloseInput>, ctx: WorkerContext) {
  return sqlite
    .transaction(() => {
      authenticate(input.session.machineId, input.secret);
      const row = latest(input.session, ctx, true);
      if (row.status !== "closed")
        db.update(machineConnection)
          .set({ status: "closed", closedAt: ctx.now })
          .where(
            and(
              eq(machineConnection.machineId, row.machineId),
              eq(machineConnection.generation, row.generation),
            ),
          )
          .run();
      return { closed: true as const };
    })
    .immediate();
}
const operations = {
  enroll: (raw: unknown, ctx: WorkerContext) => enrollWorker(workerEnrollInput.parse(raw), ctx),
  open: (raw: unknown, ctx: WorkerContext) => openWorker(workerOpenInput.parse(raw), ctx),
  exchange: (raw: unknown, ctx: WorkerContext) =>
    exchangeWorker(workerExchangeInput.parse(raw), ctx),
  close: (raw: unknown, ctx: WorkerContext) => closeWorker(workerCloseInput.parse(raw), ctx),
};
const MAX_BODY_BYTES = 2 * 1024 * 1024;
async function boundedBody(request: Request) {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES)
    throw new WorkerError("validation_failed");
  if (!request.body) throw new WorkerError("validation_failed");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new WorkerError("validation_failed");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new WorkerError("validation_failed");
  }
}
export async function workerResponse(operation: keyof typeof operations, request: Request) {
  const { requestId } = getRequestContext(request);
  const headers = { [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" };
  try {
    if (request.headers.has("origin")) throw new WorkerError("unauthorized");
    if (runtimeSnapshot().phase === "stopping") throw new WorkerError("stopping");
    const raw = await boundedBody(request);
    if (
      typeof raw === "object" &&
      raw !== null &&
      "version" in raw &&
      raw.version !== WORKER_PROTOCOL_VERSION
    )
      throw new WorkerError("unsupported_version");
    const ctx = await machineRuntimeContext();
    const data = operations[operation](raw, ctx);
    return Response.json(
      { version: WORKER_PROTOCOL_VERSION, requestId, ok: true, data },
      { headers },
    );
  } catch (error) {
    const code =
      error instanceof WorkerError
        ? error.code
        : error instanceof RemoteError || error instanceof LeaseError
          ? "conflict"
          : error instanceof z.ZodError
            ? "validation_failed"
            : "internal";
    return Response.json(
      {
        version: WORKER_PROTOCOL_VERSION,
        requestId,
        ok: false,
        error: { code, message: code === "internal" ? "内部错误" : code },
      },
      { status: code === "internal" ? 500 : code === "unauthorized" ? 401 : 400, headers },
    );
  }
}
