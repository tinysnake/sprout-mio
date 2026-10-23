import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  createMachineInput,
  getMachineInput,
  listMachinesInput,
  listProjectMachinesInput,
  renewMachineEnrollmentInput,
  saveProjectMachineBindingInput,
} from "../../contracts/machine";
import type { MachineResult } from "../../contracts/machine";
import { fail, ok, toAppError } from "../../contracts/result";
import { fieldErrorsFrom } from "../../contracts/project";
import { getRequestContext } from "../request-context";
import type { MachineContext } from "../../domain/machine";
import { toDomainAppError } from "./domain-errors";

type Domain = typeof import("../../domain/machine");
async function boundary<I, O>(
  raw: unknown,
  headers: Headers,
  requestId: string,
  schema: z.ZodType<I>,
  operation: (domain: Domain, input: I, ctx: MachineContext) => O,
): Promise<MachineResult<O>> {
  try {
    const [{ requireSession }, domain, { machineRuntimeContext }] = await Promise.all([
      import("../session"),
      import("../../domain/machine"),
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
      event: "machine.request_failed",
      requestId,
      message: "Machine 请求失败",
      data: { code: "internal" },
    });
    return fail({ code: "internal", message: "内部错误", requestId });
  }
}
export const createMachineBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, createMachineInput, (d, i, c) => d.createMachine(i, c));
export const renewMachineEnrollmentBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, renewMachineEnrollmentInput, (d, i, c) =>
    d.renewMachineEnrollment(i.machineId, c),
  );
export const listMachinesBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, listMachinesInput, (d, _i, c) => d.listMachines(c));
export const getMachineBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, getMachineInput, (d, i, c) => d.getMachine(i, c));
export const listProjectMachinesBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, listProjectMachinesInput, (d, i, c) =>
    d.listProjectMachines(i.projectId, c),
  );
export const saveProjectMachineBindingBoundary = (
  raw: unknown,
  headers: Headers,
  requestId: string,
) =>
  boundary(raw, headers, requestId, saveProjectMachineBindingInput, (d, i, c) =>
    d.saveProjectMachineBinding(i, c),
  );

export const createMachineFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    createMachineBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const renewMachineEnrollmentFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    renewMachineEnrollmentBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const listMachinesFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    listMachinesBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const getMachineFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getMachineBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const listProjectMachinesFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    listProjectMachinesBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const saveProjectMachineBindingFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    saveProjectMachineBindingBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
