import { afterAll, expect, it } from "vite-plus/test";
import { channelNativeFixture } from "./fixtures/channel-native";

// fixture 先设置 DATABASE_URL 与环境变量，再动态导入会话/配置相关模块。
const f = await channelNativeFixture();
const contracts = await import("../src/contracts/feishu-channel");
const functions = await import("../src/server/functions/feishu");
afterAll(() => f.close());

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
