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

/** 完整文档才进沙箱；片段继续走行内 HTML 清洗。 */
export function isCompleteHtmlDocument(source: string): boolean {
  return COMPLETE_DOCUMENT.test(source);
}

const REPORTER = `(function(){function send(){parent.postMessage({type:"${HEIGHT_MESSAGE}",height:document.documentElement.scrollHeight},"*")}addEventListener("load",send);if(window.ResizeObserver){new ResizeObserver(send).observe(document.documentElement)}var left=20;var poll=setInterval(function(){send();if(--left<=0)clearInterval(poll)},100)})()`;

/**
 * 把模型给的文档包进沙箱。CSP 用一次性 nonce，只有高度上报脚本能执行：文档自己的脚本
 * 不会跑，图片与请求也出不去（`default-src 'none'`）。
 */
export function sandboxDocument(source: string, nonce: string): string {
  const policy = [
    "default-src 'none'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  const head = `<meta http-equiv="Content-Security-Policy" content="${policy}"><script nonce="${nonce}">${REPORTER}</script>`;
  const opening = source.search(/<head[^>]*>/iu);
  if (opening >= 0) {
    const end = source.indexOf(">", opening) + 1;
    return source.slice(0, end) + head + source.slice(end);
  }
  const doctype = source.match(/^\s*<!doctype[^>]*>/iu);
  const start = doctype ? doctype[0].length : 0;
  return source.slice(0, start) + `<head>${head}</head>` + source.slice(start);
}

/** 高度上限只为挡住病态文档撑爆布局，正常文档按内容自适应。 */
const MAX_HEIGHT = 4000;
/** 测量到达前的占位高度：只够让文档完成排版，短文档不会被撑成一大片空白。 */
const MEASURING_HEIGHT = 60;

export function HtmlBlock({ source }: { source: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const nonce = useMemo(() => randomNonce(), [source]);
  const document = useMemo(() => sandboxDocument(source, nonce), [source, nonce]);
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

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
