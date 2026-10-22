import { useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { AgentFormDialog } from "../../../components/agent/agent-form-dialog";
import type { AgentFormValues } from "../../../components/agent/agent-form-dialog";
import { AgentProfileEditor } from "../../../components/agent/agent-profile-editor";
import type { AgentProfileDraft } from "../../../components/agent/agent-profile-editor";
import { AgentProfileList } from "../../../components/agent/agent-profile-list";
import { LoginView } from "../../../components/auth/login-view";
import type { LoginMode, LoginValues } from "../../../components/auth/login-view";
import { UnavailableNotice } from "../../../components/info-hub/unavailable-notice";
import { ProjectAgentsPanel } from "../../../components/info-hub/project-agents-panel";
import { PageFrame } from "../../../components/layout/page-frame";
import { ThemeToggle } from "../../../components/layout/theme-toggle";
import { ProjectBasicInfoForm } from "../../../components/project/project-basic-info-form";
import type { ProjectBasicInfoDraft } from "../../../components/project/project-basic-info-form";
import { ProjectFacts } from "../../../components/project/project-facts";
import { ProjectMembers } from "../../../components/project/project-members";
import { Facts, SettingsSection } from "../../../components/project/settings-section";
import { ProjectConfigForm } from "../../../components/project-config/project-config-form";
import type { ProjectConfigDraft } from "../../../components/project-config/project-config-form";
import { ProjectRepoPanel } from "../../../components/project-config/project-repo-panel";
import { Button } from "../../../components/ui/button";
import { Icon } from "../../../components/ui/icon";
import type { AgentProfile, ProjectMember } from "../../../contracts/agent";
import type { Project } from "../../../contracts/project";
import type { ProjectProfile } from "../../../contracts/project-config";
import type { AppError, AppResult, AppErrorCode } from "../../../contracts/result";
import {
  DEMO_REQUEST_ID,
  demoHumanName,
  demoInfoHub,
  demoMembers,
  demoProfiles,
  demoProject,
  demoProjectProfile,
  demoRepoState,
} from "./fixtures";
import { SceneRouter } from "./scene-router";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 固定的演示结果，标为 demo：不制造假 requestId 混入正式页面。 */
function demoSuccess<T>(data: T): AppResult<T> {
  return { ok: true, data, requestId: DEMO_REQUEST_ID };
}

function demoFailure<T>(code: AppErrorCode, message: string): AppResult<T> {
  return {
    ok: false,
    error: { code, message, requestId: DEMO_REQUEST_ID },
    requestId: DEMO_REQUEST_ID,
  };
}

function SceneControls({
  title,
  fail,
  onFailChange,
  status,
  children,
}: {
  title: string;
  fail: boolean;
  onFailChange: (fail: boolean) => void;
  status?: string;
  children?: ReactNode;
}) {
  return (
    <aside
      data-testid="scene-controls"
      className="fixed right-4 bottom-4 z-50 w-64 rounded-container border border-border bg-popover p-3 text-xs shadow-lg"
    >
      <p className="font-medium">演示控制 · {title}</p>
      <label className="mt-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={fail}
          data-testid="scene-fail"
          onChange={(event) => onFailChange(event.target.checked)}
        />
        模拟失败
      </label>
      {children}
      {status && (
        <p data-testid="scene-status" className="mt-2 leading-6 text-muted-foreground">
          {status}
        </p>
      )}
    </aside>
  );
}

/**
 * 场景容器。独立运行时占满视口；嵌入统一宿主时只占宿主给出的高度，
 * 让手机底部导航等宿主外框仍然可见，不靠 dvh 硬撑。
 */
function SceneShell({ children, embedded }: { children: ReactNode; embedded: boolean }) {
  return (
    <div
      className={
        embedded
          ? "flex min-h-0 flex-1 flex-col bg-background text-foreground"
          : "flex h-dvh flex-col bg-background text-foreground"
      }
    >
      {children}
    </div>
  );
}

function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to}>
      <Icon as={ArrowLeft} />
      {label}
    </Link>
  );
}

