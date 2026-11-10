import type {
  CapabilitySnapshot,
  DirectoryObservation,
  ExecutionEnvironment,
  ExecutionSessionKind,
  MachineConnectionView,
  MachineDetail,
  ShellFact,
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
  // 只读列表只给「可达」一个事实：不重复派生路径，不展示观察时间、连接代次或观察 revision。
  return result.kind === "accessible"
    ? { label: "当前可达", tone: "success" }
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

const EXECUTION_SESSION_LABELS: Record<ExecutionSessionKind, string> = {
  interactive_desktop: "交互桌面",
  service_session_0: "服务会话（Session 0）",
  not_applicable: "不适用（非 Windows）",
  unknown: "会话未知",
};
/** 只展示 Worker 报上来的事实；没有上报就是「未上报」，不拿平台猜一个会话。 */
export function executionEnvironmentLabel(environment: ExecutionEnvironment | undefined): string {
  if (!environment) return "执行环境未上报";
  const base = EXECUTION_SESSION_LABELS[environment.sessionKind];
  if (environment.sessionId === null) return base;
  if (environment.sessionKind === "service_session_0" && environment.sessionId === 0) return base;
  return `${base} · Session ${environment.sessionId}`;
}

/**
 * 执行环境的页面读法：状态 + 一句人能读懂的边界说明。
 * `kind` 为 null 表示 Worker 没上报（旧版本协议），与「未知」不是同一件事。
 * `desktopVerified` 为 false 时页面必须标「桌面相关能力未验证」；null 表示该平台不存在这项能力。
 */
export type ExecutionEnvironmentView = {
  kind: ExecutionSessionKind | null;
  /** 单独出现时的完整说法，例如「执行环境未上报」。 */
  label: string;
  /** 前面已经有「执行环境」字样时用的短说法，避免读成「执行环境 执行环境未上报」。 */
  shortLabel: string;
  detail: string;
  tone: StatusTone;
  desktopVerified: boolean | null;
};

const EXECUTION_SESSION_VIEWS: Record<
  ExecutionSessionKind,
  Omit<ExecutionEnvironmentView, "label" | "shortLabel">
> = {
  interactive_desktop: {
    kind: "interactive_desktop",
    detail: "Worker 跑在登录用户的交互桌面会话里，桌面相关能力有实测证据。",
    tone: "success",
    desktopVerified: true,
  },
  service_session_0: {
    kind: "service_session_0",
    detail:
      "Worker 跑在系统服务会话，没有交互桌面。托盘、图形程序、交互式凭据这类桌面能力未验证，不要按桌面环境推断。",
    tone: "warning",
    desktopVerified: false,
  },
  unknown: {
    kind: "unknown",
    detail: "Worker 读不到会话编号，因此不判定会话类型。桌面相关能力未验证，不要按桌面环境推断。",
    tone: "warning",
    desktopVerified: false,
  },
  not_applicable: {
    kind: "not_applicable",
    detail: "非 Windows 平台没有服务会话与交互桌面之分，这项不适用于该机器。",
    tone: "muted",
    desktopVerified: null,
  },
};

export function executionEnvironmentView(
  environment: ExecutionEnvironment | undefined,
): ExecutionEnvironmentView {
  if (!environment)
    return {
      kind: null,
      label: "执行环境未上报",
      shortLabel: "未上报",
      detail: "这个 Worker 没有上报执行环境。旧版本 Worker 没有这项探测，不等于不支持。",
      tone: "muted",
      desktopVerified: false,
    };
  const label = executionEnvironmentLabel(environment);
  return {
    ...EXECUTION_SESSION_VIEWS[environment.sessionKind],
    label,
    shortLabel: label,
  };
}

const SHELL_PROBE_FAILURE_REASONS: Record<
  Extract<ShellFact["probe"], { kind: "failure" }>["reason"],
  string
> = {
  missing: "找不到可执行文件",
  denied: "没有执行权限",
  timeout: "自检超时",
  unsupported: "不支持的 shell，不猜调用语法",
  failed: "执行失败",
  output_limit: "输出超出上限",
};

/** 自检结论：符号、文字与语气一起给，不靠颜色单独表达。 */
export type ShellProbeView = { glyph: "✓" | "✗" | "?"; label: string; tone: StatusTone };

export function shellProbeView(fact: ShellFact): ShellProbeView {
  if (fact.kind === "unknown") return { glyph: "?", label: "未知 shell，未判定", tone: "warning" };
  if (fact.probe.kind === "failure")
    return {
      glyph: "✗",
      label: `自检失败：${SHELL_PROBE_FAILURE_REASONS[fact.probe.reason]}`,
      tone: "danger",
    };
  return { glyph: "✓", label: "自检通过", tone: "success" };
}

/** 降级提示：Windows 上没有可用的 PowerShell 7 时必须明说，而不是只让颜色变一下。 */
export type ShellDegradation = { tone: "warning" | "danger"; title: string; detail: string };

export function shellDegradation(snapshot: CapabilitySnapshot): ShellDegradation | null {
  if (snapshot.platform !== "win32") return null;
  // 空列表是「未报告」，不是「全部候选都失败」：不能把没探测过的说成探测失败。
  if (snapshot.shells.length === 0) return null;
  const usable = (kind: ShellFact["kind"]) =>
    snapshot.shells.some((fact) => fact.kind === kind && fact.probe.kind === "success");
  if (usable("pwsh")) return null;
  const pwsh = snapshot.shells.find((fact) => fact.kind === "pwsh");
  const fallbacks = [
    usable("powershell") ? "Windows PowerShell 5.1（powershell.exe）" : null,
    usable("cmd") ? "cmd" : null,
  ].filter((value) => value !== null);
  if (fallbacks.length === 0)
    return {
      tone: "danger",
      title: "没有可用的 Windows shell",
      detail: "所有候选 shell 的自检都失败了，这台机器目前不能执行命令。",
    };
  return {
    tone: "warning",
    title: !pwsh
      ? "未探测到 PowerShell 7（pwsh）"
      : pwsh.probe.kind === "failure" && pwsh.probe.reason === "missing"
        ? "未找到 PowerShell 7（pwsh）"
        : "PowerShell 7（pwsh）自检失败",
    detail: `当前可用的是 ${fallbacks.join(" 和 ")}。${
      usable("powershell")
        ? "Windows PowerShell 5.1 的参数与语法和 PowerShell 7 有差异，为 PowerShell 7 写的脚本可能失败。"
        : "只有 cmd，依赖 PowerShell 的命令会失败。"
    }`,
  };
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
