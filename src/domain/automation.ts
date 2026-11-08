import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ID_PREFIXES, newId } from "../contracts/ids";
import {
  webhookRuleDraftSchema,
  webhookTrialInput,
  webhookUpdateInput,
  type WebhookRule,
  type WebhookRuleDraft,
  type WebhookTrigger,
} from "../contracts/automation";
import { db, sqlite } from "../db";
import { agentRun, agentRunInput, chat, message, webhookRule, webhookTrigger } from "../db/schema";
import { assertProjectAccess, ProjectAccessError, type ProjectContext } from "./access";
import { appendAutomationRunInput } from "./agent-run";
import { resolveWebhookTarget } from "./automation-target";
import { signalScheduleChange } from "./chat-schedule";
import { publishProjectChange } from "./change-feed";

export class AutomationError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "conflict" | "invalid_target" | "unauthorized",
    message: string,
  ) {
    super(message);
  }
}
type Rule = typeof webhookRule.$inferSelect;
type Trigger = typeof webhookTrigger.$inferSelect;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function humanProject(projectId: string, ctx: ProjectContext) {
  if (ctx.agent) throw new ProjectAccessError();
  return assertProjectAccess(ctx, projectId);
}
function ruleFor(id: string, ctx: ProjectContext): Rule {
  const row = db.select().from(webhookRule).where(eq(webhookRule.id, id)).get();
  if (!row) throw new AutomationError("not_found", "Webhook rule 不存在");
  humanProject(row.projectId, ctx);
  return row;
}
function view(row: Rule, baseUrl: string): WebhookRule {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    enabled: row.enabled,
    revision: row.revision,
    instruction: row.instruction,
    action: row.action,
    endpoint: new URL(`/api/webhooks/${row.id}`, baseUrl).href,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function receipt(row: Trigger): WebhookTrigger {
  const base = {
    id: row.id,
    ruleId: row.ruleId,
    mode: row.mode,
    eventId: row.eventId,
    createdAt: row.createdAt.toISOString(),
  };
  return row.decision === "accepted"
    ? { ...base, decision: "accepted", messageId: row.messageId! }
    : { ...base, decision: "skipped", reason: row.reason! };
}
function validateTarget(draft: WebhookRuleDraft, ctx: ProjectContext) {
  const result = resolveWebhookTarget(draft.projectId, draft.action, ctx);
  if ("reason" in result) throw new AutomationError("invalid_target", result.reason);
}
export function createWebhookRule(
  input: WebhookRuleDraft,
  ctx: ProjectContext,
  baseUrl: string,
): { rule: WebhookRule; secret: string } {
  const draft = webhookRuleDraftSchema.parse(input);
  const secret = randomBytes(32).toString("base64url");
  const row = sqlite
    .transaction(() => {
      humanProject(draft.projectId, ctx);
      validateTarget(draft, ctx);
      const now = new Date();
      return db
        .insert(webhookRule)
        .values({
          ...draft,
          id: newId(ID_PREFIXES.webhookRule),
          createdBy: ctx.userId,
          revision: 0,
          secretDigest: digest(secret),
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    })
    .immediate();
  return { rule: view(row, baseUrl), secret };
}
export function listWebhookRules(
  projectId: string,
  ctx: ProjectContext,
  baseUrl: string,
): WebhookRule[] {
  humanProject(projectId, ctx);
  return db
    .select()
    .from(webhookRule)
    .where(eq(webhookRule.projectId, projectId))
    .orderBy(desc(webhookRule.createdAt))
    .all()
    .map((row: Rule) => view(row, baseUrl));
}
export function updateWebhookRule(
  input: z.input<typeof webhookUpdateInput>,
  ctx: ProjectContext,
  baseUrl: string,
): WebhookRule {
  const { ruleId, expectedRevision, ...draft } = webhookUpdateInput.parse(input);
  return sqlite
    .transaction(() => {
      const previous = ruleFor(ruleId, ctx);
      if (previous.projectId !== draft.projectId || previous.revision !== expectedRevision)
        throw new AutomationError("conflict", "Webhook rule 已变化");
      if (draft.enabled) validateTarget(draft, ctx);
      const row = db
        .update(webhookRule)
        .set({ ...draft, revision: expectedRevision + 1, updatedAt: new Date() })
        .where(eq(webhookRule.id, ruleId))
        .returning()
        .get()!;
      return view(row, baseUrl);
    })
    .immediate();
}

// JSON.stringify's object order is not event identity. Normalize JSON only, rejecting lossy JS values.
export function canonicalWebhookPayload(payload: unknown): string {
  function normalize(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, normalize(item)]),
      );
    throw new AutomationError("conflict", "事件必须是 JSON");
  }
  const canonical = JSON.stringify(normalize(payload));
  if (Buffer.byteLength(canonical) > 128 * 1024) throw new AutomationError("conflict", "事件过大");
  return canonical;
}
export function assertWebhookCredential(ruleId: string, secret: string): void {
  const rule = db.select().from(webhookRule).where(eq(webhookRule.id, ruleId)).get();
  const supplied = Buffer.from(digest(secret));
  const expected = Buffer.from(rule?.secretDigest ?? digest("missing-webhook-rule"));
  if (!rule || !timingSafeEqual(supplied, expected))
    throw new AutomationError("unauthorized", "Webhook credentials 无效");
}

