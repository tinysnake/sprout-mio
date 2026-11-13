/*
 * 移植自 T3 Code（https://github.com/pingdotgg/t3code），MIT License，
 * Copyright (c) 2026 T3 Tools Inc.。
 *
 * 取代 T3 的 `splitPromptIntoComposerSegments`（`~/composer-editor-mentions`）：只保留正文里
 * 真正会出现的三种原子 token —— 点名 `@<name>`、技能标记 `📖<name>` 与附件引用 `[[att:<localId>]]`。
 * 点名要按成员名单认，否则正文里普通的 `@` 会被误当成 tag。
 */
import { scanAttachmentTokens } from "../../../contracts/attachment";
import { scanSkillTokens } from "../../../lib/skill-token";

export type MentionCandidate = { memberId: string; name: string };

export type ComposerPromptSegment =
  | { type: "text"; text: string }
  | { type: "mention"; memberId: string; name: string; source: string }
  | { type: "skill"; name: string; source: string }
  | { type: "attachment"; localId: string; source: string };

type SegmentHit =
  | { type: "mention"; memberId: string; name: string; start: number; end: number }
  | { type: "skill"; name: string; start: number; end: number }
  | { type: "attachment"; localId: string; start: number; end: number };

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

/** `@` 必须在开头或空白之后，成员名之间不重叠：长名字优先，避免 `@ann` 抢走 `@ann lee`。 */
export function scanMentionTokens(
  prompt: string,
  mentions: readonly MentionCandidate[],
): { memberId: string; name: string; start: number; end: number }[] {
  if (mentions.length === 0 || !prompt.includes("@")) return [];
  const names = [...new Set(mentions.map((mention) => mention.name))]
    .filter((name) => name.length > 0 && !/\s/.test(name))
    .sort((left, right) => right.length - left.length);
  if (names.length === 0) return [];
  const idsByName = new Map<string, string>();
  for (const mention of mentions) {
    if (!idsByName.has(mention.name)) idsByName.set(mention.name, mention.memberId);
  }
  const hits: { memberId: string; name: string; start: number; end: number }[] = [];
  let index = prompt.indexOf("@");
  while (index >= 0) {
    const before = prompt[index - 1];
    if (before === undefined || /\s/.test(before)) {
      const rest = prompt.slice(index + 1);
      const name = names.find((candidate) => rest.startsWith(candidate));
      if (name) {
        hits.push({
          memberId: idsByName.get(name) ?? "",
          name,
          start: index,
          end: index + 1 + name.length,
        });
        index = prompt.indexOf("@", index + 1 + name.length);
        continue;
      }
    }
    index = prompt.indexOf("@", index + 1);
  }
  return hits;
}

/** 三类 token 语法互不包含；重叠时先出现的胜出（与 T3 一样，`match.start < cursor` 跳过）。 */
export function splitComposerPromptSegments(
  prompt: string,
  mentions: readonly MentionCandidate[] = [],
): ComposerPromptSegment[] {
  const hits: SegmentHit[] = [
    ...scanMentionTokens(prompt, mentions).map((hit) => ({
      type: "mention" as const,
      memberId: hit.memberId,
      name: hit.name,
      start: hit.start,
      end: hit.end,
    })),
    ...scanSkillTokens(prompt).map((hit) => ({
      type: "skill" as const,
      name: hit.name,
      start: hit.start,
      end: hit.end,
    })),
    ...scanAttachmentTokens(prompt).map((hit) => ({
      type: "attachment" as const,
      localId: hit.localId,
      start: hit.start,
      end: hit.end,
    })),
  ].sort((left, right) => left.start - right.start);

  const segments: ComposerPromptSegment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) pushTextSegment(segments, prompt.slice(cursor, hit.start));
    const source = prompt.slice(hit.start, hit.end);
    if (hit.type === "mention") {
      segments.push({ type: "mention", memberId: hit.memberId, name: hit.name, source });
    } else if (hit.type === "skill") {
      segments.push({ type: "skill", name: hit.name, source });
    } else {
      segments.push({ type: "attachment", localId: hit.localId, source });
    }
    cursor = hit.end;
  }
  if (cursor < prompt.length) pushTextSegment(segments, prompt.slice(cursor));
  return segments;
}
