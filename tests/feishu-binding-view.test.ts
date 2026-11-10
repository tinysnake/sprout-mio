import { afterAll, expect, it } from "vite-plus/test";
import type { FeishuConnectionSnapshot } from "../src/contracts/feishu-channel";
import { channelNativeFixture } from "./fixtures/channel-native";

// fixture 先设置 DATABASE_URL，再动态导入落在 db 上的模块。
const f = await channelNativeFixture();
const { buildFeishuBindingView } = await import("../src/server/feishu/view");
afterAll(() => f.close());

const connection: FeishuConnectionSnapshot = Object.freeze({
  appId: "app-1",
  phase: "connected",
  generation: 3,
  epochId: "fse_current",
  error: null,
  changedAtMs: 1,
});

it("reports an unbound slot without inventing a target", () => {
  const s = f.scenario();
  const view = buildFeishuBindingView({
    ctx: s.ctx,
    projectId: s.project.id,

    connection,
    now: s.now,
  });
  expect(view).toMatchObject({
    adapter: "feishu",

    connection: { phase: "connected", generation: 3, epochId: "fse_current" },
    binding: { bound: false, revision: 0, target: null },
    challenge: null,
    humanNeedsConfirmation: false,
  });
});

it("surfaces a pending challenge as human confirmation, then the bound target", () => {
  const s = f.scenario();
  const started = f.feishu.startFeishuChallenge(
    { projectId: s.project.id, chatId: s.dm.id },
    s.ctx,
    s.now,
  );
  const pending = buildFeishuBindingView({
    ctx: s.ctx,
    projectId: s.project.id,

    connection,
    now: s.now,
  });
  expect(pending.binding.bound).toBe(false);
  expect(pending.binding.revision).toBe(1);
  expect(pending.challenge).toEqual({
    code: started.challenge,
    expiresAtMs: started.expiresAtMs,
  });
  expect(pending.humanNeedsConfirmation).toBe(true);

  f.feishu.finishFeishuChallenge(s.project.id, started.challenge, s.identity, "req_view", s.now);
  const bound = buildFeishuBindingView({
    ctx: s.ctx,
    projectId: s.project.id,

    connection,
    now: s.now,
  });
  expect(bound.binding.bound).toBe(true);
  expect(bound.binding.target).toEqual({
    projectId: s.project.id,
    chatId: s.dm.id,
    agentName: "Helper",
    chatTitle: null,
  });
  expect(bound.challenge).toBeNull();
  expect(bound.humanNeedsConfirmation).toBe(false);
});

it("shows the platform nickname of the bound account and forgets it on unbind", () => {
  const s = f.scenario();
  s.bind();
  const view = () =>
    buildFeishuBindingView({ ctx: s.ctx, projectId: s.project.id, connection, now: s.now });
  const maskedOpenId = `***${s.identity.openId.slice(-4)}`;
  expect(view().binding.account).toEqual({ nickname: null, maskedOpenId });

  f.feishu.setFeishuNickname(s.identity, "  李雷  ");
  expect(view().binding.account).toEqual({ nickname: "李雷", maskedOpenId });

  f.feishu.unbindFeishuIdentity(s.project.id, view().binding.revision, s.ctx, s.now);
  expect(view().binding.account).toBeNull();

  // 换绑或解绑后，旧身份晚到的昵称不能写回来。
  f.feishu.setFeishuNickname(s.identity, "韩梅梅");
  expect(view().binding.account).toBeNull();
});

it("keeps a cross-project binding opaque and drops an expired challenge", () => {
  const s = f.scenario();
  s.bind();
  const other = f.projects.createProject({ name: "Another project" }, s.ctx);
  const view = buildFeishuBindingView({
    ctx: s.ctx,
    projectId: other.id,

    connection,
    now: s.now,
  });
  expect(view.configured).toBe(false);
  expect(view.binding.bound).toBe(false);
  expect(view.binding.target).toBeNull();
  expect(JSON.stringify(view)).not.toContain(s.dm.id);

  const fresh = f.scenario();
  const started = f.feishu.startFeishuChallenge(
    { projectId: fresh.project.id, chatId: fresh.dm.id },
    fresh.ctx,
    fresh.now,
  );
  expect(started.expiresAtMs).toBeGreaterThan(fresh.now.getTime());
  const expired = buildFeishuBindingView({
    ctx: fresh.ctx,
    projectId: fresh.project.id,

    connection,
    now: new Date(started.expiresAtMs + 1),
  });
  expect(expired.challenge).toBeNull();
  expect(expired.humanNeedsConfirmation).toBe(false);
});
