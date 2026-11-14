import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import Papa from "papaparse";
import { Download, FileWarning, Loader2 } from "lucide-react";
import type { WorkspacePreviewKind } from "../../contracts/workspace";
import { workspaceLanguage, workspacePreviewKind } from "../../lib/workspace-preview";
import { Icon } from "../ui/icon";
import "../chat/markdown-content.css";
import "./workspace-preview.css";
import {
  fetchWorkspaceText,
  useWorkspaceBlob,
  workspaceFileUrl,
  type WorkspaceQuery,
} from "./workspace-api";

/**
 * 内嵌预览按扩展名分派，渲染器只用现成库：markdown 走 react-markdown、
 * 代码走 shiki、表格走 papaparse，HTML / PDF / 图片 / 音视频交给浏览器本身。
 * 没有对应渲染器的类型不假装能看，直接给下载入口。
 */
export function WorkspacePreview({
  projectId,
  chatId,
  path,
  name,
}: {
  projectId: string;
  chatId?: string;
  path: string;
  name: string;
}) {
  const query = { projectId, chatId, path } as WorkspaceQuery;
  const url = workspaceFileUrl(query);
  const kind = workspacePreviewKind(name);
  const fallback = <TextPreview query={query} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {renderKind(kind, url, query, fallback, name)}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-3 py-2 text-muted-foreground">
        <span className="truncate">{path}</span>
        <a className="flex items-center gap-1 hover:text-foreground" href={url} download={name}>
          <Icon as={Download} />
          下载
        </a>
      </div>
    </div>
  );
}

function renderKind(
  kind: WorkspacePreviewKind,
  url: string,
  query: WorkspaceQuery,
  fallback: React.ReactNode,
  name: string,
) {
  switch (kind) {
    case "markdown":
      return <MarkdownPreview query={query} />;
    case "code":
      return <CodePreview query={query} />;
    case "csv":
      return <CsvPreview query={query} />;
    case "text":
      return fallback;
    case "html":
      return <FramePreview url={url} title="HTML 预览" />;
    case "pdf":
      return <FramePreview url={url} title="PDF 预览" />;
    case "image":
      return <ImagePreview url={url} label={name} />;
    case "video":
      return <VideoPreview url={url} />;
    case "audio":
      return <AudioPreview url={url} />;
    default:
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Icon as={FileWarning} size={20} />
          <p>这个类型没有内嵌预览</p>
        </div>
      );
  }
}

function ImagePreview({ url, label }: { url: string; label: string }) {
  const blob = useWorkspaceBlob(url);
  if (!blob.url) return <Pending error={blob.error} />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/30 p-4">
      <img src={blob.url} alt={label} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

function VideoPreview({ url }: { url: string }) {
  const blob = useWorkspaceBlob(url);
  if (!blob.url) return <Pending error={blob.error} />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted p-2">
      <video src={blob.url} controls className="max-h-full max-w-full" />
    </div>
  );
}

function AudioPreview({ url }: { url: string }) {
  const blob = useWorkspaceBlob(url);
  if (!blob.url) return <Pending error={blob.error} />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <audio src={blob.url} controls className="w-full max-w-xl" />
    </div>
  );
}

function FramePreview({ url, title }: { url: string; title: string }) {
  return (
    <iframe
      title={title}
      src={url}
      className="min-h-0 w-full flex-1 border-0 bg-background"
      referrerPolicy="no-referrer"
    />
  );
}

function Pending({ error }: { error?: string }) {
  if (error)
    return (
      <div className="flex min-h-0 flex-1 flex-col items-start gap-2 p-4 text-destructive">
        <span>{error}</span>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 items-center gap-2 p-4 text-muted-foreground">
      <Icon as={Loader2} className="animate-spin" />
      读取中
    </div>
  );
}

function useWorkspaceText(query: WorkspaceQuery) {
  const [state, setState] = useState<{ text: string; truncated: boolean } | { error: string }>();
  useEffect(() => {
    const controller = new AbortController();
    setState(undefined);
    fetchWorkspaceText(query, controller.signal)
      .then(setState)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ error: error instanceof Error ? error.message : "读取失败" });
      });
    return () => controller.abort();
  }, [query.chatId, query.path, query.projectId]);
  return state;
}

