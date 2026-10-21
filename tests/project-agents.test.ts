import { beforeAll, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

type ErrorPayload = { ok: false; error: { code: string; message: string; requestId: string } };
type ProfilePayload = {
  ok: true;
  data: { id: string; name: string; persona: string; model?: string; effort?: string };
};
type Evidence = {
  profileId: string;
  projectId: string;
  unauthorizedCodes: string[];
  crossUserCodes: string[];
  invalidCreate: { code: string; fields: string[] };
  invalidConfig: { code: string; fields: string[] };
  foreignProfile: ErrorPayload;
  memberFirst: { ok: boolean; code?: string };
  memberSecond: { ok: boolean; code?: string };
  removeFirst: { ok: boolean; code?: string };
  removeSecond: { ok: boolean; code?: string };
  updated: ProfilePayload;
  reread: { ok: boolean; persona?: string; id?: string };
  withJob: { ok: boolean; jobTitle?: string; id?: string; code?: string };
  jobCleared: { ok: boolean; jobTitle?: string | null; id?: string; code?: string };
  jobTooLong: { code: string; fields: string[] };
  seededAmenda: {
    name: string;
    jobTitle: string | null;
    model: string | null;
    effort: string | null;
  } | null;
};

let evidence: Evidence;

beforeAll(() => {
  mkdirSync(".verify", { recursive: true });
  const directory = mkdtempSync(resolve(".verify/project-agents-test-"));
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
      const agents = await import("./src/server/functions/agent.ts");
      const configs = await import("./src/server/functions/project-config.ts");
      const projects = await import("./src/server/functions/project.ts");
      const code = (result) => result.ok ? "ok" : result.error.code;
      const fields = (result) => Object.keys(result.fieldErrors ?? {}).sort();
      const signUp = async (tag) => {
        const result = await auth.api.signUpEmail({
          body: { email: tag + "-" + Date.now() + "@example.test", password: "{{SECRET_p2-b-test-pass}}", name: tag },
          returnHeaders: true,
        });
        return { headers: new Headers({ cookie: result.headers.get("set-cookie").split(";")[0] }), userId: result.response.user.id };
      };
      const userA = await signUp("agents-a");
      const userB = await signUp("agents-b");
      const created = await projects.createProjectBoundary({ name: "A 的 Project" }, userA.headers, "req_p1");
      const projectId = created.data.id;
      const profile = await agents.createAgentProfileBoundary({ name: "验收 Agent", persona: "初始人设" }, userA.headers, "req_a1");
      const profileId = profile.data.id;
      const anonymous = new Headers();
      const unauthorized = [
        await agents.createAgentProfileBoundary({ name: "无会话" }, anonymous, "req_u1"),
        await agents.listAgentProfilesBoundary(anonymous, "req_u2"),
        await agents.getAgentProfileBoundary({ agentProfileId: profileId }, anonymous, "req_u3"),
        await agents.updateAgentProfileBoundary({ agentProfileId: profileId, persona: "y" }, anonymous, "req_u4"),
        await agents.addProjectMemberBoundary({ projectId, agentProfileId: profileId }, anonymous, "req_u5"),
        await agents.removeProjectMemberBoundary({ projectId, agentProfileId: profileId }, anonymous, "req_u6"),
        await agents.listProjectMembersBoundary({ projectId }, anonymous, "req_u7"),
        await configs.getProjectProfileBoundary({ projectId }, anonymous, "req_u8"),
        await configs.updateProjectProfileBoundary({ projectId, defaultBranch: "main" }, anonymous, "req_u9"),
      ];
      const crossUser = [
        await configs.getProjectProfileBoundary({ projectId }, userB.headers, "req_b1"),
        await configs.updateProjectProfileBoundary({ projectId, defaultBranch: "dev" }, userB.headers, "req_b2"),
        await agents.listProjectMembersBoundary({ projectId }, userB.headers, "req_b3"),
        await agents.addProjectMemberBoundary({ projectId, agentProfileId: profileId }, userB.headers, "req_b4"),
        await agents.removeProjectMemberBoundary({ projectId, agentProfileId: profileId }, userB.headers, "req_b5"),
      ];
      const invalidCreate = await agents.createAgentProfileBoundary({ name: "   " }, userA.headers, "req_v1");
      const invalidConfig = await configs.updateProjectProfileBoundary({ projectId, workDirectory: "/绝对路径" }, userA.headers, "req_v2");
      const foreignProfile = await agents.getAgentProfileBoundary({ agentProfileId: profileId }, userB.headers, "req_b6");
      const memberFirst = await agents.addProjectMemberBoundary({ projectId, agentProfileId: profileId }, userA.headers, "req_m1");
      const memberSecond = await agents.addProjectMemberBoundary({ projectId, agentProfileId: profileId }, userA.headers, "req_m2");
      const updated = await agents.updateAgentProfileBoundary({ agentProfileId: profileId, persona: "新人设" }, userA.headers, "req_a2");
      const reread = await agents.getAgentProfileBoundary({ agentProfileId: profileId }, userA.headers, "req_a3");
      // 职位可空且只用于展示，写入与清空都不影响身份。
      const withJob = await agents.updateAgentProfileBoundary({ agentProfileId: profileId, jobTitle: "技术写作者" }, userA.headers, "req_a4");
      const jobCleared = await agents.updateAgentProfileBoundary({ agentProfileId: profileId, jobTitle: null }, userA.headers, "req_a5");
      const jobTooLong = await agents.updateAgentProfileBoundary({ agentProfileId: profileId, jobTitle: "字".repeat(41) }, userA.headers, "req_a6");
      const seeded = await agents.listAgentProfilesBoundary(userA.headers, "req_a7");
      const seededAmenda = seeded.ok ? seeded.data.find((profile) => profile.name === "Amenda") : undefined;
      const removed = await agents.removeProjectMemberBoundary({ projectId, agentProfileId: profileId }, userA.headers, "req_m3");
      const afterRemove = await agents.removeProjectMemberBoundary({ projectId, agentProfileId: profileId }, userA.headers, "req_m4");
      const { sqlite } = await import("./src/db/index.ts");
      console.log("EVIDENCE " + JSON.stringify({
        profileId, projectId,
        unauthorizedCodes: unauthorized.map(code),
        crossUserCodes: crossUser.map(code),
        invalidCreate: { code: code(invalidCreate), fields: fields(invalidCreate) },
        invalidConfig: { code: code(invalidConfig), fields: fields(invalidConfig) },
        foreignProfile,
        memberFirst: { ok: memberFirst.ok, code: code(memberFirst) },
        memberSecond: { ok: memberSecond.ok, code: code(memberSecond) },
        removeFirst: { ok: removed.ok, code: code(removed) },
        removeSecond: { ok: afterRemove.ok, code: code(afterRemove) },
        updated,
        withJob: withJob.ok ? { ok: true, jobTitle: withJob.data.jobTitle, id: withJob.data.id } : { ok: false, code: code(withJob) },
        jobCleared: jobCleared.ok ? { ok: true, jobTitle: jobCleared.data.jobTitle ?? null, id: jobCleared.data.id } : { ok: false, code: code(jobCleared) },
        jobTooLong: { code: code(jobTooLong), fields: fields(jobTooLong) },
        seededAmenda: seededAmenda ? { name: seededAmenda.name, jobTitle: seededAmenda.jobTitle ?? null, model: seededAmenda.model ?? null, effort: seededAmenda.effort ?? null } : null,
        reread: reread.ok
          ? { ok: true, persona: reread.data.persona, id: reread.data.id }
          : { ok: false, code: code(reread) },
      }));
      sqlite.close();
    `,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "project-agents.sqlite"),
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

describe("Project 配置与 Agent 成员边界", () => {
  it("未登录调用每个新 boundary 都返回 unauthorized", () => {
    expect(evidence.unauthorizedCodes).toHaveLength(9);
    expect(evidence.unauthorizedCodes.every((value) => value === "unauthorized")).toBe(true);
  });

  it("另一个用户的 projectId 在配置与成员 boundary 上返回 not_found", () => {
    expect(evidence.crossUserCodes).toHaveLength(5);
    expect(evidence.crossUserCodes.every((value) => value === "not_found")).toBe(true);
  });

  it("空名称创建 profile 返回 validation_failed 并给出字段级错误", () => {
    expect(evidence.invalidCreate.code).toBe("validation_failed");
    expect(evidence.invalidCreate.fields).toContain("name");
  });

  it("绝对路径工作目录返回 validation_failed 并给出字段级错误", () => {
    expect(evidence.invalidConfig.code).toBe("validation_failed");
    expect(evidence.invalidConfig.fields).toContain("workDirectory");
  });

  it("另一个用户拿 profileId 查询详情返回 not_found", () => {
    expect(evidence.foreignProfile).toMatchObject({
      ok: false,
      error: { code: "not_found", requestId: "req_b6" },
    });
  });

  it("重复添加同一成员返回 conflict，移除一次后再移除返回 not_found", () => {
    expect(evidence.memberFirst).toEqual({ ok: true, code: "ok" });
    expect(evidence.memberSecond).toEqual({ ok: false, code: "conflict" });
    expect(evidence.removeFirst).toEqual({ ok: true, code: "ok" });
    expect(evidence.removeSecond).toEqual({ ok: false, code: "not_found" });
  });

  it("人设修改后 profile id 不变且重新读取是新值", () => {
    expect(evidence.updated.ok).toBe(true);
    expect(evidence.reread).toEqual({
      ok: true,
      persona: "新人设",
      id: evidence.profileId,
    });
  });

  it("职位可写可清，超长被边界拒绝", () => {
    expect(evidence.withJob.ok).toBe(true);
    expect(evidence.withJob.jobTitle).toBe("技术写作者");
    expect(evidence.withJob.id).toBe(evidence.profileId);
    expect(evidence.jobCleared.ok).toBe(true);
    expect(evidence.jobCleared.jobTitle).toBeNull();
    expect(evidence.jobCleared.id).toBe(evidence.profileId);
    expect(evidence.jobTooLong.code).toBe("validation_failed");
    expect(evidence.jobTooLong.fields).toContain("jobTitle");
  });

  it("播种的默认 Agent 职位为全能秘书，model 与 effort 留空沿用默认", () => {
    expect(evidence.seededAmenda).toEqual({
      name: "Amenda",
      jobTitle: "全能秘书",
      model: null,
      effort: null,
    });
  });
});
