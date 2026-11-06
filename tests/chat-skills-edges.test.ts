import { describe, expect, it } from "vite-plus/test";
import type { MentionSpan } from "../src/contracts/chat";
import type { MessageSkillSpan } from "../src/contracts/skill";
import { splitMessageSegments, type SkillEdge } from "../src/components/chat/message-segments";
import { SKILL_MARK } from "../src/lib/skill-token";

const AGENT = "agp_1";

function skill(body: string, name: string): MessageSkillSpan {
  const start = body.indexOf(`${SKILL_MARK}${name}`);
  if (start < 0) throw new Error(`${body} 里没有 ${name} 标记`);
  return { name, start, end: start + SKILL_MARK.length + name.length };
}

function edges(
  body: string,
  names: readonly string[],
  mentions: readonly MentionSpan[] = [],
): { start: SkillEdge; end: SkillEdge }[] {
  return splitMessageSegments(
    body,
    mentions,
    names.map((name) => skill(body, name)),
  ).flatMap((segment) => (segment.skillEdge ? [segment.skillEdge] : []));
}

describe("标记外悬按邻字让出的空隙决定", () => {
  it("贴着字形的一侧退到零，另一侧保留留白", () => {
    expect(edges("看📖plan-only 帮我", ["plan-only"])).toEqual([{ start: "flush", end: "full" }]);
    expect(edges("📖how帮我", ["how"])).toEqual([{ start: "full", end: "flush" }]);
    expect(edges("看📖how帮我", ["how"])).toEqual([{ start: "flush", end: "flush" }]);
  });

  it("与另一个标记只隔一个半角空格时让出整格", () => {
    expect(edges("📖how 📖plan-only", ["how", "plan-only"])).toEqual([
      { start: "full", end: "flush" },
      { start: "flush", end: "full" },
    ]);
  });

  it("空隙够宽时两枚标记各占 1px", () => {
    expect(edges("📖how  📖plan-only", ["how", "plan-only"])).toEqual([
      { start: "full", end: "half" },
      { start: "half", end: "full" },
    ]);
  });

  it("正文两端与换行处没有邻字，留白不动", () => {
    expect(edges("📖how", ["how"])).toEqual([{ start: "full", end: "full" }]);
    expect(edges("一行\n📖how", ["how"])).toEqual([{ start: "full", end: "full" }]);
  });

  it("点名标记也算占了这侧的空隙", () => {
    const body = "@bot 📖how";
    expect(
      edges(body, ["how"], [{ memberKind: "agent", memberId: AGENT, start: 0, end: 4 }]),
    ).toEqual([{ start: "flush", end: "full" }]);
  });

  it("旧格式标记不是技能段，没有外悬信息", () => {
    expect(splitMessageSegments("【技能:plan-only】 帮我", [], [])).toEqual([
      { text: "【技能:plan-only】 帮我" },
    ]);
  });
});
