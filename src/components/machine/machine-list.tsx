import type { ReactNode } from "react";
import { Monitor } from "lucide-react";
import type { MachineDetail } from "../../contracts/machine";
import { Icon } from "../ui/icon";
import type { StatusTone } from "./machine-view";
import { connectionLabel, enrollmentLabel, machineListSummary } from "./machine-view";

const toneText: Record<StatusTone, string> = {
  success: "text-status-success",
  warning: "text-status-warning",
  muted: "text-muted-foreground",
  danger: "text-status-failed",
};

export function StatusLine({
  label,
  detail,
  tone,
  testId,
}: {
  label: string;
  detail?: string;
  tone: StatusTone;
  testId?: string;
}) {
  return (
    <span data-testid={testId} className="inline-flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full bg-current ${toneText[tone]}`}
      />
      <span className={toneText[tone]}>{label}</span>
      {detail && <span className="truncate text-muted-foreground">· {detail}</span>}
    </span>
  );
}

export type MachineLinkRenderer = (props: {
  href: string;
  className: string;
  children: ReactNode;
  "data-testid"?: string;
  "data-machine-id"?: string;
  "aria-current"?: "page";
}) => ReactNode;

function DefaultMachineLink({
  href,
  className,
  children,
  ...props
}: Parameters<MachineLinkRenderer>[0]) {
  return (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  );
}

export function MachineList({
  machines,
  href,
  renderLink = DefaultMachineLink,
  selectedId,
  emptyText = "还没有 Machine，先按安装说明启动一个 Worker。",
}: {
  machines: MachineDetail[];
  href: (machineId: string) => string;
  renderLink?: MachineLinkRenderer;
  selectedId?: string;
  emptyText?: string;
}) {
  if (machines.length === 0)
    return (
      <p data-testid="machine-empty" className="text-xs leading-6 text-muted-foreground">
        {emptyText}
      </p>
    );
  return (
    <ul
      data-testid="machine-list"
      className="divide-y divide-border overflow-hidden rounded-container border border-border"
    >
      {machines.map((detail) => {
        const connection = connectionLabel(detail.connection);
        const enrollment = enrollmentLabel(detail.enrollmentStatus);
        const selected = selectedId === detail.machine.id;
        return (
          <li key={detail.machine.id}>
            {renderLink({
              href: href(detail.machine.id),
              "data-testid": "machine-item",
              "data-machine-id": detail.machine.id,
              "aria-current": selected ? "page" : undefined,
              className: `flex min-h-20 items-center gap-3.5 px-5 py-4 hover:bg-hover max-desktop:gap-2.5 max-desktop:px-3 ${
                selected ? "bg-selected" : ""
              }`,
              children: (
                <>
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
                    <Icon as={Monitor} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span data-testid="machine-item-name" className="text-sm font-medium">
                        {detail.machine.name}
                      </span>
                      <span
                        data-testid="machine-item-enrollment"
                        className={`text-xs ${toneText[enrollment.tone]}`}
                      >
                        {enrollment.label}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        <StatusLine
                          label={connection.label}
                          detail={connection.detail}
                          tone={connection.tone}
                          testId="machine-item-connection"
                        />
                      </span>
                    </span>
                    <span
                      data-testid="machine-item-summary"
                      className="mt-1.5 block text-xs leading-6 text-muted-foreground"
                    >
                      {machineListSummary(detail)}
                    </span>
                    <span className="mt-0.5 block break-all font-mono text-[0.6875rem] text-muted-foreground">
                      {detail.machine.id}
                    </span>
                  </span>
                </>
              ),
            })}
          </li>
        );
      })}
    </ul>
  );
}
