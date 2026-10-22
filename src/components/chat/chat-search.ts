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
