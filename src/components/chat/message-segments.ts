import type { MentionSpan } from "../../contracts/chat";
import type { MessageSkillSpan } from "../../contracts/skill";

export type MessageSegment = { text: string; span?: MentionSpan; skill?: MessageSkillSpan };

export function splitMessageSegments(
  body: string,
  mentions: readonly MentionSpan[],
  skills: readonly MessageSkillSpan[],
): MessageSegment[] {
  const ranges = [
    ...skills.map((skill) => ({ start: skill.start, end: skill.end, skill })),
    ...mentions.map((span) => ({ start: span.start, end: span.end, span })),
  ]
    .filter(
      (range) =>
        Number.isInteger(range.start) &&
        Number.isInteger(range.end) &&
        range.start >= 0 &&
        range.end > range.start &&
        range.end <= body.length,
    )
    .sort((a, b) => a.start - b.start);
  const result: MessageSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) result.push({ text: body.slice(cursor, range.start) });
    const { start, end, ...annotation } = range;
    result.push({ text: body.slice(start, end), ...annotation });
    cursor = end;
  }
  if (cursor < body.length) result.push({ text: body.slice(cursor) });
  return result;
}
