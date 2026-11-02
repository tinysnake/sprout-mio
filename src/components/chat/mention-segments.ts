import type { MentionSpan } from "../../contracts/chat";

/**
 * 正文的一段：带 `span` 的是点名，`text` 就是该 span 覆盖的原文；不带的是普通文本。
 *
 * 点名片的文字只取 `body.slice(start, end)`，不从成员表反查当前名：
 * 成员改名之后，历史消息要继续显示当时写下的那个名字。
 */
export type MentionSegment = { text: string; span?: MentionSpan };

/**
 * 把正文切成「纯文本 / 点名」交替的片段，供气泡逐段渲染。纯函数：只读 body 与 spans。
 *
 * 契约给的 span 已经升序、互不重叠、落在 body 内；这里仍按边界情况收口，因为
 * 读模型和渲染可能先后到位：
 * - 空正文没有片段，渲染端不补占位；
 * - 越界、空区间、非整数下标的 span 忽略，那段文字照旧当普通文本；
 * - 与已切出的片段重叠的 span 忽略，先出现的优先；
 * - 相邻 span 之间不产生空文本片段，首尾也不补空串；
 * - 每段都是 body 的原文切片，按顺序拼回去严格等于 body。
 */
export function splitMentions(body: string, mentions: readonly MentionSpan[]): MentionSegment[] {
  if (body.length === 0) return [];
  const ordered = mentions
    .filter((span) => insideBody(body, span))
    .sort((a, b) => a.start - b.start);

  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue;
    if (span.start > cursor) segments.push({ text: body.slice(cursor, span.start) });
    segments.push({ text: body.slice(span.start, span.end), span });
    cursor = span.end;
  }
  if (cursor < body.length) segments.push({ text: body.slice(cursor) });
  return segments;
}

function insideBody(body: string, span: MentionSpan): boolean {
  return (
    Number.isInteger(span.start) &&
    Number.isInteger(span.end) &&
    span.start >= 0 &&
    span.end > span.start &&
    span.end <= body.length
  );
}
