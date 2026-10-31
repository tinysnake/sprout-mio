import { p6bFixture } from "./p6b-support";
import { infoHubGetInputSchema, infoHubQuerySchema } from "../../src/contracts/info-hub-query";
const f = await p6bFixture("info");
try {
  const hub = f.projectInfoHubSchema.parse(f.info.getProjectInfoHub(f.p.id, f.ctx));
  f.equal(hub.agents.runs.active.length, 3);
  f.equal(hub.agents.agents.find((agent) => agent.agentProfileId === f.a.id)?.status, "running");
  f.check(
    hub.agents.runs.active.some(
      (run) => run.chatId === f.neighbor.id && run.runId === f.runNeighbor,
    ),
    "cross Chat activity is visible",
  );
  f.check(!JSON.stringify(hub).includes("SECRET"), "Project facts never include Chat/Task bodies");
  const chat = f.chatInfoViewSchema.parse(f.info.getChatInfo(f.chat.id, f.ctx));
  f.equal(chat.members.filter((member) => member.memberKind === "human").length, 1);
  f.equal(
    chat.instances.find((instance) => instance.instanceId === f.instanceB.id)?.leases[0]?.machineId,
    f.machineB,
  );
  const query = (raw: unknown) =>
    f.info.getInfoHub(f.p.id, infoHubQuerySchema.parse(raw), f.agentCtx);
  const agent = query({ view: "agent", agentProfileId: f.a.id, section: "instances" });
  f.check(
    agent.view === "agent" && agent.section === "instances" && agent.data.length === 2,
    "Agent view has each Chat instance",
  );
  const machine = query({ view: "machine", machineId: f.machineB });
  f.check(
    machine.view === "machine" &&
      machine.data.lease.holder?.instanceId === f.instanceB.id &&
      machine.data.lease.holder.chatId === f.chat.id,
    "Machine view resolves stored holder",
  );
  const neighbor = query({ view: "chat", chatId: f.neighbor.id, section: "runs" });
  f.check(
    neighbor.view === "chat" &&
      neighbor.section === "runs" &&
      neighbor.data.some((run) => run.runId === f.runNeighbor),
    "cross Chat query yields basic active run facts",
  );
  f.throws(() => f.info.getChatInfo(f.neighbor.id, f.agentCtx), "not_found");
  f.check(!JSON.stringify(neighbor).includes("SECRET"), "cross Chat response has no body");
  f.check(
    !infoHubGetInputSchema.safeParse({
      projectId: f.p.id,
      view: "project",
      section: "agents",
      runId: f.runB,
    }).success,
    "caller cannot supply execution identity",
  );
  f.throws(() => query({ view: "project", section: "agents", limit: 0 }));
  f.throws(() => query({ view: "project", section: "agents", limit: 101 }));
  const page1 = query({ view: "project", section: "agents", limit: 1 });
  f.check(
    "page" in page1 && page1.data.length === 1 && page1.page.total === 2 && page1.page.nextCursor,
    "page boundary has exact total and cursor",
  );
  if (!("page" in page1) || !page1.page.nextCursor) throw new Error("missing cursor");
  const cursor = page1.page.nextCursor;
  f.throws(
    () =>
      f.info.getInfoHub(
        f.p.id,
        infoHubQuerySchema.parse({ view: "project", section: "agents", limit: 1, cursor }),
        f.ctx,
      ),
    "info_hub_cursor_stale",
  );
  const actualNow = Date.now;
  try {
    Date.now = () => actualNow() + 6 * 60_000;
    f.throws(
      () => query({ view: "project", section: "agents", limit: 1, cursor }),
      "info_hub_cursor_stale",
    );
  } finally {
    Date.now = actualNow;
  }
  const page2 = query({ view: "project", section: "agents", limit: 1, cursor });
  f.check(
    "page" in page2 &&
      page2.data.length === 1 &&
      page2.page.nextCursor === null &&
      JSON.stringify(page2.data) !== JSON.stringify(page1.data),
    "last page has no duplicates or continuation",
  );
  f.throws(
    () => query({ view: "project", section: "chats", limit: 1, cursor }),
    "info_hub_cursor_stale",
  );
  f.throws(
    () => query({ view: "project", section: "agents", limit: 2, cursor }),
    "info_hub_cursor_stale",
  );
  f.throws(
    () => query({ view: "project", section: "agents", limit: 1, cursor: "forged" }),
    "info_hub_cursor_stale",
  );
  f.sqlite.prepare("UPDATE task SET revision=revision+1 WHERE project_id=?").run(f.p.id);
  f.throws(
    () => query({ view: "project", section: "agents", limit: 1, cursor }),
    "info_hub_cursor_stale",
  );
  const count = () => {
    let n = 0;
    const original = f.sqlite.prepare;
    f.sqlite.prepare = function (...args: Parameters<typeof original>) {
      n++;
      return original.apply(this, args);
    };
    try {
      query({ view: "project", section: "agents" });
      return n;
    } finally {
      f.sqlite.prepare = original;
    }
  };
  const before = count();
  for (let i = 0; i < 40; i++) {
    const profile = f.agents.createAgentProfile(
      { name: `Page ${i}`, persona: "", harness: "pi" },
      f.ctx,
    );
    f.agents.addProjectMember(f.p.id, profile.id, f.ctx);
    const dm = f.chats.createDirectChat(f.p.id, profile.id, f.ctx).chat;
    const instance = f.chats.ensureInstance(dm.id, profile.id, f.ctx);
    f.addRun(instance, "failed");
  }
  f.equal(count(), before, "SQLite statements are independent of row count");
  const defaultPage = query({ view: "project", section: "agents" });
  f.check(
    "page" in defaultPage && defaultPage.data.length === 25 && defaultPage.page.total === 42,
    "default page size is 25",
  );
  f.sqlite
    .prepare("UPDATE agent_run SET error_message=? WHERE project_id=? AND status='failed'")
    .run("具体错误".repeat(500), f.p.id);
  const large = query({ view: "project", section: "agents", limit: 100 });
  f.check(
    Buffer.byteLength(JSON.stringify(large)) <= f.INFO_HUB_LIMITS.maxResponseBytes,
    "response respects UTF-8 budget",
  );
  f.check(
    "page" in large && large.data.length < 42 && large.page.nextCursor !== null,
    "byte budget shrinks page with continuation",
  );
  f.sqlite
    .prepare(
      "UPDATE agent_run SET status='failed',error_code='fixture',error_message='failure',settled_at=? WHERE id=?",
    )
    .run(Date.now(), f.runB);
  const held = query({ view: "machine", machineId: f.machineB });
  f.check(
    held.view === "machine" && held.data.lease.state === "held",
    "settlement never infers free from a stored held lease",
  );
  const status = query({ view: "agent", agentProfileId: f.b.id, section: "summary" });
  f.check(
    status.view === "agent" &&
      status.section === "summary" &&
      status.data.status === "error" &&
      status.data.error?.runId === f.runB,
    "failed latest run yields an explicit error source",
  );
  const revision = query({ view: "project", section: "chats" }).revision;
  f.equal(
    f.info.refreshInfoHub(
      f.p.id,
      infoHubQuerySchema.parse({ view: "project", section: "chats" }),
      revision,
      f.agentCtx,
    ).kind,
    "unchanged",
  );
  f.finish();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
