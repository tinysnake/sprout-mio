import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import {
  listCrewDelegationsInput,
  cancelDelegationInput,
  dispatchDelegationInput,
  retryDelegationInput,
} from "../../contracts/delegation";
import type {
  DelegationView,
  DispatchDelegationResult,
  CrewDelegationRail,
} from "../../contracts/delegation";
import { ok, fail, type AppResult } from "../../contracts/result";
import type { RunActivity } from "../../contracts/agent-run";
import type { ProjectContext } from "../../domain/access";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

async function deps() {
  const [auth, delegation, rail, runActivity] = await Promise.all([
    import("../session"),
    import("../../domain/delegation"),
    import("../../domain/crew-delegation-rail"),
    import("../pi-host/run-activity"),
  ]);
  return {
    requireSession: auth.requireSession,
    ...delegation,
    ...rail,
    readRunActivity: runActivity.readRunActivity,
  };
}

function enrichLiveActivity(
  rail: CrewDelegationRail,
  readRunActivity: (runId: string) => RunActivity | undefined,
): CrewDelegationRail {
  const active = rail.active.map((card) => {
    if (card.status !== "running" || !card.runId) return card;
    const step = readRunActivity(card.runId)?.current;
    if (!step) return card;
    return {
      ...card,
      activity: { label: step.label, detail: step.detail ?? null, status: step.status },
    };
  });
  return { ...rail, active };
}

async function boundary<T>(
  headers: Headers,
  requestId: string,
  operation: (d: Awaited<ReturnType<typeof deps>>, ctx: ProjectContext) => AppResult<T>,
): Promise<AppResult<T>> {
  try {
    const d = await deps();
    const auth = await d.requireSession(headers, requestId);
    if (!auth.ok) return auth;
    return operation(d, { userId: auth.data.userId, requestId });
  } catch (error) {
    const mapped = await toDomainAppError(error, requestId);
    if (mapped) return fail(mapped);
    console.error("[delegation] 请求失败", { requestId, error });
    return fail({ code: "internal", message: "内部错误", requestId });
  }
}

export const dispatchDelegationFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) => {
    const requestId = getRequestContext().requestId;
    return boundary<DispatchDelegationResult>(getRequestHeaders(), requestId, (d, ctx) => {
      const parsed = dispatchDelegationInput.safeParse(data);
      if (!parsed.success)
        return fail({ code: "validation_failed", message: "委派参数无效", requestId });
      return ok(d.dispatchDelegation(parsed.data, ctx), requestId);
    });
  });

export const cancelDelegationFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) => {
    const requestId = getRequestContext().requestId;
    return boundary<null>(getRequestHeaders(), requestId, (d, ctx) => {
      const parsed = cancelDelegationInput.safeParse(data);
      if (!parsed.success)
        return fail({ code: "validation_failed", message: "取消参数无效", requestId });
      d.cancelDelegation(parsed.data, ctx);
      return ok(null, requestId);
    });
  });

export const retryDelegationFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) => {
    const requestId = getRequestContext().requestId;
    return boundary<DispatchDelegationResult>(getRequestHeaders(), requestId, (d, ctx) => {
      const parsed = retryDelegationInput.safeParse(data);
      if (!parsed.success)
        return fail({ code: "validation_failed", message: "重试参数无效", requestId });
      return ok(d.retryDelegation(parsed.data, ctx), requestId);
    });
  });

export const listCrewDelegationsFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) => {
    const requestId = getRequestContext().requestId;
    return boundary<CrewDelegationRail>(getRequestHeaders(), requestId, (d, ctx) => {
      const parsed = listCrewDelegationsInput.safeParse(data);
      if (!parsed.success)
        return fail({ code: "validation_failed", message: "Chat 参数无效", requestId });
      const rail = d.listCrewDelegationRail(parsed.data, ctx);
      return ok(enrichLiveActivity(rail, d.readRunActivity), requestId);
    });
  });

export type { DelegationView };
