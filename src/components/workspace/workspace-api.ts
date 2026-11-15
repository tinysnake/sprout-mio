import { useEffect, useState } from "react";
import type { WorkspaceTree } from "../../contracts/workspace";
import { workspaceTreeSchema } from "../../contracts/workspace";

/** 三个入口共用一个查询串拼法：树、内嵌预览、新标签页打开，参数必须一致。 */
export type WorkspaceQuery = {
  readonly projectId: string;
  readonly chatId?: string;
  readonly path: string;
};

function query(input: WorkspaceQuery) {
  const params = new URLSearchParams({ projectId: input.projectId, path: input.path });
  if (input.chatId) params.set("chatId", input.chatId);
  return params.toString();
}

export function workspaceFileUrl(input: WorkspaceQuery) {
  return `/api/workspace/file?${query(input)}`;
}

export function workspaceTreeUrl(input: WorkspaceQuery) {
  return `/api/workspace/tree?${query(input)}`;
}

/**
 * 「新标签页打开」指向应用自己的整页预览，不是字节接口：
 * md / csv 这类文件的响应类型会让浏览器显示源码，整页预览才和嵌入视图一致。
 */
export function workspaceViewerUrl(input: { projectId: string; chatId: string; path: string }) {
  const params = new URLSearchParams({ chatId: input.chatId, path: input.path });
  return `/projects/${input.projectId}/files?${params.toString()}`;
}

export class WorkspaceRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readError(response: Response) {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `请求失败（${response.status}）`;
}

export async function fetchWorkspaceTree(
  input: WorkspaceQuery,
  signal?: AbortSignal,
): Promise<WorkspaceTree> {
  const response = await fetch(workspaceTreeUrl(input), { signal, credentials: "same-origin" });
  if (!response.ok) throw new WorkspaceRequestError(response.status, await readError(response));
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    data?: unknown;
    error?: { message?: string };
  } | null;
  if (body?.ok !== true)
    throw new WorkspaceRequestError(500, body?.error?.message ?? "工作区响应无法解析");
  const parsed = workspaceTreeSchema.safeParse(body.data);
  if (!parsed.success) throw new WorkspaceRequestError(500, "工作区响应无法解析");
  return parsed.data;
}

/** 文本类预览限制在 2 MiB：再大就不是「看一眼」，而是把整个日志塞进 DOM。 */
export const WORKSPACE_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

export async function fetchWorkspaceText(input: WorkspaceQuery, signal?: AbortSignal) {
  const response = await fetch(workspaceFileUrl(input), {
    signal,
    credentials: "same-origin",
    headers: { range: `bytes=0-${WORKSPACE_TEXT_PREVIEW_BYTES - 1}` },
  });
  if (!response.ok && response.status !== 206)
    throw new WorkspaceRequestError(response.status, await readError(response));
  const text = await response.text();
  const total = Number(/\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1] ?? "0");
  return { text, truncated: total > text.length };
}

/**
 * 媒体字节不走元素自己的 src：dev server 把 `Sec-Fetch-Dest: image|video|audio` 的请求交给
 * 静态资源中间件，不进应用路由（回 Cannot GET），而 fetch 的 Sec-Fetch-Dest 是 empty。
 * 和消息附件同样的做法，dev 与生产行为一致。
 */
export function useWorkspaceBlob(url: string): { url?: string; error?: string } {
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setState({});
    fetch(url, { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response));
        objectUrl = URL.createObjectURL(await response.blob());
        if (active) setState({ url: objectUrl });
        else URL.revokeObjectURL(objectUrl);
      })
      .catch((error: unknown) => {
        if (active) setState({ error: error instanceof Error ? error.message : "读取失败" });
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  return state;
}
