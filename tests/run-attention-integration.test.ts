import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

const scratch = mkdtempSync(join(tmpdir(), "sprout-run-attention-"));
const startedAt = new Date("2026-11-11T00:00:00Z");
let now = startedAt;
let sqlite: typeof import("../src/db").sqlite;
let profiles: typeof import("../src/domain/agent");
let chats: typeof import("../src/domain/chat");
let attention: typeof import("../src/domain/run-attention");
let runs: typeof import("../src/domain/agent-run");
let projects: typeof import("../src/domain/project");
let newId: typeof import("../src/contracts/ids").newId;
let prefixes: typeof import("../src/contracts/ids").ID_PREFIXES;
let groupSchema: typeof import("../src/contracts/chat").createGroupChatInput;
let createScheduler: typeof import("../src/server/continuation-scheduler").createContinuationScheduler;

beforeAll(async () => {
  process.env.DATABASE_URL = join(scratch, "test.db");
  process.env.SPROUT_DATA_DIR = join(scratch, "data");
  process.env.SPROUT_PI_DATA_DIR = join(scratch, "pi");
  process.env.SPROUT_CONTINUATION_ENABLED = "false";
  process.env.SPROUT_PI_ENABLED = "false";
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
  const { migrateDatabase } = await import("../src/db/migrate");
  migrateDatabase();
  ({ sqlite } = await import("../src/db"));
  ({ newId, ID_PREFIXES: prefixes } = await import("../src/contracts/ids"));
  ({ createGroupChatInput: groupSchema } = await import("../src/contracts/chat"));
  projects = await import("../src/domain/project");
  profiles = await import("../src/domain/agent");
  chats = await import("../src/domain/chat");
  runs = await import("../src/domain/agent-run");
  attention = await import("../src/domain/run-attention");
  ({ createContinuationScheduler: createScheduler } =
    await import("../src/server/continuation-scheduler"));
});
afterEach(() => {
  expect(sqlite.prepare("SELECT count(*) AS n FROM wake_evaluation").get()).toEqual({ n: 0 });
  expect(sqlite.prepare("SELECT count(*) AS n FROM continuation_delivery").get()).toEqual({ n: 0 });
});
afterAll(() => {
  sqlite?.close();
  rmSync(scratch, { recursive: true, force: true });
});

function seed(tag: string, owner: "human" | "self" | "agent" = "agent") {
  const human = `human-${tag}`;
  sqlite
    .prepare(
      'INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,1,?,?)',
    )
    .run(human, tag, `${tag}@test.local`, Date.now(), Date.now());
  const ctx = { userId: human, requestId: newId(prefixes.request) };
  const project = projects.createProject({ name: tag }, ctx);
  const agent = profiles.createAgentProfile(
    { name: `worker-${tag}`, persona: "work", harness: "pi" },
    ctx,
  );
  const manager = profiles.createAgentProfile(
    { name: `owner-${tag}`, persona: "manage", harness: "pi" },
    ctx,
  );
  for (const profile of [agent, manager]) profiles.addProjectMember(project.id, profile.id, ctx);
  const group = chats.createGroupChat(
    project.id,
    groupSchema.parse({
      projectId: project.id,
      title: tag,
      initialOwner: {
        kind: owner === "human" ? "human" : "agent",
        id: owner === "human" ? human : owner === "self" ? agent.id : manager.id,
      },
      members: [
        { kind: "human", id: human },
        { kind: "agent", id: agent.id },
        { kind: "agent", id: manager.id },
      ],
    }),
    { kind: "human", userId: human, ctx },
  );
  const instance = chats.ensureInstance(group.id, agent.id, ctx);
  const run = { id: newId(prefixes.run) };
  // A running row from before migration is lazily snapshotted by the real scheduler.
  sqlite
    .prepare(
      "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,started_at,session_id) VALUES (?,?,?,?,?,'running',?,?)",
    )
    .run(
      run.id,
      instance.id,
      group.id,
      project.id,
      ctx.requestId,
      startedAt.getTime() / 1000,
      randomBytes(16).toString("hex"),
    );
  return { human, project, ctx, agent, manager, group, instance, run };
}
function row(id: string) {
  return sqlite.prepare("SELECT * FROM agent_run WHERE id=?").get(id) as Record<string, unknown>;
}
function notices(chatId: string) {
  return sqlite
    .prepare(
      "SELECT id,body FROM message WHERE chat_id=? AND sender_id='sprout.run-attention' ORDER BY rowid",
    )
    .all(chatId) as { id: string; body: string }[];
}
async function advance(ms: number) {
  now = new Date(startedAt.getTime() + ms);
  const scheduler = createScheduler({
    clock: { now: () => now, setTimeout: () => 0, clearTimeout() {} },
    onError() {},
    evaluateWake: async () => {
      throw new Error("continuation must remain disabled");
    },
  });
  scheduler.start();
  try {
    await scheduler.advance();
  } finally {
    scheduler.stop();
  }
}
function finish(id: string) {
  sqlite
    .prepare("UPDATE agent_run SET status='aborted',settled_at=? WHERE id=?")
    .run(now.getTime() / 1000, id);
}

