import type { InheritedResources, MessageSkillSpan } from "../contracts/skill";
import type { AssistantInputContext } from "../contracts/assistant";
import type { ProjectContext } from "../domain/access";
import { isSkillName, skillToken } from "../lib/skill-token";
import type { SkillCatalog } from "./pi-host/skills";

const brand: unique symbol = Symbol("PreparedPiMessage");
const preparedMessages = new WeakSet<object>();
export type SkillWarning = Readonly<{
  messageId: string;
  name: string;
  reason: "inheritance_disabled" | "unknown_skill" | "session_skill_missing";
}>;
export type PreparedPiMessage = Readonly<{
  [brand]: true;
  messageId: string;
  text: string;
  warnings: readonly SkillWarning[];
  assistantContext?: AssistantInputContext;
}>;
export class MessageSkillError extends Error {
  constructor(
    readonly code: "message_skill_corrupt" | "skill_prompt_too_large" | "skill_catalog_unavailable",
  ) {
    super(code);
  }
}
const MAX_DELIVERY_BYTES = 256 * 1024;

function seal(
  messageId: string,
  text: string,
  warnings: readonly SkillWarning[],
  assistantContext?: AssistantInputContext,
): PreparedPiMessage {
  if (Buffer.byteLength(text, "utf8") > MAX_DELIVERY_BYTES)
    throw new MessageSkillError("skill_prompt_too_large");
  const prepared = Object.freeze({
    [brand]: true as const,
    messageId,
    text,
    warnings: Object.freeze([...warnings]),
    ...(assistantContext ? { assistantContext: Object.freeze(assistantContext) } : {}),
  });
  preparedMessages.add(prepared);
  return prepared;
}

export function assertPreparedPiMessage(value: PreparedPiMessage): void {
  if (!preparedMessages.has(value)) throw new Error("pi_message_not_prepared");
}

export function expandSkillSpans(
  messageId: string,
  body: string,
  spans: readonly MessageSkillSpan[],
  catalog: SkillCatalog | null,
  openedResources: InheritedResources,
): { text: string; warnings: readonly SkillWarning[] } {
  const warnings: SkillWarning[] = [];
  const pieces: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    const warn = (reason: SkillWarning["reason"]) =>
      warnings.push(Object.freeze({ messageId, name: span.name, reason }));
    if (
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      span.start < cursor ||
      span.end <= span.start ||
      span.end > body.length ||
      !isSkillName(span.name) ||
      body.slice(span.start, span.end) !== skillToken(span.name)
    ) {
      throw new MessageSkillError("message_skill_corrupt");
    }
    pieces.push(body.slice(cursor, span.start));
    const definition = catalog?.byName.get(span.name);
    let replacement = body.slice(span.start, span.end);
    if (openedResources.kind === "disabled" || catalog?.scope.enabled === false)
      warn("inheritance_disabled");
    else if (!catalog) throw new MessageSkillError("skill_catalog_unavailable");
    else if (!definition) warn("unknown_skill");
    else if (!openedResources.skillPaths.includes(definition.filePath))
      warn("session_skill_missing");
    else replacement = definition.block;
    pieces.push(replacement);
    cursor = span.end;
  }
  pieces.push(body.slice(cursor));
  return { text: pieces.join(""), warnings };
}

export async function preparePiMessage(
  input: Readonly<{ projectId: string; chatId: string; messageId: string }>,
  openedResources: InheritedResources,
  ctx: ProjectContext,
): Promise<PreparedPiMessage> {
  const { getChat } = await import("../domain/chat");
  const { db } = await import("../db");
  const { message, webhookTrigger } = await import("../db/schema");
  const { and, eq } = await import("drizzle-orm");
  const { readSkillsFor } = await import("../domain/message-skill");
  const {
    maskAttachmentTokens,
    readAttachmentsFor,
    readAttachmentSpansFor,
    unmaskAttachmentTokens,
    unreferencedAttachmentLines,
  } = await import("../domain/message-attachment");
  const chat = getChat(input.chatId, ctx);
  if (chat.projectId !== input.projectId) throw new Error("skill_message_scope_mismatch");
  const row = db
    .select()
    .from(message)
    .where(and(eq(message.id, input.messageId), eq(message.chatId, chat.id)))
    .get();
  if (!row) throw new Error("skill_message_not_found");
  if (row.senderKind === "automation") {
    const trigger = row.automationTriggerId
      ? db.select().from(webhookTrigger).where(eq(webhookTrigger.id, row.automationTriggerId)).get()
      : undefined;
    if (!trigger || trigger.messageId !== row.id) throw new Error("automation_message_corrupt");
    return seal(
      row.id,
      JSON.stringify({
        origin: trigger.source === "cron" ? "project_cron" : "project_webhook",
        ruleId: trigger.ruleId,
        triggerId: trigger.id,
        projectId: trigger.projectId,
        mode: trigger.mode,
        eventId: trigger.eventId,
        ruleRevision: trigger.snapshot.revision,
        recipientAgentProfileId: trigger.agentProfileId,
        content: JSON.parse(row.body),
      }),
      [],
    );
  }
  const spans = readSkillsFor(chat.id, [row.id]).get(row.id) ?? [];
  const attachmentSpans = readAttachmentSpansFor(chat.id, [row.id]).get(row.id) ?? [];
  const attachments = readAttachmentsFor(chat.id, [row.id]).get(row.id) ?? [];
  const attachmentById = new Map(attachments.map((item) => [item.id, item] as const));
  // 附件要送到 Agent 手里：等长哨兵先占住位置，展开技能后再换回带 id、路径与大小时的清单行。
  const masked = maskAttachmentTokens(row.body, attachmentSpans);
  const withAttachments = (text: string): string =>
    unmaskAttachmentTokens(text, attachmentSpans, attachmentById) +
    unreferencedAttachmentLines(attachments, attachmentSpans);
  if (!spans.length) return seal(row.id, withAttachments(masked), []);
  const { resolveSkillScope, readSkillCatalog } = await import("./pi-host/skills");
  const scope = resolveSkillScope(input.projectId, ctx);
  let catalog: SkillCatalog | null = null;
  if (scope.enabled && openedResources.kind === "enabled") {
    try {
      catalog = await readSkillCatalog(scope, "fresh");
    } catch {
      throw new MessageSkillError("skill_catalog_unavailable");
    }
  }
  const effectiveResources: InheritedResources = scope.enabled
    ? openedResources
    : { kind: "disabled" };
  const expanded = expandSkillSpans(row.id, masked, spans, catalog, effectiveResources);
  return seal(row.id, withAttachments(expanded.text), expanded.warnings);
}

export function prepareSyntheticPiMessage(
  input: Readonly<{
    kind: "task_start" | "continuation" | "resource_notice" | "assistant_work" | "assistant_human";
    messageId: string;
    text: string;
    assistantContext?: AssistantInputContext;
  }>,
): PreparedPiMessage {
  return seal(input.messageId, input.text, [], input.assistantContext);
}
