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
  operation: (domain: Domain, input: I, ctx: MachineContext) => O | Promise<O>,
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
      await operation(domain, parsed.data, {
        userId: session.data.userId,
        requestId,
        ...runtime,
      }),
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

// ---------------------------------------------------------------------------
// 关系列表与只读历史：只组装 `MembershipView` / `PendingFactView` 与既有收据行，
// 不新增业务事实，也不把 epoch / generation 的授权判断搬到客户端。
// 实际读取放在 server-only 模块里动态加载，避免客户端入口引入数据库模块。
// ---------------------------------------------------------------------------

export type {
  MachineRelationView,
  MembershipHistoryView,
  MembershipReceiptView,
} from "../membership-relations";

const projectRelationInput = z.strictObject({ projectId: z.string().min(1) });
const machineRelationInput = z.strictObject({ machineId: z.string().min(1) });

export const projectMachineRelationsBoundary = (
  raw: unknown,
  headers: Headers,
  requestId: string,
) =>
  boundary(raw, headers, requestId, projectRelationInput, async (_domain, input, ctx) => {
    const relations = await import("../membership-relations");
    return relations.projectMachineRelations(input.projectId, ctx);
  });

export const machineRelationsBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, machineRelationInput, async (_domain, input, ctx) => {
    const relations = await import("../membership-relations");
    return relations.machineRelations(input.machineId, ctx);
  });

export const membershipHistoryBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, leaseKeySchema, async (_domain, input, ctx) => {
    const relations = await import("../membership-relations");
    return relations.membershipHistory(input, ctx);
  });

export const projectMachineRelationsFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    projectMachineRelationsBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const machineRelationsFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    machineRelationsBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const membershipHistoryFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    membershipHistoryBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
