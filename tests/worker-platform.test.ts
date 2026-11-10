import { describe, expect, it } from "vite-plus/test";
import {
  absolutePathSchema,
  capabilitySnapshotSchema,
  projectWorkingPath,
} from "../src/contracts/machine";
import {
  executionSessionKind,
  parsePsOutput,
  parseTasklistCsv,
  processTreeKillIsForced,
  shellInvocation,
} from "../src/worker/platform";

describe("跨平台绝对路径", () => {
  it("接受 POSIX、盘符与 UNC 绝对路径", () => {
    for (const path of [
      "/Users/snake/work",
      "/",
      "C:\\Users\\tffas",
      "C:/Users/tffas",
      "c:\\windows\\system32\\cmd.exe",
      "\\\\server\\share\\project",
      "\\\\?\\C:\\long\\path",
    ])
      expect(absolutePathSchema.safeParse(path).success, path).toBe(true);
  });

  it("拒绝相对路径、空串、NUL 与超长路径", () => {
    for (const path of [
      "",
      "relative/path",
      "./here",
      "C:",
      "C:relative",
      "/tmp/\0bad",
      `/${"a".repeat(4096)}`,
    ])
      expect(absolutePathSchema.safeParse(path).success, path).toBe(false);
  });

  it("项目工作目录按 root 自己的分隔符拼接", () => {
    expect(projectWorkingPath("/Users/snake/roots", "prj_1")).toBe("/Users/snake/roots/prj_1");
    expect(projectWorkingPath("/Users/snake/roots/", "prj_1")).toBe("/Users/snake/roots/prj_1");
    expect(projectWorkingPath("C:\\sprout\\roots", "prj_1")).toBe("C:\\sprout\\roots\\prj_1");
    expect(projectWorkingPath("C:\\sprout\\roots\\", "prj_1")).toBe("C:\\sprout\\roots\\prj_1");
  });
});

describe("平台能力契约", () => {
  const base = {
    arch: "x64",
    workerVersion: "0.1.0",
    remoteOperations: ["shell", "file_read"],
  };

  it("Windows 快照能表达三种 shell 与执行环境", () => {
    const parsed = capabilitySnapshotSchema.parse({
      ...base,
      platform: "win32",
      shells: [
        { path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", kind: "pwsh" },
        {
          path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          kind: "powershell",
        },
        { path: "C:\\Windows\\System32\\cmd.exe", kind: "cmd" },
      ].map((shell) => ({
        ...shell,
        version: "7.6.9",
        checkedAt: "2026-11-07T00:00:00.000Z",
        probe: { kind: "success" },
      })),
      executionEnvironment: { sessionId: 0, sessionKind: "service_session_0" },
    });
    expect(parsed.platform).toBe("win32");
    expect(parsed.executionEnvironment?.sessionKind).toBe("service_session_0");
  });

  it("没有执行环境字段的旧快照仍然有效", () => {
    const parsed = capabilitySnapshotSchema.parse({
      ...base,
      arch: "arm64",
      platform: "darwin",
      shells: [],
    });
    expect(parsed.executionEnvironment).toBeUndefined();
  });

  it("不认识的平台与会话种类不会被静默接受", () => {
    expect(
      capabilitySnapshotSchema.safeParse({ ...base, platform: "linux", shells: [] }).success,
    ).toBe(false);
    expect(
      capabilitySnapshotSchema.safeParse({
        ...base,
        platform: "win32",
        shells: [],
        executionEnvironment: { sessionId: 0, sessionKind: "desktop" },
      }).success,
    ).toBe(false);
  });
});

describe("各 shell 的调用语法", () => {
  it("PowerShell 用 -Command，cmd 用 /d /s /c，POSIX 保持 -lc", () => {
    expect(shellInvocation("C:\\pwsh.exe", "pwsh", "Get-Location")).toEqual({
      file: "C:\\pwsh.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-Location"],
    });
    expect(
      shellInvocation("C:\\powershell.exe", "powershell", "Get-Location").args.slice(-2),
    ).toEqual(["-Command", "Get-Location"]);
    expect(shellInvocation("C:\\cmd.exe", "cmd", "dir")).toEqual({
      file: "C:\\cmd.exe",
      args: ["/d", "/s", "/c", "dir"],
    });
    expect(shellInvocation("/bin/zsh", "zsh", "pwd")).toEqual({
      file: "/bin/zsh",
      args: ["-lc", "pwd"],
    });
    expect(shellInvocation("/bin/sh", "unknown", "pwd")).toEqual({
      file: "/bin/sh",
      args: ["-lc", "pwd"],
    });
  });
});

describe("进程列表解析", () => {
  it("tasklist CSV 的引号、逗号与空行都按 CSV 处理", () => {
    const output = [
      '"chrome.exe","1234","Console","1","100,000 K"',
      '"my ""quoted"" tool.exe","42","Services","0","1,024 K"',
      "",
      '"System Idle Process","0","Services","0","8 K"',
      "not csv",
    ].join("\r\n");
    expect(parseTasklistCsv(output)).toEqual([
      { pid: 1234, command: "chrome.exe" },
      { pid: 42, command: 'my "quoted" tool.exe' },
    ]);
  });

  it("ps 输出保留带空格的命令名", () => {
    expect(parsePsOutput("  123 /usr/bin/zsh\n456 node\nbad line\n")).toEqual([
      { pid: 123, command: "/usr/bin/zsh" },
      { pid: 456, command: "node" },
    ]);
  });
});

describe("执行环境语义", () => {
  it("Session 0 是服务会话，其他 SessionId 是交互桌面", () => {
    expect(executionSessionKind(0)).toBe("service_session_0");
    expect(executionSessionKind(1)).toBe("interactive_desktop");
    expect(executionSessionKind(130)).toBe("interactive_desktop");
  });

  it("Windows 上没有可送达的 TERM，终止一律是强制的", () => {
    expect(processTreeKillIsForced()).toBe(process.platform === "win32");
  });
});
