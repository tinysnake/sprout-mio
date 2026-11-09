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
const { createAgentProfile, addProjectMember, removeProjectMember } =
  await import("../src/domain/agent");
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
function activeHelper(chatId = dm.id) {
  chats.sendMessage(chatId, { senderKind: "human", senderId: ctx.userId, body: "Observe" }, ctx);
  const run = runs.listAgentRuns(chatId, ctx)[0];
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
  it("observes visible workers without DM and freezes an Agent-only proposal to its canonical DM", () => {
    const source = activeHelper();
    const fresh = createAgentProfile({ name: "No existing DM" }, ctx);
    addProjectMember(project.id, fresh.id, ctx);
    const before = (
      sqlite
        .prepare("SELECT count(*) n FROM chat WHERE project_id=? AND kind='dm'")
        .get(project.id) as { n: number }
    ).n;
    const observed = assistant.dispatchAssistantCall(
      source.run.id,
      ctx.userId,
      ctx.requestId,
      {
        type: "assistant_observe",
        input: { projectId: project.id, targetProjectId: project.id, limit: 50, offset: 0 },
      },
      () => null,
    );
    expect(observed).toMatchObject({
      agents: expect.arrayContaining([
        { id: fresh.id, agentProfileId: fresh.id, name: fresh.name, purpose: "worker" },
      ]),
    });
    expect(
      (
        sqlite
          .prepare("SELECT count(*) n FROM chat WHERE project_id=? AND kind='dm'")
          .get(project.id) as { n: number }
      ).n,
    ).toBe(before);
    const proposed = assistant.createAssistantProposal(
      source,
      { kind: "dm_agent", projectId: project.id, agentProfileId: fresh.id },
      "hi",
      instant,
    );
    expect(proposed.target.chatId).toBe(chats.createDirectChat(project.id, fresh.id, ctx).chat.id);
    expect(runs.listAgentRuns(proposed.target.chatId, ctx)).toEqual([]);
    expect(
      assistant.confirmAssistantProposal(proposed.proposalId, dm.id, ctx, instant),
    ).toMatchObject({ status: "submitted" });
    const notice = chats
      .listMessages(dm.id, ctx)
      .find((row) => row.senderKind === "assistant_event");
    expect(notice?.senderKind).toBe("assistant_event");
    if (notice?.senderKind === "assistant_event") {
      expect(notice.nativeSource.summary).toContain(fresh.name);
      expect(notice.nativeSource.summary).not.toMatch(/(?:msg|cnv|run|prj)_[a-z0-9]+/);
      expect(notice.nativeSource.summary).toContain("等待你确认");
      expect(notice.body).toContain("待确认工作");
      const confirmed = chats
        .listMessages(dm.id, ctx)
        .find(
          (row) => row.senderKind === "assistant_event" && row.body.includes("Human 已确认提案"),
        );
      expect(
        confirmed?.senderKind === "assistant_event" && confirmed.nativeSource.summary,
      ).toContain("已确认");
    }
  });

  it("keeps watch intervals and clocks independent and never activates tool intent without Human consent", () => {
    const profile = createAgentProfile({ name: "Interval helper", purpose: "assistant" }, ctx);
    addProjectMember(project.id, profile.id, ctx);
    const sourceChat = chats.createDirectChat(project.id, profile.id, ctx).chat;
    const source = activeHelper(sourceChat.id);
    const other = createAgentProfile({ name: "Other watched worker" }, ctx);
    addProjectMember(project.id, other.id, ctx);
    const otherChat = chats.createDirectChat(project.id, other.id, ctx).chat;
    const tool = (chatId: string, intervalSeconds: number) =>
      assistant.dispatchAssistantCall(
        source.run.id,
        ctx.userId,
        ctx.requestId,
        {
          type: "assistant_watch",
          input: { projectId: project.id, targetProjectId: project.id, chatId, intervalSeconds },
        },
        () => null,
      );
    expect(tool(work.id, 60)).toMatchObject({ active: false, intervalSeconds: 60 });
    expect(assistant.assistantPanel(sourceChat.id, ctx).watches).toHaveLength(0);
    observer.setAssistantWatch(sourceChat.id, project.id, work.id, true, ctx, instant, 60);
    observer.setAssistantWatch(sourceChat.id, project.id, otherChat.id, true, ctx, instant, 900);
    const consent = assistant
      .assistantPanel(sourceChat.id, ctx)
      .watches.find((w) => w.targetChatId === work.id)!;
    expect(tool(work.id, 120)).toMatchObject({ active: true, intervalSeconds: 120 });
    const updated = assistant.assistantPanel(sourceChat.id, ctx).watches;
    expect(updated.find((w) => w.targetChatId === work.id)).toMatchObject({
      consentedAt: consent.consentedAt,
      consentedBy: consent.consentedBy,
      intervalSeconds: 120,
    });
    expect(updated.find((w) => w.targetChatId === otherChat.id)).toMatchObject({
      intervalSeconds: 900,
    });
    for (const target of [work.id, otherChat.id])
      chats.sendMessage(target, { senderKind: "human", senderId: ctx.userId, body: "clock" }, ctx);
    const cursors = sqlite
      .prepare(
        "SELECT c.next_due_at,r.chat_id FROM assistant_run_cursor c JOIN agent_run r ON r.id=c.run_id WHERE c.assistant_chat_id=?",
      )
      .all(sourceChat.id) as { next_due_at: number; chat_id: string }[];
    const first = cursors.find((c) => c.chat_id === work.id)!;
    const second = cursors.find((c) => c.chat_id === otherChat.id)!;
    expect(second.next_due_at - first.next_due_at).toBeGreaterThanOrEqual(779000);
    expect(() =>
      observer.setAssistantWatch(sourceChat.id, project.id, work.id, true, ctx, instant, 59),
    ).toThrow();
    expect(() =>
      sqlite.prepare("UPDATE assistant_watch SET interval_seconds=0 WHERE id=?").run(consent.id),
    ).toThrow();
    observer.setAssistantWatch(sourceChat.id, project.id, work.id, false, ctx);
    observer.setAssistantWatch(sourceChat.id, project.id, otherChat.id, false, ctx);
    sqlite.prepare("DELETE FROM assistant_interest WHERE assistant_chat_id=?").run(sourceChat.id);
  });
  it("defaults purpose and freezes it at the database boundary", () => {
    expect(worker.purpose).toBe("worker");
    expect(helper.purpose).toBe("assistant");
    expect(() =>
      sqlite.prepare("UPDATE agent_profile SET purpose='assistant' WHERE id=?").run(worker.id),
    ).toThrow("immutable");
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("captures immutable bounded native facts per assistant Human input and requires its matching receipt", () => {
    const profile = createAgentProfile({ name: "Steer helper", purpose: "assistant" }, ctx);
    addProjectMember(project.id, profile.id, ctx);
    const sourceChat = chats.createDirectChat(project.id, profile.id, ctx).chat;
    const source = activeHelper(sourceChat.id);
    const target = {
      kind: "dm_agent" as const,
      projectId: project.id,
      chatId: work.id,
      agentProfileId: worker.id,
    };
    assistant.createAssistantProposal(source, target, "First fresh native decision", instant);
    const first = chats.sendMessage(
      sourceChat.id,
      { senderKind: "human", senderId: ctx.userId, body: "First steer" },
      ctx,
    );
    const captured = assistant.prepareAssistantSteerContext(source.run.id, first.id, ctx, instant);
    expect(captured.serializedText).toContain("First fresh native decision");
    assistant.createAssistantProposal(
      source,
      target,
      "Later native decision",
      new Date(instant.getTime() + 1),
    );
    expect(assistant.prepareAssistantSteerContext(source.run.id, first.id, ctx)).toEqual(captured);
    expect(captured.serializedText).not.toContain("Later native decision");
    const next = chats.sendMessage(
      sourceChat.id,
      { senderKind: "human", senderId: ctx.userId, body: "Next steer" },
      ctx,
    );
    const fresh = assistant.prepareAssistantSteerContext(source.run.id, next.id, ctx, instant);
    expect(fresh.serializedText).toContain("Later native decision");
    expect(Buffer.byteLength(fresh.serializedText)).toBeLessThanOrEqual(8192);
    expect(() => runs.markRunInputDelivered(source.run.id, first.id, ctx)).toThrow(
      "assistant_context_receipt_mismatch",
    );
    expect(() => runs.markRunInputDelivered(source.run.id, first.id, ctx, "0".repeat(64))).toThrow(
      "assistant_context_receipt_mismatch",
    );
    runs.markRunInputDelivered(source.run.id, first.id, ctx, captured.contentHash);
    const receipt = sqlite
      .prepare(
        "SELECT disposition,assistant_context_submitted_at FROM agent_run_input WHERE run_id=? AND message_id=?",
      )
      .get(source.run.id, first.id);
    expect(receipt).toMatchObject({
      disposition: "delivered",
      assistant_context_submitted_at: expect.any(Number),
    });
    expect(() =>
      sqlite
        .prepare("UPDATE agent_run_input SET assistant_context=? WHERE run_id=? AND message_id=?")
        .run(JSON.stringify({ ...captured, serializedText: "changed" }), source.run.id, first.id),
    ).toThrow("assistant_input_context_immutable");
    const otherProject = createProject({ name: "Revocable native target" }, ctx);
    addProjectMember(otherProject.id, worker.id, ctx);
    const otherChat = chats.createDirectChat(otherProject.id, worker.id, ctx).chat;
    assistant.createAssistantProposal(
      source,
      { ...target, projectId: otherProject.id, chatId: otherChat.id },
      "Private target decision",
      instant,
    );
    sqlite.prepare("UPDATE project SET created_by='revoked' WHERE id=?").run(otherProject.id);
    const last = chats.sendMessage(
      sourceChat.id,
      { senderKind: "human", senderId: ctx.userId, body: "After access revocation" },
      ctx,
    );
    expect(
      assistant.prepareAssistantSteerContext(source.run.id, last.id, ctx).serializedText,
    ).not.toContain("Private target decision");
    expect(() =>
      assistant.prepareAssistantSteerContext(source.run.id, last.id, { ...ctx, userId: "revoked" }),
    ).toThrow();
    sqlite.prepare("UPDATE agent_run SET config_snapshot='{}' WHERE id=?").run(source.run.id);
    runs.completeAgentRun(source.run.id, "Done", "stop", ctx);
    const carried = sqlite
      .prepare(
        "SELECT run_id,assistant_context,assistant_context_submitted_at FROM agent_run_input WHERE message_id=?",
      )
      .get(last.id) as {
      run_id: string;
      assistant_context: string | null;
      assistant_context_submitted_at: number | null;
    };
    expect(carried.run_id).not.toBe(source.run.id);
    expect(carried.assistant_context).toBeNull();
    expect(carried.assistant_context_submitted_at).toBeNull();
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
  it("keeps proposal clock/results immediate without duplicate watch reports, and watches later short runs by window", () => {
    const now = new Date();
    const source = activeHelper();
    const proposal = assistant.createAssistantProposal(
      source,
      { kind: "dm_agent", projectId: project.id, chatId: work.id, agentProfileId: worker.id },
      "Watched work",
      now,
    );
    const receipt = assistant.confirmAssistantProposal(proposal.proposalId, dm.id, ctx, now);
    observer.setAssistantWatch(dm.id, project.id, work.id, true, ctx, now, 60);
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
    expect(
      sqlite
        .prepare(
          "SELECT next_due_at FROM assistant_run_cursor WHERE run_id=? AND assistant_chat_id=?",
        )
        .get(input.run_id, dm.id),
    ).toEqual({ next_due_at: now.getTime() + 60000 });
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
    const notices = chats
      .listMessages(dm.id, ctx)
      .filter(
        (row) =>
          row.senderKind === "assistant_event" &&
          row.nativeSource.summary?.includes("当前Unchanged real action"),
      );
    expect(
      notices.map((row) => row.senderKind === "assistant_event" && row.nativeSource.summary),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("已进行 30 秒"),
        expect.stringContaining("已进行 1 分钟"),
      ]),
    );
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
    ).toHaveLength(0);
    observer.sampleAssistantRuns(new Date(now.getTime() + 240000));
    const digest = sqlite
      .prepare(
        "SELECT fact FROM assistant_event WHERE assistant_chat_id=? AND json_extract(fact,'$.watchId') IS NOT NULL",
      )
      .all(dm.id) as { fact: string }[];
    expect(digest).toHaveLength(1);
    expect(digest[0].fact).toContain("New short run");
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
    const now = new Date();
    for (const sourceId of [dm.id, second.id]) {
      observer.setAssistantWatch(sourceId, project.id, target.id, true, ctx, now, 60);
    }
    chats.sendMessage(
      target.id,
      { senderKind: "human", senderId: ctx.userId, body: "Watched" },
      ctx,
    );
    const run = runs.listAgentRuns(target.id, ctx)[0];
    const due = sqlite
      .prepare(
        "SELECT c.next_due_at FROM assistant_watch_cursor c JOIN assistant_watch w ON w.id=c.watch_id WHERE w.assistant_chat_id=? AND w.target_chat_id=? AND w.revoked_at IS NULL",
      )
      .get(dm.id, target.id) as { next_due_at: number };
    const time = new Date(due.next_due_at);
    expect(() =>
      observer.sampleAssistantRuns(time, () => {
        throw Object.assign(new Error("db transient"), { code: "SQLITE_BUSY" });
      }),
    ).toThrow("db transient");
    expect(
      sqlite
        .prepare(
          "SELECT c.next_due_at FROM assistant_watch_cursor c JOIN assistant_watch w ON w.id=c.watch_id WHERE w.assistant_chat_id=? AND w.target_chat_id=? AND w.revoked_at IS NULL",
        )
        .get(dm.id, target.id),
    ).toEqual(due);
    const sampledAt = new Date(time.getTime() + 1000);
    observer.sampleAssistantRuns(sampledAt, () => undefined);
    for (const sourceId of [dm.id, second.id])
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS n FROM assistant_event WHERE assistant_chat_id=? AND json_extract(fact,'$.targetChatId')=? AND json_extract(fact,'$.watchId') IS NOT NULL AND message_id IS NOT NULL",
          )
          .get(sourceId, target.id),
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
  it("enrolls existing and newly allocated Group runs for every worker and coalesces terminal results at the window deadline", () => {
    const now = new Date();
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
      now,
    );
    const watch = observer.setAssistantWatch(dm.id, project.id, group.id, true, ctx, now, 60);
    const short = runs.allocateContinuationRun(
      { projectId: project.id, chatId: group.id, instanceId: secondInstance.id },
      ctx.requestId,
      new Date(now.getTime() + 1000),
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
    sqlite
      .prepare("UPDATE agent_run SET settled_at=? WHERE id IN (?,?)")
      .run(Math.floor(now.getTime() / 1000) + 2, existing.id, short.id);
    observer.sampleAssistantRuns(new Date(now.getTime() + 1000));
    const digests = () =>
      sqlite
        .prepare(
          "SELECT fact,message_id FROM assistant_event WHERE assistant_chat_id=? AND json_extract(fact,'$.watchId')=?",
        )
        .all(dm.id, watch.watchId) as { fact: string; message_id: string }[];
    expect(digests()).toEqual([]);
    observer.sampleAssistantRuns(new Date(now.getTime() + 60000));
    expect(digests()).toHaveLength(1);
    expect(digests()[0].message_id).toEqual(expect.any(String));
    for (const run of [existing, short])
      expect(JSON.parse(digests()[0].fact).digest.runIds).toContain(run.id);
    expect(
      sqlite.prepare("SELECT revoked_at FROM assistant_watch WHERE id=?").get(watch.watchId),
    ).toEqual({ revoked_at: null });
  });
  it("allows Human watch revocation after the target DM is archived", () => {
    const lane = createProject({ name: "Archived watch target" }, ctx);
    const targetWorker = createAgentProfile({ name: "Archived watched worker" }, ctx);
    addProjectMember(lane.id, helper.id, ctx);
    addProjectMember(lane.id, targetWorker.id, ctx);
    const source = chats.createDirectChat(lane.id, helper.id, ctx).chat;
    const target = chats.createDirectChat(lane.id, targetWorker.id, ctx).chat;
    const watch = observer.setAssistantWatch(source.id, lane.id, target.id, true, ctx, instant);
    removeProjectMember(lane.id, targetWorker.id, ctx);
    expect(chats.getChat(target.id, ctx).archivedAt).not.toBeNull();
    expect(
      observer.setAssistantWatch(source.id, lane.id, target.id, false, ctx, instant),
    ).toMatchObject({
      active: false,
    });
    expect(
      observer.setAssistantWatch(source.id, lane.id, target.id, false, ctx, instant),
    ).toMatchObject({
      active: false,
    });
    expect(
      sqlite.prepare("SELECT revoked_at FROM assistant_watch WHERE id=?").get(watch.watchId),
    ).toMatchObject({ revoked_at: expect.any(Number) });
    addProjectMember(lane.id, targetWorker.id, ctx);
    chats.sendMessage(
      target.id,
      { senderKind: "human", senderId: ctx.userId, body: "Later work" },
      ctx,
    );
    expect(
      sqlite
        .prepare("SELECT count(*) AS n FROM assistant_interest WHERE origin_id=?")
        .get(watch.watchId),
    ).toEqual({ n: 0 });
  });
  it("advances the bounded undelivered scan past revoked sources without blocking another DM", () => {
    const lane = createProject({ name: "Observer scan progress" }, ctx);
    const staleHelper = createAgentProfile({ name: "Revoked source", purpose: "assistant" }, ctx);
    const freshHelper = createAgentProfile({ name: "Valid source", purpose: "assistant" }, ctx);
    const targetWorker = createAgentProfile({ name: "Queued scan worker" }, ctx);
    for (const profile of [staleHelper, freshHelper, targetWorker])
      addProjectMember(lane.id, profile.id, ctx);
    const stale = chats.createDirectChat(lane.id, staleHelper.id, ctx).chat;
    const fresh = chats.createDirectChat(lane.id, freshHelper.id, ctx).chat;
    const target = chats.createDirectChat(lane.id, targetWorker.id, ctx).chat;
    const stalePrincipal = activeHelper(stale.id);
    const freshPrincipal = activeHelper(fresh.id);
    const action = {
      kind: "dm_agent" as const,
      projectId: lane.id,
      chatId: target.id,
      agentProfileId: targetWorker.id,
    };
    for (let index = 0; index < 100; index++) {
      const proposal = proposalRecord(
        stalePrincipal,
        action,
        `Queued stale work ${index}`,
        instant,
      );
      assistant.confirmAssistantProposal(proposal.id, stale.id, ctx, instant);
    }
    const proposal = proposalRecord(freshPrincipal, action, "Queued valid work", instant);
    assistant.confirmAssistantProposal(proposal.id, fresh.id, ctx, instant);
    for (const run of runs.listAgentRuns(target.id, ctx))
      if (["queued", "running"].includes(run.status))
        runs.settleAgentRun(run.id, { status: "aborted" }, ctx);
    runs.settleAgentRun(stalePrincipal.run.id, { status: "aborted" }, ctx);
    removeProjectMember(lane.id, staleHelper.id, ctx);
    observer.sampleAssistantRuns(new Date(instant.getTime() + 1000));
    observer.sampleAssistantRuns(new Date(instant.getTime() + 2000));
    const outcome = sqlite
      .prepare(
        "SELECT message_id,suppressed_at FROM assistant_event WHERE assistant_chat_id=? AND event_key=?",
      )
      .get(fresh.id, `proposal:${proposal.id}:undelivered`);
    expect(outcome).toMatchObject({ message_id: expect.any(String), suppressed_at: null });
    expect(
      sqlite
        .prepare(
          "SELECT count(*) AS n FROM assistant_event WHERE assistant_chat_id=? AND event_key LIKE '%:undelivered' AND suppressed_at IS NOT NULL AND message_id IS NULL",
        )
        .get(stale.id),
    ).toEqual({ n: 100 });
  });
  it("keeps a queued notice factual after the worker later starts", () => {
    const now = new Date();
    const profile = createAgentProfile({ name: "Queued worker" }, ctx);
    addProjectMember(project.id, profile.id, ctx);
    const target = chats.createDirectChat(project.id, profile.id, ctx).chat;
    observer.setAssistantWatch(dm.id, project.id, target.id, true, ctx, now, 60);
    chats.sendMessage(
      target.id,
      { senderKind: "human", senderId: ctx.userId, body: "Queued work" },
      ctx,
    );
    const run = runs.listAgentRuns(target.id, ctx)[0];
    observer.sampleAssistantRuns(new Date(now.getTime() + 61000), () => undefined);
    const notice = () =>
      chats
        .listMessages(dm.id, ctx)
        .find((row) => row.senderKind === "assistant_event" && row.body.includes("Queued work"));
    const before = notice();
    expect(before?.body).toContain("Queued work");
    sqlite
      .prepare("UPDATE agent_run SET status='running',started_at=? WHERE id=?")
      .run(Math.floor(now.getTime() / 1000) + 90, run.id);
    expect(notice()).toEqual(before);
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
