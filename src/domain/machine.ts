import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../contracts/ids";
import type {
  CreateMachineInput,
  GetMachineInput,
  MachineDetail,
  MachineEnrollment,
  ProjectMachineIntent,
  MachineRootDirectory,
  SaveMachineRootDirectoryInput,
  SaveProjectMachineBindingInput,
} from "../contracts/machine";
import { WORKER_ENROLLMENT_TTL_MS, WORKER_STALE_AFTER_MS } from "../contracts/worker";
import { db, sqlite } from "../db";
import {
  diagnosticEvent,
  directoryObservation,
  machine,
  machineConnection,
  machineConnectionCounter,
  machineCredential,
  project,
  projectMachine,
  projectMachineMembership,
} from "../db/schema";
import { assertMembershipOperable, openInitialMembership } from "../server/membership";

export type MachineContext = { userId: string; requestId: string; bootId: string; now: Date };
export class MachineError extends Error {
  constructor(
    readonly code: "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "MachineError";
  }
}
export type MachineHooks = { beforeDiagnostic?: () => void };
export const hashCredential = (value: string) => createHash("sha256").update(value).digest("hex");
export function matchesCredential(value: string, hash: string | null) {
  return (
    hash !== null &&
    timingSafeEqual(Buffer.from(hashCredential(value), "hex"), Buffer.from(hash, "hex"))
  );
}
function owned(id: string, ctx: MachineContext) {
  const row = db
    .select()
    .from(machine)
    .where(and(eq(machine.id, id), eq(machine.createdBy, ctx.userId)))
    .get();
  if (!row) throw new MachineError("not_found", "Machine 不存在");
  return row;
}
function ownedProject(id: string, ctx: MachineContext) {
  if (
    !db
      .select({ id: project.id })
      .from(project)
      .where(and(eq(project.id, id), eq(project.createdBy, ctx.userId)))
      .get()
  )
    throw new MachineError("not_found", "Project 不存在");
}
function diagnostic(event: string, ctx: MachineContext, hooks: MachineHooks, projectId?: string) {
  hooks.beforeDiagnostic?.();
  db.insert(diagnosticEvent)
    .values({
      id: newId(ID_PREFIXES.diagnostic),
      at: ctx.now,
      level: "info",
      event,
      requestId: ctx.requestId,
      message: "Machine 已更新",
      ...(projectId ? { projectId } : {}),
    })
    .run();
}
export function toIntent(row: typeof projectMachine.$inferSelect): ProjectMachineIntent {
  return {
    projectId: row.projectId,
    machineId: row.machineId,
    description: row.description,
    revision: row.revision,
  };
}
export function machineBindings(machineId: string): ProjectMachineIntent[] {
  const memberships = db
    .select()
    .from(projectMachineMembership)
    .where(eq(projectMachineMembership.machineId, machineId))
    .orderBy(desc(projectMachineMembership.epoch))
    .all();
  const latest = new Map<string, typeof projectMachineMembership.$inferSelect>();
  for (const row of memberships) if (!latest.has(row.projectId)) latest.set(row.projectId, row);
  return db
    .select()
    .from(projectMachine)
    .where(eq(projectMachine.machineId, machineId))
    .all()
    .filter(
      (row: typeof projectMachine.$inferSelect) => latest.get(row.projectId)?.state === "active",
    )
    .map(toIntent);
}
export function getMachine(input: GetMachineInput, ctx: MachineContext): MachineDetail {
  return sqlite.transaction(() => {
    const row = owned(input.machineId, ctx);
    if (input.projectId) ownedProject(input.projectId, ctx);
    const credential = db
      .select()
      .from(machineCredential)
      .where(eq(machineCredential.machineId, row.id))
      .get();
    const connection = db
      .select()
      .from(machineConnection)
      .where(eq(machineConnection.machineId, row.id))
      .orderBy(desc(machineConnection.generation))
      .get();
    const capability = db
      .select()
      .from(machineConnection)
      .where(and(eq(machineConnection.machineId, row.id), isNotNull(machineConnection.capability)))
      .orderBy(desc(machineConnection.generation))
      .get();
    const counter = db
      .select()
      .from(machineConnectionCounter)
      .where(eq(machineConnectionCounter.machineId, row.id))
      .get();
    const current =
      connection?.bootId === ctx.bootId && connection?.generation === counter?.highWater;
    const reason = !connection
      ? "never_connected"
      : connection.bootId !== ctx.bootId
        ? "host_restarted"
        : !current
          ? "superseded"
          : connection.status === "closed"
            ? "closed"
            : "stale";
    const live =
      connection &&
      current &&
      connection.status === "open" &&
      ctx.now.getTime() - connection.lastSeenAt.getTime() < WORKER_STALE_AFTER_MS;
    const bindings = db
      .select()
      .from(projectMachine)
      .where(
        and(
          eq(projectMachine.machineId, row.id),
          eq(projectMachine.createdBy, ctx.userId),
          ...(input.projectId ? [eq(projectMachine.projectId, input.projectId)] : []),
        ),
      )
      .all()
      .map((binding: typeof projectMachine.$inferSelect) => {
        const fact = db
          .select()
          .from(directoryObservation)
          .where(
            and(
              eq(directoryObservation.machineId, row.id),
              eq(directoryObservation.projectId, binding.projectId),
            ),
          )
          .orderBy(desc(directoryObservation.generation), desc(directoryObservation.revision))
          .get();
        return {
          intent: toIntent(binding),
          observation: fact
            ? {
                current:
                  current &&
                  fact.generation === connection?.generation &&
                  fact.revision === row.rootRevision &&
                  row.rootDirectory !== null,
                fact: {
                  machineId: fact.machineId,
                  generation: fact.generation,
                  projectId: fact.projectId,
                  revision: fact.revision,
                  seq: fact.seq,
                  checkedAt: fact.checkedAt.toISOString(),
                  result:
                    fact.kind === "accessible"
                      ? { kind: "accessible" as const, realPath: fact.realPath! }
                      : { kind: "unavailable" as const, reason: fact.reason! },
                },
              }
            : null,
        };
      });
    return {
      machine: {
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
      enrollmentStatus: credential?.secretHash && credential.activatedAt ? "active" : "pending",
      connection: live
        ? {
            kind: connection.capability ? "online" : "connecting",
            generation: connection.generation,
            lastSeenAt: connection.lastSeenAt.toISOString(),
          }
        : {
            kind: "offline",
            generation: connection?.generation ?? null,
            lastSeenAt: connection?.lastSeenAt.toISOString() ?? null,
            reason,
          },
      capability: capability?.capability
        ? {
            generation: capability.generation,
            current: current && capability.generation === connection?.generation,
            snapshot: capability.capability,
          }
        : null,
      bindings,
    };
  })();
}
export function listMachines(ctx: MachineContext): MachineDetail[] {
  return sqlite.transaction(() =>
    db
      .select({ id: machine.id })
      .from(machine)
      .where(eq(machine.createdBy, ctx.userId))
      .all()
      .map((row: { id: string }) => getMachine({ machineId: row.id }, ctx)),
  )();
}
export function listProjectMachines(projectId: string, ctx: MachineContext): MachineDetail[] {
  return sqlite.transaction(() => {
    ownedProject(projectId, ctx);
    return db
      .select()
      .from(projectMachine)
      .where(and(eq(projectMachine.projectId, projectId), eq(projectMachine.createdBy, ctx.userId)))
      .all()
      .map((row: typeof projectMachine.$inferSelect) =>
        getMachine({ machineId: row.machineId, projectId }, ctx),
      );
  })();
}
function ticket(machineId: string, ctx: MachineContext): MachineEnrollment {
  const value = randomBytes(32).toString("base64url");
  const expires = new Date(ctx.now.getTime() + WORKER_ENROLLMENT_TTL_MS);
  db.update(machineCredential)
    .set({ ticketHash: hashCredential(value), ticketExpiresAt: expires })
    .where(eq(machineCredential.machineId, machineId))
    .run();
  return {
    detail: getMachine({ machineId }, ctx),
    ticket: value,
    expiresAt: expires.toISOString(),
  };
}
export function createMachine(
  input: CreateMachineInput,
  ctx: MachineContext,
  hooks: MachineHooks = {},
): MachineEnrollment {
  return sqlite
    .transaction(() => {
      const id = newId(ID_PREFIXES.machine);
      db.insert(machine)
        .values({
          id,
          name: input.name,
          createdBy: ctx.userId,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })
        .run();
      db.insert(machineCredential)
        .values({
          machineId: id,
          ticketHash: hashCredential(randomBytes(32).toString("base64url")),
          ticketExpiresAt: ctx.now,
        })
        .run();
      db.insert(machineConnectionCounter).values({ machineId: id, highWater: 0 }).run();
      const result = ticket(id, ctx);
      diagnostic("machine.created", ctx, hooks);
      return result;
    })
    .immediate();
}
export function renewMachineEnrollment(
  machineId: string,
  ctx: MachineContext,
  hooks: MachineHooks = {},
): MachineEnrollment {
  return sqlite
    .transaction(() => {
      owned(machineId, ctx);
      const credential = db
        .select()
        .from(machineCredential)
        .where(eq(machineCredential.machineId, machineId))
        .get();
      // 缺入网凭据的机器无法重新登记，直接说明原因，而不是让读取 undefined 崩成 internal。
      if (!credential) throw new MachineError("conflict", "Machine 缺少入网凭据，请删除后重新添加");
      if (credential.secretHash !== null) throw new MachineError("conflict", "Machine 已激活");
      const result = ticket(machineId, ctx);
      diagnostic("machine.enrollment_renewed", ctx, hooks);
      return result;
    })
    .immediate();
}
export function saveMachineRootDirectory(
  input: SaveMachineRootDirectoryInput,
  ctx: MachineContext,
  hooks: MachineHooks = {},
): MachineRootDirectory {
  return sqlite
    .transaction(() => {
      const row = owned(input.machineId, ctx);
      if (row.rootRevision !== input.expectedRevision)
        throw new MachineError("conflict", "根目录版本冲突");
      if (row.rootDirectory === input.directory)
        return { machineId: row.id, directory: row.rootDirectory, revision: row.rootRevision };
      if (row.rootRevision === Number.MAX_SAFE_INTEGER)
        throw new MachineError("conflict", "根目录版本冲突");
      const revision = row.rootRevision + 1;
      db.update(machine)
        .set({ rootDirectory: input.directory, rootRevision: revision, updatedAt: ctx.now })
        .where(eq(machine.id, row.id))
        .run();
      diagnostic("machine.root_saved", ctx, hooks);
      return { machineId: row.id, directory: input.directory, revision };
    })
    .immediate();
}
export function saveProjectMachineBinding(
  input: SaveProjectMachineBindingInput,
  ctx: MachineContext,
  hooks: MachineHooks = {},
): ProjectMachineIntent {
  return sqlite
    .transaction(() => {
      owned(input.machineId, ctx);
      ownedProject(input.projectId, ctx);
      const where = and(
        eq(projectMachine.machineId, input.machineId),
        eq(projectMachine.projectId, input.projectId),
      );
      const old = db.select().from(projectMachine).where(where).get();
      if (old) assertMembershipOperable(input.projectId, input.machineId);
      if (old && old.description === input.description) return toIntent(old);
      if (
        (old?.revision ?? null) !== input.expectedRevision ||
        old?.revision === Number.MAX_SAFE_INTEGER
      )
        throw new MachineError("conflict", "绑定版本冲突");
      const revision = old ? old.revision + 1 : 1;
      const values = {
        machineId: input.machineId,
        projectId: input.projectId,
        createdBy: ctx.userId,
        description: input.description,
        revision,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      if (old)
        db.update(projectMachine)
          .set({
            description: input.description,
            revision,
            updatedAt: ctx.now,
          })
          .where(where)
          .run();
      else {
        db.insert(projectMachine).values(values).run();
        openInitialMembership(db, { ...input, now: ctx.now });
      }
      diagnostic("machine.binding_saved", ctx, hooks, input.projectId);
      return toIntent(values);
    })
    .immediate();
}
