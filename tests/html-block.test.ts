import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  HTML_MESSAGE_LIMIT,
  isCompleteHtmlDocument,
  sandboxDocument,
} from "../src/components/chat/html-block";
import { MessageMarkdown } from "../src/components/chat/message-markdown";

function render(body: string) {
  return renderToStaticMarkup(createElement(MessageMarkdown, { body, mentions: [], skills: [] }));
}

const document =
  "<!doctype html><html><head><style>p{color:red}</style></head><body><p>hi</p></body></html>";

describe("消息里的 HTML", () => {
  it("白名单标签照常渲染，script 整块消失", () => {
    const html = render("<b>粗</b><script>alert(1)</script>");
    expect(html).toContain("<b>粗</b>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
  });

  it("事件属性被去掉", () => {
    const html = render('<p>文字<img src="x" onerror="alert(1)"></p>');
    expect(html).not.toContain("onerror");
  });

  it("javascript: 链接被去掉", () => {
    const html = render("[点我](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("超长 HTML 走提示分支，不进渲染管线", () => {
    const html = render(`<p>${"a".repeat(HTML_MESSAGE_LIMIT)}</p>`);
    expect(html).toContain('data-testid="html-too-long"');
    expect(html).not.toContain("<p>aaa");
  });

  it("围栏里的完整文档进沙箱 iframe", () => {
    const html = render("```html\n" + document + "\n```");
    expect(html).toContain('data-testid="html-block"');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
  });

  it("围栏里的片段继续按代码块渲染", () => {
    const html = render("```html\n<div>片段</div>\n```");
    expect(html).not.toContain("html-block");
    expect(html).toContain("&lt;div&gt;");
  });

  it("沙箱文档带 nonce 的 CSP，脚本源只放自己的上报脚本", () => {
    const wrapped = sandboxDocument(document, "abc123");
    expect(wrapped).toContain('http-equiv="Content-Security-Policy"');
    expect(wrapped).toContain("script-src 'nonce-abc123'");
    expect(wrapped).toContain("default-src 'none'");
    expect(wrapped).toContain('nonce="abc123"');
    expect(wrapped).not.toContain('unsafe-inline"; script');
  });

  it("完整文档判定不认普通片段", () => {
    expect(isCompleteHtmlDocument(document)).toBe(true);
    expect(isCompleteHtmlDocument("<div>片段</div>")).toBe(false);
  });
});
