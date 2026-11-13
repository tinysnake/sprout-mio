import { describe, expect, it } from "vite-plus/test";
import {
  insertAttachmentToken,
  removeAttachmentReferences,
  splitComposerSegments,
} from "../src/components/chat/composer-markdown";
import type { ComposerSegment } from "../src/components/chat/composer-markdown";

/** 镜像层与 textarea 共用一个字符串：段边界只能改分类，拼回去必须逐字符相等。 */
function join(segments: readonly ComposerSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

/** UTF-16 低代理位：段边界落在它上面，说明一个 emoji 被切成了两半。 */
function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const code = text.charCodeAt(offset);
  return code >= 0xdc00 && code <= 0xdfff;
}

function expectSameText(text: string): ComposerSegment[] {
  const segments = splitComposerSegments(text);
  expect(join(segments)).toBe(text);
  let offset = 0;
  for (const segment of segments) {
    offset += segment.text.length;
    expect(splitsSurrogatePair(text, offset)).toBe(false);
  }
  expect(offset).toBe(text.length);
  return segments;
}

const SAMPLES = [
  "",
  "普通文本",
  "**粗体**",
  "前面 **粗体** 后面",
  "*斜体* 与 **粗体**",
  "行内 `code` 段",
  "空标记 ** 与 `` 与 *",
  "未闭合 ** 标记",
  "*半*开*",
  "***粗斜体***",
  "# 标题",
  "## 二级标题",
  "### 三级标题",
  "#### 四个井号不是标题",
  "文字 # 不是标题",
  "行一\n# 行二标题\n**行三**",
  "看 [[att:1]] 这个",
  "[[att:x-1]][[att:x-2]]",
  "见 [[att:1]] 与 `code` 与 **粗体**",
  "📖审阅 看看 [[att:a]]",
  "带 emoji 🚀 的 **粗体**",
  "🚀**粗**🚀",
  "🎯 引用 [[att:🚀]] 不行，token 里只认 [A-Za-z0-9_-]",
  "`code`**紧邻**",
  "换行\n\n引用 [[att:x-1]] 之后",
];

describe("输入区即时呈现：分段只改分类", () => {
  it("任何输入下，所有段的文本拼回原文逐字符相等，段边界不切 emoji", () => {
    for (const sample of SAMPLES) expectSameText(sample);
  });

  it("emoji 不被切开，且 emoji 与装饰标记各自成段", () => {
    const segments = expectSameText("🚀**粗**🚀");
    expect(segments.map((segment) => segment.text)).toEqual(["🚀", "**", "粗", "**", "🚀"]);
    expect(segments.map((segment) => segment.tone)).toEqual([
      "plain",
      "marker",
      "strong",
      "marker",
      "plain",
    ]);
  });

  it("**粗体** 的内容与标记分开成段", () => {
    expect(splitComposerSegments("说 **重点** 了")).toEqual([
      { text: "说 ", tone: "plain" },
      { text: "**", tone: "marker" },
      { text: "重点", tone: "strong" },
      { text: "**", tone: "marker" },
      { text: " 了", tone: "plain" },
    ]);
  });

  it("*斜体* 用单星号，成对的 ** 不会被拆成两个斜体标记", () => {
    expect(splitComposerSegments("*斜*")).toEqual([
      { text: "*", tone: "marker" },
      { text: "斜", tone: "emphasis" },
      { text: "*", tone: "marker" },
    ]);
    expect(splitComposerSegments("**粗**").map((segment) => segment.tone)).toEqual([
      "marker",
      "strong",
      "marker",
    ]);
  });

  it("未闭合的 ** 原样留下，不装饰也不吞字", () => {
    expect(splitComposerSegments("未闭合 ** 标记")).toEqual([
      { text: "未闭合 ** 标记", tone: "plain" },
    ]);
    expect(splitComposerSegments("结尾是 *")).toEqual([{ text: "结尾是 *", tone: "plain" }]);
  });

  it("行内代码只切背景与颜色，标记单独成段", () => {
    expect(splitComposerSegments("调 `scanSkillTokens` 用")).toEqual([
      { text: "调 ", tone: "plain" },
      { text: "`", tone: "marker" },
      { text: "scanSkillTokens", tone: "code" },
      { text: "`", tone: "marker" },
      { text: " 用", tone: "plain" },
    ]);
  });

  it("行首 1–3 个 # 加空格才是标题，标记调暗、标题只改颜色", () => {
    expect(splitComposerSegments("# 标题\n正文")).toEqual([
      { text: "# ", tone: "marker" },
      { text: "标题", tone: "heading" },
      { text: "\n正文", tone: "plain" },
    ]);
    expect(splitComposerSegments("#### 四个井号不是标题")).toEqual([
      { text: "#### 四个井号不是标题", tone: "plain" },
    ]);
    expect(splitComposerSegments("文字 # 不是标题")).toEqual([
      { text: "文字 # 不是标题", tone: "plain" },
    ]);
  });

  it("[[att:<localId>]] 识别成带 localId 的引用段", () => {
    expect(splitComposerSegments("看 [[att:1]] 这个")).toEqual([
      { text: "看 ", tone: "plain" },
      { text: "[[att:1]]", tone: "reference", localId: "1" },
      { text: " 这个", tone: "plain" },
    ]);
  });

  it("技能与引用共存：技能段沿用消息侧形状，引用段不被吞", () => {
    const text = "📖审阅 看看 [[att:a-1]]";
    const segments = expectSameText(text);
    const skills = segments.filter((segment) => segment.skill);
    const references = segments.filter((segment) => segment.tone === "reference");
    expect(skills).toHaveLength(1);
    expect(skills[0]?.text).toBe("📖审阅");
    expect(skills[0]?.skill?.name).toBe("审阅");
    expect(skills[0]?.skillEdge).toBeDefined();
    expect(references).toHaveLength(1);
    expect(references[0]?.localId).toBe("a-1");
    expect(segments.indexOf(references[0] as ComposerSegment)).toBeGreaterThan(
      segments.indexOf(skills[0] as ComposerSegment),
    );
  });

  it("装饰不跨越引用 token：引用两侧的标记不会被配成粗体", () => {
    const segments = expectSameText("**[[att:a]]**");
    expect(segments.map((segment) => segment.tone)).toEqual(["plain", "reference", "plain"]);
    expect(segments[1]).toEqual({ text: "[[att:a]]", tone: "reference", localId: "a" });
  });
});

