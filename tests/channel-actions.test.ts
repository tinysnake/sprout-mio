import { afterAll, expect, it } from "vite-plus/test";
import type { AssistantFact } from "../src/contracts/assistant";
import type { ChannelEnvelope } from "../src/contracts/channel";
import type { VerifiedFeishuIdentity } from "../src/contracts/feishu";
import { channelNativeFixture } from "./fixtures/channel-native";

const f = await channelNativeFixture();
const { sqlite } = f;
const observer = await import("../src/domain/assistant-observer");
afterAll(() => f.close());
function deliveries(chatId: string) {
  return (
    sqlite
      .prepare(
        "SELECT id,envelope,state FROM channel_delivery WHERE json_extract(route,'$.chatId')=? ORDER BY rowid",
      )
      .all(chatId) as { id: string; envelope: string; state: string }[]
  ).map((row) => ({ ...row, envelope: JSON.parse(row.envelope) as ChannelEnvelope }));
}
function card(chatId: string) {
  const row = deliveries(chatId)
    .filter((row) => row.envelope.kind === "card")
    .at(-1)!;
  if (!row || row.envelope.kind !== "card") throw new Error("expected card");
  return { ...row, confirm: row.envelope.actions[0].token, reject: row.envelope.actions[1].token };
}
function proposal() {
  const s = f.scenario();
  const { scope } = s.bind();
  const source = s.principal();
  const p = f.assistant.createAssistantProposal(
    source,
    { kind: "dm_agent", projectId: s.project.id, agentProfileId: s.worker.id },
    "Concrete Human-approved job",
    s.now,
  );
  return { ...s, scope, p, card: card(s.dm.id) };
}
function watchIntent(s: ReturnType<typeof f.scenario>) {
  const event = f.assistant.captureAssistantFact(
    s.dm.id,
    `watch-${Math.random()}`,
    {
      kind: "decision",
      targetProjectId: s.project.id,
      targetChatId: s.work.id,
      body: "RAW INTERNAL WATCH INPUT",
      sampledAt: s.now.toISOString(),
      watchIntent: true,
      intervalSeconds: 60,
    },
    s.now,
  );
  f.assistant.deliverAssistantEvents(s.now);
  return { event, card: card(s.dm.id) };
}

it.each(["web-first", "card-first"] as const)(
  "%s confirmation races through the same proposal record and creates one work message",
  (order) => {
    const s = proposal();
    const run = () => f.delivery.consumeFeishuAction(s.identity, s.scope, s.card.confirm, s.now);
    const web = () => f.assistant.confirmAssistantProposal(s.p.proposalId, s.dm.id, s.ctx, s.now);
    const first = order === "web-first" ? web() : run();
    const second = order === "web-first" ? run() : web();
    const duplicate = run();
    expect(first).toMatchObject({ status: "submitted" });
    expect(second).toMatchObject({ status: "submitted" });
    expect(duplicate).toMatchObject({ status: "submitted" });
    const native = sqlite
      .prepare("SELECT work_message_id FROM assistant_proposal WHERE id=?")
      .get(s.p.proposalId) as { work_message_id: string };
    expect(duplicate).toMatchObject({ workMessageId: native.work_message_id });
    expect(
      sqlite
        .prepare("SELECT count(*) n FROM message WHERE assistant_proposal_id=?")
        .get(s.p.proposalId),
    ).toEqual({ n: 1 });
    expect(
      sqlite
        .prepare("SELECT count(*) n FROM agent_run_input WHERE message_id=?")
        .get(native.work_message_id),
    ).toEqual({ n: 1 });
    expect(() =>
      f.delivery.consumeFeishuAction(s.identity, s.scope, s.card.reject, s.now),
    ).toThrow();
    expect(
      sqlite.prepare("SELECT status FROM assistant_proposal WHERE id=?").get(s.p.proposalId),
    ).toEqual({ status: "submitted" });
  },
);

