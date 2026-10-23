import { useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { MachineCreateDialog } from "../../../components/machine/machine-create-dialog";
import {
  MachineDetailPanel,
  CreateMachineAction,
} from "../../../components/machine/machine-detail";
import { MachineList } from "../../../components/machine/machine-list";
import type { MachineLinkRenderer } from "../../../components/machine/machine-list";
import type {
  MachineDetail,
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
  projectId: string;
};

/** 演示控制面板：失败模拟只作用于 src/dev 的回调，不进入正式组件。 */
function DemoControls({
  state,
  update,
}: {
  state: DemoState;
  update: (patch: Partial<DemoState>) => void;
}) {
  return (
    <details
      data-testid="machine-scene-controls"
      className="fixed right-4 bottom-4 z-50 w-64 rounded-container border border-border bg-popover p-3 text-xs shadow-lg"
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
          data-testid="machine-fail-save"
          checked={state.failSave}
          onChange={(event) => update({ failSave: event.target.checked })}
        />
        模拟绑定保存失败
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
      <p className="mt-2 leading-5 text-muted-foreground">
        演示数据与本地模拟操作。刷新会回到固定 fixtures；不连接业务服务。
      </p>
    </details>
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
        ...failure("conflict", "演示：保存失败，说明与目录已保留，可重试。"),
        fieldErrors: { description: "演示：另一个窗口修改了绑定。" },
      };
    const detail = draft.machines.find((item) => item.machine.id === input.machineId);
    if (!detail) return failure("not_found", "演示：Machine 不存在。");
    const existing = detail.bindings.find((item) => item.intent.projectId === input.projectId);
    if (
      existing &&
      existing.intent.description === input.description &&
      existing.intent.directory === input.directory
    )
      return success(existing.intent);
    const intent: ProjectMachineIntent = {
      projectId: input.projectId,
      machineId: input.machineId,
      description: input.description,
      directory: input.directory,
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
                    binding.intent.projectId === input.projectId ? { ...binding, intent } : binding,
                  )
                : [...item.bindings, { intent, observation: null }],
            },
      ),
    });
    return success(intent);
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
        onEnrollmentCreated={(enrollment) => {
          update({ tickets: { ...draft.tickets, [machineId]: enrollment } });
        }}
      />
      <DemoControls state={draft} update={update} />
    </>
  );
}
