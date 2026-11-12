import { attachmentToken, scanAttachmentTokens } from "../../contracts/attachment";
import { scanSkillTokens } from "../../lib/skill-token";
import { splitMessageSegments } from "./message-segments";
import type { MessageSegment } from "./message-segments";

/**
 * 输入区镜像层的装饰分类。textarea 仍是唯一真相，这里只把草稿切成"哪一段长什么样"，
 * 供镜像层逐段渲染；分类换的是样式，`text` 始终是原文。
 */
export type ComposerTone =
  | "plain"
  | "strong"
  | "emphasis"
  | "code"
  | "heading"
  | "marker"
  | "reference";

/**
 * 一段装饰文本。**硬约束：所有段的 `text` 拼起来与输入逐字符相等**--
 * 只改分类，不增删字符；边界也不会落在 UTF-16 代理对中间（emoji 不被切开）。
 */
export type ComposerSegment = Readonly<{
  text: string;
  tone: ComposerTone;
  /** `tone === "reference"` 时，`[[att:<localId>]]` 里的本地附件 id。 */
  localId?: string;
  /** 技能段沿用消息侧的分段形状；span 与 edge 由 `splitMessageSegments` 算出，不在这里重写。 */
  skill?: MessageSegment["skill"];
  skillEdge?: MessageSegment["skillEdge"];
}>;

/** 行首标题：1–3 个 `#` 加一个空格。标记连同空格单独成段，只调暗不换字号。 */
const HEADING_MARKER = /^(#{1,3}) /u;

type Atom = Readonly<{ start: number; end: number; segment: ComposerSegment }>;

/**
 * 把草稿切成装饰分段。识别 `**粗体**`、`*斜体*`、行内 `` `code` ``、行首 `# 标题`
 * 与 `[[att:<localId>]]` 引用；技能 token 复用消息侧扫描。
 */
export function splitComposerSegments(draft: string): ComposerSegment[] {
  const atoms = atomsOf(draft);
  const atomStarts = [...atoms.keys()];
  const decorated: ComposerSegment[] = [];

  const push = (text: string, tone: ComposerTone) => {
    if (text.length > 0) decorated.push({ text, tone });
  };

  let index = 0;
  let lineStart = true;
  let heading = false;
  while (index < draft.length) {
    const atom = atoms.get(index);
    if (atom) {
      decorated.push(atom.segment);
      index = atom.end;
      lineStart = false;
      continue;
    }
    if (lineStart) {
      const marker = HEADING_MARKER.exec(draft.slice(index, index + 4));
      if (marker) {
        push(marker[0], "marker");
        index += marker[0].length;
        lineStart = false;
        heading = true;
        continue;
      }
    }
    const character = draft[index];
    if (character === "\n") {
      push("\n", "plain");
      index += 1;
      lineStart = true;
      heading = false;
      continue;
    }
    if (character === "`" || character === "*") {
      const inline = inlineDecoration(draft, index, atomStarts);
      if (inline) {
        for (const part of inline.segments) push(part.text, part.tone);
        index = inline.end;
        lineStart = false;
        continue;
      }
    }
    // 普通文本：一直吃到下一个可能开始装饰的位置。停在装饰字符上却没识别成装饰时，
    // 至少吞掉一个字符，保证循环前进。
    let end = index;
    while (
      end < draft.length &&
      !atoms.has(end) &&
      draft[end] !== "\n" &&
      draft[end] !== "`" &&
      draft[end] !== "*"
    )
      end += 1;
    if (end === index) end += 1;
    push(draft.slice(index, end), heading ? "heading" : "plain");
    index = end;
    lineStart = false;
  }
  return mergePlain(decorated);
}

/** 相邻同类普通段合并成一个，少几个节点，也让"未闭合的标记保持原样"读起来是一段。 */
function mergePlain(segments: readonly ComposerSegment[]): ComposerSegment[] {
  const plain = (segment: ComposerSegment) =>
    segment.localId === undefined && segment.skill === undefined;
  const merged: ComposerSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && plain(previous) && plain(segment) && previous.tone === segment.tone) {
      merged[merged.length - 1] = { text: previous.text + segment.text, tone: segment.tone };
      continue;
    }
    merged.push(segment);
  }
  return merged;
}

