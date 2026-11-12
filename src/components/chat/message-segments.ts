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

type Range = {
  start: number;
  end: number;
  span?: MentionSpan;
  skill?: MessageSkillSpan;
};

/** 技能排在点名前面：同起点时技能先占位，切片顺序与冻结 span 一致。 */
function rangesOf(
  body: string,
  mentions: readonly MentionSpan[],
  skills: readonly MessageSkillSpan[],
): Range[] {
  return [
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
}

/** 外悬量由原文与相邻标记决定，所以只能在原文上算，不能看占位后的字符串。 */
function skillEdgeOf(
  body: string,
  ranges: readonly Range[],
  range: Range,
  side: "start" | "end",
): SkillEdge {
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
}

function segmentOf(body: string, ranges: readonly Range[], range: Range): MessageSegment {
  const { start, end, ...annotation } = range;
  return "skill" in annotation
    ? {
        text: body.slice(start, end),
        ...annotation,
        skillEdge: {
          start: skillEdgeOf(body, ranges, range, "start"),
          end: skillEdgeOf(body, ranges, range, "end"),
        },
      }
    : { text: body.slice(start, end), ...annotation };
}

export function splitMessageSegments(
  body: string,
  mentions: readonly MentionSpan[],
  skills: readonly MessageSkillSpan[],
): MessageSegment[] {
  const ranges = rangesOf(body, mentions, skills);
  const result: MessageSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) result.push({ text: body.slice(cursor, range.start) });
    result.push(segmentOf(body, ranges, range));
    cursor = range.end;
  }
  if (cursor < body.length) result.push({ text: body.slice(cursor) });
  return result;
}

/**
 * 冻结 span 的哨兵占位。
 *
 * markdown 解析会重排、拆分并包裹文本，直接解析原文会让点名与技能 pill 的字符区间失效。
 * 所以先把这些区间换成哨兵串（私有区字符，markdown 当普通文本原样保留），解析完再由
 * MessageMarkdown 回填成既有组件——区间与文本一字不改，外悬量仍在原文上算。
 */
const SENTINEL_OPEN = "\uE000";
const SENTINEL_CLOSE = "\uE001";

export type MessageSentinel = { token: string; segment: MessageSegment };

/**
 * 占位符带一次性 nonce。正文里恰好出现同形的字面串时（例如正文自己写了两个私有区字符），
 * 没有 nonce 的写法会让回填先命中字面那处，把原文吞掉并插错芯片；带 nonce 后撞车需要同时猜中
 * nonce 与下标，正文自己不可能知道 nonce，所以字面串原样保留、真占位符照常回填。
 */
function sentinelNonce(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function maskMessageSegments(
  body: string,
  mentions: readonly MentionSpan[],
  skills: readonly MessageSkillSpan[],
): { text: string; sentinels: readonly MessageSentinel[] } {
  const ranges = rangesOf(body, mentions, skills);
  const nonce = sentinelNonce();
  const sentinels: MessageSentinel[] = [];
  let text = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    text += body.slice(cursor, range.start);
    const token = SENTINEL_OPEN + nonce + ":" + sentinels.length + SENTINEL_CLOSE;
    sentinels.push({ token, segment: segmentOf(body, ranges, range) });
    text += token;
    cursor = range.end;
  }
  text += body.slice(cursor);
  return { text, sentinels };
}
