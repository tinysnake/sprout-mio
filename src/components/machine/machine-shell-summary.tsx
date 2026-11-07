import type { LucideIcon } from "lucide-react";
import {
  ChevronRight,
  CircleDashed,
  CircleHelp,
  Minus,
  Monitor,
  Server,
  TriangleAlert,
} from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Icon } from "../ui/icon";
import type { ExecutionSessionKind, MachineDetail } from "../../contracts/machine";
import {
  executionEnvironmentView,
  formatMoment,
  shellDegradation,
  shellProbeView,
} from "./machine-view";
import type { StatusTone } from "./machine-view";

const toneText: Record<StatusTone, string> = {
  success: "text-status-success",
  warning: "text-status-warning",
  danger: "text-status-failed",
  muted: "text-muted-foreground",
};

/** 状态提示不套卡片：靠左侧的规则线表现语气，颜色只是补充。 */
const toneRule: Record<StatusTone, string> = {
  success: "border-status-success",
  warning: "border-status-warning",
  danger: "border-status-failed",
  muted: "border-border",
};

/** 每个执行环境一种图标，让「未上报 / 未知 / 不适用」不必只靠文字区分。 */
const EXECUTION_ICONS: Record<ExecutionSessionKind | "unreported", LucideIcon> = {
  unreported: CircleDashed,
  interactive_desktop: Monitor,
  service_session_0: Server,
  unknown: CircleHelp,
  not_applicable: Minus,
};

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
    return (
      <p data-testid="machine-shell-capability-missing" className="text-xs text-muted-foreground">
        {message}
      </p>
    );
  }

  const snapshot = capability.snapshot;
  const shells = snapshot.shells;
  const environment = executionEnvironmentView(snapshot.executionEnvironment);
  const degradation = shellDegradation(snapshot);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div
        data-testid="machine-execution-environment"
        className={`flex min-w-0 flex-col gap-0.5 border-l-2 pl-3 ${toneRule[environment.tone]}`}
      >
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
          <Icon
            as={EXECUTION_ICONS[environment.kind ?? "unreported"]}
            className={`size-3.5 shrink-0 ${toneText[environment.tone]}`}
          />
          <span className="text-muted-foreground">执行环境</span>
          <span
            data-testid="machine-execution-environment-label"
            className={`font-medium ${toneText[environment.tone]}`}
          >
            {environment.shortLabel}
          </span>
          {environment.desktopVerified === false && (
            <span
              data-testid="machine-execution-environment-unverified"
              className="rounded-full border border-border px-1.5 text-[0.625rem] leading-4 text-muted-foreground"
            >
              桌面相关能力未验证
            </span>
          )}
        </p>
        <p className="text-[0.6875rem] leading-5 text-muted-foreground">{environment.detail}</p>
      </div>

      {degradation && (
        <p
          data-testid="machine-shell-degradation"
          className={`flex min-w-0 flex-col gap-0.5 border-l-2 pl-3 text-[0.6875rem] leading-5 ${toneRule[degradation.tone]}`}
        >
          <span className={`flex min-w-0 items-center gap-1.5 ${toneText[degradation.tone]}`}>
            <Icon as={TriangleAlert} className="size-3.5 shrink-0" />
            <span data-testid="machine-shell-degradation-title" className="font-medium">
              {degradation.title}
            </span>
          </span>
          <span className="text-muted-foreground">{degradation.detail}</span>
        </p>
      )}

      {shells.length === 0 ? (
        <p
          data-testid="machine-shell-facts-empty"
          className="text-xs leading-6 text-muted-foreground"
        >
          Worker 未报告可用 shell。
        </p>
      ) : (
        <ul
          data-testid="machine-shell-facts"
          className="flex min-w-0 flex-col divide-y divide-border border-y border-border"
        >
          {shells.map((fact) => {
            const probe = shellProbeView(fact);
            const version = fact.version ?? "版本未知";
            return (
              <li
                key={fact.path}
                data-testid="machine-shell-fact"
                className="flex min-w-0 flex-col gap-0.5 py-2 text-[0.6875rem] leading-5"
              >
                <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span
                    data-testid="machine-shell-fact-kind"
                    className="inline-flex items-center gap-1.5 font-medium"
                  >
                    <span aria-hidden="true" className={toneText[probe.tone]}>
                      {probe.glyph}
                    </span>
                    {fact.kind}
                  </span>
                  <span
                    data-testid="machine-shell-fact-probe"
                    className={
                      probe.tone === "success" ? "text-muted-foreground" : toneText[probe.tone]
                    }
                  >
                    {probe.label}
                  </span>
                </p>
                <code
                  data-testid="machine-shell-fact-path"
                  className="min-w-0 break-all font-mono text-muted-foreground"
                >
                  {fact.path}
                </code>
                <span
                  data-testid="machine-shell-fact-version"
                  title={version}
                  className="min-w-0 truncate font-mono text-muted-foreground"
                >
                  {version}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex min-w-0 flex-wrap items-center gap-2 text-[0.6875rem]">
        <Dialog>
          <DialogTrigger
            render={<Button variant="outline" size="sm" />}
            data-testid="machine-shell-summary"
            aria-haspopup="dialog"
            className="min-w-0 gap-2 whitespace-nowrap px-2 text-[0.6875rem]"
          >
            查看完整探测详情
            <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          </DialogTrigger>
          <DialogContent data-testid="machine-shell-details" className="w-4xl">
            <DialogHeader>
              <DialogTitle>Shell 探测详情</DialogTitle>
              <DialogDescription>
                来自 Worker 的实际探测；未知 shell 不猜调用语法。
              </DialogDescription>
            </DialogHeader>
            <p
              data-testid="machine-shell-details-platform"
              className="text-xs text-muted-foreground"
            >
              平台 {snapshot.platform} {snapshot.arch} · Worker {snapshot.workerVersion}
            </p>
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
                      {shellProbeView(fact).label}
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
          平台 {snapshot.platform} {snapshot.arch}
        </span>
      </div>
    </div>
  );
}
