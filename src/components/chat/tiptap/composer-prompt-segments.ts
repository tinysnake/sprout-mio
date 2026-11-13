/*
 * 移植自 T3 Code（https://github.com/pingdotgg/t3code），MIT License，
 * Copyright (c) 2026 T3 Tools Inc.。
 *
 * 取代 T3 的 `splitPromptIntoComposerSegments`（`~/composer-editor-mentions`）：只保留正文里
 * 真正会出现的两种原子 token —— 附件引用 `[[att:<localId>]]` 与技能标记 `📖<name>`。
 */
import { scanAttachmentTokens } from "../../../contracts/attachment";
import { scanSkillTokens } from "../../../lib/skill-token";

export type ComposerPromptSegment =
  | { type: "text"; text: string }
  | { type: "skill"; name: string; source: string }
  | { type: "attachment"; localId: string; source: string };

type SegmentHit =
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

/** 两类 token 语法互不包含；重叠时先出现的胜出（与 T3 一样，`match.start < cursor` 跳过）。 */
export function splitComposerPromptSegments(prompt: string): ComposerPromptSegment[] {
  const hits: SegmentHit[] = [
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
    if (hit.type === "skill") {
      segments.push({ type: "skill", name: hit.name, source });
    } else {
      segments.push({ type: "attachment", localId: hit.localId, source });
    }
    cursor = hit.end;
  }
  if (cursor < prompt.length) pushTextSegment(segments, prompt.slice(cursor));
  return segments;
}
