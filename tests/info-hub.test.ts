import { beforeAll, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

type Evidence = {
  unauthorizedCodes: string[];
  crossCodes: string[];
  leakTokens: string[];
  hub: {
    projectId: string;
    agents: {
      agentProfileId: string;
      name: string;
      personaSummary: string;
      chatId: string | null;
      instanceId: string | null;
    }[];
    runs: {
      available: boolean;
      hostEnabled: boolean;
      active: { runId: string; status: string; pendingInputs: number }[];
      recent: unknown[];
    };
    machines: { available: boolean; reason: string };
  } | null;
  info: {
    members: { kind: string; name: string }[];
    instanceId: string | null;
    kind: string;
    archived: boolean;
    messages: { count: number; latestAt?: string };
    runs: {
      available: boolean;
      hostEnabled: boolean;
      active: { runId: string; status: string; pendingInputs: number }[];
      recent: unknown[];
    };
  } | null;
  instanceMatchesDm: boolean;
  latestMatchesSecondMessage: boolean;
  joinedProfileId: string;
  outsiderProfileId: string;
};

let evidence: Evidence;

beforeAll(() => {
  mkdirSync(".verify", { recursive: true });
  const directory = mkdtempSync(resolve(".verify/info-hub-test-"));
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
      const infoHub = await import("./src/server/functions/info-hub.ts");
      const code = (result) => result.ok ? "ok" : result.error.code;
      const signUp = async (tag) => {
        const result = await auth.api.signUpEmail({
          body: { email: tag + "-" + Date.now() + "@example.test", password: "{{SECRET_p2-d-info-hub-pass}}", name: tag },
          returnHeaders: true,
        });
        return { headers: new Headers({ cookie: result.headers.get("set-cookie").split(";")[0] }), userId: result.response.user.id };
      };
      const userA = await signUp("info-hub-a");
      const userB = await signUp("info-hub-b");
      const project = await projects.createProjectBoundary({ name: "A 的 Info Hub Project" }, userA.headers, "req_j1");
      const projectId = project.data.id;
      const joined = await agents.createAgentProfileBoundary({ name: "已加入 Agent", persona: "人设正文" }, userA.headers, "req_j2");
      const outsider = await agents.createAgentProfileBoundary({ name: "未加入 Agent", persona: "不该出现在聚合里" }, userA.headers, "req_j3");
      await agents.addProjectMemberBoundary({ projectId, agentProfileId: joined.data.id }, userA.headers, "req_j4");
      const dm = await chats.createDirectChatBoundary({ projectId, agentProfileId: joined.data.id }, userA.headers, "req_j5");
      if (!dm.ok) throw new Error("DM 创建失败");
      const chatId = dm.data.chat.id;
      const dmInstanceId = dm.data.instance.id;
      const { sqlite } = await import("./src/db/index.ts");
      const msg1 = await chats.sendMessageBoundary({ chatId, body: "第一条消息" }, userA.headers, "req_j6");
      const msg2 = await chats.sendMessageBoundary({ chatId, body: "第二条消息" }, userA.headers, "req_j7");

      const anonymous = new Headers();
      const unauthorized = [
        await infoHub.getProjectInfoHubBoundary({ projectId }, anonymous, "req_u1"),
        await infoHub.getChatInfoBoundary({ chatId }, anonymous, "req_u2"),
      ];
      const crossHub = await infoHub.getProjectInfoHubBoundary({ projectId }, userB.headers, "req_x1");
      const crossChat = await infoHub.getChatInfoBoundary({ chatId }, userB.headers, "req_x2");
      const crossLeak = JSON.stringify(crossHub) + JSON.stringify(crossChat);
      const leakTokens = [joined.data.name, outsider.data.name, joined.data.id, chatId, dmInstanceId]
        .filter((token) => crossLeak.includes(token));

      const hub = await infoHub.getProjectInfoHubBoundary({ projectId }, userA.headers, "req_j8");
      const info = await infoHub.getChatInfoBoundary({ chatId }, userA.headers, "req_j9");
      const instanceMatchesDm = info.ok && info.data.instance?.instanceId === dmInstanceId;
      const latestMatchesSecondMessage = info.ok && msg2.ok && info.data.messages.latestAt === msg2.data.createdAt;

      console.log("EVIDENCE " + JSON.stringify({
        unauthorizedCodes: unauthorized.map(code),
        crossCodes: [code(crossHub), code(crossChat)],
        leakTokens,
        hub: hub.ok ? {
          projectId: hub.data.projectId,
          agents: hub.data.agents.agents.map((entry) => ({
            agentProfileId: entry.agentProfileId,
            name: entry.name,
            personaSummary: entry.personaSummary,
            chatId: entry.chatId ?? null,
            instanceId: entry.instanceId ?? null,
          })),
          runs: hub.data.agents.runs,
          machines: hub.data.machines,
        } : null,
        info: info.ok ? {
          members: info.data.members.map((entry) => ({ kind: entry.memberKind, name: entry.displayName })),
          instanceId: info.data.instance?.instanceId ?? null,
          kind: info.data.kind,
          archived: info.data.archived,
          messages: info.data.messages,
          runs: info.data.runs,
        } : null,
        instanceMatchesDm,
        latestMatchesSecondMessage,
        joinedProfileId: joined.data.id,
        outsiderProfileId: outsider.data.id,
        firstMessageSaved: msg1.ok,
      }));
      sqlite.close();
    `,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "info-hub.sqlite"),
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

describe("Info Hub 边界与显式不可用标记", () => {
  it("未登录调用两个 boundary 都返回 unauthorized", () => {
    expect(evidence.unauthorizedCodes).toEqual(["unauthorized", "unauthorized"]);
  });

  it("另一个用户的 projectId 与 chatId 都返回 not_found，且不泄漏对象 id 或名称", () => {
    expect(evidence.crossCodes).toEqual(["not_found", "not_found"]);
    expect(evidence.leakTokens).toEqual([]);
  });

  it("两条视图的 run 视角是真实数据，machines 仍是显式不可用且 reason 指向 P4", () => {
    expect(evidence.hub?.runs.available).toBe(true);
    expect(evidence.info?.runs.available).toBe(true);
    expect(evidence.hub?.machines.available).toBe(false);
    expect(evidence.hub?.runs.hostEnabled).toEqual(expect.any(Boolean));
    expect(evidence.info?.runs.hostEnabled).toEqual(expect.any(Boolean));
    expect(evidence.hub?.runs.active).toHaveLength(1);
    expect(evidence.hub?.runs.active[0]?.status).toBe("queued");
    expect(evidence.hub?.runs.active[0]?.pendingInputs).toBe(2);
    expect(evidence.hub?.runs.recent).toEqual([]);
    expect(evidence.hub?.machines.reason).toContain("P4");
    expect(evidence.hub?.machines.reason.length).toBeGreaterThan(0);
  });
});

describe("Info Hub 聚合与数据库一致", () => {
  it("Project agents 只含已加入成员，带 DM 的成员有 chatId 与 instanceId，未加入的 profile 不出现", () => {
    expect(evidence.hub?.projectId).toMatch(/^prj_/);
    expect(evidence.hub?.agents).toHaveLength(1);
    const entry = evidence.hub?.agents[0];
    expect(entry?.agentProfileId).toBe(evidence.joinedProfileId);
    expect(entry?.name).toBe("已加入 Agent");
    expect(entry?.chatId).toMatch(/^cnv_/);
    expect(entry?.instanceId).toMatch(/^ins_/);
    expect(evidence.hub?.agents.map((agent) => agent.agentProfileId)).not.toContain(
      evidence.outsiderProfileId,
    );
  });

  it("chat 视角的成员含 human 与 agent，instance 与对话页一致", () => {
    expect(evidence.info?.members.map((member) => member.kind).sort()).toEqual(["agent", "human"]);
    expect(evidence.info?.instanceId).toMatch(/^ins_/);
    expect(evidence.instanceMatchesDm).toBe(true);
    expect(evidence.info?.kind).toBe("dm");
    expect(evidence.info?.archived).toBe(false);
  });

  it("消息计数为 2，最后消息时间等于第二条消息时间", () => {
    expect(evidence.info?.messages.count).toBe(2);
    expect(evidence.latestMatchesSecondMessage).toBe(true);
  });
});
