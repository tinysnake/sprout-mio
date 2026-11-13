import themeCss from "../../theme.css?raw";

export type ArtifactAppearance = "light" | "dark";

/** 沙箱里那层主题样式的 id；父页面换主题时只改类名，不重建文档。 */
export const ARTIFACT_THEME_STYLE_ID = "sprout-artifact-theme";

/** 父页面用来告诉沙箱当前外观的消息类型。 */
export const ARTIFACT_APPEARANCE_MESSAGE = "sprout-html-block-appearance";

/** `--font-sans` 只在 `theme.css` 的 `@theme inline` 里，浏览器会丢弃该 at-rule，所以这里补一份。 */
const FONT_TOKENS =
  ':root{--font-sans:var(--font-body);--font-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace}';

/**
 * 文档的底子：底色、正文色、字体、焦点环全部取自主题变量，取自 T3 的 `BASE_CSS`。
 * 作者只画内容，页面留白与滚动条由这层给。
 */
const BASE_CSS =
  "html{box-sizing:border-box;padding:8px;background:var(--background);color:var(--foreground);" +
  "font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;" +
  "-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}" +
  "body{margin:0}" +
  "code,kbd,pre,samp{font-family:var(--font-mono)}" +
  ":focus-visible{outline:2px solid var(--ring)!important;outline-offset:-2px!important}";

/**
 * 沙箱的主题样式表：`theme.css` 原样注入，`:root` 在前、`.dark` 在后，
 * 特异性相同靠源码顺序覆盖，所以深色只要给 `<html>` 加 `.dark`。
 */
export function artifactStyleSheet(): string {
  return `${FONT_TOKENS}${themeCss}${BASE_CSS}`;
}

/** 沙箱自己的策略：能跑文档脚本，但出不了网、读不到父页面。 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");
