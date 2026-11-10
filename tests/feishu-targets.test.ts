import { afterAll, expect, it } from "vite-plus/test";
import type { ProjectContext } from "../src/domain/project";
import { channelNativeFixture } from "./fixtures/channel-native";

// fixture 先设置 DATABASE_URL，再动态导入落在 db 上的模块。
const f = await channelNativeFixture();
const { buildFeishuTargetsView } = await import("../src/server/feishu/view");
afterAll(() => f.close());

it("lists the Human's assistant DM as a bindable target", () => {
  const s = f.scenario();
  const { targets } = buildFeishuTargetsView({ ctx: s.ctx, projectId: s.project.id });
  expect(targets).toEqual([{ chatId: s.dm.id, chatTitle: null, agentName: "Helper" }]);
});

it("does not list worker DMs or another Project's assistant DM", () => {
  const s = f.scenario();
  const otherProject = f.projects.createProject({ name: "Other project" }, s.ctx);
  const otherHelper = f.agents.createAgentProfile(
    { name: "Other helper", purpose: "assistant" },
    s.ctx,
  );
  f.agents.addProjectMember(otherProject.id, otherHelper.id, s.ctx);
  const otherDm = f.chats.createDirectChat(otherProject.id, otherHelper.id, s.ctx).chat;

  const { targets } = buildFeishuTargetsView({ ctx: s.ctx, projectId: s.project.id });
  const ids = targets.map((target) => target.chatId);
  expect(ids).toEqual([s.dm.id]);
  expect(ids).not.toContain(s.work.id);
  expect(ids).not.toContain(otherDm.id);
});

it("fails closed for an agent identity", () => {
  const s = f.scenario();
  const agentCtx: ProjectContext = {
    ...s.ctx,
    agent: { agentProfileId: s.helper.id, instanceId: "inst_targets", runId: "run_targets" },
  };
  expect(() => buildFeishuTargetsView({ ctx: agentCtx, projectId: s.project.id })).toThrow(
    "Feishu binding: forbidden",
  );
});

it("fails closed for a non-member", () => {
  const s = f.scenario();
  let thrown: unknown;
  try {
    buildFeishuTargetsView({
      ctx: { userId: "other-human", requestId: "req_targets_other" },
      projectId: s.project.id,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code: "not_found" });
});
