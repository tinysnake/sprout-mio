import { useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "@/lib/theme";

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

/**
 * 沙箱文档的纸面色：取应用自己的背景与文字色，主题切换后不必再维护第二份色值。
 * 主题样式还没生效时（SSR、测试）退回系统色，由 `color-scheme` 决定深浅。
 */
export type ArtifactPaper = { background: string; foreground: string; scheme: "light" | "dark" };

const SYSTEM_PAPER: ArtifactPaper = {
  background: "Canvas",
  foreground: "CanvasText",
  scheme: "light",
};

export function artifactPaper(scheme: "light" | "dark"): ArtifactPaper {
  if (typeof document === "undefined") return { ...SYSTEM_PAPER, scheme };
  const style = getComputedStyle(document.documentElement);
  const background = style.getPropertyValue("--background").trim();
  const foreground = style.getPropertyValue("--foreground").trim();
  if (background === "" || foreground === "") return { ...SYSTEM_PAPER, scheme };
  return { background, foreground, scheme };
}

/** 片段进沙箱时补的排版底：外壳把默认的 Times 与页边距换成应用的字号行高。 */
function shellStyle(paper: ArtifactPaper): string {
  return (
    `html{background:${paper.background};color:${paper.foreground};color-scheme:${paper.scheme}}` +
    "body{margin:0;padding:12px;font:14px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}"
  );
}

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
export function sandboxDocument(source: string, paper: ArtifactPaper = SYSTEM_PAPER): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="color-scheme" content="${paper.scheme}"><script>${REPORTER}</script>`;
  if (!isCompleteHtmlDocument(source)) {
    return `<!doctype html><html><head><meta charset="utf-8">${head}<style>${shellStyle(paper)}</style></head><body>${source}</body></html>`;
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
  const { theme } = useTheme();
  const paper = useMemo(() => artifactPaper(theme), [theme]);
  const document = useMemo(() => sandboxDocument(source, paper), [source, paper]);
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
        // 测量期先给 60px 且保持可见，高度到了再长：隐藏态切回可见可能整块不重绘。
        overflow: "hidden",
        // 不描外框：artifact 自己画边框，外层再套一圈就成了框套框。
        borderRadius: "var(--radius)",
        // 纸面跟着应用主题走：未写样式的文档在暗色主题下不会变成一块亮斑。
        // 背景与文字色都取自应用自己的 token，主题里只保养一份。
        background: paper.background,
        colorScheme: paper.scheme,
      }}
    />
  );
}
