import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "crew-delegation-")), "crew.sqlite");
const { createCrewChat, crewInput } = await import("./fixtures/crew-chat");
const { migrateDatabase } = await import("../src/db/migrate");
const { db, sqlite } = await import("../src/db");
const { ID_PREFIXES, newId } = await import("../src/contracts/ids");
const { createProject } = await import("../src/domain/project");
const { addProjectMember, createAgentProfile } = await import("../src/domain/agent");
const { listMessages, sendMessage } = await import("../src/domain/chat");
const {
  cancelDelegation,
  completeDelegation,
  confirmDelegationDelivery,
  deliverPendingDelegations,
  blockDelegation,
  dispatchDelegation,
  acknowledgeDelegationDelivery,
  listCrewDelegations,
  reconcileDelegations,
  sendDelegationInput,
} = await import("../src/domain/delegation");
const { agentRun } = await import("../src/db/schema");
const { workerDelegationResultInput } = await import("../src/contracts/delegation");
const { delegationDelivery } = await import("../src/db/schema");
type ProjectContext = import("../src/domain/access").ProjectContext;

migrateDatabase();
const userId = "usr_delegation_owner";
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(userId, "Owner", "delegation-owner@test.local");

const human: ProjectContext = { userId, requestId: newId(ID_PREFIXES.request) };
const project = createProject({ name: "Delegation" }, human);
const lead = createAgentProfile({ name: "Lead", persona: "", harness: "pi" }, human);
const worker = createAgentProfile({ name: "Worker", persona: "", harness: "pi" }, human);
const other = createAgentProfile({ name: "Other", persona: "", harness: "pi" }, human);
for (const agent of [lead, worker, other]) addProjectMember(project.id, agent.id, human);

const crew = createCrewChat(
  project.id,
  crewInput({
    projectId: project.id,
    title: "Delegation Crew",
    members: [
      { kind: "human", id: userId },
      { kind: "agent", id: lead.id },
      { kind: "agent", id: worker.id },
      { kind: "agent", id: other.id },
    ],
    initialOwner: { kind: "agent", id: lead.id },
  }),
  { kind: "human", userId, ctx: human },
);

const dispatch = (clientRequestId: string, workerProfileId = worker.id, request = "检查登录页") =>
  dispatchDelegation({ chatId: crew.id, workerProfileId, request, clientRequestId }, human);

function workerContext(delegationId: string): ProjectContext {
  const child = db
    .select()
    .from(agentRun)
    .where(eq(agentRun.chatId, readChildChat(delegationId)))
    .get();
  if (!child) throw new Error("worker run missing");
  return {
    userId,
    requestId: newId(ID_PREFIXES.request),
    agent: {
      agentProfileId: worker.id,
      instanceId: child.instanceId,
      runId: child.id,
    },
  };
}

function readInstanceId(chatId: string, agentProfileId: string): string {
  const row = sqlite
    .prepare("SELECT id FROM agent_instance WHERE chat_id = ? AND agent_profile_id = ?")
    .get(chatId, agentProfileId) as { id: string } | undefined;
  if (!row) throw new Error("instance missing");
  return row.id;
}

function readChildChat(delegationId: string): string {
  const row = sqlite
    .prepare("SELECT child_chat_id AS child FROM delegation WHERE id = ?")
    .get(delegationId) as { child: string };
  return row.child;
}