function TextPreview({ query }: { query: WorkspaceQuery }) {
  const state = useWorkspaceText(query);
  if (!state) return <Pending />;
  if ("error" in state) return <Pending error={state.error} />;
  return (
    <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 text-[12px] leading-relaxed">
      {state.text}
    </pre>
  );
}

function MarkdownPreview({ query }: { query: WorkspaceQuery }) {
  const state = useWorkspaceText(query);
  if (!state) return <Pending />;
  if ("error" in state) return <Pending error={state.error} />;
  return (
    <div className="markdown-content workspace-markdown min-h-0 flex-1 overflow-auto px-5 py-4">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {state.text}
      </Markdown>
    </div>
  );
}

type ShikiHighlighter = import("shiki").Highlighter;
let highlighterPromise: Promise<ShikiHighlighter> | undefined;

/** shiki 很重：第一次真的要高亮时才把它拉进来，语言也按需加载。 */
function getHighlighter() {
  highlighterPromise ??= import("shiki").then((shiki) =>
    shiki.createHighlighter({ themes: ["github-light", "github-dark"], langs: [] }),
  );
  return highlighterPromise;
}

function PlainCode({ code }: { code: string }) {
  return (
    <pre className="workspace-code min-h-0 flex-1 overflow-auto whitespace-pre bg-muted p-4 font-mono text-[12px] leading-relaxed">
      {code}
    </pre>
  );
}

async function highlight(code: string, language: string | undefined) {
  if (!language) return <PlainCode code={code} />;
  try {
    const highlighter = await getHighlighter();
    await highlighter.loadLanguage(language as import("shiki").BundledLanguage);
    const html = highlighter.codeToHtml(code, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
    });
    return (
      <div
        className="workspace-code min-h-0 flex-1 overflow-auto bg-muted p-4 font-mono text-[12px] leading-relaxed"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  } catch {
    return <PlainCode code={code} />;
  }
}

function CodePreview({ query }: { query: WorkspaceQuery }) {
  const state = useWorkspaceText(query);
  const [node, setNode] = useState<React.ReactNode>(null);
  const language = useMemo(() => workspaceLanguage(query.path.split("/").pop() ?? ""), [query.path]);
  useEffect(() => {
    if (!state || !("text" in state)) return;
    let alive = true;
    setNode(null);
    void highlight(state.text, language).then((result) => {
      if (alive) setNode(result);
    });
    return () => {
      alive = false;
    };
  }, [language, state]);
  if (!state) return <Pending />;
  if ("error" in state) return <Pending error={state.error} />;
  return node ?? <PlainCode code={state.text} />;
}

const CSV_MAX_ROWS = 200;
const CSV_MAX_COLUMNS = 30;

function CsvPreview({ query }: { query: WorkspaceQuery }) {
  const state = useWorkspaceText(query);
  const table = useMemo(() => {
    if (!state || !("text" in state)) return null;
    const parsed = Papa.parse<string[]>(state.text, { skipEmptyLines: true });
    const rows = parsed.data.slice(0, CSV_MAX_ROWS + 1).map((row) => row.slice(0, CSV_MAX_COLUMNS));
    if (rows.length === 0) return { header: [] as string[], body: [] as string[][], more: false };
    const [first, ...rest] = rows;
    const headerish =
      first.length > 0 &&
      first.every((cell) => cell.length > 0 && Number.isNaN(Number(cell))) &&
      new Set(first).size === first.length;
    return {
      header: headerish ? first : first.map((_, index) => `第 ${index + 1} 列`),
      body: headerish ? rest : rows,
      more: parsed.data.length > CSV_MAX_ROWS + 1,
    };
  }, [state]);
  if (!state) return <Pending />;
  if ("error" in state) return <Pending error={state.error} />;
  if (!table) return null;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="workspace-csv w-full border-collapse text-[12px]">
        <thead>
          <tr>
            {table.header.map((cell, index) => (
              <th key={index} className="sticky top-0 border-b border-border bg-secondary px-2 py-1.5 text-left font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.body.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-muted/30">
              {table.header.map((_, cellIndex) => (
                <td key={cellIndex} className="border-b border-border/60 px-2 py-1 align-top">
                  {row[cellIndex] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(table.more || "truncated" in state) && (
        <p className="px-2 py-2 text-muted-foreground">
          只显示前 {CSV_MAX_ROWS} 行、{CSV_MAX_COLUMNS} 列。
        </p>
      )}
    </div>
  );
}
