import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import type { MachineEnrollment, MachineResult } from "../../contracts/machine";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ResultError } from "../project/result-error";
import { enrollmentLabel, formatMoment } from "./machine-view";
import { StatusLine } from "./machine-list";
import { MachineInstallInstructions } from "./machine-install-instructions";

/**
 * 配对事实与一次性短期票据。长期 secret 永远不进入 UI：这里只显示
 * `MachineEnrollment.ticket`，并且默认隐藏，避免截图或旁人看到。
 * `onRenew` 仅对 `pending` 提供；active 时服务端也不允许续签。
 */
export function MachineEnrollmentPanel({
  machineId,
  enrollmentStatus,
  enrollment,
  onRenew,
  installOrigin,
}: {
  machineId: string;
  enrollmentStatus: "pending" | "active";
  enrollment: MachineEnrollment | null;
  onRenew?: (machineId: string) => Promise<MachineResult<MachineEnrollment>>;
  /** 展示用的服务器 origin，占位值不发起请求。 */
  installOrigin?: string;
}) {
  const [current, setCurrent] = useState(enrollment);
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  useEffect(() => {
    setCurrent(enrollment);
    setRevealed(false);
  }, [enrollment]);

  async function renew() {
    if (pending || !onRenew) return;
    setPending(true);
    setError(null);
    try {
      const result = await onRenew(machineId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCurrent(result.data);
      setRevealed(false);
    } finally {
      setPending(false);
    }
  }

  const status = enrollmentLabel(enrollmentStatus);
  return (
    <div className="space-y-5" data-testid="machine-enrollment-panel">
      <dl className="grid gap-y-1 text-xs leading-7">
        <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
          <dt className="text-muted-foreground">配对状态</dt>
          <dd data-testid="machine-enrollment-status">
            <StatusLine label={status.label} tone={status.tone} />
          </dd>
        </div>
        <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
          <dt className="text-muted-foreground">票据到期</dt>
          <dd data-testid="machine-enrollment-expires">
            {current ? formatMoment(current.expiresAt) : "没有待使用的票据"}
          </dd>
        </div>
      </dl>

      {enrollmentStatus === "pending" && (
        <p className="text-xs leading-6 text-muted-foreground">
          尚未配对。启动 Worker 时读取下面的一次性票据；票据十分钟有效，续签会替换旧票据。
        </p>
      )}
      {enrollmentStatus === "active" && (
        <p
          data-testid="machine-enrollment-active"
          className="text-xs leading-6 text-muted-foreground"
        >
          已配对，票据已使用或不再需要。连接状态与配对状态分开记录，断线不会让已配对的 Machine
          变回待配对。
        </p>
      )}

      {current && (
        <div className="rounded-container border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-xs font-medium">
              <Icon as={KeyRound} />
              一次性短期票据
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-pressed={revealed}
              data-testid="machine-ticket-toggle"
              onClick={() => setRevealed((value) => !value)}
            >
              {revealed ? "隐藏票据" : "显示票据"}
            </Button>
          </div>
          {revealed ? (
            <code
              data-testid="machine-ticket-value"
              className="mt-3 block break-all rounded-control bg-secondary px-3 py-2 font-mono text-[0.6875rem] whitespace-pre-wrap"
            >
              {current.ticket}
            </code>
          ) : (
            <p data-testid="machine-ticket-hidden" className="mt-2 text-xs text-muted-foreground">
              票据已隐藏。它只显示这一次，不能写进命令参数、URL、截图或日志。
            </p>
          )}
          <p className="mt-2 text-xs leading-6 text-muted-foreground">
            Worker 应通过隐藏输入或仅本人可读的票据文件读取；命令本身只带文件路径。
          </p>
        </div>
      )}

      {error && <ResultError error={error} testId="machine-renew-error" />}
      {enrollmentStatus === "pending" && onRenew && (
        <Button
          type="button"
          variant="secondary"
          loading={pending}
          data-testid="machine-renew"
          onClick={() => void renew()}
        >
          续签票据
        </Button>
      )}

      <MachineInstallInstructions machineId={machineId} origin={installOrigin} />
    </div>
  );
}
