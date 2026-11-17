import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import type { AutomationAction, WebhookRule } from "../src/contracts/automation";
import type { ProjectContext } from "../src/domain/access";

const directory = mkdtempSync(join(tmpdir(), "webhook-core-"));
process.env.DATABASE_URL = join(directory, "core.sqlite");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
const { createCrewChat } = await import("./fixtures/crew-chat");
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { db, sqlite } = await import("../src/db");
const schema = await import("../src/db/schema");
const { newId, ID_PREFIXES } = await import("../src/contracts/ids");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const chats = await import("../src/domain/chat");
const runs = await import("../src/domain/agent-run");
const automation = await import("../src/domain/automation");
const { admitAutomationInput } = await import("../src/domain/automation-input");
const ctx: ProjectContext = { userId: "webhook-human", requestId: newId(ID_PREFIXES.request) };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(ctx.userId, "Human", "webhook@test.example");
const project = createProject({ name: "Webhook project" }, ctx);
const other = createProject({ name: "Other" }, ctx);
const alpha = createAgentProfile({ name: "Alpha", persona: "", harness: "pi" }, ctx);
const beta = createAgentProfile({ name: "Beta", persona: "", harness: "pi" }, ctx);
for (const agent of [alpha, beta]) addProjectMember(project.id, agent.id, ctx);
const human = { kind: "human" as const, userId: ctx.userId, ctx };
const baseUrl = "https://sprout.test";
function group(owner: "human" | "agent" = "agent") {
  return createCrewChat(
    project.id,
    {
      projectId: project.id,
      title: "Webhook",
      initialOwner: { kind: owner, id: owner === "human" ? ctx.userId : alpha.id },
      members: [
        { kind: "human", id: ctx.userId },
        { kind: "agent", id: alpha.id },
        { kind: "agent", id: beta.id },
      ],
    },
    human,
  );
}
function rule(action: AutomationAction) {
  return automation.createWebhookRule(
    {
      projectId: project.id,
      name: "Build event",
      instruction: "Check event. @Beta /skill:danger",
      enabled: true,
      action,
    },
    ctx,
    baseUrl,
  );
}
function update(current: WebhookRule, data: Partial<WebhookRule>) {
  const { id, projectId, name, instruction, enabled, action, revision } = current;
  return automation.updateWebhookRule(
    {
      ruleId: id,
      projectId,
      name,
      instruction,
      enabled,
      action,
      expectedRevision: revision,
      ...data,
    },
    ctx,
    baseUrl,
  );
}
function deliver(
  current: ReturnType<typeof rule>,
  eventId = "event",
  payload: unknown = { build: 1 },
) {
  const receipt = automation.receiveWebhook(current.rule.id, current.secret, eventId, payload);
  if (receipt.decision !== "accepted") throw new Error(receipt.reason);
  const saved = db
    .select()
    .from(schema.message)
    .where(eq(schema.message.id, receipt.messageId))
    .get()!;
  const input = db
    .select()
    .from(schema.agentRunInput)
    .where(eq(schema.agentRunInput.messageId, saved.id))
    .get()!;
  return { receipt, saved, input, run: runs.getAgentRun(input.runId, ctx) };
}
afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("Project webhook admission and single Chat input path", () => {
  it("resolves Agent-only DM lazily, freezes the receipt and supports effective public-channel workers", () => {
    const fresh = createAgentProfile({ name: "Lazy worker", persona: "", harness: "pi" }, ctx);
    addProjectMember(project.id, fresh.id, ctx);
    const count = () =>
      (
        sqlite
          .prepare("SELECT count(*) n FROM chat WHERE project_id=? AND kind='dm'")
          .get(project.id) as { n: number }
      ).n;
    const before = count();
    const configured = rule({ kind: "dm_agent", agentProfileId: fresh.id });
    automation.listWebhookRules(project.id, ctx, baseUrl);
    expect(count()).toBe(before);
    const first = deliver(configured, "lazy-first");
    expect(count()).toBe(before + 1);
    expect(first.run.chatId).toBe(chats.createDirectChat(project.id, fresh.id, ctx).chat.id);
    const frozen = sqlite
      .prepare("SELECT snapshot,chat_id FROM webhook_trigger WHERE id=?")
      .get(first.receipt.id) as { snapshot: string; chat_id: string };
    expect(JSON.parse(frozen.snapshot).action.chatId).toBe(frozen.chat_id);
    expect(
      automation.webhookHistory(configured.rule.id, ctx).find((row) => row.id === first.receipt.id),
    ).toMatchObject({
      chatId: frozen.chat_id,
      runId: first.run.id,
      runStatus: "queued",
      source: "webhook",
      inputDisposition: "pending",
    });
    deliver(configured, "lazy-second");
    expect(count()).toBe(before + 1);
    const channel = chats.listChats(project.id, ctx).find((c) => c.kind === "crew")!;
    chats.addCrewMember(
      channel.id,
      { kind: "agent", id: fresh.id },
      channel.governanceRevision,
      human,
    );
    expect(deliver(rule({ kind: "crew", chatId: channel.id }), "public-event").run.chatId).toBe(
      channel.id,
    );
    const outsider = createAgentProfile({ name: "Outside", persona: "", harness: "pi" }, ctx);
    expect(() => rule({ kind: "dm_agent", agentProfileId: outsider.id })).toThrow(
      /agent_not_participating/,
    );
    expect(count()).toBe(before + 1);
  });

  it("reloads and revision-rotates Human-managed secrets while rejecting old values and Agent/foreign reads", () => {
    const configured = rule({ kind: "crew", chatId: group().id });
    expect(automation.webhookSecret(configured.rule.id, ctx)).toEqual({
      secret: configured.secret,
    });
    const rotated = automation.rotateWebhookSecret(
      { ruleId: configured.rule.id, expectedRevision: 0 },
      ctx,
      baseUrl,
    );
    expect(rotated.secret).not.toBe(configured.secret);
    expect(rotated.rule.revision).toBe(1);
    expect(automation.webhookSecret(configured.rule.id, ctx)).toEqual({ secret: rotated.secret });
    expect(() =>
      automation.assertWebhookCredential(configured.rule.id, configured.secret),
    ).toThrow();
    expect(() =>
      automation.assertWebhookCredential(configured.rule.id, rotated.secret),
    ).not.toThrow();
    expect(() =>
      automation.rotateWebhookSecret(
        { ruleId: configured.rule.id, expectedRevision: 0 },
        ctx,
        baseUrl,
      ),
    ).toThrow(/已变化/);
    expect(() =>
      automation.webhookSecret(configured.rule.id, { ...ctx, userId: "foreign" }),
    ).toThrow();
    const admitted = deliver(rotated, "secret-authorization");
    const agentCtx = {
      ...ctx,
      agent: {
        agentProfileId: alpha.id,
        instanceId: admitted.run.instanceId,
        runId: admitted.run.id,
      },
    };
    expect(() => automation.webhookSecret(configured.rule.id, agentCtx)).toThrow();
    expect(() =>
      automation.rotateWebhookSecret(
        { ruleId: configured.rule.id, expectedRevision: 1 },
        agentCtx,
        baseUrl,
      ),
    ).toThrow();
    sqlite
      .prepare("UPDATE webhook_rule SET recoverable_secret=NULL WHERE id=?")
      .run(configured.rule.id);
    expect(automation.webhookSecret(configured.rule.id, ctx)).toEqual({ secret: null });
    expect(
      automation.rotateWebhookSecret(
        { ruleId: configured.rule.id, expectedRevision: 1 },
        ctx,
        baseUrl,
      ).secret,
    ).toBeTruthy();
  });
  it("keeps secrets out of public views, rejects foreign Project/Agent contexts and cannot forge public source", () => {
    const current = group();
    expect(() =>
      automation.createWebhookRule(
        {
          projectId: other.id,
          name: "bad",
          instruction: "bad",
          enabled: true,
          action: { kind: "crew", chatId: current.id },
        },
        ctx,
        baseUrl,
      ),
    ).toThrow(/target_project_mismatch/);
    const configured = rule({ kind: "crew", chatId: current.id });
    const stored = db
      .select()
      .from(schema.webhookRule)
      .where(eq(schema.webhookRule.id, configured.rule.id))
      .get()!;
    expect(stored.secretDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.recoverableSecret).toBe(configured.secret);
    expect(JSON.stringify(automation.listWebhookRules(project.id, ctx, baseUrl))).not.toContain(
      configured.secret,
    );
    expect(configured.rule.endpoint).not.toContain(configured.secret);
    expect(
      automation
        .listWebhookRules(project.id, ctx, baseUrl)
        .some((r) => r.id === configured.rule.id),
    ).toBe(true);
    const admitted = deliver(configured);
    const agentCtx: ProjectContext = {
      ...ctx,
      agent: {
        agentProfileId: alpha.id,
        instanceId: admitted.run.instanceId,
        runId: admitted.run.id,
      },
    };
    expect(() => automation.listWebhookRules(project.id, agentCtx, baseUrl)).toThrow();
    expect(() =>
      automation.trialWebhook(
        { ruleId: configured.rule.id, eventId: "agent", payload: {} },
        agentCtx,
      ),
    ).toThrow();
    expect(() =>
      automation.updateWebhookRule(
        { ...configured.rule, ruleId: configured.rule.id, expectedRevision: 0 },
        agentCtx,
        baseUrl,
      ),
    ).toThrow();
    expect(() =>
      automation.webhookHistory(configured.rule.id, { ...ctx, userId: "stranger" }),
    ).toThrow();
    expect(() =>
      chats.sendMessage(
        current.id,
        { senderKind: "automation", senderId: admitted.receipt.id, body: "fake" } as never,
        ctx,
      ),
    ).toThrow(/可信/);
  });

  it("authenticates before dedupe, canonicalizes JSON, scopes trial, and retains immutable accepted snapshot after disable", () => {
    const current = group();
    const configured = rule({ kind: "crew", chatId: current.id });
    expect(() => automation.receiveWebhook(configured.rule.id, "bad", "same", {})).toThrow(
      /credentials/,
    );
    expect(automation.webhookHistory(configured.rule.id, ctx)).toHaveLength(0);
    const first = deliver(configured, "same", { z: [1, { b: 2, a: 1 }], a: true });
    const repeat = automation.receiveWebhook(configured.rule.id, configured.secret, "same", {
      a: true,
      z: [1, { a: 1, b: 2 }],
    });
    expect(repeat).toEqual(first.receipt);
    expect(() =>
      automation.receiveWebhook(configured.rule.id, configured.secret, "same", { a: false }),
    ).toThrow(/eventId/);
    const trial = automation.trialWebhook(
      { ruleId: configured.rule.id, eventId: "same", payload: { a: false } },
      ctx,
    );
    expect(trial.decision).toBe("accepted");
    expect(trial.id).not.toBe(first.receipt.id);
    const disabled = update(configured.rule, {
      enabled: false,
      instruction: "Changed instruction",
    });
    expect(() => update(configured.rule, { name: "Stale" })).toThrow(/已变化/);
    expect(
      automation.receiveWebhook(configured.rule.id, configured.secret, "disabled", {}),
    ).toMatchObject({ decision: "skipped", reason: "rule_disabled" });
    expect(
      automation.trialWebhook(
        { ruleId: configured.rule.id, eventId: "disabled", payload: {} },
        ctx,
      ),
    ).toMatchObject({ decision: "skipped", reason: "rule_disabled" });
    expect(
      automation.receiveWebhook(configured.rule.id, configured.secret, "same", {
        z: [1, { a: 1, b: 2 }],
        a: true,
      }),
    ).toEqual(first.receipt);
    const trigger = db
      .select()
      .from(schema.webhookTrigger)
      .where(eq(schema.webhookTrigger.id, first.receipt.id))
      .get()!;
    expect(trigger.snapshot).toMatchObject({
      revision: 0,
      enabled: true,
      instruction: configured.rule.instruction,
    });
    expect(JSON.parse(first.saved.body).instruction).toBe(configured.rule.instruction);
    let attempted = 0;
    admitAutomationInput(first.run.id, first.saved.id, () => ++attempted);
    expect(attempted).toBe(1);
    expect(disabled.revision).toBe(1);
    expect(automation.webhookHistory(configured.rule.id, ctx)).toHaveLength(4);
    expect(
      sqlite
        .prepare("SELECT count(*) AS n FROM agent_run_input WHERE message_id=?")
        .get(first.saved.id),
    ).toEqual({ n: 1 });
    expect(() =>
      sqlite
        .prepare("UPDATE webhook_trigger SET event_id='mutated' WHERE id=?")
        .run(first.receipt.id),
    ).toThrow(/immutable/);
    expect(() =>
      sqlite.prepare("UPDATE message SET body='mutated' WHERE id=?").run(first.saved.id),
    ).toThrow(/immutable/);
  });

  it.each(["dm_agent", "crew"] as const)(
    "pins exactly one recipient for %s without parsing event mentions or skills",
    (kind) => {
      const current =
        kind === "dm_agent" ? chats.createDirectChat(project.id, beta.id, ctx).chat : group();
      const action: AutomationAction =
        kind === "dm_agent"
          ? { kind, chatId: current.id, agentProfileId: beta.id }
          : { kind, chatId: current.id };
      const configured = rule(action);
      const admitted = deliver(configured, kind, {
        target: alpha.id,
        senderKind: "human",
        text: "@Alpha /skill:danger",
        action: { kind: "crew" },
      });
      const instance = db
        .select()
        .from(schema.agentInstance)
        .where(eq(schema.agentInstance.id, admitted.run.instanceId))
        .get()!;
      expect(instance.agentProfileId).toBe(kind === "dm_agent" ? beta.id : alpha.id);
      expect(admitted.saved.senderKind).toBe("automation");
      const visible = chats.listMessages(current.id, ctx).find((m) => m.id === admitted.saved.id)!;
      expect(visible.automationSource).toEqual({
        kind: "project_webhook",
        triggerId: admitted.receipt.id,
        ruleId: admitted.receipt.ruleId,
      });
      expect(visible.mentions).toEqual([]);
      expect(visible.skills).toEqual([]);
      expect(
        sqlite.prepare("SELECT * FROM chat_member WHERE member_kind='automation'").all(),
      ).toEqual([]);
      expect(
        sqlite
          .prepare("SELECT count(*) AS n FROM agent_run_input WHERE message_id=?")
          .get(admitted.saved.id),
      ).toEqual({ n: 1 });
    },
  );

  it("rejects a Crew action without a lead and follows the lead after configured worker removal", () => {
    const current = group();
    const configured = rule({ kind: "crew", chatId: current.id });
    sqlite.prepare("UPDATE chat SET lead_profile_id=NULL WHERE id=?").run(current.id);
    expect(
      automation.receiveWebhook(configured.rule.id, configured.secret, "leadless", {}),
    ).toMatchObject({ decision: "skipped", reason: "crew_lead_missing" });
    expect(() => rule({ kind: "crew", chatId: current.id })).toThrow(/crew_lead_missing/);
    const restored = chats.setCrewLead(
      current.id,
      alpha.id,
      chats.getChat(current.id, ctx).governanceRevision,
      human,
    );
    chats.removeCrewMember(
      current.id,
      { kind: "agent", id: beta.id },
      restored.governanceRevision,
      human,
    );
    const admitted = deliver(configured, "worker-left");
    expect(
      db
        .select()
        .from(schema.agentInstance)
        .where(eq(schema.agentInstance.id, admitted.run.instanceId))
        .get()?.agentProfileId,
    ).toBe(alpha.id);
  });

  it("rolls back the receipt and source on failed ordinary run admission", () => {
    const current = group();
    const configured = rule({ kind: "crew", chatId: current.id });
    const before = sqlite.prepare("SELECT count(*) AS n FROM message").get();
    sqlite.exec(
      "CREATE TRIGGER webhook_test_fail BEFORE INSERT ON agent_run BEGIN SELECT RAISE(ABORT,'fixture_admission_failure'); END",
    );
    try {
      expect(() =>
        automation.receiveWebhook(configured.rule.id, configured.secret, "rollback", {}),
      ).toThrow(/fixture_admission_failure/);
    } finally {
      sqlite.exec("DROP TRIGGER webhook_test_fail");
    }
    expect(automation.webhookHistory(configured.rule.id, ctx)).toEqual([]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM message").get()).toEqual(before);
    expect(deliver(configured, "rollback").receipt.decision).toBe("accepted");
  });

  it("honors Crew stop and rechecks the current lead even when preparation raced an external authority change", () => {
    const current = group();
    const configured = rule({ kind: "crew", chatId: current.id });
    const admitted = deliver(configured);
    expect(() =>
      chats.removeCrewMember(
        current.id,
        { kind: "agent", id: alpha.id },
        current.governanceRevision,
        human,
      ),
    ).toThrow(/当前 lead/);
    sqlite.prepare("UPDATE chat SET lead_profile_id=? WHERE id=?").run(beta.id, current.id);
    let sent = 0;
    admitAutomationInput(admitted.run.id, admitted.saved.id, () => ++sent);
    expect(sent).toBe(0);
    expect(runs.listAgentRunInputs(admitted.run.id, ctx)).toEqual([
      expect.objectContaining({
        disposition: "cancelled",
        cancelReason: "automation_context_changed",
      }),
    ]);
    const stoppedChat = group();
    const stoppedRule = rule({ kind: "crew", chatId: stoppedChat.id });
    const currentView = chats.getChat(stoppedChat.id, ctx);
    chats.setCrewMode(stoppedChat.id, "stopped", currentView.governanceRevision, human);
    expect(
      automation.receiveWebhook(stoppedRule.rule.id, stoppedRule.secret, "stopped", {}),
    ).toMatchObject({ decision: "skipped", reason: "chat_stopped" });
  });

  it("persists an uncertain send attempt and will not automatically retry it", () => {
    const admitted = deliver(rule({ kind: "crew", chatId: group().id }));
    let attempts = 0;
    expect(() =>
      admitAutomationInput(admitted.run.id, admitted.saved.id, () => {
        attempts++;
        throw new Error("wire lost");
      }),
    ).toThrow("wire lost");
    admitAutomationInput(admitted.run.id, admitted.saved.id, () => attempts++);
    expect(attempts).toBe(1);
    expect(runs.listAgentRunInputs(admitted.run.id, ctx)[0]?.admittedAt).toBeDefined();
    expect(runs.firstPendingRunInput(admitted.run.id, ctx)).toBeUndefined();
  });
});

it("uses actual Pi prompt and active steer with provenance, no paid model, and last-boundary revocation", async () => {
  const { startRuntime, shutdownRuntime } = await import("../src/server/runtime");
  const { PiSessionProcess } = await import("../src/server/pi-host/process");
  const { executeRun } = await import("../src/server/pi-host/run");
  const { preparePiMessage } = await import("../src/server/message-skills");
  await startRuntime();
  const trace = join(directory, "wire.jsonl");
  process.env.WEBHOOK_TRACE = trace;
  try {
    for (const mode of ["initial_and_active", "owner_after_open", "revoke_before_steer"] as const) {
      const current = group();
      const configured = rule({ kind: "crew", chatId: current.id });
      const initial = deliver(configured, "initial", {
        awaitSteer: true,
        text: "@Beta /skill:danger",
      });
      let second: ReturnType<typeof deliver> | undefined;
      class Transport extends PiSessionProcess {
        override async open(config: Parameters<InstanceType<typeof PiSessionProcess>["open"]>[0]) {
          const snapshot = await super.open(config);
          if (mode === "owner_after_open")
            sqlite
              .prepare("UPDATE chat SET lead_profile_id=NULL, crew_epoch=crew_epoch+1 WHERE id=?")
              .run(current.id);
          return snapshot;
        }
        override prompt(prepared: Parameters<InstanceType<typeof PiSessionProcess>["prompt"]>[0]) {
          expect(
            runs
              .listAgentRunInputs(initial.run.id, ctx)
              .find((i) => i.messageId === prepared.messageId)?.admittedAt,
          ).toBeDefined();
          const task = super.prompt(prepared);
          second = deliver(configured, "active", { awaitSteer: false });
          expect(second.run.id).toBe(initial.run.id);
          if (mode === "revoke_before_steer") {
            sqlite
              .prepare("UPDATE chat SET lead_profile_id=NULL, crew_epoch=crew_epoch+1 WHERE id=?")
              .run(current.id);
            queueMicrotask(() => this.abortSession());
          }
          return task;
        }
        override steer(prepared: Parameters<InstanceType<typeof PiSessionProcess>["steer"]>[0]) {
          expect(
            runs
              .listAgentRunInputs(initial.run.id, ctx)
              .find((i) => i.messageId === prepared.messageId)?.admittedAt,
          ).toBeDefined();
          super.steer(prepared);
        }
      }
      const work = runs.queuedRunWork().find((w) => w.run.id === initial.run.id)!;
      const transport = new Transport(initial.run.id, resolve("tests/fixtures/webhook-wire.mjs"));
      try {
        await Effect.runPromise(executeRun(work, transport, { isStopping: () => false }));
      } finally {
        await transport.close();
      }
      const observed = existsSync(trace)
        ? readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((c) => c.id === initial.run.id)
        : [];
      if (mode === "owner_after_open") {
        expect(observed).toEqual([]);
        expect(runs.getAgentRun(initial.run.id, ctx).status).toBe("aborted");
      } else if (mode === "initial_and_active") {
        expect(observed.map((c) => [c.type, c.messageId])).toEqual([
          ["prompt", initial.saved.id],
          ["steer", second!.saved.id],
        ]);
        for (const command of observed) {
          expect(JSON.parse(command.text)).toMatchObject({
            origin: "project_webhook",
            ruleId: configured.rule.id,
            recipientAgentProfileId: alpha.id,
            ruleRevision: 0,
          });
          expect(command.text).toContain("/skill:danger");
          expect(command).not.toHaveProperty("systemPrompt");
        }
        expect(
          runs.listAgentRunInputs(initial.run.id, ctx).every((i) => i.disposition === "delivered"),
        ).toBe(true);
      } else {
        expect(observed.map((c) => c.messageId)).toEqual([initial.saved.id]);
        expect(runs.pendingRunInputs(initial.run.id, ctx)).toEqual([]);
      }
      if (mode === "initial_and_active") {
        const prepared = await preparePiMessage(
          { projectId: project.id, chatId: current.id, messageId: initial.saved.id },
          { kind: "disabled" },
          ctx,
        );
        expect(prepared.warnings).toEqual([]);
      }
    }
  } finally {
    await shutdownRuntime("webhook-wire-done");
  }
});
