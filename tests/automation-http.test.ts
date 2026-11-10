import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "webhook-http-"));
process.env.DATABASE_URL = join(directory, "http.sqlite");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../src/db");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const { createDirectChat } = await import("../src/domain/chat");
const automation = await import("../src/domain/automation");
const { webhookPost } = await import("../src/server/webhook-ingress");
const ctx = { userId: "http-human", requestId: "webhook-http-test" };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(ctx.userId, "Human", "http@test.example");
const project = createProject({ name: "HTTP project" }, ctx);
const agent = createAgentProfile({ name: "HookAgent", persona: "", harness: "pi" }, ctx);
addProjectMember(project.id, agent.id, ctx);
const dm = createDirectChat(project.id, agent.id, ctx);
const created = automation.createWebhookRule(
  {
    projectId: project.id,
    name: "HTTP rule",
    instruction: "Handle event",
    enabled: true,
    action: { kind: "dm_agent", chatId: dm.chat.id, agentProfileId: agent.id },
  },
  ctx,
  "https://sprout.test",
);
const headers = {
  authorization: `Bearer ${created.secret}`,
  "content-type": "application/json",
  "x-sprout-event-id": "http-event",
};
function request(body = "{}", override: Record<string, string> = {}) {
  return new Request(created.rule.endpoint, {
    method: "POST",
    headers: { ...headers, ...override },
    body,
  });
}
const post = (req: Request, ruleId = created.rule.id) => webhookPost(req, ruleId);
const count = () =>
  sqlite.prepare("SELECT count(*) AS n FROM webhook_trigger").get() as { n: number };
afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("external HTTP ingress with real admission", () => {
  it("rejects credentials before accessing the body and commits no trigger", async () => {
    for (const [ruleId, authorization, status] of [
      [created.rule.id, "Bearer bad", 401],
      [created.rule.id, `Bearer ${"x".repeat(43)}`, 401],
      ["bad-id", headers.authorization, 404],
    ] as const) {
      const req = request("{}", { authorization });
      Object.defineProperty(req, "body", {
        get() {
          throw new Error("unauthorized body accessed");
        },
      });
      expect((await post(req, ruleId)).status).toBe(status);
    }
    expect(count().n).toBe(0);
  });
  it("validates event headers, media type, malformed JSON, UTF-8 and object shape", async () => {
    for (const [body, override, status] of [
      ["{}", { "x-sprout-event-id": "" }, 400],
      ["{}", { "x-sprout-event-id": "x".repeat(201) }, 400],
      ["{}", { "content-type": "text/plain" }, 415],
      ["{", {}, 400],
      ["[]", {}, 400],
      ["null", {}, 400],
    ] as [string, Record<string, string>, number][]) {
      expect((await post(request(body, override))).status).toBe(status);
    }
    expect(
      (
        await post(
          new Request(created.rule.endpoint, {
            method: "POST",
            headers,
            body: new Uint8Array([0xff]),
          }),
        )
      ).status,
    ).toBe(400);
    expect(count().n).toBe(0);
  });
  it("limits actual streamed bytes without trusting content-length", async () => {
    let cancelled = false;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          sent++;
          controller.enqueue(new Uint8Array(32769));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const req = new Request(created.rule.endpoint, {
      method: "POST",
      headers,
      body,
      duplex: "half",
    } as RequestInit);
    expect((await post(req)).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(sent).toBe(2);
    expect((await post(request("{}", { "content-length": "65537" }))).status).toBe(413);
    expect(count().n).toBe(0);
  });
  it("accepts once, replays canonical JSON and conflicts on changed payload", async () => {
    const first = await post(request('{"b":2,"a":1}'));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const receipt = await first.json();
    expect(receipt.decision).toBe("accepted");
    const replay = await post(request('{ "a":1, "b":2 }'));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    expect((await post(request('{"a":9}'))).status).toBe(409);
    expect(count().n).toBe(1);
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM message WHERE sender_kind='automation'").get(),
    ).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM agent_run_input").get()).toEqual({ n: 1 });
  });
  it("rechecks current rule state after body ingestion", async () => {
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const {
            id,
            revision,
            endpoint: _endpoint,
            createdAt: _createdAt,
            updatedAt: _updatedAt,
            ...draft
          } = created.rule;
          automation.updateWebhookRule(
            { ...draft, ruleId: id, expectedRevision: revision, enabled: false },
            ctx,
            "https://sprout.test",
          );
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const req = new Request(created.rule.endpoint, {
      method: "POST",
      headers: { ...headers, "x-sprout-event-id": "disabled-during-read" },
      body,
      duplex: "half",
    } as RequestInit);
    const result = await post(req);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ decision: "skipped", reason: "rule_disabled" });
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM message WHERE sender_kind='automation'").get(),
    ).toEqual({ n: 1 });
  });
  it("shows the newest fifty receipts even when timestamps tie", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    try {
      for (let i = 0; i < 51; i++)
        expect((await post(request("{}", { "x-sprout-event-id": `history-${i}` }))).status).toBe(
          200,
        );
    } finally {
      vi.useRealTimers();
    }
    const history = automation.webhookHistory(created.rule.id, ctx);
    expect(history).toHaveLength(50);
    expect(history[0].eventId).toBe("history-50");
    expect(history.some((entry) => entry.eventId === "history-0")).toBe(false);
  });
});
