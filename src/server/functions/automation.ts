import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  cronRuleDraftSchema,
  cronTrialInput,
  cronUpdateInput,
  webhookRuleDraftSchema,
  automationRuleIdInput,
  webhookTrialInput,
  webhookUpdateInput,
} from "../../contracts/automation";
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
export const webhookSecretFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => automationRuleIdInput.parse(x))
  .handler(({ data }) =>
    call(async (ctx) => (await import("../../domain/automation")).webhookSecret(data.ruleId, ctx)),
  );
export const rotateWebhookSecretFn = createServerFn({ method: "POST" })
  .validator((x: unknown) =>
    z
      .strictObject({
        ruleId: automationRuleIdInput.shape.ruleId,
        expectedRevision: z.number().int().nonnegative(),
      })
      .parse(x),
  )
  .handler(({ data }) =>
    call(async (ctx, origin) =>
      (await import("../../domain/automation")).rotateWebhookSecret(data, ctx, origin),
    ),
  );

const projectInput = z.object({ projectId: z.string() });
export const listCronRulesFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => x)
  .handler(({ data }) =>
    call(async (ctx) =>
      (await import("../../domain/automation")).listCronRules(
        projectInput.parse(data).projectId,
        ctx,
      ),
    ),
  );
export const createCronRuleFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => x)
  .handler(({ data }) =>
    call(async (ctx) =>
      (await import("../../domain/automation")).createCronRule(
        cronRuleDraftSchema.parse(data),
        ctx,
      ),
    ),
  );
export const updateCronRuleFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => x)
  .handler(({ data }) =>
    call(async (ctx) =>
      (await import("../../domain/automation")).updateCronRule(cronUpdateInput.parse(data), ctx),
    ),
  );
export const cronHistoryFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => x)
  .handler(({ data }) =>
    call(async (ctx) =>
      (await import("../../domain/automation")).cronHistory(
        automationRuleIdInput.parse(data).ruleId,
        ctx,
      ),
    ),
  );
export const trialCronFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => x)
  .handler(({ data }) =>
    call(async (ctx) =>
      (await import("../../domain/automation")).trialCron(cronTrialInput.parse(data), ctx),
    ),
  );
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
      (await import("../../domain/automation")).createWebhookRule(
        webhookRuleDraftSchema.parse(data),
        ctx,
        origin,
      ),
    ),
  );
export const updateWebhookRuleFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => x)
  .handler(({ data }) =>
    call(async (ctx, origin) =>
      (await import("../../domain/automation")).updateWebhookRule(
        webhookUpdateInput.parse(data),
        ctx,
        origin,
      ),
    ),
  );
export const webhookHistoryFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => x)
  .handler(({ data }) =>
    call(async (ctx) =>
      (await import("../../domain/automation")).webhookHistory(
        automationRuleIdInput.parse(data).ruleId,
        ctx,
      ),
    ),
  );
export const trialWebhookFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => x)
  .handler(({ data }) =>
    call(async (ctx) =>
      (await import("../../domain/automation")).trialWebhook(webhookTrialInput.parse(data), ctx),
    ),
  );
