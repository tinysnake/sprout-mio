import { expect, it } from "vite-plus/test";
import {
  memoryDefaults,
  type MemorySettingsView,
  type MemorySnapshot,
} from "../src/contracts/memory";
import {
  memoryActionFailureText,
  memoryBankPreview,
  memoryConfigDraft,
  memoryConfigSaveInput,
  memoryStatus,
} from "../src/components/project/memory-config-view";

const view: MemorySettingsView = {
  config: null,
  effectiveState: { state: "unavailable", reason: "not_installed" },
  bankPreview: { kind: "namespaced", bankId: "sprout::prj_1" },
  install: null,
  extensionVersion: memoryDefaults.version,
  defaults: memoryDefaults,
};

it("uses server defaults and resolves namespaced and bare banks without inventing an empty target", () => {
  const draft = memoryConfigDraft(view);
  expect(draft).toMatchObject({ enabled: true, bankPrefix: "sprout", bankName: "", apiToken: "" });
  expect(memoryBankPreview(draft, "prj_1")).toEqual({ bank: "sprout::prj_1", error: null });
  expect(memoryBankPreview({ bankPrefix: " team ", bankName: " notes " }, "prj_1").bank).toBe(
    "team::notes",
  );
  expect(memoryBankPreview({ bankPrefix: "", bankName: "notes" }, "prj_1").bank).toBe("notes");
  expect(memoryBankPreview({ bankPrefix: " ", bankName: "" }, "prj_1")).toEqual({
    bank: null,
    error: "bank 前缀或名称至少填一个",
  });
  expect(memoryBankPreview({ bankPrefix: "Invalid", bankName: "notes" }, "prj_1").bank).toBeNull();
  expect(
    memoryBankPreview({ bankPrefix: "a".repeat(32), bankName: "b".repeat(96) }, "prj_1").bank,
  ).toBeNull();
});

it("saves the loaded revision while keeping stored tokens when the password is blank", () => {
  const stored: MemorySettingsView = {
    ...view,
    config: {
      projectId: "prj_1",
      provider: "hindsight",
      enabled: false,
      settings: {
        apiUrl: "https://memory.example",
        bankPrefix: "team",
        bankName: "notes",
        autoIndexCommits: false,
        refreshPages: true,
      },
      hasToken: true,
      revision: 7,
      updatedAtMs: 1,
      updatedByHumanId: "hum_1",
    },
  };
  const draft = memoryConfigDraft(stored);
  expect(draft).toMatchObject({ enabled: false, bankPrefix: "team", apiToken: "" });
  expect(memoryConfigSaveInput("prj_1", { ...draft, apiToken: "  " }, stored)).toEqual({
    projectId: "prj_1",
    provider: "hindsight",
    enabled: false,
    revision: 7,
    settings: stored.config?.settings,
  });
  expect(
    memoryConfigSaveInput("prj_1", { ...draft, apiToken: "new-token" }, stored).secrets,
  ).toEqual({ apiToken: "new-token" });
});

it.each<[MemorySnapshot, string]>([
  [{ state: "disabled" }, "已关闭"],
  [{ state: "ready", bank: "sprout::prj_1" }, "已就绪"],
  [{ state: "unavailable", reason: "installing" }, "安装中"],
  [{ state: "unavailable", reason: "not_installed" }, "未安装"],
  [{ state: "unavailable", reason: "install_failed" }, "安装失败"],
  [{ state: "unavailable", reason: "invalid_config" }, "配置有误"],
  [{ state: "unavailable", reason: "extension_load_failed" }, "加载失败"],
])("shows the effective memory state %j as %s", (state, label) => {
  expect(memoryStatus(state).label).toBe(label);
});

it.each([
  ["unreachable", "服务不可达"],
  ["unauthorized", "鉴权失败"],
  ["forbidden", "服务拒绝访问"],
  ["server_error", "记忆服务错误"],
] as const)("explains %s and preserves the service message", (code, label) => {
  const message = memoryActionFailureText({ ok: false, code, message: "服务返回的原因" });
  expect(message).toContain(label);
  expect(message).toContain("服务返回的原因");
});
