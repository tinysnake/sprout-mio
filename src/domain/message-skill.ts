import { and, asc, eq, inArray } from "drizzle-orm";
import type { MessageSkillSpan } from "../contracts/skill";
import { db } from "../db";
import { messageSkill } from "../db/schema";
import { scanSkillTokens } from "../lib/skill-token";

export function resolveMessageSkills(body: string): readonly MessageSkillSpan[] {
  return scanSkillTokens(body);
}

export function writeMessageSkills(
  chatId: string,
  messageId: string,
  spans: readonly MessageSkillSpan[],
): void {
  if (spans.length)
    db.insert(messageSkill)
      .values(spans.map((span) => ({ chatId, messageId, ...span })))
      .run();
}

export function readSkillsFor(
  chatId: string,
  messageIds: readonly string[],
): ReadonlyMap<string, MessageSkillSpan[]> {
  const result = new Map<string, MessageSkillSpan[]>();
  if (!messageIds.length) return result;
  const rows = db
    .select()
    .from(messageSkill)
    .where(and(eq(messageSkill.chatId, chatId), inArray(messageSkill.messageId, [...messageIds])))
    .orderBy(asc(messageSkill.messageId), asc(messageSkill.start))
    .all();
  for (const { messageId, name, start, end } of rows) {
    const spans = result.get(messageId) ?? [];
    spans.push({ name, start, end });
    result.set(messageId, spans);
  }
  return result;
}
