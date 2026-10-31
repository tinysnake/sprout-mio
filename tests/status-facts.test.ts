import { describe, expect, it } from "vite-plus/test";
import {
  registerSproutStatus,
  setSproutHostFacts,
  sproutStatusPayload,
} from "../src/extension/status";
import type { SproutExtensionAPI, SproutToolContext } from "../src/extension/types";

/**
 * `sprout_status` 的进程与会话事实。
 *
 * 这两条以前是 `"unimplemented"` 常量（P1 的边界声明），现在是实时事实。这里盯的是
 * 「值来自哪里」，不是文案：`worker.pid` 必须等于跑这段代码的进程，`piSession` 必须
 * 优先取宿主写入的那一份、缺席时才退到 Pi 自己的 session manager 并明说没有宿主。
 *
 * 顺序有意义：`setSproutHostFacts` 写的是进程级槽（一次 open 一个进程，不设计撤销），
 * 所以「没有宿主」的三条在前，「宿主写过之后」那条在最后。
 */

function statusTools(): Map<string, Parameters<SproutExtensionAPI["registerTool"]>[0]> {
  const tools = new Map<string, Parameters<SproutExtensionAPI["registerTool"]>[0]>();
  registerSproutStatus({
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    },
    registerCommand: () => undefined,
  });
  return tools;
}

/** Pi 在真实会话里传进来的上下文：只带上这里真的读的那一条。 */
const piContext: SproutToolContext = {
  sessionManager: {
    getSessionId: () => "9f2c1f38-0000-4000-8000-000000000001",
    getSessionFile: () => "/tmp/pi-sessions/2026-01-01T00-00-00-000Z_9f2c1f38.jsonl",
  },
};

describe("sprout_status 的 worker 与 piSession 事实", () => {
  it("没有宿主实况时 worker 报当前进程与独立 CLI 装载，piSession 明说没有宿主", () => {
    expect(sproutStatusPayload()).toMatchObject({
      app: "sprout-mio",
      // 换成常量数字这条就红：pid 只能是跑这段代码的进程。
      worker: { pid: process.pid, loader: "standalone-cli" },
      piSession: { host: "none", id: null, file: null },
    });
    // 没有 Pi 上下文、也没有宿主实况：会话身份就是「不知道」，不能编一个。
    expect(sproutStatusPayload()).not.toHaveProperty("host");
  });

  it("Pi 上下文带来真实会话身份，但写入者仍记作 none（没有 Sprout 宿主）", () => {
    expect(sproutStatusPayload(piContext).piSession).toEqual({
      host: "none",
      id: "9f2c1f38-0000-4000-8000-000000000001",
      file: "/tmp/pi-sessions/2026-01-01T00-00-00-000Z_9f2c1f38.jsonl",
    });
    expect(sproutStatusPayload(piContext)).not.toHaveProperty("host");
  });

  it("工具执行位置上第五个参数才是 Pi 的上下文，载荷与直接调用一致", async () => {
    const tool = statusTools().get("sprout_status")!;
    const result = await tool.execute("probe", {}, undefined, undefined, piContext);
    expect(result.details).toEqual(sproutStatusPayload(piContext));
    const [block] = result.content;
    expect(block.type).toBe("text");
    expect(JSON.parse((block as { type: "text"; text: string }).text)).toEqual(result.details);
  });

  it("宿主写过实况后，装载方式与会话身份跟着宿主走，pid 仍是本进程", () => {
    const source = "pi-host-runner";
    setSproutHostFacts({
      source,
      loader: "pi-host-runner",
      runtime: { node: process.versions.node, pi: "1.4.0" },
      host: { inheritHostResources: false, extensions: ["sprout-extension"] },
      session: {
        id: "host-written-session",
        file: "/pi/data/sessions/host-written-session.jsonl",
        model: "sprout-verify-local/status-probe",
        thinking: "off",
        activeTools: 31,
        registeredTools: 31,
      },
      run: { id: "run_00000000-0000-4000-8000-000000000000" },
    });
    const payload = sproutStatusPayload(piContext);
    // 装载方式不是那条降级常量：宿主自报了什么就是什么。
    expect(payload.worker).toEqual({ pid: process.pid, loader: "pi-host-runner" });
    // 宿主写入的会话身份优先于 Pi 上下文里的那一份。
    expect(payload.piSession).toEqual({
      host: "pi-host-runner",
      id: "host-written-session",
      file: "/pi/data/sessions/host-written-session.jsonl",
    });
    expect(payload.host).toMatchObject({ source, session: { id: "host-written-session" } });
  });
});
