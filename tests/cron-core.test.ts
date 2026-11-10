import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { Effect } from "effect";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CronRule } from "../src/contracts/automation";
const directory = mkdtempSync(join(tmpdir(), "cron-core-"));
process.env.DATABASE_URL = join(directory, "core.sqlite");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../src/db");
const { newId, ID_PREFIXES } = await import("../src/contracts/ids");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const chats = await import("../src/domain/chat");
const automation = await import("../src/domain/automation");
const { automationSourceFor } = await import("../src/domain/automation-source");
const { admitAutomationInput } = await import("../src/domain/automation-input");
const ctx = { userId: "cron-human", requestId: newId(ID_PREFIXES.request) };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(ctx.userId, "Human", "cron@test.example");
const project = createProject({ name: "Cron project" }, ctx);
const agent = createAgentProfile({ name: "Agent", persona: "", harness: "pi" }, ctx);
addProjectMember(project.id, agent.id, ctx);
const at = (value: string) => new Date(`2026-11-08T${value}Z`);
function rule(expression = "* * * * *") {
  const chat = chats.createGroupChat(
    project.id,
    {
      projectId: project.id,
      title: "Cron",
      wakePolicy: "mention_only",
      initialOwner: { kind: "agent", id: agent.id },
      members: [
        { kind: "human", id: ctx.userId },
        { kind: "agent", id: agent.id },
      ],
    },
    { kind: "human", userId: ctx.userId, ctx },
  );
  return automation.createCronRule(
    {
      projectId: project.id,
      name: "Clock",
      enabled: true,
      instruction: "Check @Agent /skill:danger",
      action: { kind: "group_agent", chatId: chat.id, agentProfileId: agent.id },
      expression,
      timezone: "UTC",
    },
    ctx,
    at("12:00:00"),
  );
}
function update(
  current: CronRule,
  changes: Partial<Pick<CronRule, "enabled" | "expression" | "instruction">>,
  now = at("12:00:30"),
) {
  const {
    id,
    revision,
    nextAt: _next,
    createdAt: _created,
    updatedAt: _updated,
    ...draft
  } = current;
  return automation.updateCronRule(
    { ...draft, ...changes, ruleId: id, expectedRevision: revision },
    ctx,
    now,
  );
}
function trial(current: CronRule, eventId: string) {
  return automation.trialCron({ ruleId: current.id, eventId }, ctx, at("12:00:20"));
}
function inputFor(messageId: string) {
  return sqlite.prepare("SELECT * FROM agent_run_input WHERE message_id=?").get(messageId) as {
    run_id: string;
    disposition: string;
  };
}
afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("Project cron shared admission and durable cursor", () => {
  it("keeps Agent-only cron configuration read-only until trial then freezes canonical Chat history", () => {
    const profile = createAgentProfile({ name: "Lazy cron worker" }, ctx);
    addProjectMember(project.id, profile.id, ctx);
    const count = () =>
      (
        sqlite
          .prepare("SELECT count(*) n FROM chat WHERE project_id=? AND kind='dm'")
          .get(project.id) as { n: number }
      ).n;
    const before = count();
    const current = automation.createCronRule(
      {
        projectId: project.id,
        name: "DM cron",
        enabled: false,
        instruction: "hi",
        action: { kind: "dm_agent", agentProfileId: profile.id },
        expression: "* * * * *",
        timezone: "UTC",
      },
      ctx,
      at("12:00:00"),
    );
    automation.listCronRules(project.id, ctx);
    expect(count()).toBe(before);
    expect(trial(current, "disabled-lazy")).toMatchObject({
      decision: "skipped",
      reason: "rule_disabled",
    });
    expect(count()).toBe(before);
    const enabled = update(current, { enabled: true });
    const receipt = trial(enabled, "lazy-cron");
    expect(receipt.decision).toBe("accepted");
    if (receipt.decision !== "accepted") throw new Error("accepted");
    expect(count()).toBe(before + 1);
    const history = automation.cronHistory(current.id, ctx);
    expect(history.find((item) => item.id === receipt.id)).toMatchObject({
      source: "cron",
      chatId: chats.createDirectChat(project.id, profile.id, ctx).chat.id,
      messageId: receipt.messageId,
      runId: inputFor(receipt.messageId).run_id,
      runStatus: "queued",
      inputDisposition: "pending",
    });
    expect(history.find((item) => item.decision === "skipped")).toMatchObject({
      chatId: null,
      runId: null,
      runStatus: null,
    });
    const snapshot = sqlite
      .prepare("SELECT snapshot FROM webhook_trigger WHERE id=?")
      .get(receipt.id) as { snapshot: string };
    expect(JSON.parse(snapshot.snapshot).action.chatId).toBe(
      history.find((item) => item.id === receipt.id)!.chatId,
    );
    update(enabled, { enabled: false });
  });
  it("owns one rearming timer, skips event-loop gaps, rebases restart and ignores stale callbacks", async () => {
    const { createCronScheduler } = await import("../src/server/cron-scheduler");
    const current = rule();
    let now = at("12:00:50");
    let id = 0;
    const callbacks = new Map<number, () => void>();
    const errors: unknown[] = [];
    const scheduler = createCronScheduler({
      clock: {
        now: () => now,
        setTimeout(fn, ms) {
          expect(ms).toBe(1000);
          callbacks.set(++id, fn);
          return id;
        },
        clearTimeout(handle) {
          callbacks.delete(handle as number);
        },
      },
      onError: (error) => errors.push(error),
    });
    const fire = (value: string) => {
      now = at(value);
      const [key, callback] = callbacks.entries().next().value!;
      callbacks.delete(key);
      callback();
    };
    scheduler.start();
    scheduler.start();
    expect(callbacks.size).toBe(1);
    fire("12:01:00");
    expect(automation.cronHistory(current.id, ctx)).toHaveLength(1);
    expect(automation.cronHistory(current.id, ctx)[0]?.decision).toBe("accepted");
    fire("12:05:00");
    expect(automation.cronHistory(current.id, ctx)[0]).toMatchObject({
      decision: "skipped",
      reason: "schedule_missed",
      scheduledAt: at("12:02:00").toISOString(),
    });
    const stale = callbacks.values().next().value!;
    scheduler.stop();
    scheduler.stop();
    stale();
    expect(callbacks.size).toBe(0);
    expect(scheduler.snapshot()).toEqual({ started: false, timerArmed: false });
    now = at("15:00:00");
    scheduler.start();
    expect(automation.listCronRules(project.id, ctx).find((r) => r.id === current.id)?.nextAt).toBe(
      at("15:01:00").toISOString(),
    );
    stale();
    expect(callbacks.size).toBe(1);
    const disabled = update(current, { enabled: false }, now);
    fire("15:01:00");
    expect(disabled.nextAt).toBeNull();
    expect(automation.cronHistory(current.id, ctx)).toHaveLength(2);
    scheduler.stop();
    expect(errors).toEqual([]);
  });
  it("isolates source APIs and credentials; freezes receipt/provenance across edits", () => {
    const current = rule();
    expect(
      automation
        .listWebhookRules(project.id, ctx, "https://sprout.test")
        .some((r) => r.id === current.id),
    ).toBe(false);
    expect(() => automation.assertWebhookCredential(current.id, "secret")).toThrow(/credentials/);
    expect(() => automation.receiveWebhook(current.id, "secret", "event", {})).toThrow(
      /credentials/,
    );
    expect(() =>
      automation.trialWebhook({ ruleId: current.id, eventId: "event", payload: {} }, ctx),
    ).toThrow();
    const result = trial(current, "first");
    expect(result.decision).toBe("accepted");
    if (result.decision !== "accepted") throw new Error("expected accepted");
    const original = automationSourceFor(result.id);
    expect(original).toMatchObject({
      kind: "project_cron",
      expression: "* * * * *",
      timezone: "UTC",
      mode: "trial",
      scheduledAt: null,
      instruction: current.instruction,
    });
    const saved = chats
      .listMessages(current.action.chatId!, ctx)
      .find((m) => m.id === result.messageId)!;
    expect(saved).toMatchObject({
      senderKind: "automation",
      automationSource: original,
      mentions: [],
      skills: [],
    });
    update(current, { instruction: "Changed", expression: "0 * * * *" });
    expect(automationSourceFor(result.id)).toEqual(original);
    expect(automation.cronHistory(current.id, ctx)[0]).toMatchObject({
      expression: "* * * * *",
      decision: "accepted",
    });
    expect(trial(current, "first")).toEqual(result);
    expect(() => automation.listCronRules(project.id, { ...ctx, userId: "stranger" })).toThrow();
    const input = inputFor(result.messageId);
    sqlite
      .prepare("DELETE FROM chat_member WHERE chat_id=? AND member_kind='agent' AND member_id=?")
      .run(current.action.chatId, agent.id);
    let sent = 0;
    admitAutomationInput(input.run_id, result.messageId, () => ++sent);
    expect(sent).toBe(0);
    expect(inputFor(result.messageId).disposition).toBe("cancelled");
  });
  it("uses current run/input facts for live/Trial overlap including delivered and carried inputs", () => {
    const current = rule();
    const first = trial(current, "first");
    if (first.decision !== "accepted") throw new Error("expected accepted");
    const input = inputFor(first.messageId);
    sqlite
      .prepare(
        "UPDATE agent_run_input SET disposition='delivered',delivered_at=1 WHERE message_id=?",
      )
      .run(first.messageId);
    expect(trial(current, "overlap")).toMatchObject({
      decision: "skipped",
      reason: "rule_overlap",
    });
    expect(
      automation.tickCronRules(at("12:01:00")).find((r) => r.ruleId === current.id),
    ).toMatchObject({ decision: "skipped", reason: "rule_overlap" });
    sqlite
      .prepare("UPDATE agent_run SET status='interrupted',settled_at=1 WHERE id=?")
      .run(input.run_id);
    const released = trial(current, "released");
    expect(released.decision).toBe("accepted");
    if (released.decision !== "accepted") throw new Error("expected accepted");
    const next = inputFor(released.messageId);
    sqlite
      .prepare("UPDATE agent_run_input SET run_id=? WHERE message_id=?")
      .run(next.run_id, first.messageId);
    sqlite
      .prepare(
        "UPDATE agent_run_input SET disposition='cancelled',cancelled_at=1,cancel_reason='automation_context_changed' WHERE message_id=?",
      )
      .run(released.messageId);
    expect(trial(current, "carried-live")).toMatchObject({
      decision: "skipped",
      reason: "rule_overlap",
    });
    expect(
      automation.cronHistory(current.id, ctx).find((entry) => entry.id === first.id)?.runId,
    ).toBe(next.run_id);
    sqlite
      .prepare(
        "UPDATE agent_run_input SET disposition='pending',delivered_at=NULL,admitted_at=1 WHERE message_id=?",
      )
      .run(first.messageId);
    expect(trial(current, "uncertain-send")).toMatchObject({
      decision: "skipped",
      reason: "rule_overlap",
    });
    const independent = rule();
    expect(trial(independent, "other-rule").decision).toBe("accepted");
  });
  it("Trial never advances cursor; cancelled input releases overlap and disabled Trial skips", () => {
    const current = rule();
    const first = trial(current, "first");
    if (first.decision !== "accepted") throw new Error("expected accepted");
    sqlite
      .prepare(
        "UPDATE agent_run_input SET disposition='cancelled',cancelled_at=1,cancel_reason='automation_context_changed' WHERE message_id=?",
      )
      .run(first.messageId);
    const accepted = trial(current, "cancelled-release");
    expect(accepted.decision).toBe("accepted");
    if (accepted.decision !== "accepted") throw new Error("expected accepted");
    expect(automation.listCronRules(project.id, ctx).find((r) => r.id === current.id)?.nextAt).toBe(
      current.nextAt,
    );
    const disabled = update(current, { enabled: false });
    expect(disabled.nextAt).toBeNull();
    let sends = 0;
    admitAutomationInput(inputFor(accepted.messageId).run_id, accepted.messageId, () => ++sends);
    expect(sends).toBe(1);
    expect(trial(disabled, "disabled")).toMatchObject({
      decision: "skipped",
      reason: "rule_disabled",
    });
  });
  it("bounds late work, skips long gaps once, dedupes rewind, and rebases restart strictly after boot", () => {
    const current = rule();
    expect(
      automation.tickCronRules(at("12:01:10")).find((r) => r.ruleId === current.id)?.decision,
    ).toBe("accepted");
    const next = automation.tickCronRules(at("12:03:11"));
    expect(next.filter((r) => r.ruleId === current.id)).toHaveLength(1);
    expect(next.find((r) => r.ruleId === current.id)).toMatchObject({
      decision: "skipped",
      reason: "schedule_missed",
      scheduledAt: at("12:02:00").toISOString(),
    });
    expect(
      automation.tickCronRules(at("12:01:00"), true).some((r) => r.ruleId === current.id),
    ).toBe(false);
    automation.rebaseCronCursors(at("12:01:00"));
    expect(
      automation.tickCronRules(at("12:02:00")).find((r) => r.ruleId === current.id),
    ).toMatchObject({ decision: "skipped", reason: "schedule_missed" });
    automation.rebaseCronCursors(at("18:00:00"));
    expect(automation.listCronRules(project.id, ctx).find((r) => r.id === current.id)?.nextAt).toBe(
      at("18:01:00").toISOString(),
    );
    expect(automation.tickCronRules(at("18:00:00"))).toEqual([]);
  });
  it("edit/re-enable replaces cursor atomically and stale config cannot tick", () => {
    const current = rule();
    const changed = update(current, { expression: "0 * * * *" });
    expect(changed.nextAt).toBe(at("13:00:00").toISOString());
    expect(() => update(current, { enabled: false })).toThrow(/变化/);
    expect(automation.tickCronRules(at("12:01:00")).some((r) => r.ruleId === current.id)).toBe(
      false,
    );
    const disabled = update(changed, { enabled: false });
    expect(disabled.nextAt).toBeNull();
    expect(update(disabled, { enabled: true }, at("14:00:00")).nextAt).toBe(
      at("15:00:00").toISOString(),
    );
  });
});