describe("附件引用 token 的插入与移除", () => {
  it("标签在光标处插入 token，插入后光标落回 token 之后", () => {
    expect(insertAttachmentToken("总结一下：", { start: 5, end: 5 }, "f1")).toEqual({
      text: "总结一下：[[att:f1]]",
      caret: 15,
    });
  });

  it("有选区时替换选区，光标同样落在 token 之后", () => {
    expect(insertAttachmentToken("看 aa 这个", { start: 2, end: 4 }, "x")).toEqual({
      text: "看 [[att:x]] 这个",
      caret: 11,
    });
  });

  it("× 移除附件时删掉它的全部引用，光标按删除位置回退", () => {
    const value = "看 [[att:a]] 和 [[att:b]] 都在这";
    const removedA = removeAttachmentReferences(value, "a", value.length);
    expect(removedA).toEqual({
      text: "看  和 [[att:b]] 都在这",
      caret: value.length - 9,
      removed: 1,
    });

    const removedB = removeAttachmentReferences(value, "b", 20);
    expect(removedB).toEqual({
      text: "看 [[att:a]] 和  都在这",
      caret: 14,
      removed: 1,
    });
  });

  it("同一个附件的多条引用一次删净", () => {
    const value = "[[att:a]] 与 [[att:a]]";
    expect(removeAttachmentReferences(value, "a", value.length)).toEqual({
      text: " 与 ",
      caret: 3,
      removed: 2,
    });
  });

  it("草稿里没有该附件的引用时，文本与光标都不动", () => {
    expect(removeAttachmentReferences("没有引用", "f1", 2)).toEqual({
      text: "没有引用",
      caret: 2,
      removed: 0,
    });
  });

  it("光标离开装饰时标记隐形，靠进去时重新现出来", () => {
    const draft = "前面 **粗体** 后面";
    const markers = (caret: number | null) =>
      splitComposerSegments(draft, caret).filter((segment) => segment.tone === "marker");
    // 光标在句尾的「后面」里：两个 `**` 都隐形，但字符与宽度照旧。
    expect(
      markers(draft.length).map((segment) => ({
        text: segment.text,
        quiet: segment.quiet ?? false,
      })),
    ).toEqual([
      { text: "**", quiet: true },
      { text: "**", quiet: true },
    ]);
    // 光标进到粗体正文里：标记露出来，方便改。
    expect(markers(5).every((segment) => segment.quiet !== true)).toBe(true);
    // 没有光标（未聚焦/首次渲染）不隐藏，沿用原来的淡标记。
    expect(markers(null).every((segment) => segment.quiet !== true)).toBe(true);
    expect(join(splitComposerSegments(draft, draft.length))).toBe(draft);
    // 隐形的只能是标记，正文段无论光标在哪都必须看得见。
    expect(
      splitComposerSegments(draft, draft.length).filter(
        (segment) => segment.tone !== "marker" && segment.quiet === true,
      ),
    ).toEqual([]);
  });

  it("刚打完闭合标记、光标停在其后时，标记也收起来", () => {
    const draft = "前面 **粗体**";
    const atEnd = splitComposerSegments(draft, draft.length);
    expect(
      atEnd.filter((segment) => segment.tone === "marker").map((segment) => segment.quiet),
    ).toEqual([true, true]);
    // 光标退到闭合标记之前（正文里）时再露出来。
    const beforeClose = splitComposerSegments(draft, draft.length - 2);
    expect(
      beforeClose
        .filter((segment) => segment.tone === "marker")
        .every((segment) => segment.quiet !== true),
    ).toBe(true);
  });

  it("标题标记只在光标还在这一行时露出", () => {
    const draft = "# 标题\n另起一行";
    const marker = (caret: number) =>
      splitComposerSegments(draft, caret).find((segment) => segment.tone === "marker");
    expect(marker(3)?.quiet).toBe(undefined);
    expect(marker(draft.length)?.quiet).toBe(true);
    expect(join(splitComposerSegments(draft, 3))).toBe(draft);
  });
});
