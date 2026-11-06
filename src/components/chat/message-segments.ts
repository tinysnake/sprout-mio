import type { MentionSpan } from "../../contracts/chat";
import type { MessageSkillSpan } from "../../contracts/skill";

/**
 * 标记在一侧能外悬多少。外悬等于水平留白，但留白只买得到相邻的空隙：贴着字形时无处可悬，
 * 与另一个标记共用空隙时也要分给对方一半。
 */
export type SkillEdge = "full" | "half" | "flush";

export type MessageSegment = {
  text: string;
  span?: MentionSpan;
  skill?: MessageSkillSpan;
  skillEdge?: { start: SkillEdge; end: SkillEdge };
};

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
  const edge = (range: (typeof ranges)[number], side: "start" | "end"): SkillEdge => {
    const step = side === "start" ? -1 : 1;
    const index = side === "start" ? range.start - 1 : range.end;
    const neighbour = body[index];
    if (neighbour === undefined) return "full";
    if (neighbour !== " ") return /\s/u.test(neighbour) ? "full" : "flush";
    let far = index + step;
    while (body[far] === " ") far += step;
    const spacing = Math.abs(far - index);
    const beyond = body[far];
    if (beyond === undefined || /\s/u.test(beyond)) return "full";
    const touching = ranges.some((other) => {
      if (other === range) return false;
      return step === 1 ? other.start === far : other.end === far + 1;
    });
    if (!touching) return "full";
    return spacing >= 2 ? "half" : "flush";
  };
  const result: MessageSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) result.push({ text: body.slice(cursor, range.start) });
    const { start, end, ...annotation } = range;
    result.push(
      "skill" in annotation
        ? {
            text: body.slice(start, end),
            ...annotation,
            skillEdge: { start: edge(range, "start"), end: edge(range, "end") },
          }
        : { text: body.slice(start, end), ...annotation },
    );
    cursor = end;
  }
  if (cursor < body.length) result.push({ text: body.slice(cursor) });
  return result;
}
