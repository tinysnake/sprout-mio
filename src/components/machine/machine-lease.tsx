import type { ReactNode } from "react";
import type { MachineDetail, MachineEnrollment, MachineResult } from "../../contracts/machine";
import type { ProjectInfoHub } from "../../contracts/info-hub";
import type { LeaseView } from "../../contracts/lease";
import type { ExecutionView } from "../../contracts/remote";
import type { AppError } from "../../contracts/result";
import { PageFrame } from "../layout/page-frame";
import { SettingsSection } from "../project/settings-section";
import { ResultError } from "../project/result-error";
import { MachineEnrollmentPanel } from "./machine-enrollment-panel";
import { MachineLeaseSection } from "./lease-panel";
import { RemoteExecutionList } from "./remote-execution-panel";
import { ProjectLeaseActions } from "./project-lease-actions";
import type { LeaseMutationHandler } from "./machine-view";

export function MachineLeasePanel({
  detail,
  project,
  back,
  actions,
  enrollment = null,
  installOrigin,
  onRenewEnrollment,
  onEnrollmentCreated,
  onEnrollmentRevoked,
  leases = [],
  holderNames = {},
  runs = [],
  executions = [],
  leaseInfo,
  leaseError,
  executionError,
  onLeaseMutate,
}: {
  detail: MachineDetail;
  project: { id: string; name: string };
  back?: ReactNode;
  actions?: ReactNode;
  enrollment?: MachineEnrollment | null;
  installOrigin?: string;
  onRenewEnrollment?: (machineId: string) => Promise<MachineResult<MachineEnrollment>>;
  onEnrollmentCreated?: (enrollment: MachineEnrollment) => void;
  onEnrollmentRevoked?: (machineId: string) => void;
  leases?: readonly LeaseView[];
  holderNames?: Readonly<Record<string, string>>;
  runs?: readonly { runId: string; status: string }[];
  executions?: readonly ExecutionView[];
  leaseInfo?: ProjectInfoHub;
  leaseError?: AppError;
  executionError?: AppError;
  onLeaseMutate?: LeaseMutationHandler;
}) {
  const leaseSection = (
    onMutate?: LeaseMutationHandler,
    chatRow?: ReactNode,
    transferControls?: ReactNode,
  ) => (
    <MachineLeaseSection
      projectId={project.id}
      detail={detail}
      leases={leases}
      holderNames={holderNames}
      runs={runs}
      onMutate={onMutate}
      {...(chatRow ? { chatRow } : {})}
      {...(transferControls ? { transferControls } : {})}
    />
  );

  return (
    <PageFrame
      title={<span data-testid="machine-detail-name">{detail.machine.name}</span>}
      description={`${project.name} · 租约`}
      back={back}
      actions={actions}
      testId="machine-lease-page"
    >
      {detail.enrollmentStatus === "pending" && (
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
      )}
      <SettingsSection
        title="租约与持有者"
        description="租约单位是 Project × Machine；变更不会终止进程或删除文件。"
        testId="machine-lease-detail"
      >
        {leaseError ? (
          <ResultError error={leaseError} />
        ) : leaseInfo ? (
          <ProjectLeaseActions
            key={leaseInfo.projectId}
            info={leaseInfo}
            fixedMachineId={detail.machine.id}
          >
            {(mutate, chrome) => leaseSection(mutate, chrome.chatRow, chrome.transferControls)}
          </ProjectLeaseActions>
        ) : (
          leaseSection(onLeaseMutate)
        )}
      </SettingsSection>
      <SettingsSection
        title="远端操作"
        description="操作目标由请求自身指定；宿主工具与远端操作分开记录，结果未经确认时显示未知。"
        testId="machine-remote-executions"
      >
        {executionError ? (
          <ResultError error={executionError} />
        ) : (
          <RemoteExecutionList
            executions={executions.filter((execution) => execution.machineId === detail.machine.id)}
            machines={[detail]}
            holderNames={holderNames}
            testId="machine-executions"
          />
        )}
      </SettingsSection>
    </PageFrame>
  );
}
