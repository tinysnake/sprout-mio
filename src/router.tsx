import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    // 滚动恢复关闭：本项目的滚动容器是页面内层 div 而不是 window，Router 的
    // window 级恢复对本应用无效，却会把上一页的滚动量带到新路由上（例如从
    // Project settings 底部进入租约页会直接停在底部）。各页面自行决定滚动行为。
    scrollRestoration: false,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
