import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { ReactNode } from "react";

function SceneOutlet({ childrenRef }: { childrenRef: { current: ReactNode } }) {
  return (
    <>
      <Outlet />
      {childrenRef.current}
    </>
  );
}

/**
 * 开发场景的最小路由上下文。正式呈现组件用的是真实 `Link`，
 * 没有 router 就无法渲染，因此在演示里挂一个 memory history：
 * 链接可点、路径含义与产品一致，但不会离开场景，也不会请求服务端。
 * 根路由始终渲染场景本身，子路由只负责吃掉导航。
 *
 * router 只在首次挂载时建立；场景内容通过 ref 传入，因此上层重渲染或
 * resize 不会重建 router，也不会重置场景里正在编辑的状态。
 */
export function SceneRouter({ children }: { children: ReactNode }) {
  const childrenRef = useRef(children);
  childrenRef.current = children;

  const [router] = useState(() => {
    const rootRoute = createRootRoute({
      component: () => <SceneOutlet childrenRef={childrenRef} />,
      notFoundComponent: () => null,
    });
    const empty = () => null;
    const route = (path: string) =>
      createRoute({ getParentRoute: () => rootRoute, path, component: empty });
    return createRouter({
      routeTree: rootRoute.addChildren([
        route("/"),
        route("/projects"),
        route("/projects/$projectId/chats"),
        route("/projects/$projectId/chats/$chatId"),
        route("/agents"),
        route("/agents/$agentProfileId"),
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  });

  return <RouterProvider router={router} />;
}
