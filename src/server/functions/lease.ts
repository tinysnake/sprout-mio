import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "../../contracts/ids";
import {
  leaseKeySchema,
  leaseMutationInputSchema,
  leaseReadInputSchema,
} from "../../contracts/lease";
import { fail, ok, toAppError } from "../../contracts/result";
import type { AppResult } from "../../contracts/result";
import type { MachineContext } from "../../domain/machine";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

type Domain = typeof import("../lease");
const projectInput = leaseKeySchema.pick({ projectId: true });
const reclaimInput = leaseMutationInputSchema.options[3];
const requestInput = leaseKeySchema.extend({
  requestId: z.string().regex(appIdPattern(ID_PREFIXES.request)),
  chatId: z.string().regex(appIdPattern(ID_PREFIXES.chat)),
});
async function boundary<I, O>(
  raw: unknown,
  headers: Headers,
  requestId: string,
  schema: z.ZodType<I>,
  operation: (domain: Domain, input: I, ctx: MachineContext) => O | Promise<O>,
): Promise<AppResult<O>> {
  try {
    const [{ requireSession }, domain, { machineRuntimeContext }] = await Promise.all([
      import("../session"),
      import("../lease"),
      import("../runtime"),
    ]);
    const session = await requireSession(headers, requestId);
    if (!session.ok) return session;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return fail(toAppError(parsed.error, requestId));
    return ok(
      await operation(domain, parsed.data, {
        userId: session.data.userId,
        requestId,
        ...(await machineRuntimeContext()),
      }),
      requestId,
    );
  } catch (error) {
    return fail(
      (await toDomainAppError(error, requestId)) ?? {
        code: "internal",
        message: "内部错误",
        requestId,
      },
    );
  }
}
export const getLeaseBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, leaseReadInputSchema, (d, i, c) => d.getLease(i, c));
export const listProjectLeasesBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, projectInput, (d, i, c) => d.listProjectLeases(i, c));
export const reclaimLeaseBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, reclaimInput, (d, i, c) => d.reclaimLease(i, c));
export async function getLeaseRequestBoundary(raw: unknown, headers: Headers, requestId: string) {
  return boundary(raw, headers, requestId, requestInput, async (d, input, context) => {
    d.getLease({ projectId: input.projectId, machineId: input.machineId }, context);
    const [{ db }, { leaseMutation, agentInstance }, { and, eq }] = await Promise.all([
      import("../../db"),
      import("../../db/schema"),
      import("drizzle-orm"),
    ]);
    const row = db
      .select({ id: leaseMutation.id })
      .from(leaseMutation)
      .innerJoin(agentInstance, eq(agentInstance.id, leaseMutation.actorId))
      .where(
        and(
          eq(leaseMutation.projectId, input.projectId),
          eq(leaseMutation.machineId, input.machineId),
          eq(leaseMutation.requestId, input.requestId),
          eq(leaseMutation.actorKind, "agent"),
          eq(agentInstance.chatId, input.chatId),
          eq(agentInstance.projectId, input.projectId),
        ),
      )
      .get();
    return d.getLease(
      {
        projectId: input.projectId,
        machineId: input.machineId,
        ...(row ? { mutationId: row.id } : {}),
      },
      context,
    );
  });
}
export const getLeaseRequestFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getLeaseRequestBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const getLeaseFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getLeaseBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const listProjectLeasesFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    listProjectLeasesBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const reclaimLeaseFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    reclaimLeaseBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
