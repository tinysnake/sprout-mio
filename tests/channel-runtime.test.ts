import { afterAll, afterEach, expect, it, vi } from "vite-plus/test";
import type { FeishuRuntime } from "../src/server/feishu/runtime";
import { feishuNativeFixture } from "./fixtures/feishu-native";

const state = vi.hoisted(() => ({
  events: [] as string[],
  live: new Set<string>(),
  fail: false,
  humanId: "",
}));
vi.mock("../src/server/session", () => ({
  requireSession: async (_headers: Headers, requestId: string) => ({
    ok: true,
    data: { userId: state.humanId },
    requestId,
  }),
}));
vi.mock("../src/server/feishu/runtime", () => ({
  feishuTransportConfig: (config: unknown) => config,
  createFeishuRuntime: (input: { projectId: string; config: { appId: string } }): FeishuRuntime => {
    if (state.fail) throw new Error("secret must not reach diagnostics");
    return {
      start() {
        expect(state.live.has(input.projectId)).toBe(false);
        state.live.add(input.projectId);
        state.events.push(`start:${input.projectId}:${input.config.appId}`);
      },
      stop() {
        state.live.delete(input.projectId);
        state.events.push(`stop:${input.projectId}`);
      },
    } as FeishuRuntime;
  },
}));
const f = await feishuNativeFixture();
state.humanId = f.ctx.userId;
const functions = await import("../src/server/functions/channels");
const domain = await import("../src/domain/channel-config");
const runtime = await import("../src/server/channel-runtime");
const registry = await import("../src/server/feishu/registry");
afterAll(() => f.close());
afterEach(() => {
  state.fail = false;
  registry.stopFeishuRuntimes();
  state.events.length = 0;
});
const input = (projectId: string, suffix: string) => ({
  projectId,
  kind: "feishu",
  enabled: true,
  revision: 0,
  settings: { origin: "https://open.feishu.cn", appId: `cli_${suffix.repeat(16)}` },
  appSecret: "private-key",
});

it("starts all configured Projects, serializes reloads per Project and leaves peers untouched", async () => {
  const a = f.projects.createProject({ name: "A" }, f.ctx);
  const b = f.projects.createProject({ name: "B" }, f.ctx);
  domain.saveChannelConfig(input(a.id, "A"), f.ctx.userId);
  domain.saveChannelConfig(input(b.id, "B"), f.ctx.userId);
  await runtime.startChannelRuntimes();
  expect(state.live).toEqual(new Set([a.id, b.id]));
  const oldA = registry.currentFeishuRuntime(a.id);
  const oldB = registry.currentFeishuRuntime(b.id);
  domain.saveChannelConfig({ ...input(a.id, "C"), revision: 1 }, f.ctx.userId);
  await runtime.reloadChannelRuntime(a.id);
  expect(registry.currentFeishuRuntime(a.id)).not.toBe(oldA);
  expect(registry.currentFeishuRuntime(b.id)).toBe(oldB);
  expect(state.events.slice(-2)).toEqual([`stop:${a.id}`, `start:${a.id}:cli_${"C".repeat(16)}`]);
  state.events.length = 0;
  await Promise.all([
    runtime.reloadChannelRuntime(a.id),
    runtime.reloadChannelRuntime(a.id),
    runtime.reloadChannelRuntime(b.id),
  ]);
  expect(state.events.filter((event) => event.startsWith("start:"))).toEqual([
    `start:${a.id}:cli_${"C".repeat(16)}`,
    `start:${b.id}:cli_${"B".repeat(16)}`,
    `start:${a.id}:cli_${"C".repeat(16)}`,
  ]);
  domain.saveChannelConfig({ ...input(a.id, "C"), revision: 2, enabled: false }, f.ctx.userId);
  await runtime.reloadChannelRuntime(a.id);
  expect(registry.currentFeishuRuntime(a.id)).toBeNull();
  expect(registry.currentFeishuRuntime(b.id)).not.toBeNull();
});

it("serves secret-free Human config RPCs and reloads only successful saves", async () => {
  const project = f.projects.createProject({ name: "RPC" }, f.ctx);
  const headers = new Headers();
  const saved = await functions.saveChannelConfigBoundary(
    input(project.id, "E"),
    headers,
    "req_save",
  );
  expect(saved.ok).toBe(true);
  expect(state.live.has(project.id)).toBe(true);
  const view = await functions.getChannelConfigsBoundary(
    { projectId: project.id },
    headers,
    "req_read",
  );
  expect(view).toMatchObject({
    ok: true,
    data: [{ projectId: project.id, configured: true, hasAppSecret: true, revision: 1 }],
  });
  expect(JSON.stringify([saved, view])).not.toContain("private-key");
  expect(JSON.stringify([saved, view])).not.toContain("appSecret");
  const running = registry.currentFeishuRuntime(project.id);
  const conflict = await functions.saveChannelConfigBoundary(
    input(project.id, "E"),
    headers,
    "req_conflict",
  );
  expect(conflict).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(registry.currentFeishuRuntime(project.id)).toBe(running);
});

it("keeps committed config and records a sanitized diagnostic when reload fails", async () => {
  const project = f.projects.createProject({ name: "Failed" }, f.ctx);
  state.fail = true;
  const saved = await functions.saveChannelConfigBoundary(
    input(project.id, "D"),
    new Headers(),
    "req_reload_failure",
  );
  expect(saved.ok).toBe(true);
  expect(domain.loadChannelConfigRow(project.id, "feishu")?.revision).toBe(1);
  const diagnostics = f.sqlite
    .prepare("SELECT * FROM diagnostic_event WHERE event='channel.runtime_reload_failed'")
    .all();
  expect(diagnostics).toHaveLength(1);
  expect(JSON.stringify(diagnostics)).not.toContain("private-key");
  expect(JSON.stringify(diagnostics)).not.toContain("secret must not reach diagnostics");
});
