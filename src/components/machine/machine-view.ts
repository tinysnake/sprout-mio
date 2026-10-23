import type {
  DirectoryObservation,
  MachineConnectionView,
  MachineDetail,
  ProjectMachineIntent,
} from "../../contracts/machine";

export type StatusTone = "success" | "warning" | "muted" | "danger";

type Label = { label: string; detail?: string; tone: StatusTone };

const OFFLINE_REASONS: Record<
  Extract<MachineConnectionView, { kind: "offline" }>["reason"],
  string
> = {
  never_connected: "从未连接",
  closed: "Worker 已关闭连接",
  stale: "心跳超时",
  host_restarted: "宿主重启",
  superseded: "被新连接替代",
};

export function connectionLabel(connection: MachineConnectionView): Label {
  if (connection.kind === "online") return { label: "在线", tone: "success" };
  if (connection.kind === "connecting") return { label: "连接中", tone: "warning" };
  return {
    label: "断线",
    detail: OFFLINE_REASONS[connection.reason],
    tone: "danger",
  };
}

export function enrollmentLabel(status: MachineDetail["enrollmentStatus"]): Label {
  return status === "active"
    ? { label: "已配对", tone: "success" }
    : { label: "待配对", tone: "warning" };
}

export function formatMoment(value: string | null | undefined): string {
  if (!value) return "无记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function observationLabel(
  observation: { current: boolean; fact: DirectoryObservation } | null | undefined,
): Label {
  if (!observation) return { label: "未验证", detail: "Worker 尚未回报该目录", tone: "muted" };
  if (!observation.current)
    return {
      label: "旧观察",
      detail: "不是当前连接或绑定版本的事实",
      tone: "muted",
    };
  const { result } = observation.fact;
  return result.kind === "accessible"
    ? { label: "当前可达", detail: result.realPath, tone: "success" }
    : { label: "当前不可用", detail: result.reason, tone: "danger" };
}

export function bindingDirectory(intent: ProjectMachineIntent): string {
  return intent.directory ?? "未设置目录";
}

export function machineListSummary(detail: MachineDetail): string {
  const capability = detail.capability
    ? detail.capability.current
      ? `能力 ${detail.capability.snapshot.workerVersion}`
      : `旧能力 ${detail.capability.snapshot.workerVersion}`
    : "无能力快照";
  return `${capability} · 最后收到 ${formatMoment(detail.connection.lastSeenAt)}`;
}

export const WORKER_ORIGIN_PLACEHOLDER = "<server-origin>";

export function installCommands(machineId: string) {
  return {
    init: `node "$HOME/.local/share/sprout-worker/main.mjs" init --server ${WORKER_ORIGIN_PLACEHOLDER} --machine ${machineId} --state-dir "$HOME/.local/share/sprout-worker/identity"`,
    run: 'node "$HOME/.local/share/sprout-worker/main.mjs" run --state-dir "$HOME/.local/share/sprout-worker/identity"',
  };
}