describe("run attention through continuation scheduler", () => {
  it("leaves a slow run alive after the old 600000ms deadline, wakes another owner once at 30m and escalates once at 60m", async () => {
    const f = seed("other-owner");
    await advance(600_001);
    expect(row(f.run.id).status).toBe("running");
    expect(notices(f.group.id)).toHaveLength(0);
    expect(attention.nextRunAttentionDueAt()).toBe(startedAt.getTime() + 1_800_000);
    await advance(1_800_000);
    const marked = row(f.run.id);
    expect(marked.attention_at).toBe(now.getTime());
    expect(marked.human_required_at).toBeNull();
    const ownerMessage = notices(f.group.id)[0]!;
    expect(notices(f.group.id)).toHaveLength(1);
    const attached = sqlite
      .prepare(
        "SELECT r.id,r.status,i.agent_profile_id FROM agent_run_input input JOIN agent_run r ON r.id=input.run_id JOIN agent_instance i ON i.id=r.instance_id WHERE input.message_id=?",
      )
      .get(ownerMessage.id) as { id: string; status: string; agent_profile_id: string };
    expect(attached.agent_profile_id).toBe(f.manager.id);
    expect(attached.status).toBe("queued");
    await advance(1_800_000);
    expect(notices(f.group.id)).toHaveLength(1);
    expect(
      sqlite
        .prepare("SELECT count(*) n FROM agent_run_input WHERE message_id=?")
        .get(ownerMessage.id),
    ).toEqual({ n: 1 });
    await advance(3_600_000);
    expect(notices(f.group.id)).toHaveLength(2);
    expect(row(f.run.id)).toMatchObject({
      status: "running",
      human_notified_at: now.getTime(),
      attention_notice_next_at: null,
    });
    await advance(4_000_000);
    expect(notices(f.group.id)).toHaveLength(2);
    console.log("EVIDENCE owner", {
      startedAt: startedAt.toISOString(),
      attentionAt: new Date(Number(marked.attention_at)).toISOString(),
      ownerMessageId: ownerMessage.id,
      ownerRunId: attached.id,
      humanMessageId: notices(f.group.id)[1]!.id,
      continuedRunningAtMs: 600001,
    });
    finish(f.run.id);
  });

  it("keeps the chat human owner in the notice recipient set, not only the project creator", async () => {
    const f = seed("recipient-union", "human");
    const second = `human-${Date.now()}-second`;
    sqlite
      .prepare(
        'INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,1,?,?)',
      )
      .run(second, "second", `${second}@test.local`, Date.now(), Date.now());
    sqlite
      .prepare(
        "INSERT INTO chat_member (chat_id,member_kind,member_id,added_at) VALUES (?,'human',?,?)",
      )
      .run(f.group.id, second, startedAt.getTime() / 1000);
    sqlite.prepare("UPDATE chat SET owner_id=? WHERE id=?").run(second, f.group.id);
    await advance(3_600_000);
    const body = notices(f.group.id)[0]!.body;
    expect(body).toContain("面向人类：");
    expect(body).toContain(second);
    expect(body).toContain(f.human);
    console.log("EVIDENCE recipient-union", { recipientsLine: /面向人类：[^。]*/.exec(body)?.[0] });
    finish(f.run.id);
  });

  it.each(["human", "self"] as const)(
    "%s owner records human-required at 30m without an early message or self input",
    async (owner) => {
      const f = seed(`${owner}-owner`, owner);
      await advance(1_800_000);
      expect(row(f.run.id)).toMatchObject({
        attention_at: now.getTime(),
        human_required_at: now.getTime(),
        human_notified_at: null,
        attention_notice_next_at: null,
      });
      expect(notices(f.group.id)).toHaveLength(0);
      expect(attention.nextRunAttentionDueAt()).toBe(startedAt.getTime() + 3_600_000);
      expect(runs.getAgentRun(f.run.id, f.ctx).attention?.awaitingHandling).toBe(true);
      await advance(3_600_000);
      expect(notices(f.group.id)).toHaveLength(1);
      expect(
        sqlite.prepare("SELECT count(*) n FROM agent_run_input WHERE run_id=?").get(f.run.id),
      ).toEqual({ n: 0 });
      expect(row(f.run.id).human_notified_at).toBe(now.getTime());
      console.log(`EVIDENCE ${owner}`, {
        messagesAt30m: 0,
        messagesAt60m: 1,
        humanMessageId: notices(f.group.id)[0]!.id,
      });
      finish(f.run.id);
      expect(runs.getAgentRun(f.run.id, f.ctx).attention?.awaitingHandling).toBe(false);
      expect(attention.nextRunAttentionDueAt()).toBeNull();
    },
  );

  it("a late first sweep goes directly to one human notice; completion suppresses later reminders", async () => {
    const late = seed("late");
    await advance(3_900_000);
    expect(notices(late.group.id)).toHaveLength(1);
    expect(row(late.run.id).attention_message_id).toBeNull();
    expect(row(late.run.id).human_notified_at).toBe(now.getTime());
    finish(late.run.id);
    const done = seed("done", "human");
    await advance(1_800_000);
    finish(done.run.id);
    await advance(3_600_000);
    expect(notices(done.group.id)).toHaveLength(0);
  });

  it("rolls back message and facts together and retries the same message after a post-commit failure", async () => {
    const f = seed("rollback");
    sqlite.exec(
      "CREATE TRIGGER reject_attention BEFORE UPDATE OF attention_at ON agent_run WHEN NEW.attention_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected attention failure'); END",
    );
    await expect(advance(1_800_000)).rejects.toThrow("injected attention failure");
    expect(notices(f.group.id)).toHaveLength(0);
    expect(row(f.run.id).attention_at).toBeNull();
    sqlite.exec("DROP TRIGGER reject_attention");
    sqlite.exec(
      "CREATE TRIGGER reject_owner_input BEFORE INSERT ON agent_run_input BEGIN SELECT RAISE(ABORT,'injected input failure'); END",
    );
    await advance(1_800_000);
    const messageId = notices(f.group.id)[0]!.id;
    const retryAt = Number(row(f.run.id).attention_notice_next_at);
    expect(retryAt).toBeGreaterThan(now.getTime());
    sqlite.exec("DROP TRIGGER reject_owner_input");
    await advance(retryAt - startedAt.getTime());
    expect(notices(f.group.id)).toHaveLength(1);
    expect(row(f.run.id).attention_notice_next_at).toBeNull();
    expect(
      sqlite.prepare("SELECT count(*) n FROM agent_run_input WHERE message_id=?").get(messageId),
    ).toEqual({ n: 1 });
    finish(f.run.id);
  });

  it("freezes the policy and original owner, rejects retargeting, and keeps human deadline independent of retry", async () => {
    const f = seed("owner-changed");
    sqlite.exec(
      "CREATE TRIGGER reject_owner_input BEFORE INSERT ON agent_run_input BEGIN SELECT RAISE(ABORT,'injected input failure'); END",
    );
    await advance(1_800_000);
    sqlite.exec("DROP TRIGGER reject_owner_input");
    sqlite.prepare("UPDATE chat SET owner_id=? WHERE id=?").run(f.agent.id, f.group.id);
    sqlite.prepare("UPDATE project SET wake_policy=? WHERE id=?").run(
      JSON.stringify({
        provider: "llm",
        configRevision: 1,
        thresholdVersion: "v1",
        runAttention: { timeoutMs: 1000, escalationMs: 1000 },
      }),
      f.project.id,
    );
    await advance(1_900_000);
    expect(row(f.run.id).attention_notice_next_at).toBeNull();
    expect(row(f.run.id).human_notified_at).toBeNull();
    expect(runs.getAgentRun(f.run.id, f.ctx).attention?.humanReminderAt).toBe(
      "2026-11-11T01:00:00.000Z",
    );
    await advance(3_600_000);
    expect(notices(f.group.id)).toHaveLength(2);
    finish(f.run.id);
  });

  it("arms exact attention and human deadlines while continuation is globally off", async () => {
    const f = seed("rearm", "human");
    now = startedAt;
    const timers = new Map<number, { fn: () => void; delay: number }>();
    let seq = 0;
    const scheduler = createScheduler({
      clock: {
        now: () => now,
        setTimeout(fn, delay) {
          const id = ++seq;
          timers.set(id, { fn, delay });
          return id;
        },
        clearTimeout(id) {
          timers.delete(id as number);
        },
      },
    });
    scheduler.start();
    expect([...timers.values()].map((t) => t.delay)).toContain(1_800_000);
    await advance(1_800_000);
    // schedule-change rearming is a microtask.
    await Promise.resolve();
    expect([...timers.values()].some((t) => t.delay === 1_800_000)).toBe(true);
    scheduler.stop();
    expect(timers.size).toBe(0);
    finish(f.run.id);
  });
});
