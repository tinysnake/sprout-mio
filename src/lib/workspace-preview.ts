import type { WorkspacePreviewKind } from "../contracts/workspace";

/**
 * 预览分流与响应 content-type 读同一份扩展名表，避免服务端说 text/plain、
 * 界面按 markdown 渲染这类不一致。表里没有的扩展名一律 binary，
 * 宁可给「下载」也不猜一个错的渲染器。
 */
const KIND_BY_EXTENSION: Record<string, WorkspacePreviewKind> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  csv: "csv",
  tsv: "csv",
  html: "html",
  htm: "html",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  svg: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
  ogv: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  flac: "audio",
  aac: "audio",
  pdf: "pdf",
  txt: "text",
  log: "text",
  diff: "text",
  patch: "text",
  lock: "text",
  json: "code",
  jsonc: "code",
  json5: "code",
  yaml: "code",
  yml: "code",
  toml: "code",
  ini: "code",
  conf: "code",
  env: "code",
  ts: "code",
  tsx: "code",
  mts: "code",
  cts: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  css: "code",
  scss: "code",
  sass: "code",
  less: "code",
  py: "code",
  rb: "code",
  go: "code",
  rs: "code",
  java: "code",
  kt: "code",
  kts: "code",
  swift: "code",
  c: "code",
  h: "code",
  cc: "code",
  cpp: "code",
  hpp: "code",
  cs: "code",
  php: "code",
  sh: "code",
  bash: "code",
  zsh: "code",
  fish: "code",
  sql: "code",
  xml: "code",
  vue: "code",
  svelte: "code",
  astro: "code",
  lua: "code",
  dart: "code",
  ex: "code",
  exs: "code",
  erl: "code",
  hs: "code",
  scala: "code",
  clj: "code",
  tf: "code",
  hcl: "code",
  graphql: "code",
  gql: "code",
  proto: "code",
  gradle: "code",
  plist: "code",
  slate: "text",
};

/** 没有扩展名但确实是文本的文件，按名字认。 */
const KIND_BY_NAME: Record<string, WorkspacePreviewKind> = {
  dockerfile: "code",
  makefile: "code",
  license: "text",
  "license.md": "markdown",
  notice: "text",
  authors: "text",
  ".gitignore": "text",
  ".gitattributes": "text",
  ".editorconfig": "code",
  ".env": "code",
  ".npmrc": "code",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  mdx: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  pdf: "application/pdf",
  json: "application/json; charset=utf-8",
  jsonc: "application/json; charset=utf-8",
  json5: "application/json; charset=utf-8",
};

export const BINARY_CONTENT_TYPE = "application/octet-stream";
/** 文本类内容的兜底：不声明 charset 时浏览器会按本地编码猜，中文会花。 */
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return "";
  return name.slice(index + 1).toLowerCase();
}

export function workspacePreviewKind(name: string): WorkspacePreviewKind {
  const lower = name.toLowerCase();
  const byName = KIND_BY_NAME[lower];
  if (byName) return byName;
  return KIND_BY_EXTENSION[extensionOf(lower)] ?? "binary";
}

export function workspaceContentType(name: string): string {
  const lower = name.toLowerCase();
  const mime = MIME_BY_EXTENSION[extensionOf(lower)];
  if (mime) return mime;
  const kind = KIND_BY_NAME[lower] ?? KIND_BY_EXTENSION[extensionOf(lower)];
  if (kind === "code" || kind === "text") return TEXT_CONTENT_TYPE;
  return BINARY_CONTENT_TYPE;
}

/** 高亮语言名与扩展名同表，shiki 按它挑 grammar；不认识就退回纯文本。 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "fish",
  sql: "sql",
  lua: "lua",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  scala: "scala",
  clj: "clojure",
  tf: "terraform",
  hcl: "hcl",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  gradle: "groovy",
  plist: "xml",
  diff: "diff",
  patch: "diff",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
};

export function workspaceLanguage(name: string): string | undefined {
  const lower = name.toLowerCase();
  const ext = extensionOf(lower);
  if (LANGUAGE_BY_EXTENSION[ext]) return LANGUAGE_BY_EXTENSION[ext];
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  return undefined;
}
