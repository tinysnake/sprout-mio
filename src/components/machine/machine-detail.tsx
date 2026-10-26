import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { FolderOpen } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { MachineInstallInstructions } from "./machine-install-instructions";
import { MachineShellSummary } from "./machine-shell-summary";
import type {
  MachineDetail,
  MachineRootDirectory,
  SaveMachineRootDirectoryInput,
  MachineEnrollment,
  MachineResult,
  ProjectMachineIntent,
  SaveProjectMachineBindingInput,
} from "../../contracts/machine";
import { saveMachineRootDirectoryInput } from "../../contracts/machine";
import { fieldErrorsFrom, type FieldErrors } from "../../contracts/project";
import { toAppError, type AppError } from "../../contracts/result";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { ResultError } from "../project/result-error";
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
  onSaveRoot,
  onRootRefresh,
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
  onSaveRoot?: (
    input: SaveMachineRootDirectoryInput,
  ) => Promise<MachineResult<MachineRootDirectory>>;
  onRootRefresh?: () => void | Promise<void>;
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

  const enrollmentSection = (
    <SettingsSection title="配对与安装" testId="machine-enrollment-section">
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
  );

  return (
    <PageFrame
      title={<span data-testid="machine-detail-name">{detail.machine.name}</span>}
      description={
        <span data-testid="machine-detail-description">
          {detail.enrollmentStatus === "pending" ? `${pairing.label} · ` : ""}
          {connection.label}
          {connection.detail ? `（${connection.detail}）` : ""} · Machine
        </span>
      }
      back={back}
      actions={actions}
      testId="machine-detail-page"
    >
      <div className="grid grid-cols-1">
        {detail.enrollmentStatus === "pending" && (
          <div className="min-w-0">{enrollmentSection}</div>
        )}
        <div className="min-w-0">
          {/* 配置分组：连接、Shell 能力、root、绑定与安装维护都在这里，能力与信息一项不少。 */}
          <SettingsSection title="租约" testId="machine-lease-list-section">
            {detail.bindings.length === 0 ? (
              <p className="text-xs leading-6 text-muted-foreground">
                此 Machine 尚未绑定 Project。
              </p>
            ) : (
              <ul
                data-testid="machine-lease-list"
                className="divide-y divide-border overflow-hidden rounded-container border border-border"
              >
                {detail.bindings.map((item) => (
                  <li key={item.intent.projectId}>
                    <Link
                      to="/machines/$machineId/lease"
                      params={{ machineId: detail.machine.id }}
                      search={{ projectId: item.intent.projectId }}
                      data-testid="machine-lease-link"
                      data-project-id={item.intent.projectId}
                      className="flex min-h-16 min-w-0 items-center justify-between gap-3 px-4 py-3 hover:bg-hover max-mobile:flex-wrap"
                    >
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="shrink-0 text-xs font-medium text-muted-foreground">
                          Project
                        </span>
                        <span className="min-w-0 break-words text-sm font-medium">
                          {projectNames[item.intent.projectId] ?? item.intent.projectId}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">查看租约 →</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SettingsSection>
          <div data-testid="machine-settings-group" role="group" aria-label="设置">
            <p className="pt-6 text-sm font-medium text-muted-foreground">设置</p>
            <SettingsSection
              title="连接与配对"
              description="连接是近期通信观察，不表示物理链路仍在，也不表示租约、空闲或已释放。配对与连接分别记录。"
              testId="machine-connection-section"
            >
              <div className="grid gap-6 desktop:grid-cols-2">
                <Facts
                  items={[
                    {
                      label: "Machine ID",
                      testId: "machine-detail-id",
                      value: (
                        <code className="font-mono text-[0.6875rem]">{detail.machine.id}</code>
                      ),
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
                      value: !capability
                        ? "无能力快照"
                        : !capability.current
                          ? "旧代次快照，不当作现在可用"
                          : capability.snapshot.remoteOperations.length === 0
                            ? "Worker 未宣告远端操作能力"
                            : capability.snapshot.remoteOperations.join("、"),
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

            <SettingsSection title="Shell 能力" testId="machine-shells">
              <MachineShellSummary
                key={detail.machine.id}
                capability={capability}
                connection={detail.connection}
              />
            </SettingsSection>

            <SettingsSection
              title="Machine root 工作目录"
              description="一期不迁移已绑定 Project 的目录。修改 root 会改变这台 Machine 上所有 Project 的派生路径。"
              testId="machine-root-section"
            >
              {onSaveRoot && (
                <MachineRootForm
                  key={detail.machine.id}
                  machine={detail.machine}
                  submit={onSaveRoot}
                  refresh={onRootRefresh}
                />
              )}
            </SettingsSection>

            <SettingsSection
              title="Project 绑定"
              description="绑定保存 Project 归属与说明；路径由 Machine root 与 Project ID 派生，Worker 另外回报目录观察。"
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
                        className="min-w-0 rounded-container border border-border px-4 py-3"
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
                        <p
                          data-testid="machine-binding-path"
                          className="mt-1 flex min-w-0 items-start gap-1.5 text-xs leading-6 text-muted-foreground"
                        >
                          <Icon as={FolderOpen} />
                          <span className="min-w-0 break-all">
                            {bindingDirectory(detail.machine.rootDirectory, item.intent.projectId)}
                          </span>
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                          <div
                            data-testid="machine-binding-observation"
                            className="flex min-w-0 max-w-full flex-col items-start gap-1"
                          >
                            <StatusLine label={observation.label} tone={observation.tone} />
                            {observation.detail && (
                              <p className="text-muted-foreground">{observation.detail}</p>
                            )}
                          </div>
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
                    说明保存到当前 Project。工作路径在 Machine root 设置后派生，由 Worker 验证。
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
                  在 Project settings 的 Machines 区域加入 Project，也可通过 Project
                  上下文在这里编辑说明。
                </p>
              )}
            </SettingsSection>

            {detail.enrollmentStatus === "active" && (
              <SettingsSection title="安装与维护" testId="machine-restart-section">
                <MachineInstallInstructions
                  machineId={detail.machine.id}
                  origin={installOrigin}
                  enrollmentStatus="active"
                />
              </SettingsSection>
            )}
          </div>
        </div>
      </div>
    </PageFrame>
  );
}

function MachineRootForm({
  machine,
  submit,
  refresh,
}: {
  machine: MachineDetail["machine"];
  submit: (input: SaveMachineRootDirectoryInput) => Promise<MachineResult<MachineRootDirectory>>;
  refresh?: () => void | Promise<void>;
}) {
  const [fact, setFact] = useState({
    directory: machine.rootDirectory,
    revision: machine.rootRevision,
  });
  const [directory, setDirectory] = useState(machine.rootDirectory ?? "");
  const [draftRevision, setDraftRevision] = useState(machine.rootRevision);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);
  const live = useRef(true);
  const preserveDraft = useRef(false);
  const syncedRevision = useRef(machine.rootRevision);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (machine.rootRevision === syncedRevision.current) return;
    syncedRevision.current = machine.rootRevision;
    if (!preserveDraft.current && !pending && directory === (fact.directory ?? "")) {
      setDirectory(machine.rootDirectory ?? "");
      setDraftRevision(machine.rootRevision);
    }
    setFact({ directory: machine.rootDirectory, revision: machine.rootRevision });
  }, [machine.rootDirectory, machine.rootRevision, directory, fact, pending]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    // Refreshing current facts must not rebase a dirty draft before an explicit conflict retry.
    const expectedRevision = error?.code === "conflict" ? fact.revision : draftRevision;
    setError(null);
    setSaved(false);
    const parsed = saveMachineRootDirectoryInput.safeParse({
      machineId: machine.id,
      directory: directory || null,
      expectedRevision,
    });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error));
      return;
    }
    setFieldErrors({});
    setDraftRevision(expectedRevision);
    setPending(true);
    preserveDraft.current = true;
    try {
      const result = await submit(parsed.data);
      if (!live.current) return;
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        if (result.error.code === "conflict") await refresh?.();
        return;
      }
      setFact(result.data);
      setDraftRevision(result.data.revision);
      setDirectory(result.data.directory ?? "");
      setSaved(true);
      preserveDraft.current = false;
      await refresh?.();
    } catch (cause) {
      if (live.current) setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      if (live.current) setPending(false);
    }
  }

  return (
    <form
      data-testid="machine-root-form"
      onSubmit={save}
      aria-busy={pending}
      className="flex min-w-0 flex-col gap-4"
    >
      <p
        data-testid="machine-root-current"
        className="min-w-0 break-all text-xs leading-6 text-muted-foreground"
      >
        当前 root：{fact.directory ?? "未设置"} · root revision {fact.revision}
      </p>
      <Field
        label="Root 工作目录"
        htmlFor="machine-root-directory"
        hint="macOS 绝对路径。留空保存可清除 root，之后不探测任何 Project 路径。"
        error={fieldErrors.directory}
      >
        <Input
          id="machine-root-directory"
          data-testid="machine-root-directory"
          value={directory}
          onFocus={() => {
            preserveDraft.current = true;
          }}
          disabled={pending}
          onChange={(event) => setDirectory(event.target.value)}
        />
      </Field>
      {error && <ResultError error={error} testId="machine-root-error" />}
      {error?.code === "conflict" && (
        <p className="text-xs leading-6 text-muted-foreground">
          已刷新服务端 root 与版本，草稿已保留。核对当前事实后可重新保存。
        </p>
      )}
      {saved && (
        <StatusLine
          label="Root 已保存，目录可达性等待 Worker 观察。"
          tone="success"
          testId="machine-root-success"
        />
      )}
      <div>
        <Button type="submit" loading={pending} data-testid="machine-root-submit">
          保存 root
        </Button>
      </div>
    </form>
  );
}

export function CreateMachineAction({ onCreate }: { onCreate: () => void }) {
  return (
    <Button type="button" data-testid="new-machine-trigger" onClick={onCreate}>
      新建 Machine
    </Button>
  );
}
