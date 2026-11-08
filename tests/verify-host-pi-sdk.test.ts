import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  HOST_PI_SDK_EXIT,
  MCP_MODULE_GATES,
  hostAgentDir,
  probeHostPiMcpModule,
  probeHostPiSdk,
  skipLines,
} from "../scripts/verify/lib/host-pi-sdk.mjs";

const directories: string[] = [];

function tempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "host-pi-sdk-"));
  directories.push(directory);
  return directory;
}

/** 造一份托管安装：install/releases/9.9.9/node_modules/@earendil-works/... */
function hostedInstall(agentDir: string, options: { sdk?: boolean; mcp?: boolean } = {}) {
  const modules = join(agentDir, "install", "releases", "9.9.9", "node_modules", "@earendil-works");
  if (options.sdk !== false) {
    mkdirSync(join(modules, "pi-coding-agent", "dist"), { recursive: true });
    writeFileSync(
      join(modules, "pi-coding-agent", "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
    );
    writeFileSync(join(modules, "pi-coding-agent", "dist", "index.js"), "export {};\n");
  }
  if (options.mcp) {
    mkdirSync(join(modules, "pi-mcp", "dist"), { recursive: true });
    writeFileSync(join(modules, "pi-mcp", "dist", "index.js"), "export {};\n");
  }
  return modules;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("host Pi SDK precondition", () => {
  it("空 agent 目录：SDK 与 native MCP 模块都不可用，理由指名找不到什么", async () => {
    const agentDir = tempDirectory();

    const sdk = await probeHostPiSdk({ PI_CODING_AGENT_DIR: agentDir });
    expect(sdk).toMatchObject({ available: false, label: "宿主托管 Pi SDK", agentDir });
    expect(sdk.reason).toContain("找不到 Pi SDK");

    const mcp = await probeHostPiMcpModule({ PI_CODING_AGENT_DIR: agentDir });
    expect(mcp).toMatchObject({ available: false, label: "宿主托管 Pi SDK 的 native MCP 模块" });
    expect(mcp.reason).toContain("找不到 Pi SDK");
  });

  it("只有 SDK 时两个探测分别报可用与缺 pi-mcp，且都指到实际目录", async () => {
    const agentDir = tempDirectory();
    const modules = hostedInstall(agentDir);

    const sdk = await probeHostPiSdk({ PI_CODING_AGENT_DIR: agentDir });
    expect(sdk.available).toBe(true);
    expect(sdk.root).toBe(join(modules, "pi-coding-agent"));

    const mcp = await probeHostPiMcpModule({ PI_CODING_AGENT_DIR: agentDir });
    expect(mcp.available).toBe(false);
    expect(mcp.reason).toContain(join(modules, "pi-mcp", "dist", "index.js"));
  });

  it("SDK 与 pi-mcp 都在时两个探测都可用", async () => {
    const agentDir = tempDirectory();
    const modules = hostedInstall(agentDir, { mcp: true });

    expect((await probeHostPiSdk({ PI_CODING_AGENT_DIR: agentDir })).available).toBe(true);
    const mcp = await probeHostPiMcpModule({ PI_CODING_AGENT_DIR: agentDir });
    expect(mcp.available).toBe(true);
    expect(mcp.root).toBe(join(modules, "pi-mcp"));
  });

  it("PI_MCP_MODULE 覆盖优先，指向缺 dist/index.js 的目录时如实报不可用", async () => {
    const agentDir = tempDirectory();
    hostedInstall(agentDir, { mcp: true });

    const empty = tempDirectory();
    const override = await probeHostPiMcpModule({
      PI_CODING_AGENT_DIR: agentDir,
      PI_MCP_MODULE: empty,
    });
    expect(override.available).toBe(false);
    expect(override.reason).toContain("PI_MCP_MODULE");

    const moduleDir = tempDirectory();
    mkdirSync(join(moduleDir, "dist"), { recursive: true });
    writeFileSync(join(moduleDir, "dist", "index.js"), "export {};\n");
    const available = await probeHostPiMcpModule({
      PI_CODING_AGENT_DIR: agentDir,
      PI_MCP_MODULE: moduleDir,
    });
    expect(available).toMatchObject({ available: true, root: moduleDir });
  });

  it("MCP_MODULE_GATES 只覆盖深导入 pi-mcp 的门禁，skipLines 与退出码指明未执行", async () => {
    for (const gate of [
      "x2-mcp-extension",
      "y-mcp-worker",
      "z2-mcp-integration",
      "z3-mcp-acceptance",
    ])
      expect(MCP_MODULE_GATES.has(gate)).toBe(true);
    for (const gate of ["b-tooling", "chat-skills", "z-lease-integration"])
      expect(MCP_MODULE_GATES.has(gate)).toBe(false);

    const mcp = await probeHostPiMcpModule({ PI_CODING_AGENT_DIR: tempDirectory() });
    const lines = skipLines("y-mcp-worker", mcp);
    expect(lines[0]).toContain("SKIP y-mcp-worker 缺少宿主托管 Pi SDK 的 native MCP 模块");
    expect(lines[1]).toContain("PI_CODING_AGENT_DIR=");
    expect(lines.join("\n")).toContain("跳过不产生通过结论");
    expect(HOST_PI_SDK_EXIT).toBe(77);
  });

  it("未设 PI_CODING_AGENT_DIR 时回退到 ~/.pi/agent", () => {
    expect(hostAgentDir({})).toMatch(/\/\.pi\/agent$/);
  });
});
