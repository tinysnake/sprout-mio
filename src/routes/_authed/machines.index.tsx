import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { PageFrame } from "../../components/layout/page-frame";
import { MachineList } from "../../components/machine/machine-list";
import { MachineCreateDialog } from "../../components/machine/machine-create-dialog";
import { CreateMachineAction } from "../../components/machine/machine-detail";
import { ResultError } from "../../components/project/result-error";
import { Button } from "../../components/ui/button";
import { createMachineFn, listMachinesFn } from "../../server/functions/machine";
import { useMachineEnrollment } from "../../components/machine/machine-enrollment-context";

export const Route = createFileRoute("/_authed/machines/")({
  loader: () => listMachinesFn({ data: {} }),
  component: MachinesPage,
});

function MachinesPage() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  const { setEnrollment } = useMachineEnrollment();
  const [open, setOpen] = useState(false);
  return (
    <PageFrame
      title="Machines"
      description="当前账号的 Machine 身份与 Worker 连接。使用刷新读取最新通信事实。"
      testId="machines-page"
      actions={
        <>
          <Button variant="outline" onClick={() => void router.invalidate()}>
            刷新
          </Button>
          <CreateMachineAction onCreate={() => setOpen(true)} />
        </>
      }
    >
      {!result.ok ? (
        <ResultError error={result.error} />
      ) : (
        <MachineList
          machines={result.data}
          emptyText="还没有 Machine。先新建 Machine，再按详情说明安装并连接 Worker。"
          href={(id) => `/machines/${id}`}
          renderLink={({ href, ...props }) => <Link to={href} {...props} />}
        />
      )}
      <MachineCreateDialog
        open={open}
        onOpenChange={setOpen}
        submit={(input) => createMachineFn({ data: input })}
        onCreated={(enrollment) => {
          setEnrollment(enrollment);
          void navigate({
            to: "/machines/$machineId",
            params: { machineId: enrollment.detail.machine.id },
          });
        }}
      />
    </PageFrame>
  );
}
