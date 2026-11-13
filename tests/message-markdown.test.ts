import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { MentionSpan } from "../src/contracts/chat";
import type { MessageSkillSpan } from "../src/contracts/skill";
import { MessageMarkdown } from "../src/components/chat/message-markdown";

function render(
  body: string,
  mentions: readonly MentionSpan[] = [],
  skills: readonly MessageSkillSpan[] = [],
) {
  return renderToStaticMarkup(createElement(MessageMarkdown, { body, mentions, skills }));
}

function mention(body: string, text: string, memberId = "agp_1"): MentionSpan {
  const start = body.indexOf(text);
  if (start < 0) throw new Error("夹具正文里找不到点名文本");
  return { memberKind: "agent", memberId, start, end: start + text.length };
}

function skill(body: string, text: string, name = "poteto-mode"): MessageSkillSpan {
  const start = body.indexOf(text);
  if (start < 0) throw new Error("夹具正文里找不到技能标记");
  return { name, start, end: start + text.length };
}

describe("消息正文按 markdown 渲染", () => {
  it("加粗与列表渲染成结构，可见文字里不再出现字面标记", () => {
    const html = render("**结论**\n\n- 第一项\n- 第二项");
    expect(html).toContain("<strong>结论</strong>");
    expect(html).toContain("<ul>");
    expect(html.match(/<li>/gu)?.length).toBe(2);
    expect(html).not.toContain("**");
  });

  it("围栏代码块保留换行与缩进，块内文字与原文逐字相同", () => {
    const body = "请看：\n\n```tsx\nconst a = 1;\n\n  const b = 2;\n```";
    const html = render(body);
    expect(html).toContain("<pre>");
    expect(html).toContain("const a = 1;");
    expect(html).toContain("\n\n  const b = 2;");
  });

  it("行首 1. 解析为有序列表项，不作为缺陷", () => {
    const html = render("1. 第一项\n2. 第二项");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>第一项</li>");
    expect(html).toContain("<li>第二项</li>");
  });

  it("点名落在加粗区间里，冻结范围与文本一字不改", () => {
    const body = "**请 @Amenda 复核**";
    const spans = [mention(body, "@Amenda")];
    const html = render(body, spans);
    expect(html).toContain('data-testid="message-mention"');
    expect(html).toContain('data-member-id="agp_1"');
    expect(html).toContain(">Amenda<");
    expect(html).toContain("markdown-chip");
    expect(html).toContain("<strong>");
    expect(body.slice(spans[0].start, spans[0].end)).toBe("@Amenda");
  });

  it("技能 pill 落在列表项里，仍是同一个冻结区间", () => {
    const body = "- 用 📖poteto-mode 跑一遍";
    const spans = [skill(body, "📖poteto-mode")];
    const html = render(body, [], spans);
    expect(html).toContain("<li>");
    expect(html).toContain('data-testid="message-skill"');
    expect(html).toContain("poteto-mode");
    expect(body.slice(spans[0].start, spans[0].end)).toBe("📖poteto-mode");
  });

  it("正文自带哨兵同形字面串时不吞字、不插错芯片", () => {
    //  与  就是哨兵的边界字符；正文里凑出同形串不能骗过回填。
    const body = "前\uE0000\uE001后 @Amenda";
    const spans = [mention(body, "@Amenda")];
    const html = render(body, spans);
    expect(html).toContain("\uE0000\uE001");
    expect(html.match(/data-testid="message-mention"/gu)?.length).toBe(1);
    expect(html).toContain(">Amenda<");
    expect(html).toContain("markdown-chip");
  });

  it("图片不渲染也不预载，降级成可读文字", () => {
    const withAlt = render("见图 ![截图](https://example.test/x.png) 结束");
    expect(withAlt).not.toContain("<img");
    expect(withAlt).not.toContain("preload");
    expect(withAlt).not.toContain("example.test/x.png");
    expect(withAlt).toContain("截图");
    const withoutAlt = render("![ ](https://example.test/y.png)".replace("![ ]", "![]"));
    expect(withoutAlt).not.toContain("<img");
    expect(withoutAlt).toContain("https://example.test/y.png");
  });

  it("站外链接补 rel 并另开标签页", () => {
    const html = render("参考 https://example.test/doc 与 [标题](https://example.test/d)");
    expect(html.match(/rel="noreferrer"/gu)?.length).toBe(2);
    expect(html.match(/target="_blank"/gu)?.length).toBe(2);
  });

  it("人类文本里的孤立 * 与 _ 保持字面：算术与词内下划线都不变斜体", () => {
    const html = render("算一下 3 * 4 = 12，字段名 payload_hash 与 task_id 都不该变斜体。");
    expect(html).not.toContain("<em>");
    expect(html).toContain("3 * 4 = 12");
    expect(html).toContain("payload_hash");
    expect(html).toContain("task_id");
  });

  it("成对强调按 markdown 渲染成斜体，不作为缺陷", () => {
    const html = render("这条 *确实是斜体*。");
    expect(html).toContain("<em>确实是斜体</em>");
  });
});
