import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { leaseKeySchema } from "../../contracts/lease";
import {
  detachMachineInputSchema,
  rejoinProjectMachineInputSchema,
} from "../../contracts/membership";
import type { MembershipView } from "../../contracts/membership";
import { fieldErrorsFrom, type ProjectResult } from "../../contracts/project";
import { fail, ok, toAppError } from "../../contracts/result";
import type { MachineContext } from "../../domain/machine";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

type Domain = typeof import("../membership");
async function boundary<I, O>(
  raw: unknown,
  headers: Headers,
  requestId: string,
  schema: z.ZodType<I>,
  operation: (domain: Domain, input: I, ctx: MachineContext) => O,
): Promise<ProjectResult<O>> {
  try {
    const [{ requireSession }, domain, { machineRuntimeContext }] = await Promise.all([
      import("../session"),
      import("../membership"),
      import("../runtime"),
    ]);
    const session = await requireSession(headers, requestId);
    if (!session.ok) return session;
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      return {
        ...fail(toAppError(parsed.error, requestId)),
        fieldErrors: fieldErrorsFrom(parsed.error),
      };
    const runtime = await machineRuntimeContext();
    return ok(
      operation(domain, parsed.data, { userId: session.data.userId, requestId, ...runtime }),
      requestId,
    );
  } catch (error) {
    const mapped = await toDomainAppError(error, requestId);
    if (mapped) return fail(mapped);
    const { recordDiagnostic } = await import("../diagnostics");
    recordDiagnostic({
      level: "error",
      event: "membership.request_failed",
      requestId,
      message: "Machine 关系请求失败",
      data: { code: "internal" },
    });
    return fail({ code: "internal", message: "内部错误", requestId });
  }
}

export const detachMachineBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, detachMachineInputSchema, (domain, input, ctx) =>
    domain.detachMachine(input, ctx),
  );

export const rejoinProjectMachineBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, rejoinProjectMachineInputSchema, (domain, input, ctx) =>
    domain.rejoinProjectMachine(input, ctx),
  );

/** 读入口：Human 才带 `canForceReclaim`，服务端仍会用 fencing receipt 再核一次。 */
export const membershipViewBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, leaseKeySchema, (domain, input, ctx) =>
    domain.membershipViewFor(input, ctx.now, { canForceReclaim: true }),
  );

export const detachMachineFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    detachMachineBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const rejoinProjectMachineFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    rejoinProjectMachineBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const membershipViewFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    membershipViewBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export type MembershipBoundaryView = MembershipView | null;
