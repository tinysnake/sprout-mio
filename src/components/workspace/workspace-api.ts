import { useEffect, useState } from "react";
import type { WorkspaceEntry } from "../../contracts/workspace";
import { workspaceTreeSchema } from "../../contracts/workspace";
import { machineTreeSchema } from "../../contracts/machine-browse";

/**
 * 树、预览、新标签页三个入口都从同一个来源算 URL，参数不能各拼各的：
 * workspace 读 server 本机的工作区，machine 读那台机器上的项目工作目录。
 */
export type WorkspaceSource =
  | { readonly kind: "workspace"; readonly projectId: string; readonly chatId?: string }
  | { readonly kind: "machine"; readonly projectId: string; readonly machineId: string };

function query(source: WorkspaceSource, path: string) {
  const params = new URLSearchParams({ projectId: source.projectId, path });
  if (source.kind === "workspace" && source.chatId) params.set("chatId", source.chatId);
  if (source.kind === "machine") params.set("machineId", source.machineId);
  return params.toString();
}

export function fileUrlOf(source: WorkspaceSource, path: string) {
  const prefix = source.kind === "machine" ? "/api/machine/file" : "/api/workspace/file";
  return `${prefix}?${query(source, path)}`;
}

export function treeUrlOf(source: WorkspaceSource, path: string) {
  const prefix = source.kind === "machine" ? "/api/machine/tree" : "/api/workspace/tree";
  return `${prefix}?${query(source, path)}`;
}

/**
 * 「新标签页打开」指向应用自己的整页预览，不是字节接口：
 * md / csv 这类文件的响应类型会让浏览器显示源码，整页预览才和嵌入视图一致。
 */
export function viewerUrlOf(source: WorkspaceSource, path: string, chatId?: string) {
  const params = new URLSearchParams({ path });
  if (source.kind === "workspace") {
    params.set("chatId", source.chatId ?? "");
    return `/projects/${source.projectId}/files?${params.toString()}`;
  }
  // 机器预览页的「回到对话」需要知道是哪个 Chat；从右栏点开时一定有。
  if (chatId) params.set("chatId", chatId);
  return `/projects/${source.projectId}/machines/${source.machineId}/files?${params.toString()}`;
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

export type TreePayload = {
  readonly entries: readonly WorkspaceEntry[];
  readonly truncated: boolean;
  /** 本机工作区的来源；机器树没有这个概念。 */
  readonly root?: "repository" | "workspace";
  readonly machineName?: string;
};

export async function fetchTree(
  source: WorkspaceSource,
  path: string,
  signal?: AbortSignal,
): Promise<TreePayload> {
  const response = await fetch(treeUrlOf(source, path), { signal, credentials: "same-origin" });
  if (!response.ok) throw new WorkspaceRequestError(response.status, await readError(response));
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    data?: unknown;
    error?: { message?: string };
  } | null;
  if (body?.ok !== true)
    throw new WorkspaceRequestError(500, body?.error?.message ?? "工作区响应无法解析");
  if (source.kind === "machine") {
    const parsed = machineTreeSchema.safeParse(body.data);
    if (!parsed.success) throw new WorkspaceRequestError(500, "机器目录响应无法解析");
    return {
      entries: parsed.data.entries,
      truncated: parsed.data.truncated,
      machineName: parsed.data.machineName,
    };
  }
  const parsed = workspaceTreeSchema.safeParse(body.data);
  if (!parsed.success) throw new WorkspaceRequestError(500, "工作区响应无法解析");
  return { entries: parsed.data.entries, truncated: parsed.data.truncated, root: parsed.data.root };
}

/** 文本类预览限制在 2 MiB：再大就不是「看一眼」，而是把整个日志塞进 DOM。 */
export const WORKSPACE_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

export async function fetchFileText(url: string, signal?: AbortSignal) {
  const response = await fetch(url, {
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
