import type { ComponentType, ReactNode } from "react";
import { Outlet, createRootRoute, createRoute } from "@tanstack/react-router";
import { ChatScenes } from "./index";
import { chatsSearchSchema } from "@/components/chat/chat-search";

export const DEMO_PROJECT_ID = "prj_11111111-1111-4111-8111-111111111111";
export const DEMO_CHAT_ID = "cnv_44444444-4444-4444-8444-444444444444";
export const DEMO_CHATS_PATH = `/projects/${DEMO_PROJECT_ID}/chats`;
export const DEMO_DEFAULT_PATH = `${DEMO_CHATS_PATH}/${DEMO_CHAT_ID}?info=1`;

/**
 * 开发场景的最小路由：只有 Chats 的列表与详情两条路径，与正式路由的
 * pathname / search 语义一致，所以场景里的列表链接、返回与 `?info=1`
 * 都走真实导航而不是本地 state。
 *
 * `wrap` 用来套真实外壳：宿主传入一个使用 useLocation / useRouter 的组件，
 * 因此 AppShell 的 sidebarWidth 与 rail 判定和正式页面同源。
 * 生产构建不包含本目录，也不新增产品路由。
 */
/** 不套产品外壳时的透明容器，保持路由树的形状一致。 */
function PlainShell({ children }: { children: ReactNode }) {
  return <div className="flex h-dvh min-h-0 flex-col">{children}</div>;
}

export function chatDemoRouteTree({
  scene,
  wrap,
}: {
  scene?: string;
  wrap?: ComponentType<{ children: ReactNode }>;
} = {}) {
  const Shell = wrap ?? PlainShell;
  const root = createRootRoute({
    component: () => (
      <Shell>
        <Outlet />
      </Shell>
    ),
  });
  const chats = createRoute({
    getParentRoute: () => root,
    path: "/projects/$projectId/chats",
    validateSearch: chatsSearchSchema,
    component: () => <ChatScenes scene={scene} />,
  });
  const chat = createRoute({
    getParentRoute: () => root,
    path: "/projects/$projectId/chats/$chatId",
    validateSearch: chatsSearchSchema,
    component: () => <ChatScenes scene={scene} />,
  });
  return root.addChildren([chats, chat]);
}
