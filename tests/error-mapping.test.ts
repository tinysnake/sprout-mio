import { beforeAll, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/** 每个边界必须映射其调用图可达的全部领域错误类；这张表就是那份可达集合。 */
const REACHABLE: Record<string, readonly string[]> = {
  project: ["ProjectError"],
  agent: ["AgentError", "ProjectAccessError"],
  chat: ["ChatError", "ProjectAccessError", "AgentError"],
  infoHub: ["ProjectAccessError", "AgentError"],
  projectConfig: ["ProjectAccessError"],
};

type ProbeSpec = {
  key: string;
  boundary: string;
  errorClass: string;
  code: string;
};

const EXPECTED_PROBES: ProbeSpec[] = [
  { key: "project-missing", boundary: "project", errorClass: "ProjectError", code: "not_found" },
  { key: "project-cross-user", boundary: "project", errorClass: "ProjectError", code: "not_found" },

  { key: "agent-get-missing", boundary: "agent", errorClass: "AgentError", code: "not_found" },
  { key: "agent-update-missing", boundary: "agent", errorClass: "AgentError", code: "not_found" },
  {
    key: "agent-add-member-missing-profile",
    boundary: "agent",
    errorClass: "AgentError",
    code: "not_found",
  },
  {
    key: "agent-remove-member-missing",
    boundary: "agent",
    errorClass: "AgentError",
    code: "not_found",
  },
  { key: "agent-get-cross-user", boundary: "agent", errorClass: "AgentError", code: "not_found" },
  {
    key: "agent-add-member-conflict",
    boundary: "agent",
    errorClass: "AgentError",
    code: "conflict",
  },
  {
    key: "agent-list-members-missing-project",
    boundary: "agent",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },
  {
    key: "agent-add-member-missing-project",
    boundary: "agent",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },
  {
    key: "agent-list-members-cross-project",
    boundary: "agent",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },

  {
    key: "chat-create-dm-unjoined-profile",
    boundary: "chat",
    errorClass: "ChatError",
    code: "not_found",
  },
  {
    key: "chat-get-missing",
    boundary: "chat",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },
  {
    key: "chat-members-missing",
    boundary: "chat",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },
  {
    key: "chat-messages-missing",
    boundary: "chat",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },
  {
    key: "chat-send-message-missing",
    boundary: "chat",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },
  {
    key: "chat-get-cross-user",
    boundary: "chat",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },
  {
    key: "chat-create-dm-missing-profile",
    boundary: "chat",
    errorClass: "AgentError",
    code: "not_found",
  },

  {
    key: "info-hub-project-missing",
    boundary: "infoHub",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },
  {
    key: "info-hub-chat-missing",
    boundary: "infoHub",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },
  {
    key: "info-hub-project-cross-user",
    boundary: "infoHub",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },
  {
    key: "info-hub-chat-cross-user",
    boundary: "infoHub",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },
  {
    key: "info-hub-project-orphan-profile",
    boundary: "infoHub",
    errorClass: "AgentError",
    code: "not_found",
  },
  {
    key: "info-hub-chat-orphan-profile",
    boundary: "infoHub",
    errorClass: "AgentError",
    code: "not_found",
  },

  {
    key: "project-config-get-missing",
    boundary: "projectConfig",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },
  {
    key: "project-config-update-missing",
    boundary: "projectConfig",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },
  {
    key: "project-config-get-cross-project",
    boundary: "projectConfig",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },
  {
    key: "project-config-update-cross-project",
    boundary: "projectConfig",
    errorClass: "ProjectAccessError",
    code: "not_found",
  },

  {
    key: "session-project-unauthorized",
    boundary: "session",
    errorClass: "Session",
    code: "unauthorized",
  },
  {
    key: "session-info-hub-unauthorized",
    boundary: "session",
    errorClass: "Session",
    code: "unauthorized",
  },
];

type ProbeEvidence = {
  key: string;
  boundary: string;
  errorClass: string;
  code: string;
  requestId: string;
};

type Evidence = {
  probes: ProbeEvidence[];
  errorDiagnostics: { level: string; event: string; requestId: string }[];
};

let evidence: Evidence;

beforeAll(() => {
  mkdirSync(".verify", { recursive: true });
  const directory = mkdtempSync(resolve(".verify/error-mapping-test-"));
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
      const runtime = await import("./src/server/runtime.ts");
      await runtime.startRuntime();
      const projectConfig = await import("./src/server/functions/project-config.ts");
      const { sqlite } = await import("./src/db/index.ts");
      const signUp = async (tag) => {
        const result = await auth.api.signUpEmail({
          body: { email: tag + "-" + Date.now() + "@example.test", password: "test-pass-p2-i-error-mapping", name: tag },
          returnHeaders: true,
        });
        return { headers: new Headers({ cookie: result.headers.get("set-cookie").split(";")[0] }), userId: result.response.user.id };
      };
      const userA = await signUp("error-map-a");
      const userB = await signUp("error-map-b");

      const projectA = (await projects.createProjectBoundary({ name: "A 的映射 Project" }, userA.headers, "req_em_seed1")).data;
      const projectB = (await projects.createProjectBoundary({ name: "B 的映射 Project" }, userB.headers, "req_em_seed2")).data;
      const profileA = (await agents.createAgentProfileBoundary({ name: "A 的映射 Agent", persona: "" }, userA.headers, "req_em_seed3")).data;
      const profileB = (await agents.createAgentProfileBoundary({ name: "B 的映射 Agent", persona: "" }, userB.headers, "req_em_seed4")).data;
      await agents.addProjectMemberBoundary({ projectId: projectB.id, agentProfileId: profileB.id }, userB.headers, "req_em_seed7b");
      await agents.addProjectMemberBoundary({ projectId: projectA.id, agentProfileId: profileA.id }, userA.headers, "req_em_seed5");
      await chats.createDirectChatBoundary({ projectId: projectA.id, agentProfileId: profileA.id }, userA.headers, "req_em_seed6");
      const dmB = (await chats.createDirectChatBoundary({ projectId: projectB.id, agentProfileId: profileB.id }, userB.headers, "req_em_seed7")).data;
      const unjoinedProfile = (await agents.createAgentProfileBoundary({ name: "未入组 Agent", persona: "" }, userA.headers, "req_em_seed8")).data;
      const orphanProfile = (await agents.createAgentProfileBoundary({ name: "将被删除引用的 Agent", persona: "" }, userA.headers, "req_em_seed9")).data;
      await agents.addProjectMemberBoundary({ projectId: projectA.id, agentProfileId: orphanProfile.id }, userA.headers, "req_em_seed10");
      const orphanDm = (await chats.createDirectChatBoundary({ projectId: projectA.id, agentProfileId: orphanProfile.id }, userA.headers, "req_em_seed11")).data;

      const missing = {
        projectId: "prj_00000000-0000-4000-8000-000000000000",
        agentProfileId: "agp_00000000-0000-4000-8000-000000000000",
        chatId: "cnv_00000000-0000-4000-8000-000000000000",
      };
      const probes = [];
      let seq = 0;
      const probe = async (key, boundary, errorClass, call) => {
        const requestId = "req_em_p" + ++seq;
        const result = await call(requestId);
        probes.push({ key, boundary, errorClass, code: result.ok ? "ok" : result.error.code, requestId });
      };

      await probe("project-missing", "project", "ProjectError", (r) => projects.getProjectBoundary({ projectId: missing.projectId }, userA.headers, r));
      await probe("project-cross-user", "project", "ProjectError", (r) => projects.getProjectBoundary({ projectId: projectB.id }, userA.headers, r));

      await probe("agent-get-missing", "agent", "AgentError", (r) => agents.getAgentProfileBoundary({ agentProfileId: missing.agentProfileId }, userA.headers, r));
      await probe("agent-update-missing", "agent", "AgentError", (r) => agents.updateAgentProfileBoundary({ agentProfileId: missing.agentProfileId, name: "改名" }, userA.headers, r));
      await probe("agent-add-member-missing-profile", "agent", "AgentError", (r) => agents.addProjectMemberBoundary({ projectId: projectA.id, agentProfileId: missing.agentProfileId }, userA.headers, r));
      await probe("agent-remove-member-missing", "agent", "AgentError", (r) => agents.removeProjectMemberBoundary({ projectId: projectA.id, agentProfileId: missing.agentProfileId }, userA.headers, r));
      await probe("agent-get-cross-user", "agent", "AgentError", (r) => agents.getAgentProfileBoundary({ agentProfileId: profileB.id }, userA.headers, r));
      await probe("agent-add-member-conflict", "agent", "AgentError", (r) => agents.addProjectMemberBoundary({ projectId: projectA.id, agentProfileId: profileA.id }, userA.headers, r));
      await probe("agent-list-members-missing-project", "agent", "ProjectAccessError", (r) => agents.listProjectMembersBoundary({ projectId: missing.projectId }, userA.headers, r));
      await probe("agent-add-member-missing-project", "agent", "ProjectAccessError", (r) => agents.addProjectMemberBoundary({ projectId: missing.projectId, agentProfileId: profileA.id }, userA.headers, r));
      await probe("agent-list-members-cross-project", "agent", "ProjectAccessError", (r) => agents.listProjectMembersBoundary({ projectId: projectB.id }, userA.headers, r));

      await probe("chat-create-dm-unjoined-profile", "chat", "ChatError", (r) => chats.createDirectChatBoundary({ projectId: projectA.id, agentProfileId: unjoinedProfile.id }, userA.headers, r));
      await probe("chat-get-missing", "chat", "ProjectAccessError", (r) => chats.getChatBoundary({ chatId: missing.chatId }, userA.headers, r));
      await probe("chat-members-missing", "chat", "ProjectAccessError", (r) => chats.listChatMembersBoundary({ chatId: missing.chatId }, userA.headers, r));
      await probe("chat-messages-missing", "chat", "ProjectAccessError", (r) => chats.listMessagesBoundary({ chatId: missing.chatId }, userA.headers, r));
      await probe("chat-send-message-missing", "chat", "ProjectAccessError", (r) => chats.sendMessageBoundary({ chatId: missing.chatId, body: "你好" }, userA.headers, r));
      await probe("chat-get-cross-user", "chat", "ProjectAccessError", (r) => chats.getChatBoundary({ chatId: dmB.chat.id }, userA.headers, r));
      await probe("chat-create-dm-missing-profile", "chat", "AgentError", (r) => chats.createDirectChatBoundary({ projectId: projectA.id, agentProfileId: missing.agentProfileId }, userA.headers, r));

      await probe("info-hub-project-missing", "infoHub", "ProjectAccessError", (r) => infoHub.getProjectInfoHubBoundary({ projectId: missing.projectId }, userA.headers, r));
      await probe("info-hub-chat-missing", "infoHub", "ProjectAccessError", (r) => infoHub.getChatInfoBoundary({ chatId: missing.chatId }, userA.headers, r));
      await probe("info-hub-project-cross-user", "infoHub", "ProjectAccessError", (r) => infoHub.getProjectInfoHubBoundary({ projectId: projectB.id }, userA.headers, r));
      await probe("info-hub-chat-cross-user", "infoHub", "ProjectAccessError", (r) => infoHub.getChatInfoBoundary({ chatId: dmB.chat.id }, userA.headers, r));

      sqlite.pragma("foreign_keys = OFF");
      sqlite.prepare("DELETE FROM agent_profile WHERE id = ?").run(orphanProfile.id);
      sqlite.pragma("foreign_keys = ON");
      await probe("info-hub-project-orphan-profile", "infoHub", "AgentError", (r) => infoHub.getProjectInfoHubBoundary({ projectId: projectA.id }, userA.headers, r));
      await probe("info-hub-chat-orphan-profile", "infoHub", "AgentError", (r) => infoHub.getChatInfoBoundary({ chatId: orphanDm.chat.id }, userA.headers, r));

      await probe("project-config-get-missing", "projectConfig", "ProjectAccessError", (r) => projectConfig.getProjectProfileBoundary({ projectId: missing.projectId }, userA.headers, r));
      await probe("project-config-update-missing", "projectConfig", "ProjectAccessError", (r) => projectConfig.updateProjectProfileBoundary({ projectId: missing.projectId, defaultBranch: "main" }, userA.headers, r));
      await probe("project-config-get-cross-project", "projectConfig", "ProjectAccessError", (r) => projectConfig.getProjectProfileBoundary({ projectId: projectB.id }, userA.headers, r));
      await probe("project-config-update-cross-project", "projectConfig", "ProjectAccessError", (r) => projectConfig.updateProjectProfileBoundary({ projectId: projectB.id, defaultBranch: "main" }, userA.headers, r));

      const anonymous = new Headers();
      await probe("session-project-unauthorized", "session", "Session", (r) => projects.getProjectBoundary({ projectId: missing.projectId }, anonymous, r));
      await probe("session-info-hub-unauthorized", "session", "Session", (r) => infoHub.getChatInfoBoundary({ chatId: missing.chatId }, anonymous, r));

      const errorDiagnostics = sqlite.prepare("SELECT level, event, request_id AS requestId FROM diagnostic_event WHERE level = 'error'").all();
      console.log("EVIDENCE " + JSON.stringify({ probes, errorDiagnostics }));
      await runtime.shutdownRuntime("info-hub-test");
      sqlite.close();
    `,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "error-mapping.sqlite"),
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

describe("错误映射表覆盖每个（边界 × 可达错误类）组合", () => {
  it("探针集合与可达集合表完全一致，不缺行也不多行", () => {
    const actual = new Set(
      evidence.probes
        .filter((probe) => probe.errorClass !== "Session")
        .map((probe) => `${probe.boundary} × ${probe.errorClass}`),
    );
    const expected = Object.entries(REACHABLE).flatMap(([boundary, classes]) =>
      classes.map((errorClass) => `${boundary} × ${errorClass}`),
    );
    expect([...actual].sort()).toEqual(expected.sort());
  });
});

describe("领域错误码原样透出且永不为 internal", () => {
  for (const spec of EXPECTED_PROBES) {
    it(`${spec.key}: ${spec.boundary} × ${spec.errorClass} → ${spec.code}`, () => {
      const probe = evidence.probes.find((row) => row.key === spec.key);
      expect(probe, `缺少探针 ${spec.key}`).toBeDefined();
      expect(probe?.code).toBe(spec.code);
      expect(probe?.code).not.toBe("internal");
      expect(probe?.requestId).toMatch(/^req_em_p/);
    });
  }
});

describe("合法业务拒绝不写 error 诊断", () => {
  it("全部探针请求之后 diagnostic_event 没有任何 error 行", () => {
    expect(evidence.errorDiagnostics).toEqual([]);
  });
});
