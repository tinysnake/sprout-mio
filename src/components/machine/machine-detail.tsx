import type { ReactNode } from "react";
import { FolderOpen } from "lucide-react";
import type {
  MachineDetail,
  MachineEnrollment,
  MachineResult,
  ProjectMachineIntent,
  SaveProjectMachineBindingInput,
} from "../../contracts/machine";
import { PageFrame } from "../layout/page-frame";
import { Facts, SettingsSection } from "../project/settings-section";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { MachineBindingForm } from "./machine-binding-form";
import { MachineEnrollmentPanel } from "./machine-enrollment-panel";
import { StatusLine } from "./machine-list";
import {
  bindingDirectory,
  connectionLabel,
  enrollmentLabel,
  formatMoment,
  observationLabel,
} from "./machine-view";

export function MachineDetailPanel({
  detail,
  back,
  enrollment = null,
  bindingProject = null,
  projectNames = {},
  onRenewEnrollment,
  onSaveBinding,
  onBindingSaved,
  onEnrollmentCreated,
  onEnrollmentRevoked,
  installOrigin,
  actions,
}: {
  detail: MachineDetail;
  back?: ReactNode;
  /** 刚创建或续签得到的一次性票据；普通读取详情时为空。 */
  enrollment?: MachineEnrollment | null;
  /** 当前 Project 上下文；有值时显示加入/编辑绑定表单。 */
  bindingProject?: { id: string; name: string } | null;
  projectNames?: Record<string, string>;
  onRenewEnrollment?: (machineId: string) => Promise<MachineResult<MachineEnrollment>>;
  onSaveBinding?: (
    input: SaveProjectMachineBindingInput,
  ) => Promise<MachineResult<ProjectMachineIntent>>;
  onBindingSaved?: (intent: ProjectMachineIntent) => void;
  /**
   * 续签成功结果写回父级短期状态；只有发起请求的详情身份仍在使用时才发布。
   */
  onEnrollmentCreated?: (enrollment: MachineEnrollment) => void;
  /**
   * 在途续签被放弃：撤销该 target 的父级票据。只作用于这一台 Machine，
   * 兄弟身份或其他 Machine 刚写入的合法票据必须保留。
   */
  onEnrollmentRevoked?: (machineId: string) => void;
  installOrigin?: string;
  actions?: ReactNode;
}) {
  const connection = connectionLabel(detail.connection);
  const pairing = enrollmentLabel(detail.enrollmentStatus);
  const capability = detail.capability;
  const binding = bindingProject
    ? (detail.bindings.find((item) => item.intent.projectId === bindingProject.id) ?? null)
    : null;

  return (
    <PageFrame
      title={<span data-testid="machine-detail-name">{detail.machine.name}</span>}
      description={
        <span data-testid="machine-detail-description">
          {pairing.label} · {connection.label}
          {connection.detail ? `（${connection.detail}）` : ""} · Machine
        </span>
      }
      back={back}
      actions={actions}
      testId="machine-detail-page"
    >
      <div className="grid gap-x-8 wide:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <SettingsSection
            title="连接与配对"
            description="连接是近期通信观察，不表示物理链路仍在，也不表示租约、空闲或已释放。配对状态独立于连接。"
            testId="machine-connection-section"
          >
            <div className="grid gap-6 desktop:grid-cols-2">
              <Facts
                items={[
                  {
                    label: "Machine ID",
                    testId: "machine-detail-id",
                    value: <code className="font-mono text-[0.6875rem]">{detail.machine.id}</code>,
                  },
                  {
                    label: "配对",
                    testId: "machine-detail-enrollment",
                    value: <StatusLine label={pairing.label} tone={pairing.tone} />,
                  },
                  {
                    label: "连接",
                    testId: "machine-detail-connection",
                    value: (
                      <StatusLine
                        label={connection.label}
                        detail={connection.detail}
                        tone={connection.tone}
                      />
                    ),
                  },
                  {
                    label: "连接代次",
                    testId: "machine-detail-generation",
                    value: detail.connection.generation ?? "无记录",
                  },
                  {
                    label: "最后收到信息",
                    testId: "machine-detail-last-seen",
                    value: formatMoment(detail.connection.lastSeenAt),
                  },
                ]}
              />
              <Facts
                items={[
                  {
                    label: "最近能力",
                    testId: "machine-detail-capability-time",
                    value: capability
                      ? formatMoment(capability.snapshot.shells[0]?.checkedAt)
                      : "无能力快照",
                  },
                  {
                    label: "能力代次",
                    testId: "machine-detail-capability-generation",
                    value: capability
                      ? `${capability.generation}${capability.current ? "（当前）" : "（旧）"}`
                      : "无记录",
                  },
                  {
                    label: "Worker",
                    testId: "machine-detail-worker",
                    value: capability
                      ? `${capability.snapshot.workerVersion} · ${capability.snapshot.arch} · ${capability.snapshot.platform}`
                      : "无能力快照",
                  },
                  {
                    label: "远端操作",
                    testId: "machine-detail-remote-operations",
                    value: "未实现，P4b",
                  },
                  {
                    label: "创建时间",
                    testId: "machine-detail-created",
                    value: formatMoment(detail.machine.createdAt),
                  },
                ]}
              />
            </div>
            {capability && !capability.current && (
              <p
                data-testid="machine-detail-stale-capability"
                className="mt-4 text-xs leading-6 text-muted-foreground"
              >
                这是旧连接代次的能力快照；当前连接尚未提交新能力，不能当作现在可用。
              </p>
            )}
          </SettingsSection>

          <SettingsSection
            title="Shell 能力"
            description="来自 Worker 在 macOS 上的实际探测；未知 shell 不会猜执行语法。"
            testId="machine-shells"
          >
            {!capability ? (
              <p
                data-testid="machine-shells-empty"
                className="text-xs leading-6 text-muted-foreground"
              >
                尚无能力快照。Worker 完成认证并提交能力后才会出现。
              </p>
            ) : capability.snapshot.shells.length === 0 ? (
              <p
                data-testid="machine-shells-empty"
                className="text-xs leading-6 text-muted-foreground"
              >
                Worker 未报告可用 shell。
              </p>
            ) : (
              <ul
                id="machine-shell-list"
                className="divide-y divide-border rounded-container border border-border"
              >
                {capability.snapshot.shells.map((fact) => (
                  <li
                    key={fact.path}
                    data-testid="machine-shell-item"
                    className="grid gap-1 px-3 py-2.5 text-xs leading-6 desktop:grid-cols-[6rem_minmax(0,1fr)] desktop:gap-2"
                  >
                    <span className="text-muted-foreground">{fact.kind}</span>
                    <span className="min-w-0 break-all">
                      <code className="font-mono text-[0.6875rem]">{fact.path}</code>
                      <span className="block text-muted-foreground">
                        {fact.version ?? "版本未知"} ·{" "}
                        {fact.probe.kind === "success"
                          ? "自检通过"
                          : `自检失败：${fact.probe.reason}`}{" "}
                        · {formatMoment(fact.checkedAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SettingsSection>

          <SettingsSection
            title="Project 绑定"
            description="绑定保存的是意图；目录观察是 Worker 另外回报的事实，两者分开显示。"
            testId="machine-bindings"
          >
            {detail.bindings.length === 0 ? (
              <p
                data-testid="machine-bindings-empty"
                className="text-xs leading-6 text-muted-foreground"
              >
                还没有加入任何 Project。
              </p>
            ) : (
              <ul className="space-y-3">
                {detail.bindings.map((item) => {
                  const observation = observationLabel(item.observation);
                  return (
                    <li
                      key={item.intent.projectId}
                      data-testid="machine-binding-item"
                      data-project-id={item.intent.projectId}
                      className="rounded-container border border-border px-4 py-3"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="text-xs font-medium">
                          {projectNames[item.intent.projectId] ?? item.intent.projectId}
                        </p>
                        <span className="text-xs text-muted-foreground">
                          revision {item.intent.revision}
                        </span>
                      </div>
                      <p
                        data-testid="machine-binding-description-value"
                        className="mt-1.5 text-xs leading-6"
                      >
                        {item.intent.description || "（无说明）"}
                      </p>
                      <p className="mt-1 flex items-center gap-1.5 break-all text-xs leading-6 text-muted-foreground">
                        <Icon as={FolderOpen} />
                        {bindingDirectory(item.intent)}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <StatusLine
                          label={observation.label}
                          detail={observation.detail}
                          tone={observation.tone}
                          testId="machine-binding-observation"
                        />
                        {item.observation && (
                          <span className="text-muted-foreground">
                            · 代次 {item.observation.fact.generation} · revision{" "}
                            {item.observation.fact.revision} ·{" "}
                            {formatMoment(item.observation.fact.checkedAt)}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {bindingProject && onSaveBinding && (
              <div className="mt-6">
                <h3 className="text-sm font-medium">
                  {binding ? "编辑绑定" : `加入 ${bindingProject.name}`}
                </h3>
                <p className="mt-1 mb-4 text-xs leading-6 text-muted-foreground">
                  说明与工作目录保存到当前 Project。目录保存成功只证明意图已记录，不证明 Worker
                  已验证路径。
                </p>
                <MachineBindingForm
                  key={`${detail.machine.id}:${bindingProject.id}`}
                  machineId={detail.machine.id}
                  project={bindingProject}
                  binding={binding}
                  submit={onSaveBinding}
                  onSaved={onBindingSaved}
                />
              </div>
            )}
            {!bindingProject && (
              <p className="mt-4 text-xs leading-6 text-muted-foreground">
                在 Project settings 的 Machine 区域加入 Project 后，才能在这里编辑说明和工作目录。
              </p>
            )}
          </SettingsSection>
        </div>

        <aside className="min-w-0">
          <SettingsSection
            title="配对与安装"
            description="先把 Machine 登记到当前账号，再用一次性票据启动 Worker。"
            testId="machine-enrollment-section"
          >
            <MachineEnrollmentPanel
              machineId={detail.machine.id}
              enrollmentStatus={detail.enrollmentStatus}
              enrollment={enrollment}
              installOrigin={installOrigin}
              onRenew={onRenewEnrollment}
              onEnrollmentCreated={onEnrollmentCreated}
              onEnrollmentRevoked={onEnrollmentRevoked}
            />
          </SettingsSection>
        </aside>
      </div>
    </PageFrame>
  );
}

export function CreateMachineAction({ onCreate }: { onCreate: () => void }) {
  return (
    <Button type="button" data-testid="new-machine-trigger" onClick={onCreate}>
      新建 Machine
    </Button>
  );
}