/**
 * 技能 token 与引用 token 在这里是"原子"：装饰不跨越它们，它们也不会被拆碎。
 * 两类 token 都来自左到右扫描，重叠时先到者优先（技能名里嵌的引用整段算技能）。
 */
function atomsOf(draft: string): Map<number, Atom> {
  const skillTokens = scanSkillTokens(draft);
  const skillSegments = splitMessageSegments(draft, [], skillTokens);
  const candidates: Atom[] = [];
  let tokenIndex = 0;
  for (const segment of skillSegments) {
    if (!segment.skill) continue;
    const token = skillTokens[tokenIndex];
    tokenIndex += 1;
    if (!token) continue;
    candidates.push({
      start: token.start,
      end: token.end,
      segment: {
        text: segment.text,
        tone: "plain",
        ...(segment.skill ? { skill: segment.skill } : {}),
        ...(segment.skillEdge ? { skillEdge: segment.skillEdge } : {}),
      },
    });
  }
  for (const reference of scanAttachmentTokens(draft)) {
    candidates.push({
      start: reference.start,
      end: reference.end,
      segment: {
        text: draft.slice(reference.start, reference.end),
        tone: "reference",
        localId: reference.localId,
      },
    });
  }
  candidates.sort((left, right) => left.start - right.start);
  const atoms = new Map<number, Atom>();
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    atoms.set(candidate.start, candidate);
    cursor = candidate.end;
  }
  return atoms;
}

/**
 * 在 `index` 处识别一段行内装饰。闭合必须同行、内容非空、不跨原子段；
 * 识别不了返回 null，调用方把这里当普通文本。
 */
function inlineDecoration(
  draft: string,
  index: number,
  atomStarts: readonly number[],
): { end: number; segments: readonly ComposerSegment[] } | null {
  const delimiter = draft.startsWith("**", index) ? "**" : draft.startsWith("`", index) ? "`" : "*";
  const tone: ComposerTone =
    delimiter === "**" ? "strong" : delimiter === "`" ? "code" : "emphasis";
  const bodyStart = index + delimiter.length;
  let search = bodyStart;
  while (search < draft.length) {
    const bodyEnd = draft.indexOf(delimiter, search);
    if (bodyEnd < 0) return null;
    if (delimiter === "*" && (draft[bodyEnd - 1] === "*" || draft[bodyEnd + 1] === "*")) {
      search = bodyEnd + 1;
      continue;
    }
    if (bodyEnd === bodyStart) return null;
    const lineBreak = draft.indexOf("\n", bodyStart);
    if (lineBreak >= 0 && lineBreak < bodyEnd) return null;
    if (atomStarts.some((start) => start > index && start < bodyEnd)) return null;
    return {
      end: bodyEnd + delimiter.length,
      segments: [
        { text: delimiter, tone: "marker" },
        { text: draft.slice(bodyStart, bodyEnd), tone },
        { text: delimiter, tone: "marker" },
      ],
    };
  }
  return null;
}

/** 「标签」按钮：把 `[[att:<localId>]]` 插进给定范围，光标落回 token 之后。 */
export function insertAttachmentToken(
  value: string,
  range: Readonly<{ start: number; end: number }>,
  localId: string,
): { text: string; caret: number } {
  const token = attachmentToken(localId);
  return {
    text: `${value.slice(0, range.start)}${token}${value.slice(range.end)}`,
    caret: range.start + token.length,
  };
}

/**
 * `×` 移除附件：把草稿里该附件的**全部**引用 token 一并删掉。
 * 光标按删除位置回退；落在被删 token 内部时收到 token 起点，不会跳到别处。
 */
export function removeAttachmentReferences(
  value: string,
  localId: string,
  caret: number,
): { text: string; caret: number; removed: number } {
  const hits = scanAttachmentTokens(value).filter((token) => token.localId === localId);
  let text = value;
  let nextCaret = caret;
  for (const hit of [...hits].reverse()) {
    text = text.slice(0, hit.start) + text.slice(hit.end);
    if (hit.end <= caret) nextCaret -= hit.end - hit.start;
    else if (hit.start < caret) nextCaret = hit.start;
  }
  return { text, caret: nextCaret, removed: hits.length };
}
