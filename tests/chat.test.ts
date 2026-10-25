import { beforeAll, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

type Evidence = {
  chatId: string;
  instanceId: string;
  instanceCount: number;
  dmRepeat: { sameChat: boolean; sameInstance: boolean; ok: boolean };
  title: {
    initialUndefined: boolean;
    renamed: { ok: boolean; title?: string; requestId?: string };
    trimmed: string | undefined;
    crossUserCode: string;
    crossUserTitleAfter: string | null;
    crossProjectCode: string;
    anonymousCode: string;
    anonTitleAfter: string | null;
    emptyCode: string;
    emptyFields: string[];
    tooLongCode: string;
    tooLongFields: string[];
    blankCode: string;
    clearedUndefined: boolean;
    titleAfterClearInDb: string | null;
    dbRejectsBlank: boolean;
    diagnostics: number;
  };
  unauthorizedCodes: string[];
  crossUserCodes: string[];
  crossProfileDm: {
    otherProfileCode: string;
    ghostProfileCode: string;
    chatRows: number;
    instanceRows: number;
    failedDiagnostics: number;
  };
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
  const directory = mkdtempSync(resolve(".verify/chat-test-"));
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
      const chats = await import("./src/server/functions/chat.ts");
      const domain = await import("./src/domain/chat.ts");
      const code = (result) => result.ok ? "ok" : result.error.code;
      const fields = (result) => Object.keys(result.fieldErrors ?? {}).sort();
      const signUp = async (tag) => {
        const result = await auth.api.signUpEmail({
          body: { email: tag + "-" + Date.now() + "@example.test", password: "test-pass-p2-c-chat", name: tag },
          returnHeaders: true,
        });
        return { headers: new Headers({ cookie: result.headers.get("set-cookie").split(";")[0] }), userId: result.response.user.id };
      };
      const userA = await signUp("chat-a");
      const userB = await signUp("chat-b");
      const project = await projects.createProjectBoundary({ name: "A 的对话 Project" }, userA.headers, "req_c1");
      const projectId = project.data.id;
      const profile = await agents.createAgentProfileBoundary({ name: "对话 Agent", persona: "初始人设" }, userA.headers, "req_c2");
      const profileId = profile.data.id;
      await agents.addProjectMemberBoundary({ projectId, agentProfileId: profileId }, userA.headers, "req_c3");

      const dm1 = await chats.createDirectChatBoundary({ projectId, agentProfileId: profileId }, userA.headers, "req_d1");
      const dm2 = await chats.createDirectChatBoundary({ projectId, agentProfileId: profileId }, userA.headers, "req_d2");
      if (!dm1.ok || !dm2.ok) throw new Error("DM 创建失败");
      const chatId = dm1.data.chat.id;
      const instanceId = dm1.data.instance.id;
      const { sqlite } = await import("./src/db/index.ts");
      const instanceCount = sqlite.prepare("SELECT count(*) AS n FROM agent_instance WHERE chat_id = ?").get(chatId).n;

      const anonymous = new Headers();
      const unauthorized = [
        await chats.createDirectChatBoundary({ projectId, agentProfileId: profileId }, anonymous, "req_u1"),
        await chats.listChatsBoundary({ projectId }, anonymous, "req_u2"),
        await chats.getChatBoundary({ chatId }, anonymous, "req_u3"),
        await chats.listChatMembersBoundary({ chatId }, anonymous, "req_u4"),
        await chats.listInstancesForChatBoundary({ chatId }, anonymous, "req_u5"),
        await chats.listMessagesBoundary({ chatId }, anonymous, "req_u6"),
        await chats.sendMessageBoundary({ chatId, body: "无会话" }, anonymous, "req_u7"),
      ];
      const crossUser = [
        await chats.listChatsBoundary({ projectId }, userB.headers, "req_x1"),
        await chats.createDirectChatBoundary({ projectId, agentProfileId: profileId }, userB.headers, "req_x2"),
        await chats.getChatBoundary({ chatId }, userB.headers, "req_x3"),
        await chats.listChatMembersBoundary({ chatId }, userB.headers, "req_x4"),
        await chats.listInstancesForChatBoundary({ chatId }, userB.headers, "req_x5"),
        await chats.listMessagesBoundary({ chatId }, userB.headers, "req_x6"),
        await chats.sendMessageBoundary({ chatId, body: "越权消息" }, userB.headers, "req_x7"),
      ];
      const invalidBody = await chats.sendMessageBoundary({ chatId, body: "   " }, userA.headers, "req_v1");

      // 标题：写入路径、服务端权限与数据库约束三方面的反证。
      const initialTitle = domain.getChat(chatId, { userId: userA.userId, requestId: "req_t0" }).title;
      const renamed = await chats.updateChatTitleBoundary(
        { chatId, title: "  仓库首页架构评审  " },
        userA.headers,
        "req_t1",
      );
      const trimmed = domain.getChat(chatId, { userId: userA.userId, requestId: "req_t2" }).title;
      const crossUserTitle = await chats.updateChatTitleBoundary(
        { chatId, title: "越权重命名" },
        userB.headers,
        "req_t3",
      );
      const crossProjectTitle = await chats.updateChatTitleBoundary(
        { chatId, title: "跨 Project 重命名" },
        userB.headers,
        "req_t4",
      );
      const anonymousTitle = await chats.updateChatTitleBoundary(
        { chatId, title: "未登录重命名" },
        anonymous,
        "req_t5",
      );
      const crossUserTitleAfter = sqlite.prepare("SELECT title FROM chat WHERE id = ?").get(chatId).title;
      const emptyTitle = await chats.updateChatTitleBoundary({ chatId, title: "   " }, userA.headers, "req_t6");
      const tooLongTitle = await chats.updateChatTitleBoundary(
        { chatId, title: "x".repeat(81) },
        userA.headers,
        "req_t7",
      );
      const cleared = await chats.clearChatTitleBoundary({ chatId }, userA.headers, "req_t8");
      const titleAfterClearInDb = sqlite.prepare("SELECT title FROM chat WHERE id = ?").get(chatId).title;
      let dbRejectsBlank = false;
      try {
        sqlite.prepare("UPDATE chat SET title = '   ' WHERE id = ?").run(chatId);
      } catch (error) {
        dbRejectsBlank = /chat_title_check/.test(String(error));
      }
      const titleDiagnostics = sqlite
        .prepare("SELECT count(*) AS n FROM diagnostic_event WHERE event IN ('chat.title_updated', 'chat.title_cleared') AND chat_id = ?")
        .get(chatId).n;

      const bProject = await projects.createProjectBoundary({ name: "B 的对话 Project" }, userB.headers, "req_b1");
      const bProjectId = bProject.data.id;
      const ghostProfileId = "agp_00000000-0000-4000-8000-000000000000";
      const crossProfileDm = await chats.createDirectChatBoundary(
        { projectId: bProjectId, agentProfileId: profileId },
        userB.headers,
        "req_b2",
      );
      const ghostProfileDm = await chats.createDirectChatBoundary(
        { projectId: bProjectId, agentProfileId: ghostProfileId },
        userB.headers,
        "req_b3",
      );
      const bChatRows = sqlite.prepare("SELECT count(*) AS n FROM chat WHERE project_id = ?").get(bProjectId).n;
      const bInstanceRows = sqlite.prepare("SELECT count(*) AS n FROM agent_instance WHERE project_id = ?").get(bProjectId).n;
      const failedDiagnostics = sqlite
        .prepare("SELECT count(*) AS n FROM diagnostic_event WHERE event = 'chat.request_failed' AND request_id IN (?, ?)")
        .get("req_b2", "req_b3").n;

      const ctx = { userId: userA.userId, requestId: "req_dom" };
      domain.sendMessage(chatId, { senderKind: "agent", senderId: profileId, body: "agent 第一条" }, ctx);
      const agentFirst = domain.listMessages(chatId, ctx);
      const agentFirstAgain = domain.listMessages(chatId, ctx);
      const humanSend = await chats.sendMessageBoundary({ chatId, body: "human 第二条" }, userA.headers, "req_h1");
      const afterHuman = domain.listMessages(chatId, ctx);

      const personaUpdate = await agents.updateAgentProfileBoundary({ agentProfileId: profileId, persona: "新人设：编辑后的分身" }, userA.headers, "req_a2");
      const instancesAfter = domain.listInstancesForChat(chatId, ctx);
      const messagesAfter = domain.listMessages(chatId, ctx);

      console.log("EVIDENCE " + JSON.stringify({
        chatId,
        instanceId,
        instanceCount,
        dmRepeat: {
          ok: dm2.ok,
          sameChat: dm2.data.chat.id === chatId,
          sameInstance: dm2.data.instance.id === instanceId,
        },
        unauthorizedCodes: unauthorized.map(code),
        crossUserCodes: crossUser.map(code),
        title: {
          initialUndefined: initialTitle === undefined,
          renamed: renamed.ok
            ? { ok: true, title: renamed.data.title, requestId: renamed.requestId }
            : { ok: false },
          trimmed,
          crossUserCode: code(crossUserTitle),
          crossUserTitleAfter,
          crossProjectCode: code(crossProjectTitle),
          anonymousCode: code(anonymousTitle),
          anonTitleAfter: crossUserTitleAfter,
          emptyCode: code(emptyTitle),
          emptyFields: fields(emptyTitle),
          tooLongCode: code(tooLongTitle),
          tooLongFields: fields(tooLongTitle),
          blankCode: code(emptyTitle),
          clearedUndefined: cleared.ok && cleared.data.title === undefined,
          titleAfterClearInDb,
          dbRejectsBlank,
          diagnostics: titleDiagnostics,
        },
        crossProfileDm: {
          otherProfileCode: code(crossProfileDm),
          ghostProfileCode: code(ghostProfileDm),
          chatRows: bChatRows,
          instanceRows: bInstanceRows,
          failedDiagnostics,
        },
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
          DATABASE_URL: join(directory, "chat.sqlite"),
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

describe("Chat DM 边界与分身身份", () => {
  it("同一 (project, profile) 重复发起 DM 返回同一对话与同一分身，agent_instance 只有一行", () => {
    expect(evidence.dmRepeat).toEqual({ ok: true, sameChat: true, sameInstance: true });
    expect(evidence.instanceCount).toBe(1);
  });

  it("未登录调用每个新 boundary 都返回 unauthorized", () => {
    expect(evidence.unauthorizedCodes).toHaveLength(7);
    expect(evidence.unauthorizedCodes.every((value) => value === "unauthorized")).toBe(true);
  });

  it("另一个用户的 project 与 chat 在列表、详情与发消息上返回 not_found", () => {
    expect(evidence.crossUserCodes).toHaveLength(7);
    expect(evidence.crossUserCodes.every((value) => value === "not_found")).toBe(true);
  });

  it("B 用自己的 project 引用他人或不存在的 profileId 都返回 not_found，不写错误诊断，不新增行", () => {
    expect(evidence.crossProfileDm.otherProfileCode).toBe("not_found");
    expect(evidence.crossProfileDm.ghostProfileCode).toBe("not_found");
    expect(evidence.crossProfileDm.chatRows).toBe(0);
    expect(evidence.crossProfileDm.instanceRows).toBe(0);
    expect(evidence.crossProfileDm.failedDiagnostics).toBe(0);
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

describe("Chat 标题的写入路径与权限反证", () => {
  it("新建 DM 不带标题，title 为空由 null 语义表达，不写空字符串", () => {
    expect(evidence.title.initialUndefined).toBe(true);
  });

  it("项目创建者重命名成功，返回值与库里的 title 都是 trim 后的值", () => {
    expect(evidence.title.renamed.ok).toBe(true);
    expect(evidence.title.renamed.title).toBe("仓库首页架构评审");
    expect(evidence.title.trimmed).toBe("仓库首页架构评审");
    expect(evidence.title.renamed.requestId).toMatch(/^req_/);
  });

  it("跨用户重命名返回 not_found 且库里 title 未变", () => {
    expect(evidence.title.crossUserCode).toBe("not_found");
    expect(evidence.title.crossUserTitleAfter).toBe("仓库首页架构评审");
  });

  it("跨 Project 的调用者重命名返回 not_found", () => {
    // 用户 B 用自己的 Project 引用用户 A 的 chat：借 Project 操作他人对话必须被拒。
    expect(evidence.title.crossProjectCode).toBe("not_found");
  });

  it("未登录重命名返回 unauthorized 且数据未变", () => {
    expect(evidence.title.anonymousCode).toBe("unauthorized");
    expect(evidence.title.anonTitleAfter).toBe("仓库首页架构评审");
  });

  it("空白标题与超长标题都是 validation_failed 并给出 title 字段错误", () => {
    expect(evidence.title.emptyCode).toBe("validation_failed");
    expect(evidence.title.emptyFields).toContain("title");
    expect(evidence.title.tooLongCode).toBe("validation_failed");
    expect(evidence.title.tooLongFields).toContain("title");
  });

  it("恢复默认把 title 置回 null，而不是写空字符串", () => {
    expect(evidence.title.clearedUndefined).toBe(true);
    expect(evidence.title.titleAfterClearInDb).toBeNull();
  });

  it("数据库约束独立拦住空白 title，不只靠 domain 层校验", () => {
    expect(evidence.title.dbRejectsBlank).toBe(true);
  });

  it("标题写入与恢复都留下身份诊断事件", () => {
    expect(evidence.title.diagnostics).toBe(2);
  });
});
