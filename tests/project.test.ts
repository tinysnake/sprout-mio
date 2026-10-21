import { beforeAll, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

type Project = { id: string; name: string; description?: string; createdAt: string };
type ErrorPayload = { ok: false; error: { code: string; message: string; requestId: string } };
type SuccessPayload = { ok: true; data: Project; requestId: string };
type Rows = {
  projects: number;
  events: number;
  lastEvent: { project_id: string; request_id: string };
};
type RollbackRows = Rows & {
  hookFailed: boolean;
  unchangedProjects: boolean;
  unchangedEvents: boolean;
};

type Evidence = {
  created: SuccessPayload;
  createdRows: Rows;
  seededProjects: number;
  seededEvents: number;
  listed: { ok: true; data: Project[] };
  rolledBack: RollbackRows;
  rejectedFields: string[];
  invalidFields: string[];
  renamed: SuccessPayload;
  clearedDescription: SuccessPayload;
  emptyPatch: ErrorPayload;
  crossUpdate: ErrorPayload;
  afterUpdateEvents: string[];
  unauthorized: ErrorPayload;
  missing: ErrorPayload;
  infrastructure: ErrorPayload[];
  internalEvents: { level: string; event: string; request_id: string; data: string }[];
};

let evidence: Evidence;

beforeAll(() => {
  mkdirSync(".verify", { recursive: true });
  const directory = mkdtempSync(resolve(".verify/project-test-"));
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
      const boundary = await import("./src/server/functions/project.ts");
      const { createProject } = await import("./src/domain/project.ts");
      const { createProjectInput } = await import("./src/contracts/project.ts");
      const { sqlite } = await import("./src/db/index.ts");
      const counts = () => ({
        projects: sqlite.prepare("SELECT count(*) AS count FROM project").get().count,
        events: sqlite.prepare("SELECT count(*) AS count FROM diagnostic_event").get().count,
        lastEvent: sqlite.prepare("SELECT project_id, request_id FROM diagnostic_event ORDER BY rowid DESC LIMIT 1").get(),
      });
      const signUp = await auth.api.signUpEmail({
        body: { email: "project-" + Date.now() + "@example.test", password: "{{SECRET_e-project-test-pass}}", name: "Project verifier" },
        returnHeaders: true,
      });
      const headers = new Headers({ cookie: signUp.headers.get("set-cookie").split(";")[0] });
      const seededProjects = counts().projects;
      const seededEvents = counts().events;
      const created = await boundary.createProjectBoundary({ name: "验收样例", description: "分层样例" }, headers, "req_a");
      const createdRows = counts();
      const listed = await boundary.listProjectsBoundary(headers, "req_b");
      const before = counts();
      let hookFailed = false;
      try {
        createProject({ name: "回滚样例" }, { userId: signUp.response.user.id, requestId: "req_c" }, {
          afterProjectInsert: () => { throw new Error("强制失败"); },
        });
      } catch { hookFailed = true; }
      const rolledBack = { ...counts(), hookFailed, unchangedProjects: counts().projects === before.projects, unchangedEvents: counts().events === before.events };
      const rejected = createProjectInput.safeParse({ name: "   ", description: "a".repeat(501) });
      // 改名与改描述走同一个 updateProject，不重建 Project。
      const renamed = await boundary.updateProjectBoundary({ projectId: created.data.id, name: "改名后的样例", description: "新描述" }, headers, "req_r");
      const clearedDescription = await boundary.updateProjectBoundary({ projectId: created.data.id, description: null }, headers, "req_r2");
      const emptyPatch = await boundary.updateProjectBoundary({ projectId: created.data.id }, headers, "req_r3");
      const crossUpdate = await boundary.updateProjectBoundary({ projectId: created.data.id, name: "越权改名" }, new Headers(), "req_r4");
      const afterUpdateEvents = sqlite.prepare("SELECT event FROM diagnostic_event WHERE project_id = ? ORDER BY rowid").all(created.data.id).map((row) => row.event);
      const invalid = await boundary.createProjectBoundary({ name: "   ", description: "a".repeat(501) }, headers, "req_d");
      const unauthorized = await boundary.createProjectBoundary({ name: "无会话" }, new Headers(), "req_e");
      const missing = await boundary.getProjectBoundary({ projectId: "prj_00000000-0000-4000-8000-000000000000" }, headers, "req_f");
      const brokenHeaders = new Proxy(headers, { get() { throw new Error("session infrastructure secret"); } });
      const infrastructure = await Promise.all([
        boundary.createProjectBoundary({ name: "不可创建" }, brokenHeaders, "req_x"),
        boundary.listProjectsBoundary(brokenHeaders, "req_x"),
        boundary.getProjectBoundary({ projectId: created.data.id }, brokenHeaders, "req_x"),
      ]);
      const internalEvents = sqlite.prepare("SELECT level, event, request_id, data FROM diagnostic_event WHERE event = 'project.request_failed'").all();
      console.log("EVIDENCE " + JSON.stringify({
        infrastructure, internalEvents,
        created, createdRows, listed, rolledBack,
        seededProjects, seededEvents,
        rejectedFields: rejected.success ? [] : [...new Set(rejected.error.issues.map((issue) => issue.path.join(".")))],
        invalidFields: invalid.ok ? [] : Object.keys(invalid.fieldErrors ?? {}),
        renamed, clearedDescription, emptyPatch, crossUpdate, afterUpdateEvents,
        unauthorized, missing,
      }));
      sqlite.close();
    `,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "project.sqlite"),
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

describe("Project 创建与查询", () => {
  it("创建成功后 Project 行与 project.created 诊断行指向同一个 project_id", () => {
    expect(evidence.created.ok).toBe(true);
    // 注册已经播种一个默认 Project 和一条诊断，这里在其之上累加。
    expect(evidence.createdRows.projects).toBe(evidence.seededProjects + 1);
    expect(evidence.createdRows.events).toBe(evidence.seededEvents + 1);
    expect(evidence.createdRows.lastEvent.project_id).toBe(evidence.created.data.id);
    expect(evidence.createdRows.lastEvent.request_id).toBe("req_a");
    expect(evidence.created.requestId).toBe("req_a");
    expect(evidence.created.data.name).toBe("验收样例");
    expect(evidence.created.data.description).toBe("分层样例");
  });

  it("事务失败时 Project 行与诊断行都不新增", () => {
    expect(evidence.rolledBack.hookFailed).toBe(true);
    expect(evidence.rolledBack.projects).toBe(evidence.createdRows.projects);
    expect(evidence.rolledBack.events).toBe(evidence.createdRows.events);
    expect(evidence.rolledBack.unchangedProjects).toBe(true);
    expect(evidence.rolledBack.unchangedEvents).toBe(true);
  });

  it("改名与改描述不改变 id，诊断记录 project.updated", () => {
    expect(evidence.renamed.ok).toBe(true);
    expect(evidence.renamed.data.id).toBe(evidence.created.data.id);
    expect(evidence.renamed.data.name).toBe("改名后的样例");
    expect(evidence.renamed.data.description).toBe("新描述");
    expect(evidence.afterUpdateEvents).toEqual([
      "project.created",
      "project.updated",
      "project.updated",
    ]);
  });

  it("描述可以清空，空补丁被边界拒绝", () => {
    expect(evidence.clearedDescription.ok).toBe(true);
    expect(evidence.clearedDescription.data.description).toBeUndefined();
    expect(evidence.clearedDescription.data.name).toBe("改名后的样例");
    expect(evidence.emptyPatch.ok).toBe(false);
    expect(evidence.emptyPatch.error.code).toBe("validation_failed");
  });

  it("未登录不能修改任何 Project", () => {
    expect(evidence.crossUpdate.ok).toBe(false);
    expect(evidence.crossUpdate.error.code).toBe("unauthorized");
  });

  it("注册播种的默认 Project 与默认 Agent", () => {
    expect(evidence.seededProjects).toBe(1);
    expect(evidence.seededEvents).toBe(1);
  });

  it("列表与详情重新读取同一个 Project", () => {
    expect(evidence.listed.ok).toBe(true);
    const ids = evidence.listed.data.map((project) => project.id);
    // 最新创建的排在最前，默认 Project 在它之后。
    expect(ids[0]).toBe(evidence.created.data.id);
    expect(ids).toHaveLength(evidence.seededProjects + 1);
  });

  it("空名称与超长描述在边界被拒绝，并给出字段级错误", () => {
    expect([...evidence.rejectedFields].sort()).toEqual(["description", "name"]);
    expect(evidence.invalidFields.sort()).toEqual(["description", "name"]);
  });

  it("未登录调用返回 unauthorized 载荷", () => {
    expect(evidence.unauthorized).toMatchObject({
      ok: false,
      error: { code: "unauthorized", requestId: "req_e" },
      requestId: "req_e",
    });
  });

  it("session 基础设施失败返回脱敏 internal 载荷并记录当前请求诊断", () => {
    expect(evidence.infrastructure).toHaveLength(3);
    for (const result of evidence.infrastructure) {
      expect(result).toEqual({
        ok: false,
        error: { code: "internal", message: "内部错误", requestId: "req_x" },
        requestId: "req_x",
      });
    }
    expect(evidence.internalEvents).toHaveLength(3);
    for (const row of evidence.internalEvents) {
      expect(row).toEqual({
        level: "error",
        event: "project.request_failed",
        request_id: "req_x",
        data: JSON.stringify({ code: "internal" }),
      });
    }
  });

  it("不存在的 id 返回 not_found 载荷", () => {
    expect(evidence.missing).toMatchObject({
      ok: false,
      error: { code: "not_found", requestId: "req_f" },
      requestId: "req_f",
    });
  });
});