function LoginScene({ embedded }: { embedded: boolean }) {
  const [mode, setMode] = useState<LoginMode>("login");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [fail, setFail] = useState(false);
  const [accepted, setAccepted] = useState<LoginValues | null>(null);

  async function submit(values: LoginValues) {
    setPending(true);
    setError(null);
    setAccepted(null);
    await delay(700);
    if (fail) {
      setError({
        code: "unauthorized",
        message: "邮箱或密码不正确，请检查后重试。",
        requestId: DEMO_REQUEST_ID,
      });
    } else {
      setAccepted(values);
    }
    setPending(false);
  }

  return (
    <SceneShell embedded={embedded}>
      <LoginView
        embedded={embedded}
        mode={mode}
        onModeChange={(next) => {
          setMode(next);
          setError(null);
          setAccepted(null);
        }}
        pending={pending}
        error={error}
        onSubmit={(values) => void submit(values)}
      />
      <SceneControls
        title={mode === "login" ? "登录" : "注册"}
        fail={fail}
        onFailChange={setFail}
        status={accepted ? `演示：${accepted.email} 通过表单校验，未创建真实会话。` : undefined}
      />
    </SceneShell>
  );
}

function AgentsScene({ embedded }: { embedded: boolean }) {
  const [profiles, setProfiles] = useState<AgentProfile[]>(demoProfiles);
  const [open, setOpen] = useState(false);
  const [fail, setFail] = useState(false);
  const [status, setStatus] = useState("");

  async function submit(values: AgentFormValues): Promise<AppResult<AgentProfile>> {
    await delay(600);
    if (fail) return demoFailure("internal", "创建失败，请重试。");
    const now = new Date().toISOString();
    const jobTitle = values.jobTitle.trim();
    return demoSuccess<AgentProfile>({
      id: `agp_${crypto.randomUUID()}`,
      name: values.name,
      ...(jobTitle ? { jobTitle } : {}),
      persona: values.persona,
      harness: "pi",
      createdBy: "demo-human",
      createdAt: now,
      updatedAt: now,
    });
  }

  return (
    <SceneShell embedded={embedded}>
      <PageFrame
        title="Agents"
        description="当前账号创建的 Agent profile。选择一个查看或修改人设。"
        back={<BackLink to="/projects" label="返回 Projects" />}
        actions={
          <>
            <Button type="button" data-testid="new-agent-trigger" onClick={() => setOpen(true)}>
              新建 Agent
            </Button>
            <ThemeToggle />
          </>
        }
        testId="agents-page"
      >
        <AgentProfileList profiles={profiles} />
        <p className="mt-4 text-xs leading-6 text-muted-foreground">
          职位是人设的展示标签；没有额外的权限含义。
        </p>
      </PageFrame>
      <AgentFormDialog
        open={open}
        onOpenChange={setOpen}
        submit={submit}
        onCreated={(profile) => {
          setProfiles((current) => [...current, profile]);
          setStatus(`演示：已创建 ${profile.name}。`);
        }}
      />
      <SceneControls title="Agent 列表" fail={fail} onFailChange={setFail} status={status} />
    </SceneShell>
  );
}

