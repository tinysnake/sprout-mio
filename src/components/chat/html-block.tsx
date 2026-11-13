import { useEffect, useMemo, useRef, useState } from "react";

/** 单条消息的 HTML 渲染上限（字符）。超限退回原文，避免解析阶段把页面拖死。 */
export const HTML_MESSAGE_LIMIT = 100_000;

const HTML_TAG = /<[a-z!/]/iu;
const COMPLETE_DOCUMENT = /<!doctype\s+html|<html[\s>]/iu;
const HEIGHT_MESSAGE = "sprout-html-block-height";

export function containsHtml(source: string): boolean {
  return HTML_TAG.test(source);
}

/** 超限只看长度与是否含 HTML：超长纯文本是另一回事，仍按普通消息渲染。 */
export function exceedsHtmlLimit(source: string): boolean {
  return source.length > HTML_MESSAGE_LIMIT && containsHtml(source);
}

/** 完整文档自带 `<head>`；片段由 `sandboxDocument` 补一层外壳。 */
export function isCompleteHtmlDocument(source: string): boolean {
  return COMPLETE_DOCUMENT.test(source);
}

const REPORTER = `(function(){function send(){parent.postMessage({type:"${HEIGHT_MESSAGE}",height:document.documentElement.scrollHeight},"*")}addEventListener("load",send);if(window.ResizeObserver){new ResizeObserver(send).observe(document.documentElement)}var left=20;var poll=setInterval(function(){send();if(--left<=0)clearInterval(poll)},100)})()`;

/** 片段进沙箱时补的排版底：外壳把默认的 Times 与页边距换成应用的字号行高。 */
const SHELL_STYLE =
  "html{background:#fff;color:#111;color-scheme:light}" +
  "body{margin:0;padding:12px;font:14px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}";

/** 沙箱里可以跑文档自己的脚本，但出不了网，也读不到父页面。 */
const CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * 把模型给的 HTML 变成一个独立文档：完整文档原样注入策略与上报脚本，片段补外壳，
 * 这样片段里的 `<style>` 与 `style=` 都按文档样式生效，而不是被行内清洗器剥掉。
 */
export function sandboxDocument(source: string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="color-scheme" content="light"><script>${REPORTER}</script>`;
  if (!isCompleteHtmlDocument(source)) {
    return `<!doctype html><html><head><meta charset="utf-8">${head}<style>${SHELL_STYLE}</style></head><body>${source}</body></html>`;
  }
  const withHead = insertAfter(source, /<head[^>]*>/iu, head);
  if (withHead !== null) return withHead;
  const withHtml = insertAfter(source, /<html[^>]*>/iu, `<head>${head}</head>`);
  if (withHtml !== null) return withHtml;
  const doctype = source.match(/^\s*<!doctype[^>]*>/iu);
  const start = doctype ? doctype[0].length : 0;
  return source.slice(0, start) + `<head>${head}</head>` + source.slice(start);
}

function insertAfter(source: string, opening: RegExp, addition: string): string | null {
  const match = opening.exec(source);
  if (match === null) return null;
  const end = match.index + match[0].length;
  return source.slice(0, end) + addition + source.slice(end);
}

/** 高度上限只为挡住病态文档撑爆布局，正常文档按内容自适应。 */
const MAX_HEIGHT = 20_000;
/** 测量到达前的占位高度：只够让文档完成排版，短文档不会被撑成一大片空白。 */
const MEASURING_HEIGHT = 60;

export function HtmlBlock({ source }: { source: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const document = useMemo(() => sandboxDocument(source), [source]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const message = data as { type?: unknown; height?: unknown };
      if (message.type !== HEIGHT_MESSAGE || typeof message.height !== "number") return;
      if (!Number.isFinite(message.height) || message.height <= 0) return;
      setHeight(Math.min(Math.round(message.height), MAX_HEIGHT));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      ref={frame}
      data-testid="html-block"
      title="HTML"
      sandbox="allow-scripts"
      srcDoc={document}
      style={{
        width: "100%",
        height: height ?? MEASURING_HEIGHT,
        // 高度按内容量出来，边框不能从里面再扣 2px，否则沙箱内永远差一点点滚动。
        boxSizing: "content-box",
        display: "block",
        visibility: height === null ? "hidden" : undefined,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        // 沙箱文档当一张浅色纸面渲染：深色主题下默认黑字与透明底会互相吃掉，
        // 固定浅色底 + `colorScheme: light` 让没写样式的文档在两种主题下都可读。
        background: "#ffffff",
        colorScheme: "light",
      }}
    />
  );
}
