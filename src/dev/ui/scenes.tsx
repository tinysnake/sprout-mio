import { useState } from "react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { ProjectFormDialog } from "../../components/project/project-form-dialog";
import { ProjectFacts } from "../../components/project/project-facts";
import { PageFrame } from "../../components/layout/page-frame";
import { ThemeToggle } from "../../components/layout/theme-toggle";
import { ChatEmptyState, ChatListPanel } from "../../components/chat/chat-list";
import { ChatWorkspace } from "../../components/layout/chat-workspace";
import { chatsSearchSchema } from "../../components/chat/chat-search";
import { createProjectInput, fieldErrorsFrom } from "../../contracts/project";
import type { Project } from "../../contracts/project";
import { AppShell, projectCreationFocusTarget } from "../../components/layout/app-shell";
import { Select } from "../../components/ui/select";
import { ChatScenes } from "../scenes/chat";
import { MachineScenes } from "../scenes/machine";
import { ManagementScenes } from "../scenes/management";
import {
  DEMO_REQUEST_ID,
  demoHumanName,
  demoProfiles,
  demoProject,
} from "../scenes/management/fixtures";
import { TaskScenes } from "../scenes/tasks";
import { Gallery } from "./gallery";

const entries = [
  ["components", "共享组件"],
  ["login", "登录与注册"],
  ["agents", "Agents"],
  ["agent-detail", "Agent 详情"],
  ["members", "Project 成员"],
  ["settings", "Project settings"],
  ["chat", "Chat 工作区"],
  ["chat-states", "Chat 状态"],
  ["chat-messages", "消息与追加"],
  ["chat-inspector", "Info Hub"],
  ["tasks", "Task 四态与详情"],
  ["machines", "Machines"],
] as const;
const requested = new URLSearchParams(location.search).get("scene") ?? "components";
const selected = entries.some(([value]) => value === requested) ? requested : "components";
const projectPath = `/projects/${demoProject.id}`;
const chatPath = `${projectPath}/chats/cnv_44444444-4444-4444-8444-444444444444`;

