import { Profiler, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { MachineCreateDialog } from "../../../components/machine/machine-create-dialog";
import { MachineEnrollmentPanel } from "../../../components/machine/machine-enrollment-panel";
import {
  MachineDetailPanel,
  CreateMachineAction,
} from "../../../components/machine/machine-detail";
import { MachineList } from "../../../components/machine/machine-list";
import type { MachineLinkRenderer } from "../../../components/machine/machine-list";
import type {
  MachineDetail,
  MachineRootDirectory,
  SaveMachineRootDirectoryInput,
  MachineEnrollment,
  MachineResult,
  ProjectMachineIntent,
  SaveProjectMachineBindingInput,
} from "../../../contracts/machine";
import type { AppErrorCode } from "../../../contracts/result";
import { PageFrame } from "../../../components/layout/page-frame";
import { ResultError } from "../../../components/project/result-error";
import { Select } from "../../../components/ui/select";
import { Icon } from "../../../components/ui/icon";
import {
  DEMO_REQUEST_ID,
  demoEnrollment,
  demoMachineDetails,
  demoProject,
  demoProjectNames,
  machineProject,
  secondProject,
} from "./fixtures";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function failure<T>(code: AppErrorCode, message: string): MachineResult<T> {
  return {
    ok: false,
    error: { code, message, requestId: DEMO_REQUEST_ID },
    requestId: DEMO_REQUEST_ID,
  };
}

function success<T>(data: T): MachineResult<T> {
  return { ok: true, data, requestId: DEMO_REQUEST_ID };
}

type DemoState = {
  machines: MachineDetail[];
  tickets: Record<string, MachineEnrollment | undefined>;
  failCreate: boolean;
  failRenew: boolean;
  failSave: boolean;
  failRoot: boolean;
  conflictRoot: boolean;
  throwRenew: boolean;
  projectId: string;
};

function DemoControls({
  state,
  update,
  onActivate,
  onSwitch,
}: {
  state: DemoState;
  update: (patch: Partial<DemoState>) => void;
  onActivate?: () => void;
  onSwitch?: (machineId: string) => void;
}) {
  return (
    <details
      data-testid="machine-scene-controls"
      className="mt-6 rounded-container border border-border bg-popover p-3 text-xs shadow-lg desktop:fixed desktop:right-4 desktop:bottom-4 desktop:z-50 desktop:mt-0 desktop:w-64"
    >
      <summary className="cursor-pointer font-medium">演示控制 · Machines</summary>
      <label className="mt-2 flex items-center gap-2">
        <input
          type="checkbox"
          data-testid="machine-fail-create"
          checked={state.failCreate}
          onChange={(event) => update({ failCreate: event.target.checked })}
        />
        模拟创建票据失败
      </label>
      <label className="mt-1 flex items-center gap-2">
        <input
          type="checkbox"
          data-testid="machine-fail-renew"
          checked={state.failRenew}
          onChange={(event) => update({ failRenew: event.target.checked })}
        />
        模拟续签失败
      </label>
      <label className="mt-1 flex items-center gap-2">
        <input
          type="checkbox"
          data-testid="machine-throw-renew"
          checked={state.throwRenew}
          onChange={(event) => update({ throwRenew: event.target.checked })}
        />
        模拟续签网络异常
      </label>
      <label className="mt-1 flex items-center gap-2">
        <input
          type="checkbox"
          data-testid="machine-fail-save"
          checked={state.failSave}
          onChange={(event) => update({ failSave: event.target.checked })}
        />
        模拟绑定保存失败
      </label>
      <label className="mt-1 flex items-center gap-2">
        <input
          type="checkbox"
          data-testid="machine-fail-root"
          checked={state.failRoot}
          onChange={(event) => update({ failRoot: event.target.checked })}
        />
        模拟 root 保存失败
      </label>
      <label className="mt-1 flex items-center gap-2">
        <input
          type="checkbox"
          data-testid="machine-conflict-root"
          checked={state.conflictRoot}
          onChange={(event) => update({ conflictRoot: event.target.checked })}
        />
        模拟 root 并发冲突（一次）
      </label>
      <label className="mt-3 block" htmlFor="machine-demo-project">
        当前 Project
      </label>
      <Select
        id="machine-demo-project"
        data-testid="machine-demo-project"
        className="mt-1"
        value={state.projectId}
        onChange={(event) => update({ projectId: event.target.value })}
      >
        <option value={machineProject.id}>{machineProject.name}</option>
        <option value={secondProject.id}>{secondProject.name}</option>
      </Select>
      {onSwitch && (
        <>
          <label className="mt-3 block" htmlFor="machine-demo-switch">
            切到另一台 Machine
          </label>
          <Select
            id="machine-demo-switch"
            data-testid="machine-demo-switch"
            className="mt-1"
            value=""
            onChange={(event) => {
              if (event.target.value) onSwitch(event.target.value);
            }}
          >
            <option value="">选择 Machine</option>
            {state.machines.map((item) => (
              <option key={item.machine.id} value={item.machine.id}>
                {item.machine.name}
              </option>
            ))}
          </Select>
        </>
      )}
      {onActivate && (
        <button
          type="button"
          data-testid="machine-demo-activate"
          className="mt-3 w-full rounded-control border border-border px-2 py-1 text-left"
          onClick={onActivate}
        >
          把当前 Machine 标为已配对
        </button>
      )}
      <p className="mt-2 leading-5 text-muted-foreground">
        演示数据与本地模拟操作。刷新会回到固定 fixtures；不连接业务服务。
      </p>
    </details>
  );
}

type LifecycleAttempt = {
  machineId: string;
  resolve: (result: MachineResult<MachineEnrollment>) => void;
  reject: (cause: unknown) => void;
};

function lifecycleTicket(machineId: string): string {
  return `${machineId.slice(4, 12).toUpperCase()}${"LIFECYCLE".padEnd(35, "Z")}`.slice(0, 43);
}

function lifecycleEnrollment(machineId: string): MachineEnrollment {
  const detail =
    demoMachineDetails.find((item) => item.machine.id === machineId) ?? demoMachineDetails[0]!;
  return {
    detail:
      detail.machine.id === machineId
        ? detail
        : { ...detail, machine: { ...detail.machine, id: machineId } },
    ticket: lifecycleTicket(machineId),
    expiresAt: "2026-10-18T08:10:00.000Z",
  };
}

function MachineLifecycleProbe({ go }: { go: (to: string) => void }) {
  const [view, setView] = useState<{
    machineId: string;
    parent: MachineEnrollment | null;
    mounted: boolean;
  }>({
    machineId: "mch_11111111-1111-4111-8111-111111111111",
    parent: null,
    mounted: true,
  });
  const attempts = useRef<LifecycleAttempt[]>([]);
  const commits = useRef<{ machineId: string; exposed: boolean; owned: boolean }[]>([]);
  const parentSlot = useRef<MachineEnrollment | null>(null);
  parentSlot.current = view.parent;

  useEffect(() => {
    const api = {
      commits() {
        return commits.current;
      },
      show(machineId: string, mode: "empty" | "ticket" = "empty", ownerId = machineId) {
        setView((current) => ({
          ...current,
          machineId,
          mounted: true,
          parent: mode === "ticket" ? lifecycleEnrollment(ownerId) : null,
        }));
      },
      visit(machineId: string) {
        setView((current) => ({ ...current, machineId, mounted: true }));
      },
      parent() {
        return parentSlot.current?.detail.machine.id ?? null;
      },
      refresh() {
        setView((current) => ({
          ...current,
          parent: current.parent ? { ...current.parent } : null,
        }));
      },
      unmount() {
        setView((current) => ({ ...current, mounted: false }));
      },
      pending() {
        return attempts.current.map((attempt) => attempt.machineId);
      },
      settle(index: number, kind: "success" | "failure" | "throw") {
        const [attempt] = attempts.current.splice(index, 1);
        if (!attempt) return null;
        if (kind === "throw") attempt.reject(new Error("LIFECYCLE_PROBE_THROW"));
        else if (kind === "failure")
          attempt.resolve(failure("conflict", "演示：生命周期探针的失败结果。"));
        else
          attempt.resolve({
            ok: true,
            data: lifecycleEnrollment(attempt.machineId),
            requestId: DEMO_REQUEST_ID,
          });
        return attempt.machineId;
      },
    };
    const host = window as typeof window & { __machineLifecycle?: typeof api };
    host.__machineLifecycle = api;
    return () => {
      delete host.__machineLifecycle;
    };
  }, []);

  const enrollment =
    view.parent && view.parent.detail.machine.id === view.machineId ? view.parent : null;

  return (
    <PageFrame
      title="续签请求生命周期探针"
      description="演示场景：同一次续签请求归属一个组件身份寿命；切换 Machine 会撤回旧请求的所有权。"
      back={<BackToMachines go={go} />}
      testId="machine-lifecycle-probe"
    >
      {view.mounted && (
        <Profiler
          id="machine-enrollment"
          onRender={() => {
            const value = document.querySelector(
              '[data-testid="machine-ticket-value"]',
            )?.textContent;
            commits.current.push({
              machineId: view.machineId,
              exposed: value != null,
              owned: value == null || value === lifecycleTicket(view.machineId),
            });
          }}
        >
          <MachineEnrollmentPanel
            machineId={view.machineId}
            enrollmentStatus="pending"
            enrollment={enrollment}
            installOrigin="http://127.0.0.1:3000"
            onEnrollmentCreated={(created) =>
              setView((current) => ({ ...current, parent: created }))
            }
            onEnrollmentRevoked={(target) =>
              setView((current) =>
                current.parent?.detail.machine.id === target
                  ? { ...current, parent: null }
                  : current,
              )
            }
            onRenew={(machineId) =>
              new Promise<MachineResult<MachineEnrollment>>((resolve, reject) => {
                attempts.current.push({ machineId, resolve, reject });
              })
            }
          />
        </Profiler>
      )}
    </PageFrame>
  );
}

function BackToMachines({ go }: { go: (to: string) => void }) {
  return (
    <a
      href="/machines"
      data-testid="machine-detail-back"
      onClick={(event) => {
        event.preventDefault();
        go("/machines");
      }}
    >
      <Icon as={ArrowLeft} />
      返回 Machines
    </a>
  );
}

export function MachineScenes() {
  const location = useLocation();
  const navigate = useNavigate();
  const go = (to: string) => {
    void navigate({ to });
  };
  const [draft, setDraft] = useState<DemoState>({
    machines: demoMachineDetails,
    tickets: { [demoMachineDetails[1]!.machine.id]: demoEnrollment(demoMachineDetails[1]!) },
    failCreate: false,
    failRenew: false,
    failSave: false,
    failRoot: false,
    conflictRoot: false,
    throwRenew: false,
    projectId: machineProject.id,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const update = (patch: Partial<DemoState>) => setDraft((current) => ({ ...current, ...patch }));
  const project = draft.projectId === secondProject.id ? secondProject : demoProject;
  const projectName = project.id === demoProject.id ? demoProject.name : secondProject.name;

  const renderLink: MachineLinkRenderer = ({ href, children, ...props }) => (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        event.preventDefault();
        go(href);
      }}
    >
      {children}
    </a>
  );

  async function create(name: string): Promise<MachineResult<MachineEnrollment>> {
    await delay(300);
    if (draft.failCreate)
      return {
        ...failure("internal", "演示：创建失败，输入已保留，可直接重试。"),
        fieldErrors: { name: "演示：服务端拒绝了这次创建。" },
      };
    const now = "2026-10-18T07:20:00.000Z";
    const detail: MachineDetail = {
      machine: {
        id: `mch_${crypto.randomUUID()}`,
        name: name.trim(),
        rootDirectory: null,
        rootRevision: 1,
        createdBy: "demo-human",
        createdAt: now,
        updatedAt: now,
      },
      enrollmentStatus: "pending",
      connection: {
        kind: "offline",
        generation: null,
        lastSeenAt: null,
        reason: "never_connected",
      },
      capability: null,
      bindings: [],
    };
    const enrollment = demoEnrollment(detail);
    update({
      machines: [detail, ...draft.machines],
      tickets: { ...draft.tickets, [detail.machine.id]: enrollment },
    });
    return success(enrollment);
  }

  async function renew(machineId: string): Promise<MachineResult<MachineEnrollment>> {
    await delay(300);
    if (draft.throwRenew) throw new Error("REVIEW_NETWORK_FAILURE secret-stack-detail");
    if (draft.failRenew) return failure("conflict", "演示：续签失败，旧票据继续有效。");
    const detail = draft.machines.find((item) => item.machine.id === machineId);
    if (!detail) return failure("not_found", "演示：Machine 不存在。");
    const enrollment = demoEnrollment(detail, "RENEW".padEnd(43, "B"));
    update({ tickets: { ...draft.tickets, [machineId]: enrollment } });
    return success(enrollment);
  }

  async function saveBinding(
    input: SaveProjectMachineBindingInput,
  ): Promise<MachineResult<ProjectMachineIntent>> {
    await delay(300);
    if (draft.failSave)
      return {
        ...failure("conflict", "演示：保存失败，说明已保留，可重试。"),
        fieldErrors: { description: "演示：另一个窗口修改了绑定。" },
      };
    const detail = draft.machines.find((item) => item.machine.id === input.machineId);
    if (!detail) return failure("not_found", "演示：Machine 不存在。");
    const existing = detail.bindings.find((item) => item.intent.projectId === input.projectId);
    if (existing && existing.intent.description === input.description)
      return success(existing.intent);
    const intent: ProjectMachineIntent = {
      projectId: input.projectId,
      machineId: input.machineId,
      description: input.description,
      revision: (existing?.intent.revision ?? 0) + 1,
    };
    update({
      machines: draft.machines.map((item) =>
        item.machine.id !== input.machineId
          ? item
          : {
              ...item,
              bindings: existing
                ? item.bindings.map((binding) =>
                    binding.intent.projectId === input.projectId
                      ? { intent, observation: binding.observation }
                      : binding,
                  )
                : [...item.bindings, { intent, observation: null }],
            },
      ),
    });
    return success(intent);
  }

  async function saveRoot(
    input: SaveMachineRootDirectoryInput,
  ): Promise<MachineResult<MachineRootDirectory>> {
    await delay(300);
    if (draft.failRoot) return failure("internal", "演示：root 保存失败，草稿已保留。");
    const detail = draft.machines.find((item) => item.machine.id === input.machineId);
    if (!detail) return failure("not_found", "演示：Machine 不存在。");
    if (draft.conflictRoot) {
      update({
        conflictRoot: false,
        machines: draft.machines.map((item) =>
          item.machine.id !== input.machineId
            ? item
            : {
                ...item,
                machine: {
                  ...item.machine,
                  rootDirectory: "/Users/other/root",
                  rootRevision: item.machine.rootRevision + 1,
                },
                bindings: item.bindings.map((binding) => ({
                  ...binding,
                  observation: binding.observation
                    ? { ...binding.observation, current: false }
                    : null,
                })),
              },
        ),
      });
      return failure("conflict", "演示：另一个窗口修改了 root，请核对服务端事实后重试。");
    }
    if (input.expectedRevision !== detail.machine.rootRevision)
      return failure("conflict", "演示：root 版本已变化。");
    const revision =
      detail.machine.rootRevision + (input.directory === detail.machine.rootDirectory ? 0 : 1);
    update({
      machines: draft.machines.map((item) =>
        item.machine.id !== input.machineId
          ? item
          : {
              ...item,
              machine: { ...item.machine, rootDirectory: input.directory, rootRevision: revision },
              bindings: item.bindings.map((binding) => ({
                ...binding,
                observation: binding.observation
                  ? {
                      ...binding.observation,
                      current:
                        binding.observation.current &&
                        revision === binding.observation.fact.revision,
                    }
                  : null,
              })),
            },
      ),
    });
    return success({ machineId: input.machineId, directory: input.directory, revision });
  }

  if (location.pathname === "/machines" || location.pathname === "/machines/") {
    return (
      <>
        <PageFrame
          title="Machines"
          description="当前账号登记的 macOS Machine。连接与配对分别记录；断线不代表空闲或已释放。"
          back={
            <a
              href="/projects"
              onClick={(event) => {
                event.preventDefault();
                go("/projects");
              }}
            >
              <Icon as={ArrowLeft} />
              返回 Projects
            </a>
          }
          actions={<CreateMachineAction onCreate={() => setCreateOpen(true)} />}
          testId="machines-page"
        >
          <MachineList
            machines={draft.machines}
            href={(machineId) => `/machines/${machineId}`}
            renderLink={renderLink}
          />
          <a
            href="/machines/lifecycle"
            data-testid="machine-lifecycle-link"
            onClick={(event) => {
              event.preventDefault();
              go("/machines/lifecycle");
            }}
          >
            续签请求生命周期探针
          </a>
          <p className="mt-4 text-xs leading-6 text-muted-foreground">
            Machines 只展示连接和 Project 绑定；租约与远端操作属于 P4b，尚未实现。
          </p>
        </PageFrame>
        <MachineCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          submit={(values) => create(values.name)}
          onCreated={(enrollment) => go(`/machines/${enrollment.detail.machine.id}`)}
        />
        <DemoControls state={draft} update={update} />
      </>
    );
  }

  const machineId = location.pathname.replace(/^\/machines\//, "");
  if (machineId === "lifecycle") return <MachineLifecycleProbe go={go} />;
  const detail = draft.machines.find((item) => item.machine.id === machineId);
  if (!detail) {
    return (
      <PageFrame
        title="Machine 不存在"
        description="请返回列表选择已有 Machine。"
        back={<BackToMachines go={go} />}
        testId="machine-detail-page"
      >
        <ResultError
          error={{
            code: "not_found",
            message: "演示：未找到该 Machine。",
            requestId: DEMO_REQUEST_ID,
          }}
          testId="machine-detail-error"
        />
      </PageFrame>
    );
  }

  return (
    <>
      <MachineDetailPanel
        detail={detail}
        back={<BackToMachines go={go} />}
        enrollment={draft.tickets[machineId] ?? null}
        bindingProject={{ id: project.id, name: projectName }}
        projectNames={demoProjectNames}
        installOrigin="http://127.0.0.1:3000"
        onRenewEnrollment={renew}
        onSaveBinding={saveBinding}
        onSaveRoot={saveRoot}
        onEnrollmentCreated={(enrollment) => {
          update({ tickets: { ...draft.tickets, [machineId]: enrollment } });
        }}
        onEnrollmentRevoked={(target) => {
          if (target !== machineId) return;
          const tickets = { ...draft.tickets };
          delete tickets[target];
          update({ tickets });
        }}
      />
      <DemoControls
        state={draft}
        update={update}
        onSwitch={(id) => go(`/machines/${id}`)}
        onActivate={
          detail.enrollmentStatus === "pending"
            ? () =>
                update({
                  machines: draft.machines.map((item) =>
                    item.machine.id === machineId
                      ? { ...item, enrollmentStatus: "active" as const }
                      : item,
                  ),
                })
            : undefined
        }
      />
    </>
  );
}
