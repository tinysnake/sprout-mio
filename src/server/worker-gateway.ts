import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  workerCloseInput,
  workerEnrollInput,
  workerExchangeInput,
  workerOpenInput,
  WORKER_POLL_INTERVAL_MS,
  WORKER_STALE_AFTER_MS,
} from "../contracts/worker";
import type { WorkerSession, WORKER_ERROR_CODES } from "../contracts/worker";
import { db, sqlite } from "../db";
import {
  directoryObservation,
  machineConnection,
  machineConnectionCounter,
  machineCredential,
  projectMachine,
} from "../db/schema";
import { hashCredential, machineBindings, matchesCredential } from "../domain/machine";
import { getRequestContext, REQUEST_ID_HEADER } from "./request-context";
import { machineRuntimeContext, runtimeSnapshot } from "./runtime";

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
      const row = latest(input.session, ctx);
      const { session, seq, capability, observations } = input;
      const payloadHash = createHash("sha256")
        .update(canonicalPayload({ session, seq, capability, observations }))
        .digest("hex");
      if (seq < row.seq || (seq === row.seq && row.lastPayloadHash !== payloadHash))
        throw new WorkerError("conflict");
      if (seq === row.seq) return { session, seq, bindings: machineBindings(session.machineId) };
      for (const observation of observations) {
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
        if (!binding || binding.revision !== observation.revision || binding.directory === null)
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
        .set({ seq, capability, lastPayloadHash: payloadHash, lastSeenAt: ctx.now })
        .where(
          and(
            eq(machineConnection.machineId, session.machineId),
            eq(machineConnection.generation, session.generation),
          ),
        )
        .run();
      return { session, seq, bindings: machineBindings(session.machineId) };
    })
    .immediate();
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
    if (typeof raw === "object" && raw !== null && "version" in raw && raw.version !== 1)
      throw new WorkerError("unsupported_version");
    const ctx = await machineRuntimeContext();
    const data = operations[operation](raw, ctx);
    return Response.json({ version: 1, requestId, ok: true, data }, { headers });
  } catch (error) {
    const code =
      error instanceof WorkerError
        ? error.code
        : error instanceof z.ZodError
          ? "validation_failed"
          : "internal";
    return Response.json(
      {
        version: 1,
        requestId,
        ok: false,
        error: { code, message: code === "internal" ? "内部错误" : code },
      },
      { status: code === "internal" ? 500 : code === "unauthorized" ? 401 : 400, headers },
    );
  }
}
