import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { leaseKeySchema } from "../../contracts/lease";
import { executionReadInputSchema } from "../../contracts/remote";
import { fail, ok, toAppError } from "../../contracts/result";
import type { AppResult } from "../../contracts/result";
import type { MachineContext } from "../../domain/machine";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

type Domain = typeof import("../remote");
const listInput = leaseKeySchema
  .partial({ machineId: true })
  .extend({ limit: z.number().int().min(1).max(100).optional() });
async function boundary<I, O>(
  raw: unknown,
  headers: Headers,
  requestId: string,
  schema: z.ZodType<I>,
  operation: (domain: Domain, input: I, ctx: MachineContext) => O,
): Promise<AppResult<O>> {
  try {
    const [{ requireSession }, domain, { machineRuntimeContext }] = await Promise.all([
      import("../session"),
      import("../remote"),
      import("../runtime"),
    ]);
    const session = await requireSession(headers, requestId);
    if (!session.ok) return session;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return fail(toAppError(parsed.error, requestId));
    return ok(
      operation(domain, parsed.data, {
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
export const getExecutionBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, executionReadInputSchema, (d, i, c) => d.getExecution(i, c));
export const listProjectExecutionsBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, listInput, (d, i, c) => d.listProjectExecutions(i, c));
export const getExecutionFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getExecutionBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const listProjectExecutionsFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    listProjectExecutionsBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
