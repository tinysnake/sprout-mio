import { useId, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown } from "lucide-react";
import type { MachineDetail } from "../../contracts/machine";
import { formatMoment } from "./machine-view";

export function MachineShellSummary({ capability }: { capability: MachineDetail["capability"] }) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  const shells = capability?.snapshot.shells ?? [];

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem]">
      <Popover.Root
        open={open}
        triggerId={triggerId}
        onOpenChange={(next, details) => setOpen(details.reason === "trigger-press" ? !open : next)}
      >
        <Popover.Trigger
          id={triggerId}
          data-testid="machine-shell-summary"
          openOnHover
          delay={0}
          onFocus={(event) => {
            if (event.currentTarget.matches(":focus-visible")) setOpen(true);
          }}
          className="inline-flex min-w-0 items-center gap-2 whitespace-nowrap rounded-control py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          {shells.length ? (
            <span className="inline-flex items-center gap-1.5">
              {shells.map((fact, index) => (
                <span key={fact.path} className="inline-flex items-center gap-1.5">
                  {index > 0 && <span className="text-muted-foreground">·</span>}
                  <span
                    data-testid="machine-shell-summary-item"
                    className={
                      fact.kind === "unknown" || fact.probe.kind === "failure"
                        ? "text-destructive"
                        : capability?.current
                          ? "text-status-success"
                          : "text-muted-foreground"
                    }
                  >
                    {fact.kind === "unknown" ? "?" : fact.probe.kind === "success" ? "✓" : "✗"}{" "}
                    {fact.kind}
                  </span>
                </span>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">
              ? {capability ? "未报告 shell" : "尚未探测"}
            </span>
          )}
          {capability && !capability.current && (
            <span className="text-muted-foreground">旧代次</span>
          )}
          <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
            <Popover.Popup
              data-testid="machine-shell-details"
              initialFocus={false}
              finalFocus={false}
              className="max-h-[var(--available-height)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-container border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-none"
            >
              <Popover.Title className="text-xs font-medium">Shell 探测详情</Popover.Title>
              <Popover.Description className="mt-1 text-xs leading-6 text-muted-foreground">
                来自 Worker 的实际探测；未知 shell 不猜调用语法。
              </Popover.Description>
              {capability && !capability.current && (
                <p
                  data-testid="machine-shell-stale"
                  className="mt-2 text-xs leading-6 text-muted-foreground"
                >
                  旧连接代次 {capability.generation} 的快照，不能当作现在可用。
                </p>
              )}
              {!shells.length ? (
                <p
                  data-testid="machine-shells-empty"
                  className="mt-2 text-xs leading-6 text-muted-foreground"
                >
                  {capability
                    ? "Worker 未报告可用 shell。"
                    : "尚无能力快照。Worker 完成认证并提交能力后才会出现。"}
                </p>
              ) : (
                <ul id="machine-shell-list" className="mt-2 divide-y divide-border">
                  {shells.map((fact) => (
                    <li
                      key={fact.path}
                      data-testid="machine-shell-item"
                      className="py-2 text-xs leading-6"
                    >
                      <p className="font-medium">{fact.kind}</p>
                      <code className="block break-all font-mono text-[0.6875rem]">
                        {fact.path}
                      </code>
                      <p className="break-words text-muted-foreground">
                        {fact.version ?? "版本未知"}
                      </p>
                      <p
                        className={
                          fact.probe.kind === "failure"
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }
                      >
                        {fact.probe.kind === "success"
                          ? "自检通过"
                          : `自检失败：${fact.probe.reason}`}
                      </p>
                      {fact.kind === "unknown" && (
                        <p className="text-muted-foreground">未知 shell，不猜调用语法。</p>
                      )}
                      <p className="text-muted-foreground">
                        检查时间 {formatMoment(fact.checkedAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <span
        data-testid="machine-shell-platform"
        className="whitespace-nowrap text-muted-foreground"
      >
        平台 {capability ? `${capability.snapshot.platform} ${capability.snapshot.arch}` : "未知"}
      </span>
    </div>
  );
}
