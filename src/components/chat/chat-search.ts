import { useCallback, useMemo } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { z } from "zod";

/** 父 Chats 路由的 id：详情页读同一份 search，不依赖上一个页面留下的对象。 */
export const CHATS_ROUTE_ID = "/_authed/projects/$projectId/chats";

/**
 * inspector 的开关由 URL 表达：`?info=1` 打开，关闭时删除该参数。
 * 无法解析的值一律当作关闭，不把坏 URL 变成打开状态。
 */
export const chatsSearchSchema = z.object({
  info: z.coerce.number().int().min(0).max(1).optional().catch(undefined),
  /** 右栏当前页签：信息还是文件。缺省是信息，坏值一并当作缺省。 */
  pane: z.enum(["info", "files"]).optional().catch(undefined),
  /**
   * 正在中栏预览的工作区文件（相对工作区根的路径）。放在 URL 里，
   * 刷新、前进后退和「复制链接给同事」都能回到同一个文件。
   */
  file: z.string().min(1).optional().catch(undefined),
  /** 中栏打开着的文件页签，逗号分隔、逐段 URI 编码；详情见 decodeOpenFiles。 */
  files: z.string().optional().catch(undefined),
  /**
   * 右栏的文件树改看哪台机器上的项目目录。缺省是本 Chat 的工作区；
   * 机器在不在线、能不能读由服务端判，URL 只记用户点了哪台。
   */
  machine: z.string().min(1).optional().catch(undefined),
});

export type ChatsSearch = z.infer<typeof chatsSearchSchema>;

/**
 * 打开或关闭当前 Chat 的 inspector，保留 search 里的其他参数。
 * 关闭时用 replace：URL 是唯一状态，直接打开 `?info=1` 的用户按关闭不会
 * 退出应用，也不会在历史里留下一个“再点一下又打开”的中间项。
 */
export function useChatInspector(projectId: string, chatId?: string) {
  const search = useSearch({ from: CHATS_ROUTE_ID });
  const navigate = useNavigate();
  const open = search.info === 1;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!chatId) return;
      void navigate({
        to: "/projects/$projectId/chats/$chatId",
        params: { projectId, chatId },
        search: (previous) => ({ ...previous, info: next ? 1 : undefined }),
        replace: !next,
      });
    },
    [navigate, projectId, chatId],
  );
  return { open, setOpen };
}

export type ChatSidePane = "info" | "files";

/** 右栏页签与文件预览都住在 URL 里，组件只读不各存一份状态。 */
export function useChatSidePane(projectId: string, chatId?: string) {
  const search = useSearch({ from: CHATS_ROUTE_ID });
  const navigate = useNavigate();
  const pane: ChatSidePane = search.pane === "files" ? "files" : "info";
  const setPane = useCallback(
    (next: ChatSidePane) => {
      if (!chatId) return;
      void navigate({
        to: "/projects/$projectId/chats/$chatId",
        params: { projectId, chatId },
        search: (previous) => ({
          ...previous,
          info: 1,
          pane: next === "info" ? undefined : next,
        }),
        replace: true,
      });
    },
    [chatId, navigate, projectId],
  );
  return { pane, setPane };
}

/**
 * 标题栏那个「工作区文件」按钮：右栏不在文件页签上就切过去，已经在就切回信息。
 * 两个页签都在右栏头部，所以这个按钮永远有可见的结果，不会点成「什么都没发生」。
 */
export function useChatFilesEntry(projectId: string, chatId?: string) {
  const { pane, setPane } = useChatSidePane(projectId, chatId);
  const { open } = useChatInspector(projectId, chatId);
  const filesOpen = open && pane === "files";
  const toggleFiles = useCallback(() => {
    setPane(filesOpen ? "info" : "files");
  }, [filesOpen, setPane]);
  return { filesOpen, toggleFiles };
}

/**
 * 从租约那一行跳到那台机器的文件树：换的是右栏的文件来源，不换对话、
 * 不要求租约还在手上。传 `undefined` 回到 Chat 自己的工作区。
 */
export function useMachineBrowse(projectId: string, chatId?: string) {
  const search = useSearch({ from: CHATS_ROUTE_ID });
  const navigate = useNavigate();
  const current = search.machine;
  return useCallback(
    (machineId?: string) => {
      if (!chatId) return;
      const switching = machineId !== current;
      void navigate({
        to: "/projects/$projectId/chats/$chatId",
        params: { projectId, chatId },
        search: (previous) => ({
          ...previous,
          info: 1,
          pane: "files",
          machine: machineId,
          // 换来源时页签一起收起：机器上的路径回到本机工作区就是另一份文件。
          ...(switching ? { file: undefined, files: undefined } : {}),
        }),
        replace: true,
      });
    },
    [chatId, current, navigate, projectId],
  );
}

/** 逗号在文件名里是合法字符，所以路径先整段编码再拼，解码时逐段还原。 */
const OPEN_FILE_SEPARATOR = ",";

export function decodeOpenFiles(raw?: string): string[] {
  if (!raw) return [];
  const files: string[] = [];
  for (const part of raw.split(OPEN_FILE_SEPARATOR)) {
    if (!part) continue;
    try {
      const path = decodeURIComponent(part);
      if (path && !files.includes(path)) files.push(path);
    } catch {
      // 坏段落当不存在，不因为一个参数就让整个列表失效。
    }
  }
  return files;
}

export function encodeOpenFiles(paths: readonly string[]): string | undefined {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return undefined;
  return unique.map((path) => encodeURIComponent(path)).join(OPEN_FILE_SEPARATOR);
}

/**
 * 中栏的文件页签：没打开过的文件开新页签，打开过的只切换，
 * 「聊天」页签保留页签列表，关闭单个页签才真的移除。
 */
export function useChatFile(projectId: string, chatId?: string) {
  const search = useSearch({ from: CHATS_ROUTE_ID });
  const navigate = useNavigate();
  const files = useMemo(() => decodeOpenFiles(search.files), [search.files]);
  const file = search.file;
  const go = useCallback(
    (next: { files: string[]; file?: string }) => {
      if (!chatId) return;
      void navigate({
        to: "/projects/$projectId/chats/$chatId",
        params: { projectId, chatId },
        search: (previous) => ({
          ...previous,
          files: encodeOpenFiles(next.files),
          file: next.file,
        }),
        replace: true,
      });
    },
    [chatId, navigate, projectId],
  );
  const open = useCallback(
    (path: string) => {
      go({ files: files.includes(path) ? files : [...files, path], file: path });
    },
    [files, go],
  );
  const activate = useCallback((path?: string) => go({ files, file: path }), [files, go]);
  const closeTab = useCallback(
    (path: string) => {
      const index = files.indexOf(path);
      const rest = files.filter((entry) => entry !== path);
      const next = file === path ? (rest[index] ?? rest[index - 1]) : file;
      go({ files: rest, file: next });
    },
    [file, files, go],
  );
  return { file, files, open, activate, closeTab };
}
