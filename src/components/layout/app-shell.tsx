import { Popover } from "@base-ui/react/popover";
import { Link } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  FolderKanban,
  LogOut,
  MessageSquare,
  Monitor,
  Settings2,
  Users,
  Bot,
  Plus,
} from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Project } from "../../contracts/project";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ThemeMenuToggle } from "./theme-toggle";

const ShellContext = createContext<{ sidebarWidth: number; openProjectCreation: () => void }>({
  sidebarWidth: 200,
  openProjectCreation: () => {
    throw new Error("新建 Project 需要 AppShell 上下文");
  },
});

export function projectCreationFocusTarget(preferred?: HTMLElement | null) {
  if (preferred?.isConnected && preferred.getClientRects().length) return preferred;
  return (
    document.querySelector<HTMLElement>('[data-testid="project-selector"]') ??
    document.querySelector<HTMLElement>('[data-testid="mobile-projects"]')
  );
}

export function useAppShell() {
  return useContext(ShellContext);
}

function useViewportWidth() {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return width;
}

function preference(name: string) {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

const navClass =
  "flex min-h-[38px] w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const popupClass =
  "z-50 max-h-[min(70dvh,480px)] min-w-56 overflow-y-auto rounded-container border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none";

type ProjectNavigationProps = {
  project?: Project;
  pathname: string;
  close?: () => void;
  compact?: boolean;
};

function ProjectNavigation({ project, pathname, close, compact }: ProjectNavigationProps) {
  if (!project)
    return <p className="px-2.5 py-2 text-xs text-muted-foreground">创建 Project 后开始协作</p>;
  const active = (suffix: string) => pathname.includes(`/projects/${project.id}/${suffix}`);
  const selectedClass = "bg-selected text-foreground [&_svg]:text-primary";
  return (
    <nav aria-label="Project 导航" data-testid="project-submenu" className="space-y-1">
      <Link
        to="/projects/$projectId/chats"
        params={{ projectId: project.id }}
        onClick={close}
        aria-label="Chats"
        aria-current={active("chats") ? "page" : undefined}
        title={compact ? "Chats" : undefined}
        data-testid="tab-chats"
        className={`${navClass} ${active("chats") ? selectedClass : ""} ${compact ? "justify-center px-0" : ""}`}
      >
        <Icon as={MessageSquare} />
        {!compact && <span>Chats</span>}
      </Link>
      <Link
        to="/projects/$projectId/members"
        params={{ projectId: project.id }}
        onClick={close}
        aria-label="Members"
        aria-current={active("members") ? "page" : undefined}
        title={compact ? "Members" : undefined}
        data-testid="tab-agents"
        className={`${navClass} ${active("members") ? selectedClass : ""} ${compact ? "justify-center px-0" : ""}`}
      >
        <Icon as={Users} />
        {!compact && <span>Members</span>}
      </Link>
      <Link
        to="/projects/$projectId/settings"
        params={{ projectId: project.id }}
        onClick={close}
        aria-label="Project settings"
        aria-current={active("settings") ? "page" : undefined}
        title={compact ? "Project settings" : undefined}
        data-testid="tab-settings"
        className={`${navClass} ${active("settings") ? selectedClass : ""} ${compact ? "justify-center px-0" : ""}`}
      >
        <Icon as={Settings2} />
        {!compact && <span>Project settings</span>}
      </Link>
    </nav>
  );
}

function ProjectSelector({
  projects,
  project,
  compact,
  onCreateProject,
}: {
  projects: Project[];
  project?: Project;
  compact?: boolean;
  onCreateProject: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [project?.id]);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid="project-selector"
        aria-label={`切换 Project：${project?.name ?? "选择 Project"}`}
        className={`flex h-10 min-w-0 items-center gap-2 rounded-control border border-border bg-background px-3 text-xs font-medium hover:border-input ${compact ? "w-10 justify-center px-0" : "w-full"}`}
      >
        <Icon as={FolderKanban} />
        {!compact && (
          <>
            <span className="min-w-0 flex-1 truncate text-left">
              {project?.name ?? "选择 Project"}
            </span>
            <Icon as={ChevronDown} size={12} />
          </>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
          <Popover.Popup className={popupClass}>
            <Popover.Title className="px-2.5 py-2 text-[11px] text-muted-foreground">
              切换 Project
            </Popover.Title>
            {projects.map((item) => (
              <Link
                key={item.id}
                to="/projects/$projectId/chats"
                params={{ projectId: item.id }}
                onClick={() => setOpen(false)}
                data-testid="project-option"
                data-project-id={item.id}
                aria-current={item.id === project?.id ? "true" : undefined}
                className={`${navClass} ${item.id === project?.id ? "bg-selected text-foreground" : ""}`}
              >
                <Icon as={FolderKanban} />
                <span className="min-w-0 truncate">{item.name}</span>
              </Link>
            ))}
            <div className="mt-1 border-t border-border pt-1.5">
              <Button
                variant="ghost"
                data-testid="new-project-trigger"
                className="w-full justify-start"
                onClick={() => {
                  setOpen(false);
                  onCreateProject();
                }}
              >
                <Icon as={Plus} />
                新建 Project
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AccountMenu({
  name,
  email,
  compact,
  pending,
  onSignOut,
  error,
}: {
  name: string;
  email: string;
  compact?: boolean;
  pending: boolean;
  onSignOut: () => void;
  error?: string | null;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="账号菜单"
        data-testid="account-menu"
        className={`flex min-h-8.5 w-full items-center gap-2 rounded-control px-1.5 hover:bg-hover max-desktop:min-h-11 ${compact ? "justify-center px-0" : ""}`}
      >
        <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
          {name.slice(0, 1)}
        </span>
        {!compact && <span className="min-w-0 flex-1 truncate text-left text-xs">{name}</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={6} className="z-50">
          <Popover.Popup className={popupClass}>
            <Popover.Title className="px-2.5 pt-2 text-xs font-medium">{name}</Popover.Title>
            <p
              data-testid="session-email"
              className="max-w-64 break-all px-2.5 py-2 text-xs text-muted-foreground"
            >
              {email}
            </p>
            <ThemeMenuToggle />
            <Button
              variant="ghost"
              data-testid="sign-out"
              disabled={pending}
              onClick={onSignOut}
              className="w-full justify-start"
            >
              <Icon as={LogOut} />
              {pending ? "正在登出…" : "登出"}
            </Button>
            {error && (
              <p role="alert" className="px-2.5 py-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function AppShell({
  projects,
  projectId,
  pathname,
  inspectorOpen,
  name,
  email,
  pending,
  onSignOut,
  signOutError,
  onCreateProject,
  children,
}: {
  projects: Project[];
  projectId?: string;
  pathname: string;
  inspectorOpen: boolean;
  name: string;
  email: string;
  pending: boolean;
  onSignOut: () => void;
  signOutError?: string | null;
  onCreateProject: () => void;
  children: ReactNode;
}) {
  const width = useViewportWidth();
  const mobile = width <= 900;
  const [collapsed, setCollapsed] = useState(
    () => preference("sprout:sidebar-collapsed") === "true",
  );
  const [expanded, setExpanded] = useState(true);
  const [mobileProjectsOpen, setMobileProjectsOpen] = useState(false);
  const [preferredProject, setPreferredProject] = useState(() => preference("sprout:last-project"));
  const compact = collapsed || (width < 1200 && inspectorOpen);
  const sidebarWidth = mobile ? 0 : compact ? 64 : 200;
  const project = projectId
    ? projects.find((p) => p.id === projectId)
    : (projects.find((p) => p.id === preferredProject) ?? projects[0]);
  const agentPage = pathname.startsWith("/agents");
  useEffect(() => {
    setMobileProjectsOpen(false);
  }, [pathname, mobile]);
  useEffect(() => {
    if (!projectId || project?.id !== projectId) return;
    setPreferredProject(projectId);
    try {
      localStorage.setItem("sprout:last-project", projectId);
    } catch {
      /* Storage is optional. */
    }
  }, [projectId, project?.id]);
  useEffect(() => {
    try {
      localStorage.setItem("sprout:sidebar-collapsed", String(collapsed));
    } catch {
      /* Storage is optional. */
    }
  }, [collapsed]);

  function openProjectCreation() {
    setMobileProjectsOpen(false);
    onCreateProject();
  }

  return (
    <ShellContext.Provider value={{ sidebarWidth, openProjectCreation }}>
      <div
        data-testid="app-shell"
        data-sidebar-width={sidebarWidth}
        className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-background min-[901px]:flex-row"
      >
        {!mobile && (
          <aside
            aria-label="应用导航"
            data-testid="app-sidebar"
            className={`flex min-h-0 shrink-0 flex-col border-r border-border bg-sidebar px-2.5 ${compact ? "w-16" : "w-[200px]"}`}
          >
            <div className="-mx-2.5 mb-2.5 flex h-[63px] shrink-0 items-center border-b border-border px-2.5">
              <ProjectSelector
                projects={projects}
                project={project}
                compact={compact}
                onCreateProject={openProjectCreation}
              />
            </div>
            <nav aria-label="一级导航" className="min-h-0 flex-1 overflow-y-auto py-2">
              <button
                type="button"
                data-testid="nav-projects"
                aria-label="Projects"
                aria-expanded={expanded}
                aria-controls="desktop-project-links"
                onClick={() => setExpanded((v) => !v)}
                className={`${navClass} ${compact ? "justify-center px-0" : ""}`}
              >
                <Icon as={FolderKanban} />
                {!compact && (
                  <>
                    <span className="flex-1">Projects</span>
                    <Icon as={ChevronDown} size={12} className={expanded ? "" : "-rotate-90"} />
                  </>
                )}
              </button>
              {expanded && (
                <div id="desktop-project-links" className={compact ? "py-1" : "py-1 pl-6"}>
                  <ProjectNavigation project={project} pathname={pathname} compact={compact} />
                </div>
              )}
              <Link
                to="/agents"
                data-testid="nav-agents"
                aria-label="Agents"
                aria-current={agentPage ? "page" : undefined}
                title={compact ? "Agents" : undefined}
                className={`${navClass} mt-2 ${agentPage ? "bg-selected text-foreground [&_svg]:text-primary" : ""} ${compact ? "justify-center px-0" : ""}`}
              >
                <Icon as={Bot} />
                {!compact && <span>Agents</span>}
              </Link>
              <div
                aria-label="Machines，未实现，P4"
                title="Machines · 未实现，P4"
                className={`${navClass} cursor-default ${compact ? "justify-center px-0" : ""}`}
              >
                <Icon as={Monitor} />
                {!compact && (
                  <span>
                    Machines<span className="block text-[9px] font-normal">未实现，P4</span>
                  </span>
                )}
              </div>
              <div
                aria-label="Management，未实现"
                title="Management · 未实现"
                className={`${navClass} cursor-default ${compact ? "justify-center px-0" : ""}`}
              >
                <Icon as={Settings2} />
                {!compact && (
                  <span>
                    Management<span className="block text-[9px] font-normal">未实现</span>
                  </span>
                )}
              </div>
            </nav>
            <div
              className={`shrink-0 border-t border-border py-2 ${compact ? "flex flex-col items-center gap-1" : "flex items-center gap-1"}`}
            >
              <div className={compact ? "flex justify-center" : "min-w-0 flex-1"}>
                <AccountMenu
                  name={name}
                  email={email}
                  compact={compact}
                  pending={pending}
                  onSignOut={onSignOut}
                  error={signOutError}
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                data-testid="toggle-sidebar"
                aria-label={compact ? "展开侧栏" : "收起侧栏"}
                aria-expanded={!compact}
                onClick={() => setCollapsed((v) => !v)}
                className="shrink-0"
              >
                <Icon as={compact ? ChevronsRight : ChevronsLeft} />
              </Button>
            </div>
          </aside>
        )}
        <main
          id="main-content"
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          {children}
        </main>
        {mobile && (
          <nav
            aria-label="一级导航"
            data-testid="mobile-primary-nav"
            className="grid shrink-0 grid-cols-5 items-stretch border-t border-border bg-sidebar px-2 pb-[max(6px,env(safe-area-inset-bottom))] pt-1"
          >
            <Popover.Root open={mobileProjectsOpen} onOpenChange={setMobileProjectsOpen}>
              <Popover.Trigger
                aria-label="Projects"
                data-testid="mobile-projects"
                className={`flex min-h-12 min-w-0 flex-col items-center justify-start gap-1 px-1 pt-1.5 text-[10px] ${!agentPage ? "text-primary" : "text-muted-foreground"}`}
              >
                <Icon as={FolderKanban} />
                <span className="max-w-full truncate">Projects</span>
                {/* 说明行始终占位，避免有说明的项把图标顶高。 */}
                <span aria-hidden="true" className="text-[9px] leading-3" />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner side="top" align="start" sideOffset={8} className="z-50">
                  <Popover.Popup className={popupClass}>
                    <Popover.Title className="sr-only">Project 导航</Popover.Title>
                    <ProjectSelector
                      projects={projects}
                      project={project}
                      onCreateProject={openProjectCreation}
                    />
                    <div className="mt-2">
                      <ProjectNavigation
                        project={project}
                        pathname={pathname}
                        close={() => setMobileProjectsOpen(false)}
                      />
                    </div>
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
            <Link
              to="/agents"
              aria-current={agentPage ? "page" : undefined}
              className={`flex min-h-12 min-w-0 flex-col items-center justify-start gap-1 px-1 pt-1.5 text-[10px] ${agentPage ? "text-primary" : "text-muted-foreground"}`}
            >
              <Icon as={Bot} />
              <span className="max-w-full truncate">Agents</span>
              <span aria-hidden="true" className="text-[9px] leading-3" />
            </Link>
            <span
              aria-label="Machines，未实现，P4"
              className="flex min-h-12 min-w-0 flex-col items-center justify-start gap-1 px-1 pt-1.5 text-[10px] text-muted-foreground"
            >
              <Icon as={Monitor} />
              <span className="max-w-full truncate">Machines</span>
              <span className="text-[9px] leading-3 whitespace-nowrap">未实现，P4</span>
            </span>
            <span
              aria-label="Management，未实现"
              className="flex min-h-12 min-w-0 flex-col items-center justify-start gap-1 px-1 pt-1.5 text-[10px] text-muted-foreground"
            >
              <Icon as={Settings2} />
              <span className="max-w-full truncate">Management</span>
              <span className="text-[9px] leading-3 whitespace-nowrap">未实现</span>
            </span>
            <div className="flex min-h-12 min-w-0 items-center justify-center">
              <AccountMenu
                name={name}
                email={email}
                compact
                pending={pending}
                onSignOut={onSignOut}
                error={signOutError}
              />
            </div>
          </nav>
        )}
      </div>
    </ShellContext.Provider>
  );
}
