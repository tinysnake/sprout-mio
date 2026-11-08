import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { fail, ok, toAppError } from "../../contracts/result";
import type { ProjectContext } from "../../domain/access";
import { getRequestContext } from "../request-context";

async function call<T>(operation: (ctx: ProjectContext, baseUrl: string) => T | Promise<T>) {
  const requestId = getRequestContext().requestId;
  try {
    const [{ requireSession }, { config }] = await Promise.all([
      import("../session"),
      import("../../lib/config"),
    ]);
    const session = await requireSession(getRequestHeaders(), requestId);
    if (!session.ok) return session;
    return ok(
      await operation({ userId: session.data.userId, requestId }, config.APP_ORIGIN),
      requestId,
    );
  } catch (error) {
    return fail(toAppError(error, requestId));
  }
}
const projectInput = z.object({ projectId: z.string() });
export const listWebhookRulesFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => projectInput.parse(x))
  .handler(({ data }) =>
    call(async (ctx, origin) =>
      (await import("../../domain/automation")).listWebhookRules(data.projectId, ctx, origin),
    ),
  );
export const createWebhookRuleFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => x)
  .handler(({ data }) =>
    call(async (ctx, origin) =>
      (await import("../../domain/automation")).createWebhookRule(data as never, ctx, origin),
    ),
  );
export const updateWebhookRuleFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => x)
  .handler(({ data }) =>
    call(async (ctx, origin) =>
      (await import("../../domain/automation")).updateWebhookRule(data as never, ctx, origin),
    ),
  );
export const webhookHistoryFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => x)
  .handler(({ data }) =>
    call(async (ctx) =>
      (await import("../../domain/automation")).webhookHistory(
        (data as { ruleId: string }).ruleId,
        ctx,
      ),
    ),
  );
export const trialWebhookFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => x)
  .handler(({ data }) =>
    call(async (ctx) => (await import("../../domain/automation")).trialWebhook(data as never, ctx)),
  );
