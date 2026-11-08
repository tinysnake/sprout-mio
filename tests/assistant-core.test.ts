import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "assistant-core-"));
process.env.DATABASE_URL = join(directory, "core.sqlite");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../src/db");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const chats = await import("../src/domain/chat");
const runs = await import("../src/domain/agent-run");
const assistant = await import("../src/domain/assistant");
const observer = await import("../src/domain/assistant-observer");
const ctx = { userId: "assistant-human", requestId: "req_11111111" };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(ctx.userId, "Human", "assistant@test.example");
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('revoked','Other','other@test.example',0,1,1)",
  )
  .run();
const project = createProject({ name: "Assistant project" }, ctx);
const worker = createAgentProfile({ name: "Worker" }, ctx);
const helper = createAgentProfile({ name: "Helper", purpose: "assistant" }, ctx);
addProjectMember(project.id, worker.id, ctx);
addProjectMember(project.id, helper.id, ctx);
const dm = chats.createDirectChat(project.id, helper.id, ctx).chat;
const work = chats.createDirectChat(project.id, worker.id, ctx).chat;
const instant = new Date("2026-11-08T12:00:00Z");
function activeHelper() {
  chats.sendMessage(dm.id, { senderKind: "human", senderId: ctx.userId, body: "Observe" }, ctx);
  const run = runs.listAgentRuns(dm.id, ctx)[0];
  sqlite
    .prepare("UPDATE agent_run SET status='running',started_at=? WHERE id=?")
    .run(instant.getTime() / 1000, run.id);
  return assistant.assistantPrincipal(run.id, ctx.userId, ctx.requestId);
}
function proposalRecord(...args: Parameters<typeof assistant.createAssistantProposal>) {
  const result = assistant.createAssistantProposal(...args);
  return {
    ...result,
    id: result.proposalId,
    instanceId: (
      sqlite
        .prepare("SELECT instance_id FROM assistant_proposal WHERE id=?")
        .get(result.proposalId) as { instance_id: string }
    ).instance_id,
  };
}
afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});
describe("native assistant authority and durable work", () => {
  it("defaults purpose and freezes it at the database boundary", () => {
    expect(worker.purpose).toBe("worker");
    expect(helper.purpose).toBe("assistant");
    expect(() =>
      sqlite.prepare("UPDATE agent_profile SET purpose='assistant' WHERE id=?").run(worker.id),
    ).toThrow("immutable");
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("confirms once, admits exact input once, observes failure once per DM", () => {
    const source = activeHelper();
    const target = {
      kind: "dm_agent" as const,
      projectId: project.id,
      chatId: work.id,
      agentProfileId: worker.id,
    };
    const proposal = assistant.createAssistantProposal(source, target, "Do concrete work", instant);
    const receipt = assistant.confirmAssistantProposal(proposal.proposalId, dm.id, ctx, instant);
    expect(assistant.confirmAssistantProposal(proposal.proposalId, dm.id, ctx, instant)).toEqual(
      receipt,
    );
    const input = sqlite
      .prepare("SELECT run_id FROM agent_run_input WHERE message_id=?")
      .get(receipt.messageId) as { run_id: string };
    expect(() =>
      sqlite
        .prepare("UPDATE assistant_proposal SET confirmed_by='intruder' WHERE id=?")
        .run(proposal.proposalId),
    ).toThrow(/confirmation/);
    expect(() =>
      sqlite
        .prepare("UPDATE assistant_proposal SET work_message_id='msg_00000000' WHERE id=?")
        .run(proposal.proposalId),
    ).toThrow(/confirmation/);
    expect(
      sqlite.prepare("SELECT * FROM assistant_interest WHERE run_id=?").all(input.run_id),
    ).toHaveLength(0);
    sqlite
      .prepare("UPDATE agent_run SET status='running',started_at=? WHERE id=?")
      .run(instant.getTime() / 1000, input.run_id);
    let sent = 0;
    expect(assistant.admitAssistantInput(input.run_id, receipt.messageId, () => ++sent)).toBe(1);
    expect(
      assistant.admitAssistantInput(input.run_id, receipt.messageId, () => ++sent),
    ).toBeUndefined();
    expect(sent).toBe(1);
    runs.markRunInputDelivered(input.run_id, receipt.messageId, ctx);
    runs.transitionAgentRun(
      input.run_id,
      "failed",
      { errorCode: "fixture_failure", errorMessage: "Fixture worker failed" },
      ctx,
    );
    observer.sampleAssistantRuns(new Date(instant.getTime() + 5000));
    observer.sampleAssistantRuns(new Date(instant.getTime() + 10000));
    expect(
      sqlite
        .prepare("SELECT * FROM assistant_event WHERE event_key=?")
        .all(`${input.run_id}:terminal`),
    ).toHaveLength(1);
    expect(chats.listMessages(dm.id, ctx).some((m) => m.senderKind === "assistant_event")).toBe(
      true,
    );
  });
  it("denies forged Human and cross-Project targets; rechecks rights before replay and first send", () => {
    const source = activeHelper();
    const proposal = assistant.createAssistantProposal(
      source,
      { kind: "dm_agent", projectId: project.id, chatId: work.id, agentProfileId: worker.id },
      "Restricted work",
      instant,
    );
    expect(() =>
      assistant.confirmAssistantProposal(
        proposal.proposalId,
        dm.id,
        { ...ctx, userId: "intruder" },
        instant,
      ),
    ).toThrow();
    expect(() =>
      assistant.createAssistantProposal(
        source,
        { kind: "dm_agent", projectId: "prj_00000000", chatId: work.id, agentProfileId: worker.id },
        "Wrong project",
        instant,
      ),
    ).toThrow();
    const receipt = assistant.confirmAssistantProposal(proposal.proposalId, dm.id, ctx, instant);
    const input = sqlite
      .prepare("SELECT run_id FROM agent_run_input WHERE message_id=?")
      .get(receipt.messageId) as { run_id: string };
    sqlite.prepare("UPDATE project SET created_by='revoked' WHERE id=?").run(project.id);
    expect(() =>
      assistant.confirmAssistantProposal(proposal.proposalId, dm.id, ctx, instant),
    ).toThrow();
    let sent = false;
    expect(
      assistant.admitAssistantInput(input.run_id, receipt.messageId, () => {
        sent = true;
      }),
    ).toBeUndefined();
    expect(sent).toBe(false);
    expect(
      sqlite
        .prepare("SELECT cancel_reason FROM agent_run_input WHERE message_id=?")
        .get(receipt.messageId),
    ).toEqual({ cancel_reason: "assistant_context_changed" });
    sqlite.prepare("UPDATE project SET created_by=? WHERE id=?").run(ctx.userId, project.id);
  });
  it("samples unchanged activity on the elapsed clock, merges proposal/watch and keeps a watch for new short runs", () => {
    const now = new Date();
    observer.setAssistantInterval(dm.id, 60, ctx, now);
    observer.setAssistantWatch(dm.id, project.id, work.id, true, ctx, now);
    const source = activeHelper();
    const proposal = assistant.createAssistantProposal(
      source,
      { kind: "dm_agent", projectId: project.id, chatId: work.id, agentProfileId: worker.id },
      "Watched work",
      now,
    );
    const receipt = assistant.confirmAssistantProposal(proposal.proposalId, dm.id, ctx, now);
    const input = sqlite
      .prepare("SELECT run_id FROM agent_run_input WHERE message_id=? AND disposition='pending'")
      .get(receipt.messageId) as { run_id: string };
    sqlite
      .prepare("UPDATE agent_run SET status='running',started_at=? WHERE id=?")
      .run(Math.floor(now.getTime() / 1000), input.run_id);
    assistant.admitAssistantInput(input.run_id, receipt.messageId, () => {});
    expect(
      sqlite.prepare("SELECT * FROM assistant_interest WHERE run_id=?").all(input.run_id),
    ).toHaveLength(2);
    const live = {
      current: {
        id: "live-step",
        kind: "tool" as const,
        label: "Unchanged real action",
        detail: "Same action",
        startedAt: new Date(now.getTime() + 30000).toISOString(),
        status: "running" as const,
      },
      entries: [],
      updatedAt: now.toISOString(),
    };
    observer.sampleAssistantRuns(new Date(now.getTime() + 60000), () => live);
    observer.sampleAssistantRuns(new Date(now.getTime() + 120000), () => live);
    const periodic = sqlite
      .prepare("SELECT fact FROM assistant_event WHERE event_key LIKE ?")
      .all(`${input.run_id}:%`) as { fact: string }[];
    expect(periodic).toHaveLength(2);
    expect(periodic[0].fact).toContain("60s");
    expect(periodic[1].fact).toContain("120s");
    expect(periodic[0].fact).toContain("动作已进行 30s");
    expect(periodic[1].fact).toContain("动作已进行 90s");
    expect(periodic.every((event) => event.fact.includes("Unchanged real action"))).toBe(true);
    runs.transitionAgentRun(
      input.run_id,
      "failed",
      { errorCode: "fixture_failure", errorMessage: "Failed" },
      ctx,
    );
    sqlite.prepare("UPDATE agent_run SET activity=? WHERE id=?").run(
      JSON.stringify({
        current: null,
        entries: [{ ...live.current, label: "Persisted settled action", status: "error" }],
        updatedAt: now.toISOString(),
      }),
      input.run_id,
    );
    observer.sampleAssistantRuns(new Date(now.getTime() + 121000), () => {
      throw new Error("must not read live for terminal");
    });
    const terminal = sqlite
      .prepare("SELECT fact FROM assistant_event WHERE event_key=?")
      .get(`${input.run_id}:terminal`) as { fact: string };
    expect(terminal.fact).toContain("Persisted settled action");
    expect(terminal.fact).not.toContain("Unchanged real action");
    observer.sampleAssistantRuns(new Date(now.getTime() + 180000));
    expect(
      sqlite
        .prepare("SELECT * FROM assistant_event WHERE event_key LIKE ?")
        .all(`${input.run_id}:%`),
    ).toHaveLength(3);
    chats.sendMessage(
      work.id,
      { senderKind: "human", senderId: ctx.userId, body: "New short run" },
      ctx,
    );
    const next = runs.listAgentRuns(work.id, ctx).find((run) => run.status === "queued")!;
    expect(next).toBeTruthy();
    runs.transitionAgentRun(
      next.id,
      "failed",
      { errorCode: "fixture_failure", errorMessage: "Before prompt" },
      ctx,
    );
    observer.sampleAssistantRuns(new Date(now.getTime() + 181000));
    expect(
      sqlite.prepare("SELECT * FROM assistant_event WHERE event_key=?").all(`${next.id}:terminal`),
    ).toHaveLength(1);
    expect(
      sqlite.prepare("SELECT * FROM assistant_watch WHERE revoked_at IS NULL").all(),
    ).toHaveLength(1);
  });
  it("preserves uncertain admission without rerunning a thrown send", () => {
    const source = activeHelper();
    const now = new Date();
    const proposal = assistant.createAssistantProposal(
      source,
      { kind: "dm_agent", projectId: project.id, chatId: work.id, agentProfileId: worker.id },
      "Uncertain send",
      now,
    );
    const receipt = assistant.confirmAssistantProposal(proposal.proposalId, dm.id, ctx, now);
    const input = sqlite
      .prepare("SELECT run_id FROM agent_run_input WHERE message_id=?")
      .get(receipt.messageId) as { run_id: string };
    let attempts = 0;
    expect(() =>
      assistant.admitAssistantInput(input.run_id, receipt.messageId, () => {
        attempts++;
        throw new Error("transport uncertain");
      }),
    ).toThrow("transport uncertain");
    assistant.admitAssistantInput(input.run_id, receipt.messageId, () => {
      attempts++;
    });
    expect(attempts).toBe(1);
    expect(
      sqlite
        .prepare("SELECT admitted_at FROM agent_run_input WHERE message_id=?")
        .get(receipt.messageId),
    ).toHaveProperty("admitted_at", expect.any(Number));
  });
  it("does not replay pre-purpose worker session snapshots into an assistant", () => {
    const source = activeHelper();
    sqlite
      .prepare("UPDATE agent_run SET config_snapshot=? WHERE id=?")
      .run(JSON.stringify({ sessionFile: "/tmp/worker-history.jsonl" }), source.run.id);
    expect(runs.previousSessionFile(source.run.id, ctx)).toBeUndefined();
    sqlite
      .prepare("UPDATE agent_run SET config_snapshot=? WHERE id=?")
      .run(
        JSON.stringify({ purpose: "assistant", sessionFile: "/tmp/assistant-history.jsonl" }),
        source.run.id,
      );
    expect(runs.previousSessionFile(source.run.id, ctx)).toBe("/tmp/assistant-history.jsonl");
  });
  it("pins Group-owner proposals and permits an explicit Agent under a Human owner without fanout", () => {
    const source = activeHelper();
    const other = createAgentProfile({ name: "Group second worker" }, ctx);
    addProjectMember(project.id, other.id, ctx);
    const actor = { kind: "human" as const, userId: ctx.userId, ctx };
    let group = chats.createGroupChat(
      project.id,
      {
        projectId: project.id,
        title: "Pinned owner",
        members: [
          { kind: "human", id: ctx.userId },
          { kind: "agent", id: worker.id },
          { kind: "agent", id: other.id },
        ],
        initialOwner: { kind: "agent", id: worker.id },
        wakePolicy: "owner_led",
      },
      actor,
    );
    const pinned = proposalRecord(
      source,
      { kind: "group_owner", projectId: project.id, chatId: group.id },
      "Pinned concrete operation",
      instant,
    );
    group = chats.setChatOwner(
      group.id,
      { kind: "human", id: ctx.userId },
      group.governanceRevision,
      actor,
    );
    expect(() => assistant.confirmAssistantProposal(pinned.id, dm.id, ctx, instant)).toThrow();
    const explicit = proposalRecord(
      source,
      { kind: "group_agent", projectId: project.id, chatId: group.id, agentProfileId: other.id },
      "Only the explicit Agent",
      instant,
    );
    const receipt = assistant.confirmAssistantProposal(explicit.id, dm.id, ctx, instant);
    const input = sqlite
      .prepare(
        "SELECT i.*,r.instance_id FROM agent_run_input i JOIN agent_run r ON r.id=i.run_id WHERE i.message_id=?",
      )
      .get(receipt.messageId) as { run_id: string; instance_id: string };
    expect(
      sqlite
        .prepare("SELECT count(*) AS n FROM agent_run_input WHERE message_id=?")
        .get(receipt.messageId),
    ).toEqual({ n: 1 });
    expect(input.instance_id).toBe(explicit.instanceId);
    group = chats.setChatOwner(
      group.id,
      { kind: "agent", id: worker.id },
      group.governanceRevision,
      actor,
    );
    expect(() =>
      assistant.confirmAssistantProposal(explicit.id, dm.id, ctx, instant),
    ).not.toThrow();
    expect(() =>
      sqlite.prepare("UPDATE assistant_proposal SET body='forged' WHERE id=?").run(explicit.id),
    ).toThrow("immutable");
    expect(() =>
      sqlite.prepare("UPDATE message SET body='forged' WHERE id=?").run(receipt.messageId),
    ).toThrow("immutable");
  });
  it("carries only unadmitted proposal lineage and enrolls the real next run on admission", () => {
    const source = activeHelper();
    const isolated = createAgentProfile({ name: "Carry worker" }, ctx);
    addProjectMember(project.id, isolated.id, ctx);
    const target = chats.createDirectChat(project.id, isolated.id, ctx).chat;
    chats.sendMessage(
      target.id,
      { senderKind: "human", senderId: ctx.userId, body: "Earlier work" },
      ctx,
    );
    const first = runs.listAgentRuns(target.id, ctx)[0];
    sqlite
      .prepare("UPDATE agent_run SET status='running',started_at=?,config_snapshot='{}' WHERE id=?")
      .run(instant.getTime() / 1000, first.id);
    const proposal = proposalRecord(
      source,
      { kind: "dm_agent", projectId: project.id, chatId: target.id, agentProfileId: isolated.id },
      "Follow this message only",
      instant,
    );
    const receipt = assistant.confirmAssistantProposal(proposal.id, dm.id, ctx, instant);
    expect(
      sqlite
        .prepare("SELECT count(*) AS n FROM assistant_interest WHERE origin_id=?")
        .get(proposal.id),
    ).toEqual({ n: 0 });
    runs.completeAgentRun(first.id, "Earlier reply", "stop", ctx);
    const input = sqlite
      .prepare("SELECT * FROM agent_run_input WHERE message_id=?")
      .get(receipt.messageId) as { run_id: string };
    expect(input.run_id).not.toBe(first.id);
    observer.sampleAssistantRuns(new Date(instant.getTime() + 1000));
    expect(
      sqlite
        .prepare(
          "SELECT count(*) AS n FROM assistant_event WHERE event_key=? AND assistant_chat_id=?",
        )
        .get(`${first.id}:terminal`, dm.id),
    ).toEqual({ n: 0 });
    assistant.admitAssistantInput(input.run_id, receipt.messageId, () => {});
    expect(
      sqlite.prepare("SELECT run_id FROM assistant_interest WHERE origin_id=?").get(proposal.id),
    ).toEqual({ run_id: input.run_id });
  });
  it("reports queued cancellation without enrolling an unadmitted proposal or waking any Agent", () => {
    const source = activeHelper();
    const isolated = createAgentProfile({ name: "Canceled worker" }, ctx);
    addProjectMember(project.id, isolated.id, ctx);
    const target = chats.createDirectChat(project.id, isolated.id, ctx).chat;
    const proposal = proposalRecord(
      source,
      { kind: "dm_agent", projectId: project.id, chatId: target.id, agentProfileId: isolated.id },
      "Queued operation",
      instant,
    );
    const receipt = assistant.confirmAssistantProposal(proposal.id, dm.id, ctx, instant);
    const input = sqlite
      .prepare("SELECT run_id FROM agent_run_input WHERE message_id=?")
      .get(receipt.messageId) as { run_id: string };
    runs.settleAgentRun(input.run_id, { status: "aborted" }, ctx);
    const before = sqlite.prepare("SELECT count(*) AS n FROM agent_run").get();
    observer.sampleAssistantRuns(new Date(instant.getTime() + 1000));
    observer.sampleAssistantRuns(new Date(instant.getTime() + 2000));
    expect(
      sqlite
        .prepare("SELECT count(*) AS n FROM assistant_interest WHERE origin_id=?")
        .get(proposal.id),
    ).toEqual({ n: 0 });
    const notices = sqlite
      .prepare("SELECT * FROM assistant_event WHERE event_key=?")
      .all(`proposal:${proposal.id}:undelivered`);
    expect(notices).toHaveLength(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM agent_run").get()).toEqual(before);
  });
  it("delivers once to each DM and rolls back transient capture failures while suppressing revoked pending facts", () => {
    activeHelper();
    const another = createAgentProfile({ name: "Second assistant", purpose: "assistant" }, ctx);
    addProjectMember(project.id, another.id, ctx);
    const second = chats.createDirectChat(project.id, another.id, ctx).chat;
    const isolated = createAgentProfile({ name: "Watched worker" }, ctx);
    addProjectMember(project.id, isolated.id, ctx);
    const target = chats.createDirectChat(project.id, isolated.id, ctx).chat;
    for (const sourceId of [dm.id, second.id]) {
      observer.setAssistantInterval(sourceId, 60, ctx, instant);
      observer.setAssistantWatch(sourceId, project.id, target.id, true, ctx, instant);
    }
    chats.sendMessage(
      target.id,
      { senderKind: "human", senderId: ctx.userId, body: "Watched" },
      ctx,
    );
    const run = runs.listAgentRuns(target.id, ctx)[0];
    const due = sqlite
      .prepare(
        "SELECT next_due_at FROM assistant_run_cursor WHERE assistant_chat_id=? AND run_id=?",
      )
      .get(dm.id, run.id) as { next_due_at: number };
    const time = new Date(due.next_due_at);
    expect(() =>
      observer.sampleAssistantRuns(time, () => {
        throw Object.assign(new Error("db transient"), { code: "SQLITE_BUSY" });
      }),
    ).toThrow("db transient");
    expect(
      sqlite
        .prepare(
          "SELECT next_due_at FROM assistant_run_cursor WHERE assistant_chat_id=? AND run_id=?",
        )
        .get(dm.id, run.id),
    ).toEqual(due);
    const sampledAt = new Date(time.getTime() + 1000);
    observer.sampleAssistantRuns(sampledAt, () => undefined);
    for (const sourceId of [dm.id, second.id])
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS n FROM assistant_event WHERE assistant_chat_id=? AND json_extract(fact,'$.runId')=? AND json_extract(fact,'$.kind')='periodic' AND message_id IS NOT NULL",
          )
          .get(sourceId, run.id),
      ).toEqual({ n: 1 });
    const event = assistant.captureAssistantFact(
      second.id,
      "pending-revoked",
      {
        kind: "periodic",
        runId: run.id,
        targetProjectId: project.id,
        targetChatId: target.id,
        body: "Pending fact",
        sampledAt: time.toISOString(),
      },
      time,
    );
    observer.setAssistantWatch(second.id, project.id, target.id, false, ctx, time);
    assistant.deliverAssistantEvents(time);
    const suppressed = sqlite
      .prepare(
        "SELECT suppressed_at,message_id FROM assistant_event WHERE event_key='pending-revoked'",
      )
      .get() as { suppressed_at: number; message_id: null };
    expect(suppressed.suppressed_at).not.toBeNull();
    expect(suppressed.message_id).toBeNull();
    observer.setAssistantWatch(second.id, project.id, target.id, true, ctx, time);
    assistant.deliverAssistantEvents(time);
    expect(
      sqlite
        .prepare("SELECT message_id FROM assistant_event WHERE event_key='pending-revoked'")
        .get(),
    ).toEqual({ message_id: null });
    expect(event).toBeDefined();
  });
  it("enrolls existing and newly allocated Group runs for every worker, including immediate terminal runs", () => {
    const secondWorker = createAgentProfile({ name: "Second watched worker" }, ctx);
    addProjectMember(project.id, secondWorker.id, ctx);
    const group = chats.createGroupChat(
      project.id,
      {
        projectId: project.id,
        title: "Watched multi-Agent group",
        members: [
          { kind: "agent", id: worker.id },
          { kind: "agent", id: secondWorker.id },
        ],
        initialOwner: { kind: "human", id: ctx.userId },
        wakePolicy: "owner_led",
      },
      { kind: "human", userId: ctx.userId, ctx },
    );
    const firstInstance = chats.ensureInstance(group.id, worker.id, ctx);
    const secondInstance = chats.ensureInstance(group.id, secondWorker.id, ctx);
    const existing = runs.allocateContinuationRun(
      { projectId: project.id, chatId: group.id, instanceId: firstInstance.id },
      ctx.requestId,
      instant,
    );
    const watch = observer.setAssistantWatch(dm.id, project.id, group.id, true, ctx, instant);
    const short = runs.allocateContinuationRun(
      { projectId: project.id, chatId: group.id, instanceId: secondInstance.id },
      ctx.requestId,
      instant,
    );
    expect(
      sqlite
        .prepare(
          "SELECT run_id FROM assistant_interest WHERE assistant_chat_id=? AND origin_id=? ORDER BY run_id",
        )
        .all(dm.id, watch.watchId),
    ).toEqual([existing.id, short.id].sort().map((run_id) => ({ run_id })));
    runs.abortAgentRun(existing.id, ctx);
    runs.abortAgentRun(short.id, ctx);
    observer.sampleAssistantRuns(new Date(instant.getTime() + 1));
    for (const run of [existing, short])
      expect(
        sqlite
          .prepare(
            "SELECT message_id FROM assistant_event WHERE assistant_chat_id=? AND event_key=?",
          )
          .get(dm.id, `${run.id}:terminal`),
      ).toMatchObject({ message_id: expect.any(String) });
    expect(
      sqlite.prepare("SELECT revoked_at FROM assistant_watch WHERE id=?").get(watch.watchId),
    ).toEqual({ revoked_at: null });
  });
  it("keeps assistants out of inherited Public Channels, Group membership, and Task responsibility", async () => {
    const { taskResponsibilityFacts } = await import("../src/domain/task-capabilities");
    expect(() => taskResponsibilityFacts(dm.id, ctx)).toThrow(
      "承接分身必须是 Project 内的工作 Agent",
    );
    expect(taskResponsibilityFacts(work.id, ctx).kind).toBe("agent");
    expect(
      sqlite
        .prepare(
          "SELECT * FROM chat_effective_member WHERE member_id=? AND chat_id IN (SELECT id FROM chat WHERE kind='public_channel')",
        )
        .all(helper.id),
    ).toEqual([]);
    expect(() =>
      chats.createGroupChat(
        project.id,
        {
          projectId: project.id,
          members: [{ kind: "agent", id: helper.id }],
          initialOwner: { kind: "agent", id: helper.id },
          wakePolicy: "owner_led",
        },
        { kind: "human", userId: ctx.userId, ctx },
      ),
    ).toThrow();
  });
});