it("native action/receipt failure rolls back work creation and grant consumption together", () => {
  const s = proposal();
  sqlite.exec(
    "CREATE TRIGGER fail_card_receipt BEFORE INSERT ON channel_action_receipt BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END",
  );
  try {
    expect(() =>
      f.delivery.consumeFeishuAction(s.identity, s.scope, s.card.confirm, s.now),
    ).toThrow("receipt unavailable");
    expect(
      sqlite
        .prepare("SELECT status,work_message_id FROM assistant_proposal WHERE id=?")
        .get(s.p.proposalId),
    ).toEqual({ status: "pending", work_message_id: null });
    expect(
      sqlite
        .prepare("SELECT count(*) n FROM message WHERE assistant_proposal_id=?")
        .get(s.p.proposalId),
    ).toEqual({ n: 0 });
  } finally {
    sqlite.exec("DROP TRIGGER fail_card_receipt");
  }
  expect(f.delivery.consumeFeishuAction(s.identity, s.scope, s.card.confirm, s.now)).toMatchObject({
    status: "submitted",
  });
});

it.each(["identity", "switch", "expiry", "altered", "unknown", "permission", "content"] as const)(
  "rejects %s grant misuse without native work",
  (change) => {
    const s = proposal();
    let identity = s.identity;
    let scope = s.scope;
    let token = s.card.confirm;
    let now = s.now;
    if (change === "identity")
      identity = { ...identity, openId: "wrong-human" } as VerifiedFeishuIdentity;
    if (change === "switch")
      f.feishu.switchFeishuTarget(
        { projectId: s.project.id, chatId: s.dm.id },
        f.feishu.getFeishuBinding(s.project.id, s.ctx).revision,
        s.ctx,
      );
    if (change === "expiry") now = new Date(s.now.getTime() + 10 * 60_000);
    if (change === "altered") token += "x";
    if (change === "unknown") token = "opaque-not-real";
    if (change === "permission") f.agents.removeProjectMember(s.project.id, s.worker.id, s.ctx);
    if (change === "content") {
      expect(() =>
        sqlite
          .prepare("UPDATE assistant_proposal SET body='changed job' WHERE id=?")
          .run(s.p.proposalId),
      ).toThrow("assistant operation is immutable");
      sqlite
        .prepare(
          "UPDATE channel_action_grant SET action=json_set(action,'$.operationHash','altered') WHERE delivery_id=?",
        )
        .run(s.card.id);
    }
    expect(() => f.delivery.consumeFeishuAction(identity, scope, token, now)).toThrow();
    expect(
      sqlite
        .prepare("SELECT count(*) n FROM message WHERE assistant_proposal_id=?")
        .get(s.p.proposalId),
    ).toEqual({ n: 0 });
  },
);

it("confirms a card issued before a reconnect exactly once through the current epoch", () => {
  const s = proposal();
  const scope = f.feishu.captureFeishuAdmissionScope(s.project.id, s.identity, s.reconnect())!;
  expect(f.delivery.consumeFeishuAction(s.identity, scope, s.card.confirm, s.now)).toMatchObject({
    status: "submitted",
  });
  expect(
    sqlite
      .prepare("SELECT count(*) n FROM message WHERE assistant_proposal_id=?")
      .get(s.p.proposalId),
  ).toEqual({ n: 1 });
});

it("does not disclose consumed results after identity/route/permission loss", () => {
  const s = proposal();
  f.delivery.consumeFeishuAction(s.identity, s.scope, s.card.confirm, s.now);
  expect(() =>
    f.delivery.consumeFeishuAction(
      { ...s.identity, openId: "another" } as VerifiedFeishuIdentity,
      s.scope,
      s.card.confirm,
      s.now,
    ),
  ).toThrow();
  sqlite
    .prepare("DELETE FROM project_member WHERE project_id=? AND agent_profile_id=?")
    .run(s.project.id, s.worker.id);
  expect(() =>
    f.delivery.consumeFeishuAction(s.identity, s.scope, s.card.confirm, s.now),
  ).toThrow();
  f.feishu.unbindFeishuIdentity(
    s.project.id,
    f.feishu.getFeishuBinding(s.project.id, s.ctx).revision,
    s.ctx,
  );
  expect(() =>
    f.delivery.consumeFeishuAction(s.identity, s.scope, s.card.confirm, s.now),
  ).toThrow();
});

