import type {
  CapabilitySnapshot,
  ExecutionEnvironment,
  ShellFact,
} from "../../../contracts/machine";
import type { MachineDetail } from "../../../contracts/machine";

/**
 * 演示用的平台与执行环境场景。字段取自 p8d Worker 的真实上报形状：
 * Windows 候选 shell 固定是 pwsh → powershell → cmd，找不到的候选也照样上报一条
 * `failure: missing`，所以「降级」在页面上是看得见的探测结果，不是页面自己猜的。
 */
const CHECKED_AT = "2026-10-18T07:10:00.000Z";
const GNU_BASH_VERSION =
  "GNU bash, version 3.2.57(1)-release (arm64-apple-darwin26) Copyright (C) 2007 Free Software Foundation, Inc.";

function success(path: string, kind: ShellFact["kind"], version: string | null): ShellFact {
  return { path, kind, version, checkedAt: CHECKED_AT, probe: { kind: "success" } };
}

function missing(path: string, kind: ShellFact["kind"]): ShellFact {
  return {
    path,
    kind,
    version: null,
    checkedAt: CHECKED_AT,
    probe: { kind: "failure", reason: "missing" },
  };
}

export const MACOS_PLATFORM_SHELLS: ShellFact[] = [
  success("/bin/zsh", "zsh", "zsh 5.9"),
  success("/bin/bash", "bash", GNU_BASH_VERSION),
  success("/bin/sh", "sh", GNU_BASH_VERSION),
];

const WINDOWS_PWSH7_SHELLS: ShellFact[] = [
  success("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "pwsh", "PowerShell 7.4.6"),
  success(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "powershell",
    "5.1.26100.2161",
  ),
  success("C:\\Windows\\System32\\cmd.exe", "cmd", "10.0.26100.2161"),
];

/** 没装 PowerShell 7：pwsh 候选按 Worker 的行为照样上报一条 missing。 */
const WINDOWS_POWERSHELL51_SHELLS: ShellFact[] = [
  missing("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "pwsh"),
  success(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "powershell",
    "5.1.26100.2161",
  ),
  success("C:\\Windows\\System32\\cmd.exe", "cmd", "10.0.26100.2161"),
];

/** 精简镜像（Server Core 一类）：只有 cmd。 */
const WINDOWS_CMD_ONLY_SHELLS: ShellFact[] = [
  missing("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "pwsh"),
  missing("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell"),
  success("C:\\Windows\\System32\\cmd.exe", "cmd", "10.0.26100.2161"),
];

const SERVICE_SESSION: ExecutionEnvironment = { sessionId: 0, sessionKind: "service_session_0" };

const WINDOWS_REMOTE_OPERATIONS: CapabilitySnapshot["remoteOperations"] = [
  "shell",
  "file_read",
  "file_write",
  "process_list",
  "process_signal",
];

export const PLATFORM_SCENES = [
  "macos-full",
  "windows-pwsh7",
  "windows-powershell51",
  "windows-cmd-only",
  "windows-desktop",
  "windows-unknown",
  "windows-unreported",
] as const;

export type PlatformScene = (typeof PLATFORM_SCENES)[number];

export const PLATFORM_SCENE_LABELS: Record<PlatformScene, string> = {
  "macos-full": "macOS arm64 · zsh / bash / sh",
  "windows-pwsh7": "Windows 11 · PowerShell 7 + 5.1 + cmd",
  "windows-powershell51": "Windows 11 · 只有 PowerShell 5.1 + cmd（降级）",
  "windows-cmd-only": "Windows Server Core · 只有 cmd（降级）",
  "windows-desktop": "Windows 11 · 交互桌面会话（Session 3）",
  "windows-unknown": "Windows 11 · 会话未知（读不到 SessionId）",
  "windows-unreported": "Windows 11 · 旧 Worker 未上报执行环境",
};

function windowsSnapshot(
  shells: ShellFact[],
  executionEnvironment: ExecutionEnvironment | undefined,
  workerVersion: string,
): CapabilitySnapshot {
  return {
    platform: "win32",
    arch: "x64",
    workerVersion,
    ...(executionEnvironment ? { executionEnvironment } : {}),
    shells,
    remoteOperations: WINDOWS_REMOTE_OPERATIONS,
  };
}

export function platformSnapshot(scene: PlatformScene): CapabilitySnapshot {
  switch (scene) {
    case "macos-full":
      return {
        platform: "darwin",
        arch: "arm64",
        workerVersion: "0.4.2",
        executionEnvironment: { sessionId: null, sessionKind: "not_applicable" },
        shells: MACOS_PLATFORM_SHELLS,
        remoteOperations: ["shell", "file_read", "file_write", "process_list", "process_signal"],
      };
    case "windows-pwsh7":
      return windowsSnapshot(WINDOWS_PWSH7_SHELLS, SERVICE_SESSION, "0.4.2");
    case "windows-powershell51":
      return windowsSnapshot(WINDOWS_POWERSHELL51_SHELLS, SERVICE_SESSION, "0.4.2");
    case "windows-cmd-only":
      return windowsSnapshot(WINDOWS_CMD_ONLY_SHELLS, SERVICE_SESSION, "0.4.2");
    case "windows-desktop":
      return windowsSnapshot(
        WINDOWS_PWSH7_SHELLS,
        { sessionId: 3, sessionKind: "interactive_desktop" },
        "0.4.2",
      );
    case "windows-unknown":
      return windowsSnapshot(
        WINDOWS_PWSH7_SHELLS,
        { sessionId: null, sessionKind: "unknown" },
        "0.4.2",
      );
    case "windows-unreported":
      // 0.4.1 的 Worker 没有执行环境探测：缺省字段表示未上报，不表示桌面。
      return windowsSnapshot(WINDOWS_PWSH7_SHELLS, undefined, "0.4.1");
  }
}

export function platformCapability(scene: PlatformScene): NonNullable<MachineDetail["capability"]> {
  return { generation: 3, current: true, snapshot: platformSnapshot(scene) };
}
