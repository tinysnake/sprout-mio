import { afterAll, expect, it } from "vite-plus/test";
import { channelNativeFixture } from "./fixtures/channel-native";

// fixture 先设置 DATABASE_URL 与环境变量，再动态导入会话/配置相关模块。
const f = await channelNativeFixture();
const contracts = await import("../src/contracts/feishu-channel");
const functions = await import("../src/server/functions/feishu");
const channelFunctions = await import("../src/server/functions/channels");
afterAll(() => f.close());

it("rejects unauthenticated and Agent-token channel configuration calls", async () => {
  for (const headers of [new Headers(), new Headers({ authorization: "Bearer agent-token" })]) {
    const before = f.sqlite.prepare("SELECT * FROM channel_config").all();
    const read = await channelFunctions.getChannelConfigsBoundary(
      { projectId: f.project.id, userId: f.ctx.userId },
      headers,
      "req_channel_read",
    );
    const save = await channelFunctions.saveChannelConfigBoundary(
      { projectId: f.project.id, kind: "feishu", enabled: false, revision: 0, settings: {} },
      headers,
      "req_channel_save",
    );
    expect(read.ok).toBe(false);
    expect(save.ok).toBe(false);
    expect(f.sqlite.prepare("SELECT * FROM channel_config").all()).toEqual(before);
  }
});

it("strips caller-supplied identity fields and requires an integer revision", () => {
  const stripped = contracts.feishuRevisionInput.parse({
    projectId: f.project.id,
    expectedRevision: 2,
    humanId: "forged-human",
    userId: "forged-human",
  });
  expect(stripped).toEqual({ projectId: f.project.id, expectedRevision: 2 });
  expect(() => contracts.feishuRevisionInput.parse({ projectId: f.project.id })).toThrow();
  expect(() =>
    contracts.feishuRevisionInput.parse({ projectId: f.project.id, expectedRevision: -1 }),
  ).toThrow();
  expect(() =>
    contracts.feishuStartChallengeInput.parse({ projectId: f.project.id, chatId: f.dm.id }),
  ).toThrow();
});

it("fails closed without a session instead of trusting the payload", async () => {
  const result = await functions.getFeishuBindingBoundary(
    { projectId: f.project.id },
    new Headers(),
    "req_boundary",
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(["unauthorized", "forbidden"]).toContain(result.error.code);
    expect(result.requestId).toBe("req_boundary");
  }
});

it("rejects mutations from an unauthenticated caller without touching the slot", async () => {
  const before = (
    f.sqlite
      .prepare("SELECT revision FROM feishu_identity_slot WHERE human_id=?")
      .get(f.ctx.userId) as { revision: number } | undefined
  )?.revision;
  const result = await functions.startFeishuChallengeBoundary(
    { projectId: f.project.id, chatId: f.dm.id, expectedRevision: before ?? 0 },
    new Headers(),
    "req_boundary_mutation",
  );
  expect(result.ok).toBe(false);
  const after = (
    f.sqlite
      .prepare("SELECT revision FROM feishu_identity_slot WHERE human_id=?")
      .get(f.ctx.userId) as { revision: number } | undefined
  )?.revision;
  expect(after).toBe(before);
});
