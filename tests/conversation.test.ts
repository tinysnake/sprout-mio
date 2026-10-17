import { beforeAll, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

type Evidence = {
  conversationId: string;
  instanceId: string;
  instanceCount: number;
  dmRepeat: { sameConversation: boolean; sameInstance: boolean; ok: boolean };
  unauthorizedCodes: string[];
  crossUserCodes: string[];
  invalidBody: { code: string; fields: string[] };
  agentFirst: { bodies: string[]; senderKinds: string[]; stable: boolean };
  afterHuman: { bodies: string[]; senderKinds: string[]; count: number };
  humanSend: { ok: boolean; id?: string };
  personaUpdate: { ok: boolean };
  instanceUnchanged: boolean;
  messagesRetained: number;
};

let evidence: Evidence;

beforeAll(() => {
  mkdirSync(".verify", { recursive: true });
  const directory = mkdtempSync(resolve(".verify/conversation-test-"));
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      const { migrateDatabase } = await import("./src/db/migrate.ts");
      migrateDatabase();
      const { auth } = await import("./src/lib/auth.ts");
      const projects = await import("./src/server/functions/project.ts");
      const agents = await import("./src/server/functions/agent.ts");
      const conversations = await import("./src/server/functions/conversation.ts");
      const domain = await import("./src/domain/conversation.ts");
      const code = (result) => result.ok ? "ok" : result.error.code;
      const fields = (result) => Object.keys(result.fieldErrors ?? {}).sort();
      const signUp = async (tag) => {
        const result = await auth.api.signUpEmail({
          body: { email: tag + "-" + Date.now() + "@example.test", password: "{{SECRET_p2-c-conversation-pass}}", name: tag },
          returnHeaders: true,
        });
        return { headers: new Headers({ cookie: result.headers.get("set-cookie").split(";")[0] }), userId: result.response.user.id };
      };
      const userA = await signUp("conversation-a");
      const userB = await signUp("conversation-b");
      const project = await projects.createProjectBoundary({ name: "A 的对话 Project" }, userA.headers, "req_c1");
      const projectId = project.data.id;
      const profile = await agents.createAgentProfileBoundary({ name: "对话 Agent", persona: "初始人设" }, userA.headers, "req_c2");
      const profileId = profile.data.id;
      await agents.addProjectMemberBoundary({ projectId, agentProfileId: profileId }, userA.headers, "req_c3");

      const dm1 = await conversations.createDirectConversationBoundary({ projectId, agentProfileId: profileId }, userA.headers, "req_d1");
      const dm2 = await conversations.createDirectConversationBoundary({ projectId, agentProfileId: profileId }, userA.headers, "req_d2");
      if (!dm1.ok || !dm2.ok) throw new Error("DM 创建失败");
      const conversationId = dm1.data.conversation.id;
      const instanceId = dm1.data.instance.id;
      const { sqlite } = await import("./src/db/index.ts");
      const instanceCount = sqlite.prepare("SELECT count(*) AS n FROM agent_instance WHERE conversation_id = ?").get(conversationId).n;

      const anonymous = new Headers();
      const unauthorized = [
        await conversations.createDirectConversationBoundary({ projectId, agentProfileId: profileId }, anonymous, "req_u1"),
        await conversations.listConversationsBoundary({ projectId }, anonymous, "req_u2"),
        await conversations.getConversationBoundary({ conversationId }, anonymous, "req_u3"),
        await conversations.listConversationMembersBoundary({ conversationId }, anonymous, "req_u4"),
        await conversations.listInstancesForConversationBoundary({ conversationId }, anonymous, "req_u5"),
        await conversations.listMessagesBoundary({ conversationId }, anonymous, "req_u6"),
        await conversations.sendMessageBoundary({ conversationId, body: "无会话" }, anonymous, "req_u7"),
      ];
      const crossUser = [
        await conversations.listConversationsBoundary({ projectId }, userB.headers, "req_x1"),
        await conversations.createDirectConversationBoundary({ projectId, agentProfileId: profileId }, userB.headers, "req_x2"),
        await conversations.getConversationBoundary({ conversationId }, userB.headers, "req_x3"),
        await conversations.listConversationMembersBoundary({ conversationId }, userB.headers, "req_x4"),
        await conversations.listInstancesForConversationBoundary({ conversationId }, userB.headers, "req_x5"),
        await conversations.listMessagesBoundary({ conversationId }, userB.headers, "req_x6"),
        await conversations.sendMessageBoundary({ conversationId, body: "越权消息" }, userB.headers, "req_x7"),
      ];
      const invalidBody = await conversations.sendMessageBoundary({ conversationId, body: "   " }, userA.headers, "req_v1");

      const ctx = { userId: userA.userId, requestId: "req_dom" };
      domain.sendMessage(conversationId, { senderKind: "agent", senderId: profileId, body: "agent 第一条" }, ctx);
      const agentFirst = domain.listMessages(conversationId, ctx);
      const agentFirstAgain = domain.listMessages(conversationId, ctx);
      const humanSend = await conversations.sendMessageBoundary({ conversationId, body: "human 第二条" }, userA.headers, "req_h1");
      const afterHuman = domain.listMessages(conversationId, ctx);

      const personaUpdate = await agents.updateAgentProfileBoundary({ agentProfileId: profileId, persona: "新人设：编辑后的分身" }, userA.headers, "req_a2");
      const instancesAfter = domain.listInstancesForConversation(conversationId, ctx);
      const messagesAfter = domain.listMessages(conversationId, ctx);

      console.log("EVIDENCE " + JSON.stringify({
        conversationId,
        instanceId,
        instanceCount,
        dmRepeat: {
          ok: dm2.ok,
          sameConversation: dm2.data.conversation.id === conversationId,
          sameInstance: dm2.data.instance.id === instanceId,
        },
        unauthorizedCodes: unauthorized.map(code),
        crossUserCodes: crossUser.map(code),
        invalidBody: { code: code(invalidBody), fields: fields(invalidBody) },
        agentFirst: {
          bodies: agentFirst.map((entry) => entry.body),
          senderKinds: agentFirst.map((entry) => entry.senderKind),
          stable: JSON.stringify(agentFirst) === JSON.stringify(agentFirstAgain),
        },
        afterHuman: {
          bodies: afterHuman.map((entry) => entry.body),
          senderKinds: afterHuman.map((entry) => entry.senderKind),
          count: afterHuman.length,
        },
        humanSend: humanSend.ok ? { ok: true, id: humanSend.data.id } : { ok: false },
        personaUpdate: { ok: personaUpdate.ok },
        instanceUnchanged: instancesAfter.length === 1 && instancesAfter[0].id === instanceId,
        messagesRetained: messagesAfter.length,
      }));
      sqlite.close();
    `,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "conversation.sqlite"),
          BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
          NODE_ENV: "test",
        },
        encoding: "utf8",
        timeout: 60000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    evidence = JSON.parse(
      output
        .split("\n")
        .find((line) => line.startsWith("EVIDENCE "))!
        .slice(9),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Conversation DM 边界与分身身份", () => {
  it("同一 (project, profile) 重复发起 DM 返回同一对话与同一分身，agent_instance 只有一行", () => {
    expect(evidence.dmRepeat).toEqual({ ok: true, sameConversation: true, sameInstance: true });
    expect(evidence.instanceCount).toBe(1);
  });

  it("未登录调用每个新 boundary 都返回 unauthorized", () => {
    expect(evidence.unauthorizedCodes).toHaveLength(7);
    expect(evidence.unauthorizedCodes.every((value) => value === "unauthorized")).toBe(true);
  });

  it("另一个用户的 project 与 conversation 在列表、详情与发消息上返回 not_found", () => {
    expect(evidence.crossUserCodes).toHaveLength(7);
    expect(evidence.crossUserCodes.every((value) => value === "not_found")).toBe(true);
  });

  it("空 body 发送返回 validation_failed 并给出 body 字段错误", () => {
    expect(evidence.invalidBody.code).toBe("validation_failed");
    expect(evidence.invalidBody.fields).toContain("body");
  });

  it("agent 先发消息顺序稳定，human 第二条后仍按时间与 rowid 升序", () => {
    expect(evidence.agentFirst.bodies).toEqual(["agent 第一条"]);
    expect(evidence.agentFirst.senderKinds).toEqual(["agent"]);
    expect(evidence.agentFirst.stable).toBe(true);
    expect(evidence.humanSend.ok).toBe(true);
    expect(evidence.afterHuman.count).toBe(2);
    expect(evidence.afterHuman.bodies).toEqual(["agent 第一条", "human 第二条"]);
    expect(evidence.afterHuman.senderKinds).toEqual(["agent", "human"]);
  });

  it("修改 profile 人设后分身 instance id 不变且消息保留", () => {
    expect(evidence.personaUpdate.ok).toBe(true);
    expect(evidence.instanceUnchanged).toBe(true);
    expect(evidence.messagesRetained).toBe(2);
  });
});