it("gates cron initial prompt and cross-rule active steer at the real transport boundary", async () => {
  const { startRuntime, shutdownRuntime } = await import("../src/server/runtime");
  const { PiSessionProcess } = await import("../src/server/pi-host/process");
  const { executeRun } = await import("../src/server/pi-host/run");
  const runs = await import("../src/domain/agent-run");
  const trace = join(directory, "cron-wire.jsonl");
  process.env.WEBHOOK_TRACE = trace;
  await startRuntime();
  try {
    for (const mode of [
      "initial_and_active",
      "revoke_after_open",
      "revoke_before_steer",
    ] as const) {
      const seed = rule();
      const {
        id,
        revision,
        nextAt: _nextAt,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...data
      } = seed;
      const current = automation.updateCronRule(
        {
          ...data,
          ruleId: id,
          expectedRevision: revision,
          action: { kind: "group_owner", chatId: seed.action.chatId! },
        },
        ctx,
      );
      const firstRule = update(current, { instruction: "AWAIT_STEER @Agent /skill:danger" });
      const secondRule = automation.createCronRule(
        {
          projectId: project.id,
          name: "Independent rule",
          enabled: true,
          instruction: "Active cron input",
          action: current.action,
          expression: current.expression,
          timezone: current.timezone,
        },
        ctx,
      );
      const first = trial(firstRule, "initial");
      if (first.decision !== "accepted") throw new Error("expected accepted");
      const runId = inputFor(first.messageId).run_id;
      let second: ReturnType<typeof trial> | undefined;
      const revoke = () =>
        chats.setChatOwner(current.action.chatId!, { kind: "human", id: ctx.userId }, 0, {
          kind: "human",
          userId: ctx.userId,
          ctx,
        });
      class Transport extends PiSessionProcess {
        override async open(config: Parameters<InstanceType<typeof PiSessionProcess>["open"]>[0]) {
          const snapshot = await super.open(config);
          if (mode === "revoke_after_open") revoke();
          return snapshot;
        }
        override prompt(prepared: Parameters<InstanceType<typeof PiSessionProcess>["prompt"]>[0]) {
          const work = super.prompt(prepared);
          second = trial(secondRule, "active");
          if (second.decision !== "accepted")
            throw new Error("independent cron input must be accepted");
          expect(inputFor(second.messageId).run_id).toBe(runId);
          if (mode === "revoke_before_steer") {
            revoke();
            queueMicrotask(() => this.abortSession());
          }
          return work;
        }
      }
      const transport = new Transport(runId, resolve("tests/fixtures/webhook-wire.mjs"));
      try {
        await Effect.runPromise(
          executeRun(
            runs.queuedRunWork().find((work) => work.run.id === runId)!,
            transport,
            { isStopping: () => false },
          ),
        );
      } finally {
        await transport.close();
      }
      const observed = existsSync(trace)
        ? readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((command) => command.id === runId)
        : [];
      if (mode === "revoke_after_open") {
        expect(observed).toEqual([]);
        expect(runs.getAgentRun(runId, ctx).status).toBe("aborted");
      } else if (mode === "initial_and_active") {
        expect(observed.map((command) => command.type)).toEqual(["prompt", "steer"]);
        for (const command of observed) {
          expect(JSON.parse(command.text)).toMatchObject({
            origin: "project_cron",
            content: { mode: "trial", schedule: { timezone: "UTC", scheduledAt: null } },
          });
          expect(command).not.toHaveProperty("systemPrompt");
        }
        expect(
          runs.listAgentRunInputs(runId, ctx).every((input) => input.disposition === "delivered"),
        ).toBe(true);
      } else {
        expect(observed.map((command) => command.messageId)).toEqual([first.messageId]);
        expect(runs.pendingRunInputs(runId, ctx)).toEqual([]);
        expect(
          runs
            .listAgentRunInputs(runId, ctx)
            .find(
              (input) => second?.decision === "accepted" && input.messageId === second.messageId,
            ),
        ).toMatchObject({ disposition: "cancelled", cancelReason: "automation_context_changed" });
      }
    }
  } finally {
    await shutdownRuntime("cron-wire-done");
  }
});