describe("Crew delegation", () => {
  it("dispatches into a child chat without touching the Crew timeline", () => {
    const result = dispatch("client-dispatch-1");
    expect(result.created).toBe(true);
    expect(readChildChat(result.delegationId)).toBe(result.childChatId);
    const child = listMessages(result.childChatId, human);
    expect(child).toHaveLength(1);
    expect(child[0]?.body).toBe("检查登录页");
    expect(listMessages(crew.id, human)).toHaveLength(0);
    const replay = dispatch("client-dispatch-1");
    expect(replay.created).toBe(false);
    expect(replay.delegationId).toBe(result.delegationId);
  });

  it("lets the lead dispatch and add input as an agent", () => {
    sendMessage(
      crew.id,
      { senderKind: "human", senderId: userId, body: "开始处理发布说明" },
      human,
    );
    const leadRun = db
      .select()
      .from(agentRun)
      .where(eq(agentRun.chatId, crew.id))
      .all()
      .find(
        (run: typeof agentRun.$inferSelect) => run.instanceId === readInstanceId(crew.id, lead.id),
      );
    const leadContext: ProjectContext = {
      userId,
      requestId: newId(ID_PREFIXES.request),
      agent: { agentProfileId: lead.id, instanceId: leadRun!.instanceId, runId: leadRun!.id },
    };
    const result = dispatchDelegation(
      {
        chatId: crew.id,
        workerProfileId: worker.id,
        request: "整理发布说明",
        clientRequestId: "lead-dispatch-1",
      },
      leadContext,
    );
    const sent = sendDelegationInput(result.delegationId, "先给结论，再列改动", leadContext);
    expect(sent.delegationId).toBe(result.delegationId);
    const bodies = listMessages(result.childChatId, human).map((message) => message.body);
    expect(bodies).toContain("先给结论，再列改动");
  });

  it("delivers a completed result to the lead run and records a Crew delegation card", () => {
    const crewBefore = listMessages(crew.id, human).length;
    const result = dispatch("client-complete-1");
    const before = readChildChat(result.delegationId);
    completeDelegation(
      result.delegationId,
      {
        summary: "登录页改版完成",
        artifact: { title: "登录页改版报告", html: "<h1>报告</h1>".padEnd(1240, "x") },
      },
      workerContext(result.delegationId),
    );
    const crewMessages = listMessages(crew.id, human);
    expect(crewMessages).toHaveLength(crewBefore + 1);
    expect(crewMessages.at(-1)).toMatchObject({
      senderKind: "delegation_event",
      delegation: {
        delegationId: result.delegationId,
        childChatId: result.childChatId,
        status: "completed",
        workerProfileName: worker.name,
        summary: "登录页改版完成",
      },
    });
    const leads: (typeof agentRun.$inferSelect)[] = db
      .select()
      .from(agentRun)
      .where(eq(agentRun.chatId, crew.id))
      .all();
    expect(leads.length).toBeGreaterThan(0);
    const prompt = sqlite
      .prepare(
        "SELECT id, delegation_prompt_for_chat_id AS promptFor, body FROM message WHERE delegation_prompt_for_chat_id = ?",
      )
      .get(crew.id) as { id: string; promptFor: string; body: string } | undefined;
    expect(prompt?.body).toContain("委派结果");
    const delivery = db
      .select()
      .from(delegationDelivery)
      .where(eq(delegationDelivery.delegationId, result.delegationId))
      .get();
    expect(delivery?.state).toBe("bound");
    const leadRun = leads.find((run) => run.instanceId === delivery?.runId) ?? leads[0]!;
    acknowledgeDelegationDelivery(leadRun.id, prompt!.id);
    const acked = db
      .select()
      .from(delegationDelivery)
      .where(eq(delegationDelivery.delegationId, result.delegationId))
      .get();
    expect(delivery?.messageId).toBe(prompt!.id);
    expect(before).toBe(result.childChatId);
    expect(acked?.state).toBe("acknowledged");
  });

  it("records a blocked result as a durable blocked event", () => {
    const result = dispatch("client-blocked-1");
    blockDelegation(
      result.delegationId,
      { summary: "studio-mac 不在线", reason: "resource_unavailable" },
      workerContext(result.delegationId),
    );
    const view = listCrewDelegations(crew.id, human);
    const row = view.delegations.find((item) => item.id === result.delegationId);
    expect(row?.status).toBe("blocked");
    expect(row?.terminalReason).toBeNull();
    expect(view.events.some((event) => event.kind === "blocked")).toBe(true);
  });

  it("settles a delegation whose worker run died without reporting", () => {
    const result = dispatch("client-dead-worker");
    sqlite
      .prepare(
        "UPDATE agent_run SET status = 'failed', stop_reason = 'process_lost', error_code = 'host_lost', error_message = 'host lost', started_at = COALESCE(started_at, unixepoch()), settled_at = unixepoch() WHERE chat_id = ?",
      )
      .run(result.childChatId);
    expect(reconcileDelegations()).toBeGreaterThan(0);
    const view = listCrewDelegations(crew.id, human);
    const row = view.delegations.find((item) => item.id === result.delegationId);
    expect(row?.status).toBe("failed");
    expect(row?.terminalReason).toBe("interrupted");
    const prompt = sqlite
      .prepare(
        "SELECT body FROM message WHERE delegation_prompt_for_chat_id = ? ORDER BY rowid DESC",
      )
      .get(crew.id) as { body: string } | undefined;
    expect(prompt?.body).toContain("process_lost");
  });

  it("cancels a running delegation, aborts its worker run and delivers the canceled event", () => {
    const result = dispatch("client-cancel-1");
    cancelDelegation({ delegationId: result.delegationId, reason: "方向变了" }, human);
    const view = listCrewDelegations(crew.id, human);
    expect(view.delegations.find((row) => row.id === result.delegationId)?.status).toBe("canceled");
    const childRuns: (typeof agentRun.$inferSelect)[] = db
      .select()
      .from(agentRun)
      .where(eq(agentRun.chatId, result.childChatId))
      .all();
    expect(childRuns.every((run) => run.status !== "running")).toBe(true);
    const delivery = db
      .select()
      .from(delegationDelivery)
      .where(eq(delegationDelivery.delegationId, result.delegationId))
      .get();
    expect(delivery?.state).toBe("bound");
    expect(delivery?.runId).toBeTruthy();
    const prompt = sqlite
      .prepare(
        "SELECT body FROM message WHERE delegation_prompt_for_chat_id = ? ORDER BY rowid DESC",
      )
      .get(crew.id) as { body: string } | undefined;
    expect(prompt?.body).toContain("canceled");
    expect(prompt?.body).toContain("方向变了");
  });

  it("holds a delivery for attention when the lead changed before completion", () => {
    const crewBefore = listMessages(crew.id, human).length;
    const result = dispatch("client-lead-change-1");
    // 改任本身会被未结责任挡住；这里直接改库模拟历史数据里的 lead 变更。
    sqlite
      .prepare(
        "UPDATE chat SET lead_profile_id = ?, crew_epoch = crew_epoch + 1, governance_revision = governance_revision + 1 WHERE id = ?",
      )
      .run(other.id, crew.id);
    completeDelegation(
      result.delegationId,
      { summary: "旧 lead 的结果" },
      workerContext(result.delegationId),
    );
    const delivery = db
      .select()
      .from(delegationDelivery)
      .where(eq(delegationDelivery.delegationId, result.delegationId))
      .get();
    expect(delivery?.state).toBe("attention");
    expect(delivery?.attentionReason).toBe("lead_changed");
    const crewMessages = listMessages(crew.id, human);
    expect(crewMessages).toHaveLength(crewBefore + 1);
    expect(crewMessages.at(-1)).toMatchObject({
      senderKind: "delegation_event",
      delegation: {
        delegationId: result.delegationId,
        childChatId: result.childChatId,
        status: "completed",
        workerProfileName: worker.name,
        summary: "旧 lead 的结果",
      },
    });
  });

  it("derives child chat membership from the parent Crew, not from sibling workers", () => {
    sqlite
      .prepare("UPDATE chat SET lead_profile_id = ?, crew_epoch = crew_epoch + 1 WHERE id = ?")
      .run(lead.id, crew.id);
    const result = dispatch("client-access-1");
    const members = sqlite
      .prepare(
        "SELECT member_kind AS kind, member_id AS id FROM chat_effective_member WHERE chat_id = ? ORDER BY member_id",
      )
      .all(result.childChatId) as { kind: string; id: string }[];
    expect(members).toEqual(
      expect.arrayContaining([
        { kind: "human", id: userId },
        { kind: "agent", id: lead.id },
        { kind: "agent", id: worker.id },
      ]),
    );
    expect(members.some((member) => member.id === other.id)).toBe(false);
  });

  it("rejects late input after the delegation has been canceled", () => {
    const result = dispatch("client-cancel-input-1");
    cancelDelegation({ delegationId: result.delegationId, reason: "方向变了" }, human);
    expect(() => sendDelegationInput(result.delegationId, "补充一句", human)).toThrow(
      /不能再追加输入/,
    );
  });

  it("rejects a worker completing a delegation it does not own", () => {
    const result = dispatch("client-owner-check-1");
    const wrong = workerContext(result.delegationId);
    expect(() =>
      completeDelegation(
        result.delegationId,
        { summary: "wrong" },
        {
          ...wrong,
          agent: { ...wrong.agent!, agentProfileId: lead.id },
        },
      ),
    ).toThrow(/只有被委派/);
  });

  it("writes result prompts into a Crew inbox, never into a worker child chat", () => {
    const first = dispatch("client-inbox-1", worker.id, "整理 A");
    const second = dispatch("client-inbox-2", other.id, "整理 B");
    completeDelegation(
      first.delegationId,
      { summary: "A 完成" },
      workerContext(first.delegationId),
    );
    completeDelegation(
      second.delegationId,
      { summary: "B 完成" },
      {
        userId,
        requestId: newId(ID_PREFIXES.request),
        agent: (() => {
          const run = db
            .select()
            .from(agentRun)
            .where(eq(agentRun.chatId, readChildChat(second.delegationId)))
            .get()!;
          return { agentProfileId: other.id, instanceId: run.instanceId, runId: run.id };
        })(),
      },
    );
    const prompts = sqlite
      .prepare(
        "SELECT chat_id AS chatId, body FROM message WHERE delegation_prompt_for_chat_id = ?",
      )
      .all(crew.id) as { chatId: string; body: string }[];
    const inboxIds = new Set(prompts.map((prompt) => prompt.chatId));
    expect(inboxIds.size).toBe(1);
    const inbox = [...inboxIds][0]!;
    expect([first.childChatId, second.childChatId]).not.toContain(inbox);
    const childBodies = [
      readChildChat(first.delegationId),
      readChildChat(second.delegationId),
    ].flatMap((chatId) => listMessages(chatId, human).map((message) => message.body));
    expect(childBodies.join("\n")).not.toContain("B 完成");
    expect(childBodies.join("\n")).not.toContain("A 完成");
  });

  it("refuses a bound delivery after the Crew is stopped", () => {
    const result = dispatch("client-stop-1");
    completeDelegation(
      result.delegationId,
      { summary: "准备投递" },
      workerContext(result.delegationId),
    );
    const delivery = db
      .select()
      .from(delegationDelivery)
      .where(eq(delegationDelivery.delegationId, result.delegationId))
      .get()!;
    expect(delivery.state).toBe("bound");
    sqlite.prepare("UPDATE crew_control SET mode='stopped' WHERE chat_id=?").run(crew.id);
    expect(confirmDelegationDelivery(delivery.runId!, delivery.messageId!)).toBe("invalid");
    const after = db
      .select()
      .from(delegationDelivery)
      .where(eq(delegationDelivery.id, delivery.id))
      .get()!;
    expect(after.state).toBe("attention");
    expect(after.attentionReason).toBe("crew_stopped");
    sqlite.prepare("UPDATE crew_control SET mode='active' WHERE chat_id=?").run(crew.id);
  });

  it("requeues a bound delivery whose lead run ended before admission", () => {
    const result = dispatch("client-recover-1");
    completeDelegation(
      result.delegationId,
      { summary: "需要恢复" },
      workerContext(result.delegationId),
    );
    const delivery = db
      .select()
      .from(delegationDelivery)
      .where(eq(delegationDelivery.delegationId, result.delegationId))
      .get()!;
    sqlite
      .prepare(
        "UPDATE agent_run SET status='interrupted', stop_reason='process_lost', started_at=COALESCE(started_at, unixepoch()), settled_at=unixepoch() WHERE id=?",
      )
      .run(delivery.runId);
    deliverPendingDelegations();
    const after = db
      .select()
      .from(delegationDelivery)
      .where(eq(delegationDelivery.id, delivery.id))
      .get()!;
    expect(after.attentionReason ?? after.state).toBe("bound");
    expect(after.runId).not.toBe(delivery.runId);
  });

  it("measures summaries and artifacts in UTF-8 bytes, not characters", () => {
    expect(workerDelegationResultInput.safeParse({ summary: "汉".repeat(3000) }).success).toBe(
      false,
    );
    expect(
      workerDelegationResultInput.safeParse({
        summary: "ok",
        artifact: { title: "大报告", html: "汉".repeat(90_000) },
      }).success,
    ).toBe(false);
  });
});
