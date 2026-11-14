import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { CrewDelegationCard } from "../src/contracts/delegation";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "crew-rail-")), "rail.sqlite");
const { migrateDatabase } = await import("../src/db/migrate");
const { db, sqlite } = await import("../src/db");
const { chat, delegation } = await import("../src/db/schema");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const { createCrewChat } = await import("./fixtures/crew-chat");
const { dispatchDelegation, cancelDelegation } = await import("../src/domain/delegation");
const { listCrewDelegationRail, groupCrewDelegations } =
  await import("../src/domain/crew-delegation-rail");
migrateDatabase();
const uid = "usr_rail_owner";
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(uid, "Owner", "rail-owner@example.test");
const ctx = { userId: uid, requestId: "req_rail" };
const project = createProject({ name: "Crew rail" }, ctx);
const lead = createAgentProfile({ name: "Lead", persona: "", harness: "pi" }, ctx);
const worker = createAgentProfile({ name: "Worker", persona: "", harness: "pi" }, ctx);
for (const agent of [lead, worker]) addProjectMember(project.id, agent.id, ctx);
const crew = createCrewChat(
  project.id,
  {
    projectId: project.id,
    title: "Crew",
    members: [
      { kind: "human", id: uid },
      { kind: "agent", id: lead.id },
      { kind: "agent", id: worker.id },
    ],
  },
  { kind: "human", userId: uid, ctx },
);

describe("Crew rail 的读取边界", () => {
  it("隔离 crew/epoch、排除取消与归档，输出只含卡片字段", () => {
    const create = (key: string) =>
      dispatchDelegation(
        {
          chatId: crew.id,
          workerProfileId: worker.id,
          request: `委派 ${key}\n完整请求`,
          clientRequestId: `rail-${key}-0000`,
        },
        ctx,
      );
    const active = create("active");
    const completed = create("completed");
    const oldEpoch = create("epoch");
    const canceled = create("canceled");
    const archived = create("archived");
    db.update(delegation)
      .set({
        status: "completed",
        terminalSummary: "已生成报告\n更多内容",
        terminalReason: "completed",
        settledAt: new Date(),
      })
      .where(eq(delegation.id, completed.delegationId))
      .run();
    db.update(delegation)
      .set({ crewEpoch: 99 })
      .where(eq(delegation.id, oldEpoch.delegationId))
      .run();
    cancelDelegation({ delegationId: canceled.delegationId, reason: "撤销" }, ctx);
    db.update(chat).set({ archivedAt: new Date() }).where(eq(chat.id, archived.childChatId)).run();
    const rail = listCrewDelegationRail({ projectId: project.id, crewChatId: crew.id }, ctx);
    expect(rail.counts).toEqual({ active: 1, needsYou: 0, completed: 1 });
    expect(rail.active[0].delegationId).toBe(active.delegationId);
    expect(rail.completed[0].summary).toBe("已生成报告");
    expect(Object.keys(rail.active[0]).sort()).toEqual(
      [
        "delegationId",
        "childChatId",
        "workerProfileName",
        "title",
        "status",
        "updatedAt",
        "elapsedMs",
        "summary",
        "attentionReason",
      ].sort(),
    );
    expect(() =>
      listCrewDelegationRail({ projectId: "prj_wrong", crewChatId: crew.id }, ctx),
    ).toThrow();
    expect(() =>
      listCrewDelegationRail(
        { projectId: project.id, crewChatId: crew.id },
        { userId: "usr_outsider", requestId: "req_denied" },
      ),
    ).toThrow();
  });

  it("attention 优先、分段不重叠，完成卡片最多 20，计数保留总数", () => {
    const card = (
      id: string,
      status: CrewDelegationCard["status"],
      attentionReason: string | null = null,
    ): CrewDelegationCard => ({
      delegationId: id,
      childChatId: `chat-${id}`,
      workerProfileName: "Worker",
      title: id,
      status,
      updatedAt: new Date().toISOString(),
      elapsedMs: 1000,
      summary: null,
      attentionReason,
    });
    const grouped = groupCrewDelegations([
      card("active", "running"),
      card("queued", "queued"),
      card("blocked", "blocked"),
      card("failed", "failed"),
      card("attention", "completed", "结果未送达"),
      ...Array.from({ length: 25 }, (_, i) => card(`done-${i}`, "completed")),
    ]);
    expect(grouped.counts).toEqual({ active: 2, needsYou: 3, completed: 25 });
    expect(grouped.completed).toHaveLength(20);
    expect(grouped.needsYou.map((item) => item.delegationId)).toContain("attention");
    expect(groupCrewDelegations([]).counts).toEqual({ active: 0, needsYou: 0, completed: 0 });
  });
});
