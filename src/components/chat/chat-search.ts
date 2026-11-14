import { useCallback } from "react";
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

export function useChatFile(projectId: string, chatId?: string) {
  const search = useSearch({ from: CHATS_ROUTE_ID });
  const navigate = useNavigate();
  const file = search.file;
  const open = useCallback(
    (path: string) => {
      if (!chatId) return;
      void navigate({
        to: "/projects/$projectId/chats/$chatId",
        params: { projectId, chatId },
        search: (previous) => ({ ...previous, file: path }),
        replace: true,
      });
    },
    [chatId, navigate, projectId],
  );
  const close = useCallback(() => {
    if (!chatId) return;
    void navigate({
      to: "/projects/$projectId/chats/$chatId",
      params: { projectId, chatId },
      search: (previous) => ({ ...previous, file: undefined }),
      replace: true,
    });
  }, [chatId, navigate, projectId]);
  return { file, open, close };
}