function ScenePicker() {
  return (
    <details className="fixed top-2 left-1/2 z-[100] -translate-x-1/2 text-xs">
      <summary className="cursor-pointer rounded-md border border-border bg-popover px-2 py-1 text-popover-foreground shadow-sm">
        开发演示
      </summary>
      <div className="mt-1 w-64 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
        <label htmlFor="development-scene">演示场景</label>
        <Select
          id="development-scene"
          value={selected}
          className="mt-2 w-full"
          onChange={(event) => {
            location.assign(`/__dev/ui/?scene=${event.target.value}`);
          }}
        >
          {entries.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <label className="mt-3 flex items-center gap-2">
          <input
            type="checkbox"
            defaultChecked={new URLSearchParams(location.search).get("projectFailure") === "1"}
            onChange={(event) => {
              const query = new URLSearchParams(location.search);
              query.set("projectFailure", event.target.checked ? "1" : "0");
              location.assign(`/__dev/ui/?${query}`);
            }}
          />
          模拟 Project 创建失败
        </label>
        <p className="mt-2 leading-5 text-muted-foreground">
          虚构样例与模拟操作，仅用于核对共享组件；不连接业务服务。
        </p>
      </div>
    </details>
  );
}

function SceneContent() {
  const current = useLocation();
  const navigate = useNavigate();
  const [notice, setNotice] = useState("");
  const [projects, setProjects] = useState<Project[]>([demoProject]);
  const [createOpen, setCreateOpen] = useState(false);
  if (selected === "components") return <Gallery />;
  if (selected === "login") return <ManagementScenes scene="login" embedded />;
  const pathname = current.pathname;
  const projectId = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const currentProject = projects.find((project) => project.id === projectId);
  const newlyCreated = currentProject && projectId !== demoProject.id;
  const chat = pathname.includes("/chats");
  const management = pathname.startsWith("/agents/")
    ? "agent-detail"
    : pathname === "/agents"
      ? "agents"
      : pathname.endsWith("/members")
        ? "members"
        : "settings";
  const chatScene =
    selected === "chat-states"
      ? "states"
      : selected === "chat-messages"
        ? "messages"
        : selected === "chat-inspector"
          ? "inspector"
          : "workspace";
  return (
    <AppShell
      projects={projects}
      projectId={projectId}
      pathname={pathname}
      inspectorOpen={
        chatScene === "workspace" &&
        /^\/projects\/[^/]+\/chats\/[^/]+$/.test(pathname) &&
        new URLSearchParams(current.searchStr).get("info") === "1"
      }
      name={demoHumanName}
      email="linche@example.test"
      pending={false}
      onSignOut={() => setNotice("演示：已点击登出；未创建或销毁真实会话。")}
      onCreateProject={() => setCreateOpen(true)}
    >
      {notice && (
        <p role="status" className="shrink-0 border-b border-border bg-secondary px-4 py-2 text-xs">
          {notice}
        </p>
      )}
      {selected === "tasks" ? (
        <TaskScenes />
      ) : selected === "machines" ? (
        <MachineScenes />
      ) : newlyCreated ? (
        chat ? (
          <ChatWorkspace
            selected={false}
            list={
              <ChatListPanel
                projectId={currentProject.id}
                chats={[]}
                chatAgents={[]}
                profiles={[]}
              />
            }
            chat={
              <ChatEmptyState
                title="选择一条 Chat"
                body="这个演示 Project 尚未加入 Agent。切回 Sprout 重构可查看成员操作场景。"
              />
            }
          />
        ) : (
          <PageFrame
            title={management === "members" ? "Project 成员" : "Project settings"}
            description="此处展示刚创建的演示 Project。切回 Sprout 重构可查看完整编辑与成员操作场景。"
            actions={<ThemeToggle />}
          >
            <ProjectFacts project={currentProject} requestId={DEMO_REQUEST_ID} />
          </PageFrame>
        )
      ) : chat ? (
        <ChatScenes scene={chatScene} />
      ) : (
        <ManagementScenes scene={management} embedded />
      )}
      <ProjectFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        finalFocus={() => projectCreationFocusTarget()}
        submit={async (values) => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const parsed = createProjectInput.safeParse(values);
          if (!parsed.success)
            return {
              ok: false,
              error: {
                code: "validation_failed",
                message: "演示：输入校验失败",
                requestId: DEMO_REQUEST_ID,
              },
              requestId: DEMO_REQUEST_ID,
              fieldErrors: fieldErrorsFrom(parsed.error),
            };
          if (new URLSearchParams(location.search).get("projectFailure") === "1")
            return {
              ok: false,
              error: {
                code: "internal",
                message: "演示：创建失败，请保留输入后重试。",
                requestId: DEMO_REQUEST_ID,
              },
              requestId: DEMO_REQUEST_ID,
            };
          const now = new Date().toISOString();
          return {
            ok: true,
            data: {
              ...parsed.data,
              id: `prj_${crypto.randomUUID()}`,
              createdAt: now,
              updatedAt: now,
            },
            requestId: DEMO_REQUEST_ID,
          };
        }}
        onCreated={(project) => {
          setProjects((previous) => [...previous, project]);
          void navigate({ to: "/projects/$projectId/chats", params: { projectId: project.id } });
        }}
      />
      <Outlet />
    </AppShell>
  );
}

function initialPath() {
  if (selected === "machines") return "/machines";
  if (selected.startsWith("chat")) return `${chatPath}?info=1`;
  if (selected === "agents") return "/agents";
  if (selected === "agent-detail") return `/agents/${demoProfiles[0]!.id}`;
  if (selected === "members") return `${projectPath}/members`;
  if (selected === "settings") return `${projectPath}/settings`;
  return "/";
}

const root = createRootRoute({ component: SceneContent });
const route = (path: string) =>
  createRoute({
    getParentRoute: () => root,
    path,
    validateSearch: path.includes("/chats") ? chatsSearchSchema : undefined,
    component: () => null,
  });
const router = createRouter({
  routeTree: root.addChildren([
    route("/"),
    route("/projects"),
    route("/projects/$projectId/chats"),
    route("/projects/$projectId/chats/$chatId"),
    route("/projects/$projectId/settings"),
    route("/projects/$projectId/members"),
    route("/agents"),
    route("/agents/$agentProfileId"),
    route("/machines"),
    route("/machines/$machineId"),
    route("/machines/$machineId/lease"),
  ]),
  history: createMemoryHistory({ initialEntries: [initialPath()] }),
});

export function SceneWorkbench() {
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <ScenePicker />
      <RouterProvider router={router} />
    </div>
  );
}