function AgentDetailScene({ embedded }: { embedded: boolean }) {
  const { agentProfileId } = useParams({ strict: false }) as { agentProfileId?: string };
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const [profiles, setProfiles] = useState<AgentProfile[]>(demoProfiles);
  const [fail, setFail] = useState(false);
  const [status, setStatus] = useState("");
  const profile = agentProfileId
    ? profiles.find((item) => item.id === agentProfileId)
    : profiles[index];
  if (!profile) {
    return (
      <SceneShell embedded={embedded}>
        <PageFrame
          title="没有此 Agent 的演示数据"
          description="每个场景使用固定样例，跨场景导航会重置模拟修改。"
          back={<BackLink to="/agents" label="返回 Agents" />}
        />
      </SceneShell>
    );
  }

  const editingProfile = profile;
  async function submit(draft: AgentProfileDraft): Promise<AppResult<AgentProfile>> {
    await delay(700);
    if (fail) return demoFailure("forbidden", "没有修改此 profile 的权限。");
    const jobTitle = draft.jobTitle.trim();
    const model = draft.model.trim();
    const effort = draft.effort.trim();
    const next: AgentProfile = {
      ...editingProfile,
      name: draft.name,
      jobTitle: jobTitle || undefined,
      persona: draft.persona,
      model: model || undefined,
      effort: effort || undefined,
      updatedAt: new Date().toISOString(),
    };
    setProfiles((current) => current.map((item) => (item.id === next.id ? next : item)));
    setStatus("演示：人设已保存，下一轮运行生效。");
    return demoSuccess(next);
  }

  return (
    <SceneShell embedded={embedded}>
      <PageFrame
        title={profile.name}
        description={
          <>
            <span>{profile.jobTitle || "未设置职位"}</span>
            {" · Agent profile"}
          </>
        }
        back={<BackLink to="/agents" label="返回 Agents" />}
        actions={<ThemeToggle />}
        testId="agent-detail-page"
      >
        <SettingsSection
          title="Profile 信息"
          description="profile 的身份与宿主的 harness；修改人设不会重建分身。"
        >
          <Facts
            items={[
              {
                label: "Profile ID",
                value: <code className="font-mono text-[0.6875rem]">{profile.id}</code>,
              },
              { label: "harness", value: profile.harness },
              {
                label: "最近修改",
                value: (
                  <time dateTime={profile.updatedAt} title={profile.updatedAt}>
                    {new Date(profile.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                  </time>
                ),
              },
            ]}
          />
        </SettingsSection>
        <AgentProfileEditor
          key={profile.id}
          profile={profile}
          submit={submit}
          onSaved={() => undefined}
        />
      </PageFrame>
      <SceneControls title="Agent 详情" fail={fail} onFailChange={setFail} status={status}>
        <label className="mt-2 flex items-center gap-2">
          切换 profile
          <select
            className="min-w-0 flex-1 rounded-control border border-input bg-background px-1.5 py-1 text-xs"
            value={String(profiles.findIndex((item) => item.id === profile.id))}
            data-testid="scene-profile-select"
            onChange={(event) => {
              const next = Number(event.target.value);
              if (agentProfileId) {
                void navigate({
                  to: "/agents/$agentProfileId",
                  params: { agentProfileId: profiles[next]!.id },
                });
              } else {
                setIndex(next);
              }
              setStatus("");
            }}
          >
            {profiles.map((item, position) => (
              <option key={item.id} value={String(position)}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </SceneControls>
    </SceneShell>
  );
}

function MembersScene({ embedded }: { embedded: boolean }) {
  const [members, setMembers] = useState<ProjectMember[]>(demoMembers);
  const [fail, setFail] = useState(false);
  // profile 查询独立失败：成员与移除入口必须仍然可用。
  const [profilesMissing, setProfilesMissing] = useState(false);
  const [status, setStatus] = useState("");

  async function add(agentProfileId: string): Promise<AppResult<ProjectMember>> {
    await delay(600);
    if (fail) return demoFailure("conflict", "该 Agent 已加入 Project，不能重复添加。");
    const member: ProjectMember = {
      projectId: demoProject.id,
      agentProfileId,
      addedBy: "demo-human",
      addedAt: new Date().toISOString(),
    };
    setMembers((current) => [...current, member]);
    setStatus("演示：已添加 Agent 成员。");
    return demoSuccess(member);
  }

  async function remove(agentProfileId: string): Promise<AppResult<null>> {
    await delay(600);
    if (fail) return demoFailure("internal", "移除失败，成员仍在 Project 中，请重试。");
    setMembers((current) => current.filter((member) => member.agentProfileId !== agentProfileId));
    setStatus("演示：已移除 Agent 成员，全局 profile 仍保留。");
    return demoSuccess(null);
  }

  return (
    <SceneShell embedded={embedded}>
      <PageFrame
        title="Members"
        description="查看当前 Project 的 Human 与 Agent 成员，添加或移除 Agent。"
        back={<BackLink to={`/projects/${demoProject.id}/chats`} label="返回 Chats" />}
        actions={<ThemeToggle />}
        testId="project-members-page"
      >
        <ProjectMembers
          members={members}
          profiles={profilesMissing ? [] : demoProfiles}
          humanName={demoHumanName}
          add={add}
          remove={remove}
          onChanged={() => undefined}
        />
      </PageFrame>
      <SceneControls title="Members" fail={fail} onFailChange={setFail} status={status}>
        <label className="mt-2 flex items-center gap-2">
          <input
            type="checkbox"
            checked={profilesMissing}
            data-testid="scene-profiles-missing"
            onChange={(event) => setProfilesMissing(event.target.checked)}
          />
          模拟 profile 查询失败
        </label>
      </SceneControls>
    </SceneShell>
  );
}

function SettingsScene({ embedded }: { embedded: boolean }) {
  const [project, setProject] = useState<Project>(demoProject);
  const [profile, setProfile] = useState<ProjectProfile>(demoProjectProfile);
  const [fail, setFail] = useState(false);
  const [status, setStatus] = useState("");

  async function submitBasicInfo(draft: ProjectBasicInfoDraft): Promise<AppResult<Project>> {
    await delay(600);
    if (fail) return demoFailure("internal", "保存失败，已保留你的输入，请重试。");
    const next: Project = {
      ...project,
      name: draft.name,
      description: draft.description || undefined,
      updatedAt: new Date().toISOString(),
    };
    setProject(next);
    setStatus("演示：Project 基本信息已保存。");
    return demoSuccess(next);
  }

  async function submitConfig(draft: ProjectConfigDraft): Promise<AppResult<ProjectProfile>> {
    await delay(600);
    if (fail) return demoFailure("validation_failed", "演示：配置未通过校验。");
    const next: ProjectProfile = {
      projectId: project.id,
      defaultBranch: draft.defaultBranch,
      ...(draft.gitRemote.trim() ? { gitRemote: draft.gitRemote.trim() } : {}),
      ...(draft.workDirectory.trim() ? { workDirectory: draft.workDirectory.trim() } : {}),
      updatedAt: new Date().toISOString(),
    };
    setProfile(next);
    setStatus("演示：协作配置已保存。");
    return demoSuccess(next);
  }

  return (
    <SceneShell embedded={embedded}>
      <PageFrame
        title="Project settings"
        description="管理当前 Project 的基本信息与协作配置，查看 Chat 使用的仓库来源。"
        back={<BackLink to={`/projects/${project.id}/chats`} label="返回 Chats" />}
        actions={<ThemeToggle />}
        testId="project-settings-page"
      >
        <ProjectBasicInfoForm
          project={project}
          submit={submitBasicInfo}
          onSaved={() => undefined}
        />
        <SettingsSection
          title="基本事实"
          description="Project 的身份与本次查询的诊断标识；排查问题时可以引用 requestId。"
        >
          <ProjectFacts project={project} requestId={DEMO_REQUEST_ID} />
        </SettingsSection>
        <ProjectConfigForm profile={profile} submit={submitConfig} onSaved={() => undefined} />
        <ProjectRepoPanel
          state={demoRepoState}
          prepare={async () => {
            await delay(700);
            if (fail) return demoFailure("internal", "演示：仓库获取失败。");
            setStatus("演示：已按当前配置获取仓库工作副本。");
            return demoSuccess(demoRepoState);
          }}
          onRefresh={() => undefined}
        />
        <SettingsSection
          title="关联信息"
          description="原 Project 页面的 Info Hub 查询保留在这里：成员分身、活动与最近 run，以及尚未实现的 Machine 视角。"
        >
          <details data-testid="settings-info-hub" className="group">
            <summary
              data-testid="project-info-hub-toggle"
              className="flex cursor-pointer list-none items-center gap-1.5 text-xs underline decoration-input underline-offset-3 hover:decoration-foreground"
            >
              <Icon
                as={ChevronRight}
                size={12}
                className="transition-transform group-open:rotate-90"
              />
              展开 Project 的关联信息
            </summary>
            <div className="mt-4 flex flex-col gap-3">
              <ProjectAgentsPanel projectId={project.id} view={demoInfoHub.agents} />
              <UnavailableNotice
                testId="info-hub-machines-notice"
                title="Project 的 Machine 与租约"
                reason={demoInfoHub.machines.reason}
              />
            </div>
          </details>
        </SettingsSection>
      </PageFrame>
      <SceneControls title="Project settings" fail={fail} onFailChange={setFail} status={status} />
    </SceneShell>
  );
}

/**
 * 管理页的开发场景入口。场景本身不连接服务：固定数据加固定回调，
 * 用来检查正式组件的状态、浅暗主题与宽窄屏呈现。
 */
export function ManagementScenes({
  scene = "login",
  embedded = false,
}: {
  scene?: string;
  /**
   * `true` 表示由上层宿主提供布局与路由：这里不再包 SceneRouter、
   * 不占满视口，也不会因为宿主重渲染而重建 router 或重置场景状态。
   */
  embedded?: boolean;
}) {
  const selected =
    scene === "agents" || scene === "agent-detail" || scene === "members" || scene === "settings"
      ? scene
      : "login";

  const content =
    selected === "login" ? (
      <LoginScene embedded={embedded} />
    ) : selected === "agents" ? (
      <AgentsScene embedded={embedded} />
    ) : selected === "agent-detail" ? (
      <AgentDetailScene embedded={embedded} />
    ) : selected === "members" ? (
      <MembersScene embedded={embedded} />
    ) : (
      <SettingsScene embedded={embedded} />
    );

  return embedded ? content : <SceneRouter>{content}</SceneRouter>;
}
