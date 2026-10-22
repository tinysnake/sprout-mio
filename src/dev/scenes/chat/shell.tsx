import type { ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import type { Project } from "../../../contracts/project";
import { DEMO_PROJECT_ID } from "./router";

const projects: Project[] = [
  {
    id: DEMO_PROJECT_ID,
    name: "演示 Project",
    description: "Chat 场景的固定样例",
    createdAt: "2026-06-18T02:00:00.000Z",
    updatedAt: "2026-06-18T02:00:00.000Z",
  },
];

/**
 * 开发宿主外壳：真实 AppShell 包住场景。pathname 与 `?info=1` 都来自同一个
 * router，因此侧栏 rail、三栏宽度与正式页面由同一份布局决定。
 * 这里的账号与 Project 是虚构样例，没有真实服务调用。
 */
export function ChatDemoShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const inspectorOpen = new URLSearchParams(location.searchStr).get("info") === "1";
  return (
    <AppShell
      projects={projects}
      projectId={DEMO_PROJECT_ID}
      pathname={location.pathname}
      inspectorOpen={inspectorOpen}
      name="林澈"
      email="demo@sprout.local"
      pending={false}
      onSignOut={() => undefined}
      createProjectAction={
        <Button variant="ghost" disabled className="w-full justify-start">
          创建 Project（演示）
        </Button>
      }
    >
      {children}
    </AppShell>
  );
}