it("rejected watch intent stays rejected, duplicate rejection is safe and a fresh intent can still be confirmed", () => {
  const s = f.scenario();
  const { scope } = s.bind();
  // Existing unrelated active watch must survive rejecting this intent.
  const other = f.agents.createAgentProfile({ name: "Other worker" }, s.ctx);
  f.agents.addProjectMember(s.project.id, other.id, s.ctx);
  const otherChat = f.chats.createDirectChat(s.project.id, other.id, s.ctx).chat;
  const active = observer.setAssistantWatch(
    s.dm.id,
    s.project.id,
    otherChat.id,
    true,
    s.ctx,
    s.now,
    60,
  );
  const first = watchIntent(s);
  expect(f.delivery.consumeFeishuAction(s.identity, scope, first.card.reject, s.now)).toEqual({
    kind: "watch",
    rejected: true,
  });
  expect(f.delivery.consumeFeishuAction(s.identity, scope, first.card.reject, s.now)).toEqual({
    kind: "watch",
    rejected: true,
  });
  expect(() =>
    f.delivery.consumeFeishuAction(s.identity, scope, first.card.confirm, s.now),
  ).toThrow();
  expect(() =>
    observer.setAssistantWatch(
      s.dm.id,
      s.project.id,
      s.work.id,
      true,
      s.ctx,
      s.now,
      60,
      first.event.id,
    ),
  ).toThrow();
  expect(
    sqlite.prepare("SELECT revoked_at FROM assistant_watch WHERE id=?").get(active.watchId),
  ).toEqual({ revoked_at: null });
  const fresh = watchIntent(s);
  expect(
    f.delivery.consumeFeishuAction(s.identity, scope, fresh.card.confirm, s.now),
  ).toMatchObject({ kind: "watch", active: true });
  expect(
    f.delivery.consumeFeishuAction(s.identity, scope, fresh.card.confirm, s.now),
  ).toMatchObject({ kind: "watch", active: true });
});

it("safely projects durable semantic watch summary and refuses unknown/corrupt/raw fallback events", async () => {
  const s = f.scenario();
  s.bind();
  const watch = observer.setAssistantWatch(
    s.dm.id,
    s.project.id,
    s.work.id,
    true,
    s.ctx,
    s.now,
    60,
  );
  const before = deliveries(s.dm.id).length;
  for (const fact of [
    { kind: "unknown", body: "SECRET UNKNOWN" },
    { kind: "decision", body: "SECRET FALLBACK" },
    { kind: "periodic", body: "SECRET CORRUPT", runState: { status: "invented" } },
  ]) {
    f.assistant.captureAssistantFact(
      s.dm.id,
      `unsafe-${Math.random()}`,
      {
        targetProjectId: s.project.id,
        targetChatId: s.work.id,
        sampledAt: s.now.toISOString(),
        ...fact,
      } as AssistantFact,
      s.now,
    );
  }
  f.assistant.deliverAssistantEvents(s.now);
  expect(deliveries(s.dm.id)).toHaveLength(before);
  const event = f.assistant.captureAssistantFact(
    s.dm.id,
    "semantic-window",
    {
      kind: "periodic",
      watchId: watch.watchId,
      targetProjectId: s.project.id,
      targetChatId: s.work.id,
      body: "RAW CONTEXT MUST NEVER LEAK",
      sampledAt: s.now.toISOString(),
      watchWindow: {
        messages: [{ id: "internal", senderKind: "human", body: "PRIVATE RAW INPUT" }],
        runs: [],
      },
    },
    s.now,
  );
  sqlite
    .prepare(
      "UPDATE assistant_watch_summary SET status='completed',summary='Durable model summary' WHERE event_id=?",
    )
    .run(event.id);
  f.assistant.deliverAssistantEvents(s.now);
  expect(deliveries(s.dm.id).at(-1)?.envelope.text).toBe("Durable model summary");
  expect(JSON.stringify(deliveries(s.dm.id))).not.toMatch(/RAW|PRIVATE|SECRET/);
  // Summary changes after prepare must suppress the obsolete prepared payload.
  const row = deliveries(s.dm.id).at(-1)!;
  sqlite
    .prepare("UPDATE channel_delivery SET state='failed' WHERE id<>? AND state='ready'")
    .run(row.id);
  let begins = 0;
  await f.delivery.emitNextFeishuDelivery({
    prepare: async (input) => {
      sqlite
        .prepare(
          "UPDATE assistant_watch_summary SET summary='New current model summary' WHERE event_id=?",
        )
        .run(event.id);
      return input;
    },
    begin: () => {
      begins++;
      return {
        initiated: true,
        completion: Promise.resolve({ kind: "accepted", messageId: "unexpected" }),
      };
    },
  });
  expect(begins).toBe(0);
  expect(deliveries(s.dm.id).at(-1)?.state).toBe("suppressed");
});