function admit(
  rule: Rule,
  mode: "live" | "trial",
  eventId: string,
  payload: unknown,
): WebhookTrigger {
  const canonical = canonicalWebhookPayload(payload);
  const fingerprint = digest(canonical);
  const prior = db
    .select()
    .from(webhookTrigger)
    .where(
      and(
        eq(webhookTrigger.ruleId, rule.id),
        eq(webhookTrigger.mode, mode),
        eq(webhookTrigger.eventId, eventId),
      ),
    )
    .get();
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw new AutomationError("conflict", "eventId 已用于不同事件");
    return receipt(prior);
  }
  const ctx: ProjectContext = { userId: rule.createdBy, requestId: newId(ID_PREFIXES.request) };
  const target = rule.enabled
    ? resolveWebhookTarget(rule.projectId, rule.action, ctx)
    : { reason: "rule_disabled" };
  const id = newId(ID_PREFIXES.webhookTrigger);
  const messageId = "reason" in target ? null : newId(ID_PREFIXES.message);
  const snapshot = {
    revision: rule.revision,
    instruction: rule.instruction,
    action: rule.action,
    enabled: rule.enabled,
    createdBy: rule.createdBy,
  };
  const now = new Date();
  // Both sides of the source/receipt FK are written in this immediate transaction.
  sqlite.pragma("defer_foreign_keys = ON");
  const row = db
    .insert(webhookTrigger)
    .values({
      id,
      ruleId: rule.id,
      projectId: rule.projectId,
      mode,
      eventId,
      fingerprint,
      snapshot,
      decision: "reason" in target ? "skipped" : "accepted",
      reason: "reason" in target ? target.reason : null,
      chatId: "reason" in target ? null : target.chatId,
      agentProfileId: "reason" in target ? null : target.agentProfileId,
      messageId,
      createdAt: now,
    })
    .returning()
    .get();
  if (!("reason" in target) && messageId) {
    db.insert(message)
      .values({
        id: messageId,
        chatId: target.chatId,
        senderKind: "automation",
        senderId: id,
        automationTriggerId: id,
        body: JSON.stringify({ instruction: rule.instruction, event: JSON.parse(canonical) }),
        createdAt: now,
      })
      .run();
    appendAutomationRunInput(messageId, target.agentProfileId, ctx);
    db.update(chat).set({ updatedAt: now }).where(eq(chat.id, target.chatId)).run();
  }
  return receipt(row);
}
function afterAdmission(result: WebhookTrigger, projectId: string) {
  if (result.decision === "accepted") {
    const saved = db.select().from(message).where(eq(message.id, result.messageId)).get()!;
    signalScheduleChange(saved.chatId);
    publishProjectChange(projectId, saved.chatId);
  }
}
export function receiveWebhook(
  ruleId: string,
  secret: string,
  eventId: string,
  payload: unknown,
): WebhookTrigger {
  z.string().min(1).max(200).parse(eventId);
  let projectId = "";
  const result = sqlite
    .transaction(() => {
      const rule = db.select().from(webhookRule).where(eq(webhookRule.id, ruleId)).get();
      if (!rule || !timingSafeEqual(Buffer.from(digest(secret)), Buffer.from(rule.secretDigest)))
        throw new AutomationError("unauthorized", "Webhook credentials 无效");
      projectId = rule.projectId;
      return admit(rule, "live", eventId, payload);
    })
    .immediate();
  afterAdmission(result, projectId);
  return result;
}
export function trialWebhook(
  input: z.input<typeof webhookTrialInput>,
  ctx: ProjectContext,
): WebhookTrigger {
  const data = webhookTrialInput.parse(input);
  let projectId = "";
  const result = sqlite
    .transaction(() => {
      const rule = ruleFor(data.ruleId, ctx);
      projectId = rule.projectId;
      return admit(rule, "trial", data.eventId, data.payload);
    })
    .immediate();
  afterAdmission(result, projectId);
  return result;
}
export function webhookHistory(
  ruleId: string,
  ctx: ProjectContext,
): (WebhookTrigger & { chatId: string | null; runId: string | null; runStatus: string | null })[] {
  ruleFor(ruleId, ctx);
  return db
    .select()
    .from(webhookTrigger)
    .where(eq(webhookTrigger.ruleId, ruleId))
    .orderBy(desc(webhookTrigger.createdAt))
    .limit(50)
    .all()
    .map((row: Trigger) => {
      const run = row.messageId
        ? db
            .select({ id: agentRunInput.runId })
            .from(agentRunInput)
            .where(eq(agentRunInput.messageId, row.messageId))
            .get()
        : undefined;
      const status = run
        ? db.select({ status: agentRun.status }).from(agentRun).where(eq(agentRun.id, run.id)).get()
        : undefined;
      return {
        ...receipt(row),
        chatId: row.chatId,
        runId: run?.id ?? null,
        runStatus: status?.status ?? null,
      };
    });
}
