import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import "../../../styles.css";
import { initTheme } from "../../../lib/theme";
import { ChatDemoShell } from "./shell";
import { DEMO_DEFAULT_PATH, chatDemoRouteTree } from "./router";

// 开发页没有根路由的 head script，首帧前在这里应用已保存的主题。
initTheme();

const params = new URLSearchParams(window.location.search);
const scene = params.get("scene") ?? undefined;
const initialPath = params.get("path") ?? DEMO_DEFAULT_PATH;
// `?shell=0` 只渲染场景本身；默认套真实 AppShell，因此侧栏、rail 与列宽
// 和正式页面由同一份布局决定。场景仍然跑在同一条 memory router 上，
// 列表链接与 `?info=1` 都是真实导航。
const useShell = params.get("shell") !== "0";

const router = createRouter({
  routeTree: chatDemoRouteTree({ scene, wrap: useShell ? ChatDemoShell : undefined }),
  history: createMemoryHistory({ initialEntries: [initialPath] }),
  defaultPreload: false,
});

const container = document.getElementById("root");
if (!container) throw new Error("dev chat scene 缺少 #root 挂载点");

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
