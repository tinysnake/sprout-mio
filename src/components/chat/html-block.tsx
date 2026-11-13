import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/lib/theme";
import {
  ARTIFACT_APPEARANCE_MESSAGE,
  ARTIFACT_CSP,
  ARTIFACT_THEME_STYLE_ID,
  artifactStyleSheet,
  type ArtifactAppearance,
} from "./html-artifact-theme";

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

/**
 * 沙箱里的引导脚本：先按生成时定的外观挂上 `.dark`，再听父页面的换主题消息，
 * 并把内容高度报回去。高度连发 20 次（100ms 间隔）是因为父页面的监听要等挂载后才在。
 */
function bootstrap(initial: ArtifactAppearance): string {
  return `(function(){
function paint(next){var dark=next==="dark";document.documentElement.classList.toggle("dark",dark);var meta=document.querySelector('meta[name="color-scheme"]');if(meta)meta.setAttribute("content",dark?"dark":"light")}
function send(){parent.postMessage({type:"${HEIGHT_MESSAGE}",height:document.documentElement.scrollHeight},"*")}
function receive(event){var data=event.data;if(!data||data.type!=="${ARTIFACT_APPEARANCE_MESSAGE}")return;paint(data.appearance);send()}
paint("${initial}");
addEventListener("message",receive);
addEventListener("load",send);
if(window.ResizeObserver){new ResizeObserver(send).observe(document.documentElement)}
var left=20;var poll=setInterval(function(){send();if(--left<=0)clearInterval(poll)},100)
})()`;
}

/**
 * 把模型给的 HTML 变成一个独立文档：完整文档原样注入主题与上报脚本，片段补外壳，
 * 这样片段里的 `<style>` 与 `style=` 都按文档样式生效，而不是被行内清洗器剥掉。
 */
export function sandboxDocument(source: string, appearance: ArtifactAppearance = "light"): string {
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
    `<meta name="color-scheme" content="${appearance}">` +
    `<style id="${ARTIFACT_THEME_STYLE_ID}">${artifactStyleSheet()}</style>` +
    `<script>${bootstrap(appearance)}</script>`;
  if (!isCompleteHtmlDocument(source)) {
    return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${source}</body></html>`;
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
  const { theme } = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [markup, setMarkup] = useState<string | null>(null);
  const builtFor = useRef<string | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // 文档只在源码变化时重建。换主题走下面的消息，沙箱里的状态不会被重载冲掉。
  useEffect(() => {
    if (builtFor.current === source) return;
    builtFor.current = source;
    setMarkup(sandboxDocument(source, themeRef.current));
  }, [source]);

  const announce = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      { type: ARTIFACT_APPEARANCE_MESSAGE, appearance: themeRef.current },
      "*",
    );
  }, []);

  useEffect(() => {
    announce();
  }, [theme, markup, announce]);

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

  // 顶渲染读不到真实外观，先按浅色给一份，别让首帧只是个空框；挂载后立刻换成真主题。
  const srcDoc = markup ?? sandboxDocument(source, "light");

  return (
    <iframe
      ref={frame}
      data-testid="html-block"
      title="HTML"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      onLoad={announce}
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
        background: "var(--background)",
      }}
    />
  );
}
