import { beforeAll, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const FIXTURE_COMMIT = "a".repeat(40);

type Evidence = {
  unauthorizedCodes: string[];
  crossCodes: string[];
  crossLeakTokens: string[];
  turn0: {
    projectId: string;
    chatId: string;
    instanceId: string | null;
    agentProfileId: string | null;
    profileName: string | null;
    hostEnabled: boolean;
    workspace: unknown;
    activeRun: { runId: string; status: string; pendingInputs: number } | null;
    previousRun: unknown;
    injectedIntoPrompt: boolean;
  } | null;
  turn1: {
    workspace: { basis: string; path: string; source: string; ref: string; commit: string } | null;
    activeRun: unknown;
    previousRun: {
      runId: string;
      status: string;
      requestId: string;
      errorCode?: string;
      errorMessage?: string;
    } | null;
    injectedIntoPrompt: boolean;
  } | null;
  hubRecent: {
    status: string;
    requestId: string;
    pendingInputs: number;
    errorCode?: string;
    errorMessage?: string;
  }[];
  hubMachines: { available: boolean; reason: string };
  chatActive: unknown[];
  turnMatchesDb: boolean;
  runId: string;
  fixtureCommit: string;
};

let evidence: Evidence;

beforeAll(() => {
  mkdirSync(".verify", { recursive: true });
  const directory = mkdtempSync(resolve(".verify/info-hub-runs-test-"));
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
      const { transitionAgentRun } = await import("./src/domain/agent-run.ts");
      const { sqlite } = await import("./src/db/index.ts");
      const code = (result) => result.ok ? "ok" : result.error.code;
      const signUp = async (tag) => {
        const result = await auth.api.signUpEmail({
          body: { email: tag + "-" + Date.now() + "@example.test", password: "{{SECRET_p3-d-info-hub-pass}}", name: tag },
          returnHeaders: true,
        });
        return { headers: new Headers({ cookie: result.headers.get("set-cookie").split(";")[0] }), userId: result.response.user.id };
      };
      const userA = await signUp("runs-a");
      const userB = await signUp("runs-b");
      const project = await projects.createProjectBoundary({ name: "P3-D run 视角 Project" }, userA.headers, "req_q1");
      const projectId = project.data.id;
      const joined = await agents.createAgentProfileBoundary({ name: "运行中的分身", persona: "人设" }, userA.headers, "req_q2");
      await agents.addProjectMemberBoundary({ projectId, agentProfileId: joined.data.id }, userA.headers, "req_q3");
      const dm = await chats.createDirectChatBoundary({ projectId, agentProfileId: joined.data.id }, userA.headers, "req_q4");
      if (!dm.ok) throw new Error("DM 创建失败");
      const chatId = dm.data.chat.id;
      await chats.sendMessageBoundary({ chatId, body: "第一条" }, userA.headers, "req_q5");
      await chats.sendMessageBoundary({ chatId, body: "第二条" }, userA.headers, "req_q6");

      const anonymous = new Headers();
      const unauthorized = [
        await infoHub.getTurnStartContextBoundary({ chatId }, anonymous, "req_u1"),
      ];
      const cross = await infoHub.getTurnStartContextBoundary({ chatId }, userB.headers, "req_x1");
      const crossLeak = JSON.stringify(cross);
      const crossLeakTokens = [joined.data.name, joined.data.id, chatId, dm.data.instance.id]
        .filter((token) => crossLeak.includes(token));

      const turn0 = await infoHub.getTurnStartContextBoundary({ chatId }, userA.headers, "req_t0");
      if (!turn0.ok) throw new Error("轮初上下文查询失败");
      const runRow = sqlite.prepare("SELECT id FROM agent_run WHERE chat_id=?").get(chatId);
      transitionAgentRun(runRow.id, "failed", { errorCode: "repo_workdir_missing", errorMessage: "工作副本不存在：/ghost" }, { userId: userA.userId, requestId: "req_fail" });
      const fixtureCommit = "${FIXTURE_COMMIT}";
      sqlite.prepare('INSERT INTO repo_checkout (id, project_id, path, source_kind, source, ref, "commit", resolved_at, size_bytes, status) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), ?, ?)').run("repoc_00000000-0000-4000-8000-000000000001", projectId, "/verify/repos/prj-fixture", "bound_copy", "/verify/repos/prj-fixture", "main", fixtureCommit, 64, "ready");

      const turn1 = await infoHub.getTurnStartContextBoundary({ chatId }, userA.headers, "req_t1");
      const hub = await infoHub.getProjectInfoHubBoundary({ projectId }, userA.headers, "req_t2");
      const info = await infoHub.getChatInfoBoundary({ chatId }, userA.headers, "req_t3");
      const failedRow = sqlite.prepare("SELECT request_id, status, error_code, error_message FROM agent_run WHERE id=?").get(runRow.id);
      const turnMatchesDb = turn1.ok
        && turn1.data.activeRun === null
        && turn1.data.previousRun?.runId === runRow.id
        && turn1.data.previousRun?.status === "failed"
        && turn1.data.previousRun?.errorCode === failedRow.error_code
        && turn1.data.previousRun?.errorMessage === failedRow.error_message
        && turn1.data.previousRun?.requestId === failedRow.request_id
        && turn1.data.workspace?.basis === "project_checkout"
        && turn1.data.workspace?.commit === fixtureCommit;

      console.log("EVIDENCE " + JSON.stringify({
        unauthorizedCodes: unauthorized.map(code),
        crossCodes: [code(cross)],
        crossLeakTokens,
        turn0: turn0.ok ? {
          projectId: turn0.data.projectId,
          chatId: turn0.data.chatId,
          instanceId: turn0.data.instanceId,
          agentProfileId: turn0.data.agentProfileId,
          profileName: turn0.data.profileName,
          hostEnabled: turn0.data.hostEnabled,
          workspace: turn0.data.workspace,
          activeRun: turn0.data.activeRun,
          previousRun: turn0.data.previousRun,
          injectedIntoPrompt: turn0.data.injectedIntoPrompt,
        } : null,
        turn1: turn1.ok ? {
          workspace: turn1.data.workspace,
          activeRun: turn1.data.activeRun,
          previousRun: turn1.data.previousRun,
          injectedIntoPrompt: turn1.data.injectedIntoPrompt,
        } : null,
        hubRecent: hub.ok ? hub.data.agents.runs.recent : [],
        hubMachines: hub.ok ? hub.data.machines : { available: true, reason: "" },
        chatActive: info.ok ? info.data.runs.active : [],
        turnMatchesDb,
        runId: runRow.id,
        fixtureCommit,
      }));
      sqlite.close();
    `,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "info-hub-runs.sqlite"),
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

describe("轮初必要上下文查询", () => {
  it("未登录 unauthorized，越权 not_found 且不泄漏分身、对话或 run 的任何标识", () => {
    expect(evidence.unauthorizedCodes).toEqual(["unauthorized"]);
    expect(evidence.crossCodes).toEqual(["not_found"]);
    expect(evidence.crossLeakTokens).toEqual([]);
  });

  it("无 run 时字段齐全：活跃 run 带未投递输入、无历史 run、未配置仓库时 workspace 为 null", () => {
    expect(evidence.turn0?.projectId).toMatch(/^prj_/);
    expect(evidence.turn0?.chatId).toMatch(/^cnv_/);
    expect(evidence.turn0?.instanceId).toMatch(/^ins_/);
    expect(evidence.turn0?.agentProfileId).toMatch(/^agp_/);
    expect(evidence.turn0?.profileName).toBe("运行中的分身");
    expect(typeof evidence.turn0?.hostEnabled).toBe("boolean");
    expect(evidence.turn0?.workspace).toBeNull();
    expect(evidence.turn0?.activeRun?.status).toBe("queued");
    expect(evidence.turn0?.activeRun?.pendingInputs).toBe(2);
    expect(evidence.turn0?.previousRun).toBeNull();
  });

  it("始终显式声明不注入模型 prompt", () => {
    expect(evidence.turn0?.injectedIntoPrompt).toBe(false);
    expect(evidence.turn1?.injectedIntoPrompt).toBe(false);
  });

  it("失败 run 后：上一次 run 的错误与 requestId 来自数据库实值，workspace 取最近就绪副本", () => {
    expect(evidence.turnMatchesDb).toBe(true);
    expect(evidence.turn1?.workspace?.basis).toBe("project_checkout");
    expect(evidence.turn1?.workspace?.commit).toBe(FIXTURE_COMMIT);
    expect(evidence.turn1?.activeRun).toBeNull();
    expect(evidence.turn1?.previousRun?.errorCode).toBe("repo_workdir_missing");
    expect(evidence.turn1?.previousRun?.errorMessage).toContain("工作副本不存在");
  });
});

describe("两个视角的 run 事实与数据库一致", () => {
  it("Project 视角 recent 含失败 run 的 errorCode、errorMessage 与 requestId", () => {
    expect(evidence.hubRecent).toHaveLength(1);
    expect(evidence.hubRecent[0]?.status).toBe("failed");
    expect(evidence.hubRecent[0]?.errorCode).toBe("repo_workdir_missing");
    expect(evidence.hubRecent[0]?.errorMessage).toContain("工作副本不存在");
    expect(evidence.hubRecent[0]?.requestId).toBe("req_q5");
  });

  it("Chat 视角 active 为空，失败 run 进入 recent，pending 不冒充已投递", () => {
    expect(evidence.chatActive).toEqual([]);
    expect(evidence.hubRecent[0]?.pendingInputs).toBe(2);
  });

  it("Machine 视角仍是显式不可用且 reason 指向 P4", () => {
    expect(evidence.hubMachines.available).toBe(false);
    expect(evidence.hubMachines.reason).toContain("P4");
  });
});
