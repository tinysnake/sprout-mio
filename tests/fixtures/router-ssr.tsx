import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * 组件内部使用 TanStack Router 的 Link，静态渲染前需要一个已加载的 router 上下文
 * （否则 Link 读不到 router，抛 “useRouter must be used inside a <RouterProvider>”）。
 * 传入 path 时按该路径模式挂一个承载元素的路由，url 用具体地址，用来覆盖 Link 的
 * 活动态（当前轮次的 aria-current 由 router 的 Link 活动态给出）。
 */
export async function renderWithRouter(
  element: ReactElement,
  options: { path?: string; url?: string } = {},
) {
  const { path = "/", url = path } = options;
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => element,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}
