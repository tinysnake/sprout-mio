import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    // 滚动恢复关闭：本项目的滚动容器是页面内层 div 而不是 window，Router 的
    // window 级恢复对本应用无效，却会把上一页的滚动量带到新路由上（例如从
    // Project settings 底部进入租约页会直接停在底部）。各页面自行决定滚动行为。
    scrollRestoration: false,
    // intent 预加载结果留两秒：hover 或 touchstart 触发的预加载与随后的点击原本各跑一遍整链，
    // 本机实测一次点击因此发出 17 个请求，其中 8 个是重复的；留两秒后降到 9 个。
    // 留太久会让点击直接看到陈旧的 loader 事实，两秒覆盖「预加载刚结束就点」这个真实窗口。
    defaultPreload: "intent",
    defaultPreloadStaleTime: 2_000,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
