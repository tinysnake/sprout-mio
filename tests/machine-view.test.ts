import { describe, expect, it } from "vite-plus/test";
import { saveProjectMachineBindingInput } from "../src/contracts/machine";
import {
  connectionLabel,
  enrollmentLabel,
  installCommands,
  observationLabel,
} from "../src/components/machine/machine-view";

describe("Machine 呈现映射", () => {
  it("配对状态不随连接状态变化", () => {
    expect(enrollmentLabel("pending").label).toBe("待配对");
    expect(enrollmentLabel("active").label).toBe("已配对");
  });

  it("断线保留离线原因，不表示空闲或已释放", () => {
    const label = connectionLabel({
      kind: "offline",
      generation: 2,
      lastSeenAt: "2026-10-17T23:15:00.000Z",
      reason: "stale",
    });
    expect(label.label).toBe("断线");
    expect(label.detail).toBe("心跳超时");
    expect(label.tone).toBe("danger");
  });

  it("连接中与在线分开表达", () => {
    expect(
      connectionLabel({ kind: "online", generation: 3, lastSeenAt: "2026-10-18T07:11:30.000Z" }),
    ).toMatchObject({ label: "在线", tone: "success" });
    expect(
      connectionLabel({
        kind: "connecting",
        generation: 4,
        lastSeenAt: "2026-10-18T07:12:02.000Z",
      }),
    ).toMatchObject({ label: "连接中", tone: "warning" });
  });

  it("旧目录观察不能被当作当前事实", () => {
    const stale = observationLabel({
      current: false,
      fact: {
        machineId: "mch_44444444-4444-4444-8444-444444444444",
        generation: 2,
        projectId: "prj_11111111-1111-4111-8111-111111111111",
        bindingRevision: 3,
        revision: 4,
        seq: 41,
        checkedAt: "2026-10-17T22:55:00.000Z",
        result: { kind: "unavailable", reason: "missing" },
      },
    });
    expect(stale.label).toBe("旧观察");
    expect(observationLabel(null).label).toBe("未验证");
    // 可达时只给「当前可达」这一个事实：既不重复派生路径，也不把观察时间 / 代次 / revision 当阅读内容。
    expect(
      observationLabel({
        current: true,
        fact: {
          machineId: "mch_44444444-4444-4444-8444-444444444444",
          generation: 3,
          projectId: "prj_11111111-1111-4111-8111-111111111111",
          bindingRevision: 5,
          revision: 5,
          seq: 42,
          checkedAt: "2026-10-18T07:09:00.000Z",
          result: { kind: "accessible", realPath: "/Users/example/project" },
        },
      }),
    ).toEqual({ label: "当前可达", tone: "success" });
  });

  it("安装命令只带身份与状态目录，不包含票据", () => {
    const commands = installCommands("mch_11111111-1111-4111-8111-111111111111");
    const http = installCommands(
      "mch_11111111-1111-4111-8111-111111111111",
      "http://192.168.1.10:3210",
    );
    expect(http.init).toContain("--allow-http http://192.168.1.10:3210");
    expect(http.run).not.toContain("--allow-http");
    for (const origin of [
      "https://example.com",
      "http://localhost:3210",
      "http://127.0.0.1:3210",
      "http://[::1]:3210",
    ])
      expect(
        installCommands("mch_11111111-1111-4111-8111-111111111111", origin).init,
      ).not.toContain("--allow-http");
    expect(commands.init).toContain("--machine mch_11111111-1111-4111-8111-111111111111");
    expect(commands.init).toContain("--state-dir");
    expect(commands.run).toBe(
      'node "$HOME/.local/share/sprout-worker/main.mjs" run --state-dir "$HOME/.local/share/sprout-worker/identity"',
    );
    expect(`${commands.init} ${commands.run}`).not.toMatch(/ticket|secret|AAAA/);
  });

  it("绑定输入沿用共享 schema：空说明合法，限长且不再接受目录", () => {
    const input = {
      machineId: "mch_11111111-1111-4111-8111-111111111111",
      projectId: "prj_11111111-1111-4111-8111-111111111111",
      description: "",
      expectedRevision: null,
    };
    expect(saveProjectMachineBindingInput.safeParse(input).success).toBe(true);
    expect(
      saveProjectMachineBindingInput.safeParse({ ...input, description: "字".repeat(501) }).success,
    ).toBe(false);
    expect(
      saveProjectMachineBindingInput.safeParse({ ...input, directory: "relative/path" }).success,
    ).toBe(false);
  });
});
