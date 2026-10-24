import { ChevronRight } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import type { MachineDetail } from "../../contracts/machine";
import { formatMoment } from "./machine-view";

export function MachineShellSummary({
  capability,
  connection,
}: {
  capability: MachineDetail["capability"];
  connection: MachineDetail["connection"];
}) {
  if (!capability?.current) {
    const message =
      connection.kind === "offline"
        ? "Worker 已断连"
        : connection.kind === "connecting"
          ? "Worker 正在连接，当前能力尚未上报"
          : "当前能力尚未上报";
    return <p className="text-xs text-muted-foreground">{message}</p>;
  }
  const shells = capability.snapshot.shells;

  return (
    <div className="flex min-w-0 items-center gap-2 text-[0.6875rem]">
      <Dialog>
        <DialogTrigger
          render={<Button variant="outline" size="sm" />}
          data-testid="machine-shell-summary"
          aria-haspopup="dialog"
          className="min-w-0 gap-2 whitespace-nowrap px-2 text-[0.6875rem]"
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
                        : "text-status-success"
                    }
                  >
                    {fact.kind === "unknown" ? "?" : fact.probe.kind === "success" ? "✓" : "✗"}{" "}
                    {fact.kind}
                  </span>
                </span>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">? 未报告 shell</span>
          )}
          <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        </DialogTrigger>
        <DialogContent data-testid="machine-shell-details" className="w-4xl">
          <DialogHeader>
            <DialogTitle>Shell 探测详情</DialogTitle>
            <DialogDescription>来自 Worker 的实际探测；未知 shell 不猜调用语法。</DialogDescription>
          </DialogHeader>
          {!shells.length ? (
            <p
              data-testid="machine-shells-empty"
              className="mt-2 text-xs leading-6 text-muted-foreground"
            >
              Worker 未报告可用 shell。
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
                  <code className="block break-all font-mono text-[0.6875rem]">{fact.path}</code>
                  <p
                    data-testid="machine-shell-version"
                    className="break-words font-mono text-[0.6875rem] text-muted-foreground"
                  >
                    {fact.version ?? "版本未知"}
                  </p>
                  <p
                    className={
                      fact.probe.kind === "failure" ? "text-destructive" : "text-muted-foreground"
                    }
                  >
                    {fact.probe.kind === "success" ? "自检通过" : `自检失败：${fact.probe.reason}`}
                  </p>
                  {fact.kind === "unknown" && (
                    <p className="text-muted-foreground">未知 shell，不猜调用语法。</p>
                  )}
                  <p className="text-muted-foreground">检查时间 {formatMoment(fact.checkedAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
      <span
        data-testid="machine-shell-platform"
        className="whitespace-nowrap text-muted-foreground"
      >
        平台 {capability.snapshot.platform} {capability.snapshot.arch}
      </span>
    </div>
  );
}
