import type { InheritedResources, MessageSkillSpan } from "../contracts/skill";
import type { ProjectContext } from "../domain/access";
import { isSkillName } from "../lib/skill-token";
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
): PreparedPiMessage {
  if (Buffer.byteLength(text, "utf8") > MAX_DELIVERY_BYTES)
    throw new MessageSkillError("skill_prompt_too_large");
  const prepared = Object.freeze({
    [brand]: true as const,
    messageId,
    text,
    warnings: Object.freeze([...warnings]),
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
      body.slice(span.start, span.end) !== `【技能:${span.name}】`
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
  const { message } = await import("../db/schema");
  const { and, eq } = await import("drizzle-orm");
  const { readSkillsFor } = await import("../domain/message-skill");
  const chat = getChat(input.chatId, ctx);
  if (chat.projectId !== input.projectId) throw new Error("skill_message_scope_mismatch");
  const row = db
    .select()
    .from(message)
    .where(and(eq(message.id, input.messageId), eq(message.chatId, chat.id)))
    .get();
  if (!row) throw new Error("skill_message_not_found");
  const spans = readSkillsFor(chat.id, [row.id]).get(row.id) ?? [];
  if (!spans.length) return seal(row.id, row.body, []);
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
  const expanded = expandSkillSpans(row.id, row.body, spans, catalog, effectiveResources);
  return seal(row.id, expanded.text, expanded.warnings);
}

export function prepareSyntheticPiMessage(
  input: Readonly<{
    kind: "task_start" | "continuation" | "resource_notice";
    messageId: string;
    text: string;
  }>,
): PreparedPiMessage {
  return seal(input.messageId, input.text, []);
}
