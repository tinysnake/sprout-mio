import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import type { MachineEnrollment, MachineResult } from "../../contracts/machine";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ResultError } from "../project/result-error";
import { enrollmentLabel, formatMoment } from "./machine-view";
import { StatusLine } from "./machine-list";
import { MachineInstallInstructions } from "./machine-install-instructions";

function enrollmentKey(enrollment: MachineEnrollment | null): string {
  if (!enrollment) return "none";
  return `${enrollment.detail.machine.id}|${enrollment.expiresAt}|${enrollment.ticket}`;
}

export function MachineEnrollmentPanel({
  machineId,
  enrollmentStatus,
  enrollment,
  onRenew,
  onEnrollmentCreated,
  onEnrollmentRevoked,
  installOrigin,
}: {
  machineId: string;
  enrollmentStatus: "pending" | "active";
  enrollment: MachineEnrollment | null;
  onRenew?: (machineId: string) => Promise<MachineResult<MachineEnrollment>>;
  onEnrollmentCreated?: (enrollment: MachineEnrollment) => void;
  /**
   * 在途续签被放弃时撤销该 target 的父级票据。服务端结果未知，可能已替换票据，
   * 展示一张已失效的一次性票据比丢失这次展示更糟。
   */
  onEnrollmentRevoked?: (machineId: string) => void;
  installOrigin?: string;
}) {
  const [current, setCurrent] = useState(enrollment);
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const inFlight = useRef<object | null>(null);
  // 渲染即推进，让迟到的结果在身份切换的同一提交里失效，不等下方 effect。
  const identity = useRef(machineId);
  const appliedIdentity = useRef(machineId);
  identity.current = machineId;
  const appliedKey = useRef(enrollmentKey(enrollment));
  const renewRef = useRef(onRenew);
  renewRef.current = onRenew;
  const createdRef = useRef(onEnrollmentCreated);
  createdRef.current = onEnrollmentCreated;
  const revokedRef = useRef(onEnrollmentRevoked);
  revokedRef.current = onEnrollmentRevoked;

  useEffect(() => {
    const key = enrollmentKey(enrollment);
    if (appliedIdentity.current !== machineId) {
      const abandoned = appliedIdentity.current;
      appliedIdentity.current = machineId;
      if (inFlight.current) revokedRef.current?.(abandoned);
      inFlight.current = null;
      appliedKey.current = key;
      setPending(false);
      setCurrent(enrollment);
      setRevealed(false);
      setError(null);
      return;
    }
    if (appliedKey.current === key) return;
    appliedKey.current = key;
    setCurrent(enrollment);
    setRevealed(false);
    setError(null);
  }, [enrollment, machineId]);

  useEffect(
    () => () => {
      if (inFlight.current) revokedRef.current?.(appliedIdentity.current);
      inFlight.current = null;
    },
    [],
  );

  async function renew() {
    const renewEnrollment = renewRef.current;
    if (inFlight.current || !renewEnrollment) return;
    const token = {};
    inFlight.current = token;
    const target = machineId;
    const owned = () => inFlight.current === token && identity.current === target;
    setPending(true);
    setError(null);
    try {
      const result = await renewEnrollment(target);
      if (!owned()) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCurrent(result.data);
      setRevealed(false);
      createdRef.current?.(result.data);
    } catch (cause) {
      if (!owned()) return;
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      if (owned()) {
        inFlight.current = null;
        setPending(false);
      }
    }
  }

  const status = enrollmentLabel(enrollmentStatus);
  const ticket =
    enrollmentStatus === "pending" && current?.detail.machine.id === machineId ? current : null;
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
            {ticket ? formatMoment(ticket.expiresAt) : "没有待使用的票据"}
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

      {ticket && (
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
              {ticket.ticket}
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
