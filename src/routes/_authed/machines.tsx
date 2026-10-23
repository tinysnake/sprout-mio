import { createFileRoute, Outlet } from "@tanstack/react-router";
import { MachineEnrollmentProvider } from "../../components/machine/machine-enrollment-context";

export const Route = createFileRoute("/_authed/machines")({ component: MachinesLayout });

function MachinesLayout() {
  return (
    <MachineEnrollmentProvider>
      <Outlet />
    </MachineEnrollmentProvider>
  );
}
