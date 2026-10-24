import type {
  DirectoryObservation,
  MachineConnectionView,
  MachineDetail,
} from "../../contracts/machine";
import type { LeaseMutationInput, LeaseMutationView } from "../../contracts/lease";
import type { AppResult } from "../../contracts/result";

import { projectWorkingPath } from "../../contracts/machine";

export type StatusTone = "success" | "warning" | "muted" | "danger";

/**
 * 租约变更的注入点：正式页面接服务端入口，演示场景接固定回调。
 * 返回值就是服务端结果，组件不会把 pending 自己转成成功。
 */
export type LeaseMutationHandler = (
  input: LeaseMutationInput,
) => Promise<AppResult<LeaseMutationView>>;

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

const DIRECTORY_UNAVAILABLE_REASONS: Record<
  Extract<DirectoryObservation["result"], { kind: "unavailable" }>["reason"],
  string
> = {
  missing:
    "期望路径的目录不存在。一期不会自动创建，需自行在 Worker 所在机器上创建目录，或修改 root。",
  not_directory: "该路径存在但不是目录。请在 Worker 所在机器上改为目录，或修改 root 指向目录。",
  denied:
    "该路径存在，但 Worker 无权访问。请在 Worker 所在机器上为运行 Worker 的用户授予目录访问权限。",
  io_error:
    "读取该路径时出错。请在 Worker 所在机器上检查磁盘和目录是否可读，排除问题后等待重新检查。",
};

export function observationLabel(
  observation: { current: boolean; fact: DirectoryObservation } | null | undefined,
): Label {
  if (!observation) return { label: "未验证", detail: "Worker 尚未回报该目录", tone: "muted" };
  if (!observation.current)
    return {
      label: "旧观察",
      detail: "不是当前连接或 root 版本的事实",
      tone: "muted",
    };
  const { result } = observation.fact;
  return result.kind === "accessible"
    ? { label: "当前可达", detail: result.realPath, tone: "success" }
    : { label: "当前不可用", detail: DIRECTORY_UNAVAILABLE_REASONS[result.reason], tone: "danger" };
}

export function bindingDirectory(root: string | null, projectId: string): string {
  return root === null
    ? "尚未设置 Machine root，无法探测路径"
    : projectWorkingPath(root, projectId);
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

export function installCommands(machineId: string, origin = WORKER_ORIGIN_PLACEHOLDER) {
  const url = origin === WORKER_ORIGIN_PLACEHOLDER ? null : new URL(origin);
  const allowHttp =
    url?.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ? ` --allow-http ${url.origin}`
      : "";
  return {
    init: `node "$HOME/.local/share/sprout-worker/main.mjs" init --server ${origin}${allowHttp} --machine ${machineId} --state-dir "$HOME/.local/share/sprout-worker/identity"`,
    run: 'node "$HOME/.local/share/sprout-worker/main.mjs" run --state-dir "$HOME/.local/share/sprout-worker/identity"',
  };
}
