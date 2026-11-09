import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const directory = mkdtempSync(join(tmpdir(), "assistant-windows-"));
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
const { assistantCallSchema } = await import("../src/contracts/assistant");
const ctx = { userId: "window-human", requestId: "req_11111111" };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(ctx.userId, "Human", "windows@test.example");
const project = createProject({ name: "Window project" }, ctx);
const instant = new Date(Date.now() + 2000);
const at = (seconds: number) => new Date(instant.getTime() + seconds * 1000);
let sequence = 0;
function fixture() {
  const n = ++sequence;
  const helper = createAgentProfile({ name: `Helper ${n}`, purpose: "assistant" }, ctx);
  const worker = createAgentProfile({ name: `Worker ${n}` }, ctx);
  addProjectMember(project.id, helper.id, ctx);
  addProjectMember(project.id, worker.id, ctx);
  const dm = chats.createDirectChat(project.id, helper.id, ctx).chat;
  const target = chats.createDirectChat(project.id, worker.id, ctx).chat;
  chats.sendMessage(dm.id, { senderKind: "human", senderId: ctx.userId, body: "Watch" }, ctx);
  const run = runs.listAgentRuns(dm.id, ctx)[0];
  sqlite
    .prepare("UPDATE agent_run SET status='running',started_at=? WHERE id=?")
    .run(instant.getTime() / 1000, run.id);
  const call = (active?: boolean) =>
    assistant.dispatchAssistantCall(
      run.id,
      ctx.userId,
      ctx.requestId,
      {
        type: "assistant_watch",
        input: {
          projectId: project.id,
          targetProjectId: project.id,
          chatId: target.id,
          intervalSeconds: 60,
          ...(active === undefined ? {} : { active }),
        },
      },
      () => null,
    );
  const events = () =>
    sqlite
      .prepare(
        "SELECT fact,message_id FROM assistant_event WHERE assistant_chat_id=? AND json_extract(fact,'$.kind')!='decision'",
      )
      .all(dm.id) as { fact: string; message_id: string | null }[];
  const say = (body: string, seconds: number, terminal = true) => {
    const msg = chats.sendMessage(
      target.id,
      { senderKind: "human", senderId: ctx.userId, body },
      ctx,
    );
    const { run_id } = sqlite
      .prepare("SELECT run_id FROM agent_run_input WHERE message_id=?")
      .get(msg.id) as { run_id: string };
    const run = runs.getAgentRun(run_id, ctx);
    sqlite
      .prepare("UPDATE message SET created_at=? WHERE id=?")
      .run(Math.floor(at(seconds).getTime() / 1000), msg.id);
    sqlite
      .prepare("UPDATE agent_run SET queued_at=?,status=?,settled_at=?,started_at=? WHERE id=?")
      .run(
        Math.floor(at(seconds).getTime() / 1000),
        terminal ? "aborted" : "running",
        terminal ? Math.floor(at(seconds + 1).getTime() / 1000) : null,
        Math.floor(at(seconds).getTime() / 1000),
        run.id,
      );
    return { msg, run };
  };
  return { dm, target, worker, call, events, say };
}
afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});
describe("Chat watch digest windows", () => {
  it("waits 60s for multiple messages/terminal runs, persists one content digest and continues across windows", () => {
    const f = fixture();
    f.say("Historical content must stay out", -10);
    observer.setAssistantWatch(f.dm.id, project.id, f.target.id, true, ctx, instant, 60);
    f.say("Investigate the upload timeout", 5);
    f.say("The retry limit should be three", 20);
    observer.sampleAssistantRuns(at(59));
    expect(f.events()).toEqual([]);
    observer.sampleAssistantRuns(at(60));
    expect(f.events()).toHaveLength(1);
    expect(f.events()[0].message_id).not.toBeNull();
    expect(f.events()[0].fact).toContain("Investigate the upload timeout");
    expect(f.events()[0].fact).toContain("retry limit should be three");
    expect(f.events()[0].fact).not.toContain("Historical content");
    observer.sampleAssistantRuns(at(60));
    const restarted = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const {sampleAssistantRuns}=await import('./src/domain/assistant-observer.ts'); sampleAssistantRuns(new Date('${at(60).toISOString()}'));`,
      ],
      { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 60000 },
    );
    expect({ status: restarted.status, stderr: restarted.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    observer.sampleAssistantRuns(at(120));
    expect(f.events()).toHaveLength(1);
    f.say("Added timeout diagnostic details", 125);
    observer.sampleAssistantRuns(at(179));
    expect(f.events()).toHaveLength(1);
    observer.sampleAssistantRuns(at(180));
    expect(f.events()).toHaveLength(2);
    expect(f.events()[1].fact).toContain("timeout diagnostic details");
  });
  it("captures message-free terminal activity in the same SQLite timestamp second as consent exactly once", () => {
    const f = fixture();
    observer.setAssistantWatch(f.dm.id, project.id, f.target.id, true, ctx, instant, 60);
    const instance = sqlite
      .prepare("SELECT id FROM agent_instance WHERE chat_id=?")
      .get(f.target.id) as { id: string };
    const run = runs.allocateContinuationRun(
      { projectId: project.id, chatId: f.target.id, instanceId: instance.id },
      ctx.requestId,
      instant,
    );
    sqlite
      .prepare(
        "UPDATE agent_run SET queued_at=?,status='aborted',started_at=?,settled_at=?,activity=? WHERE id=?",
      )
      .run(
        ...Array(3).fill(Math.floor(instant.getTime() / 1000)),
        JSON.stringify({
          current: null,
          entries: [
            {
              id: "same-second",
              kind: "tool",
              label: "Inspected upload logs",
              startedAt: instant.toISOString(),
              finishedAt: instant.toISOString(),
              status: "success",
            },
          ],
          updatedAt: instant.toISOString(),
        }),
        run.id,
      );
    observer.sampleAssistantRuns(at(59));
    expect(f.events()).toEqual([]);
    observer.sampleAssistantRuns(at(60));
    expect(f.events()).toHaveLength(1);
    expect(f.events()[0].fact).toContain("Inspected upload logs");
    observer.sampleAssistantRuns(at(120));
    expect(f.events()).toHaveLength(1);
  });
  it("finds new activity beyond a page of unchanged active runs", () => {
    const f = fixture();
    const target = chats.listChats(project.id, ctx).find((chat) => chat.kind === "public_channel")!;
    const watch = observer.setAssistantWatch(
      f.dm.id,
      project.id,
      target.id,
      true,
      ctx,
      instant,
      60,
    );
    const profiles = [f.worker];
    for (let i = 0; i < 50; i++) {
      const profile = createAgentProfile({ name: `Page worker ${sequence}-${i}` }, ctx);
      addProjectMember(project.id, profile.id, ctx);
      profiles.push(profile);
    }
    const observedRuns = profiles.map((profile, index) => {
      const instance = chats.ensureInstance(target.id, profile.id, ctx);
      const run = runs.allocateContinuationRun(
        { projectId: project.id, chatId: target.id, instanceId: instance.id },
        ctx.requestId,
        at(2),
      );
      sqlite
        .prepare("UPDATE agent_run SET status='running',started_at=? WHERE id=?")
        .run(Math.floor(at(index === 50 ? 40 : 1).getTime() / 1000), run.id);
      return run;
    });
    sqlite
      .prepare("UPDATE assistant_watch_cursor SET window_started_at=? WHERE watch_id=?")
      .run(at(30).getTime(), watch.watchId);
    observer.sampleAssistantRuns(at(60));
    const events = f.events();
    expect(events).toHaveLength(1);
    const fact = JSON.parse(events[0].fact);
    expect(fact.digest.runIds).toEqual([observedRuns[50].id]);
    expect(fact.digest.truncated).toBe(false);
  });
  it("includes ordinary Agent content and reschedules the same consent without replaying history", () => {
    const f = fixture();
    const watch = observer.setAssistantWatch(
      f.dm.id,
      project.id,
      f.target.id,
      true,
      ctx,
      instant,
      60,
    );
    const { run } = f.say("Inspect timeout policy", 5, false);
    const reply = chats.sendMessage(
      f.target.id,
      {
        senderKind: "agent",
        senderId: f.worker.id,
        body: "Timeout is configured at 30 seconds; retry handling still needs review",
      },
      { ...ctx, agent: { agentProfileId: f.worker.id, instanceId: run.instanceId, runId: run.id } },
    );
    sqlite
      .prepare("UPDATE message SET created_at=? WHERE id=?")
      .run(Math.floor(at(10).getTime() / 1000), reply.id);
    const updated = observer.setAssistantWatch(
      f.dm.id,
      project.id,
      f.target.id,
      true,
      ctx,
      at(20),
      120,
    );
    expect(updated.watchId).toBe(watch.watchId);
    expect(assistant.assistantPanel(f.dm.id, ctx).watches[0].consentedAt).toEqual(instant);
    observer.sampleAssistantRuns(at(60));
    expect(f.events()).toEqual([]);
    observer.sampleAssistantRuns(at(140));
    expect(f.events()).toHaveLength(1);
    expect(f.events()[0].fact).toContain("retry handling still needs review");
    expect(JSON.parse(f.events()[0].fact).digest.messageIds).toContain(reply.id);
    observer.sampleAssistantRuns(at(260));
    expect(f.events()).toHaveLength(1);
  });
  it("suppresses captured-but-undelivered digests and confirmation cards when stopped", () => {
    const f = fixture();
    const watch = observer.setAssistantWatch(
      f.dm.id,
      project.id,
      f.target.id,
      true,
      ctx,
      instant,
      60,
    );
    const target = {
      targetProjectId: project.id,
      targetChatId: f.target.id,
      sampledAt: at(1).toISOString(),
    };
    assistant.captureAssistantFact(
      f.dm.id,
      "pending-digest",
      { kind: "periodic", watchId: watch.watchId, ...target, body: "Captured progress" },
      at(1),
    );
    assistant.captureAssistantFact(
      f.dm.id,
      "pending-intent",
      {
        kind: "decision",
        watchIntent: true,
        intervalSeconds: 60,
        ...target,
        body: "Old confirmation",
      },
      at(1),
    );
    f.call(false);
    assistant.deliverAssistantEvents(at(2));
    expect(
      sqlite
        .prepare("SELECT message_id,suppressed_at FROM assistant_event WHERE assistant_chat_id=?")
        .all(f.dm.id),
    ).toEqual([
      { message_id: null, suppressed_at: at(2).getTime() },
      { message_id: null, suppressed_at: at(2).getTime() },
    ]);
    expect(assistant.assistantPanel(f.dm.id, ctx).decisions).toEqual([]);
  });
  it("tool stop is idempotent, suppresses digests and old intents, and permits a fresh Human confirmation", () => {
    const f = fixture();
    f.call();
    expect(
      assistant.assistantPanel(f.dm.id, ctx).decisions.filter((e) => e.fact.watchIntent),
    ).toHaveLength(1);
    observer.setAssistantWatch(f.dm.id, project.id, f.target.id, true, ctx, instant, 60);
    expect(
      assistant.assistantPanel(f.dm.id, ctx).decisions.filter((e) => e.fact.watchIntent),
    ).toHaveLength(0);
    f.say("Do not forward after stop", 5);
    expect(f.call(false)).toMatchObject({ active: false, action: "stopped", chatId: f.target.id });
    expect(f.call(false)).toMatchObject({ active: false, action: "stopped" });
    observer.sampleAssistantRuns(at(60));
    expect(f.events()).toEqual([]);
    expect(assistant.assistantPanel(f.dm.id, ctx).watches).toEqual([]);
    expect(
      assistant.assistantPanel(f.dm.id, ctx).decisions.filter((e) => e.fact.watchIntent),
    ).toEqual([]);
    f.call();
    expect(
      assistant.assistantPanel(f.dm.id, ctx).decisions.filter((e) => e.fact.watchIntent),
    ).toHaveLength(1);
    observer.setAssistantWatch(f.dm.id, project.id, f.target.id, true, ctx, at(61), 60);
    expect(assistant.assistantPanel(f.dm.id, ctx).watches).toHaveLength(1);
  });
  it("does not stop another DM or Human's watch, consumes pending-only intents, and rejects stale confirmation IDs", () => {
    const f = fixture();
    const second = fixture();
    observer.setAssistantWatch(second.dm.id, project.id, f.target.id, true, ctx, instant, 60);
    f.call();
    const old = assistant.assistantPanel(f.dm.id, ctx).decisions.find((e) => e.fact.watchIntent)!;
    f.call(false);
    expect(assistant.assistantPanel(second.dm.id, ctx).watches).toHaveLength(1);
    expect(
      sqlite.prepare("SELECT * FROM assistant_watch WHERE assistant_chat_id=?").all(f.dm.id),
    ).toEqual([]);
    expect(() =>
      observer.setAssistantWatch(f.dm.id, project.id, f.target.id, true, ctx, at(1), 60, old.id),
    ).toThrow("关注意图已处理");
    expect(() =>
      observer.setAssistantWatch(
        second.dm.id,
        project.id,
        f.target.id,
        false,
        { ...ctx, userId: "unrelated-human" },
        at(1),
      ),
    ).toThrow();
    f.call();
    const fresh = assistant.assistantPanel(f.dm.id, ctx).decisions.find((e) => e.fact.watchIntent)!;
    expect(fresh.id).not.toBe(old.id);
    observer.setAssistantWatch(f.dm.id, project.id, f.target.id, true, ctx, at(2), 60, fresh.id);
    observer.setAssistantWatch(f.dm.id, project.id, f.target.id, true, ctx, at(2), 60, fresh.id);
    expect(assistant.assistantPanel(f.dm.id, ctx).watches).toHaveLength(1);
    f.call(false);
    expect(() =>
      observer.setAssistantWatch(f.dm.id, project.id, f.target.id, true, ctx, at(3), 60, fresh.id),
    ).toThrow("关注意图已处理");
    expect(assistant.assistantPanel(second.dm.id, ctx).watches).toHaveLength(1);
  });
  it("bounds sampled content with traceable source IDs and does not replay the omitted remainder", () => {
    const f = fixture();
    observer.setAssistantWatch(f.dm.id, project.id, f.target.id, true, ctx, instant, 60);
    const insert = sqlite.prepare(
      "INSERT INTO message(id,chat_id,sender_kind,sender_id,body,created_at) VALUES (?,?,'human',?,?,?)",
    );
    for (let i = 0; i < 55; i++)
      insert.run(
        `bounded-${f.target.id}-${i}`,
        f.target.id,
        ctx.userId,
        `Upload diagnostic sample ${i}`,
        Math.floor(at(1).getTime() / 1000),
      );
    observer.sampleAssistantRuns(at(60));
    const digest = JSON.parse(f.events()[0].fact).digest;
    expect(digest.truncated).toBe(true);
    expect(digest.messageIds).toHaveLength(50);
    expect(f.events()[0].fact).toContain("Upload diagnostic sample");
    observer.sampleAssistantRuns(at(120));
    expect(f.events()).toHaveLength(1);
    expect(
      sqlite.prepare("SELECT count(*) n FROM message WHERE chat_id=?").get(f.target.id),
    ).toEqual({ n: 55 });
  });
  it("labels public channel watch confirmations and active watches without falling back to an Agent name", () => {
    const f = fixture();
    const channel = sqlite
      .prepare("SELECT id FROM chat WHERE project_id=? AND kind='public_channel'")
      .get(project.id) as { id: string };
    assistant.captureAssistantFact(
      f.dm.id,
      "public-watch",
      {
        kind: "decision",
        watchIntent: true,
        intervalSeconds: 60,
        targetProjectId: project.id,
        targetChatId: channel.id,
        sampledAt: instant.toISOString(),
        body: "关注公共频道",
      },
      instant,
    );
    const pending = assistant
      .assistantPanel(f.dm.id, ctx)
      .decisions.find((e) => e.fact.watchIntent)!;
    expect(pending.targetLabel).toBe("公共频道（Project 范围）");
    observer.setAssistantWatch(f.dm.id, project.id, channel.id, true, ctx, instant, 60, pending.id);
    expect(assistant.assistantPanel(f.dm.id, ctx).watches[0].targetLabel).toBe(pending.targetLabel);
  });
  it("parses stop without overloading intervalSeconds", () => {
    expect(
      assistantCallSchema.safeParse({
        type: "assistant_watch",
        input: {
          projectId: project.id,
          targetProjectId: project.id,
          chatId: "chat",
          active: false,
        },
      }).success,
    ).toBe(true);
    expect(
      assistantCallSchema.safeParse({
        type: "assistant_watch",
        input: {
          projectId: project.id,
          targetProjectId: project.id,
          chatId: "chat",
          intervalSeconds: 0,
        },
      }).success,
    ).toBe(false);
  });
});
