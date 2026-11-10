import { afterAll, expect, it } from "vite-plus/test";
import type { FeishuCardAck } from "../src/contracts/feishu-channel";
import type { FeishuEpoch } from "../src/contracts/feishu";
import type { ChannelEnvelope } from "../src/contracts/channel";
import {
  createFeishuConnectionOwner,
  type FeishuConnectionCallbacks,
  type FeishuConnectionOwner,
  type FeishuDispatcherHandlers,
  type FeishuEventDispatcherLike,
  type FeishuWsClientLike,
} from "../src/server/feishu/owner";
import {
  classifyFeishuMessageEvent,
  createFeishuIngressHandlers,
  FEISHU_CARD_EVENT,
  FEISHU_MESSAGE_EVENT,
} from "../src/server/feishu/ingress";
import { channelNativeFixture } from "./fixtures/channel-native";

const f = await channelNativeFixture();
afterAll(() => f.close());

type Scenario = ReturnType<typeof f.scenario>;

type FakeClient = {
  callbacks: FeishuConnectionCallbacks;
  handlers: FeishuDispatcherHandlers;
  closed: boolean;
  started: boolean;
  status: () => { state: string };
};

/** 每个 owner 一份假 client：记录 SDK 回调与经过代数围栏的 handler。 */
function harness(s: Scenario) {
  const clients: FakeClient[] = [];
  const opened: FeishuEpoch[] = [];
  const errors: unknown[] = [];
  let clock = s.now;
  let slot: FakeClient | null = null;
  const lifecycle = {
    ready: (at = clock) => {
      const epoch = s.lifecycle.ready(at);
      opened.push(epoch);
      return epoch;
    },
    reconnected: (at = clock) => {
      const epoch = s.lifecycle.reconnected(at);
      opened.push(epoch);
      return epoch;
    },
    disconnected: (epoch: FeishuEpoch, at = clock) => s.lifecycle.disconnected(epoch, at),
  };
  const owner: FeishuConnectionOwner = createFeishuConnectionOwner({
    appId: s.identity.appId,
    lifecycle,
    createClient: (callbacks) => {
      const client: FakeClient = {
        callbacks,
        handlers: {},
        closed: false,
        started: false,
        status: () => ({ state: "reconnecting" }),
      };
      clients.push(client);
      slot = client;
      return {
        start: () => {
          client.started = true;
        },
        close: () => {
          client.closed = true;
        },
        getConnectionStatus: client.status,
      } satisfies FeishuWsClientLike;
    },
    createDispatcher: (handlers): FeishuEventDispatcherLike => {
      slot!.handlers = handlers;
      return { register: () => undefined };
    },
    createHandlers: ({ currentEpoch }) =>
      createFeishuIngressHandlers({
        appId: s.identity.appId,
        currentEpoch,
        captureScope: (identity, epoch) =>
          f.feishu.captureFeishuAdmissionScope(s.project.id, identity, epoch),
        admitText: (event, scope, requestId) => f.feishu.admitFeishuText(event, scope, requestId),
        finishChallenge: (opaque, identity, requestId) =>
          f.feishu.finishFeishuChallenge(s.project.id, opaque, identity, requestId),
        isChallengeCode: (text) => f.feishu.isFeishuChallengeCode(text),
        consumeAction: (identity, scope, token, at) =>
          f.delivery.consumeFeishuAction(identity, scope, token, at),
        now: () => clock,
        requestId: () => "req_ingress",
        onDiagnostic: () => undefined,
      }),
    now: () => clock,
    onError: (error) => errors.push(error),
  });
  return {
    owner,
    clients,
    opened,
    errors,
    get epoch() {
      return opened.at(-1)!;
    },
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

function nativeMessages(chatId: string): number {
  return (
    f.sqlite.prepare("SELECT count(*) n FROM message WHERE chat_id=?").get(chatId) as { n: number }
  ).n;
}

// 平台 create_time 必须落在 fixture 时钟附近，否则会被当成不可信时间戳。
const trustedTime = (s: Scenario, offset = 0) => String(s.now.getTime() + offset);

type MessageExtras = Readonly<{
  senderType?: string;
  chatType?: string;
  openId?: string | null;
  messageType?: string;
  appId?: string;
  createTime?: string;
}>;

function messageEvent(s: Scenario, messageId: string, text: string, extras: MessageExtras = {}) {
  const openId = extras.openId === undefined ? s.identity.openId : extras.openId;
  return {
    app_id: extras.appId ?? s.identity.appId,
    tenant_key: s.identity.tenantKey,
    event_id: `evt-${messageId}`,
    create_time: trustedTime(s),
    sender: {
      sender_id: openId === null ? {} : { open_id: openId },
      sender_type: extras.senderType ?? "user",
    },
    message: {
      message_id: messageId,
      chat_id: openId ?? "chat",
      chat_type: extras.chatType ?? "p2p",
      message_type: extras.messageType ?? "text",
      content: JSON.stringify({ text }),
      create_time: extras.createTime ?? trustedTime(s, 1_000),
    },
  };
}

function cardEvent(
  s: Scenario,
  token: string,
  extras: Readonly<{ openId?: string; appId?: string }> = {},
) {
  return {
    app_id: extras.appId ?? s.identity.appId,
    tenant_key: s.identity.tenantKey,
    event_id: `evt-card-${token.slice(0, 6)}`,
    operator: { open_id: extras.openId ?? s.identity.openId, tenant_key: s.identity.tenantKey },
    action: { value: { token }, tag: "button" },
  };
}

function proposalCardToken(s: Scenario): string {
  const source = s.principal();
  f.assistant.createAssistantProposal(
    source,
    { kind: "dm_agent", projectId: s.project.id, agentProfileId: s.worker.id },
    "确认后执行的工作",
    s.now,
  );
  const row = f.sqlite
    .prepare(
      "SELECT envelope FROM channel_delivery WHERE json_extract(route,'$.chatId')=? AND json_extract(envelope,'$.kind')='card' ORDER BY rowid DESC LIMIT 1",
    )
    .get(s.dm.id) as { envelope: string };
  const envelope = JSON.parse(row.envelope) as ChannelEnvelope;
  if (envelope.kind !== "card") throw new Error("expected card envelope");
  return envelope.actions[0]!.token;
}

it("admits one p2p text into the native DM and treats a redelivery as a duplicate", () => {
  const s = f.scenario();
  s.bind();
  const h = harness(s);
  h.owner.start();
  h.clients[0]!.callbacks.onReady();
  expect(h.owner.snapshot().phase).toBe("connected");
  const before = nativeMessages(s.dm.id);

  const event = messageEvent(s, "om_native_input", "帮我总结一下");
  expect(h.clients[0]!.handlers[FEISHU_MESSAGE_EVENT]!(event)).toEqual({});
  expect(nativeMessages(s.dm.id)).toBe(before + 1);
  // 同一 event_id 再投一次：命中 receipt，不再造第二条原生消息。
  expect(h.clients[0]!.handlers[FEISHU_MESSAGE_EVENT]!(event)).toEqual({});
  expect(nativeMessages(s.dm.id)).toBe(before + 1);
  const bodies = f.sqlite
    .prepare("SELECT body FROM message WHERE chat_id=? ORDER BY rowid")
    .all(s.dm.id) as { body: string }[];
  expect(bodies.at(-1)!.body).toBe("帮我总结一下");
  h.owner.stop();
});

it("stops admitting a chat once its Human unbinds it", () => {
  const s = f.scenario();
  s.bind();
  const h = harness(s);
  h.owner.start();
  h.clients[0]!.callbacks.onReady();
  const before = nativeMessages(s.dm.id);
  f.feishu.unbindFeishuIdentity(
    s.project.id,
    f.feishu.getFeishuBinding(s.project.id, s.ctx).revision,
    s.ctx,
  );
  expect(
    h.clients[0]!.handlers[FEISHU_MESSAGE_EVENT]!(messageEvent(s, "om_after_unbind", "解绑之后")),
  ).toEqual({});
  expect(nativeMessages(s.dm.id)).toBe(before);
  const receipts = f.sqlite
    .prepare("SELECT COUNT(*) AS n FROM feishu_inbound_receipt WHERE platform_message_id=?")
    .get("om_after_unbind") as { n: number };
  expect(receipts.n).toBe(0);
  h.owner.stop();
});

it.each([
  ["self", { senderType: "app" }],
  ["bot", { senderType: "bot" }],
  ["group", { chatType: "group" }],
  ["image", { messageType: "image" }],
  ["foreign app", { appId: "cli_ffffffffffffffff" }],
  ["stale timestamp", { createTime: "1700000000000" }],
  ["missing open_id", { openId: null }],
] as const)("rejects %s input without creating a native message", (_name, extras) => {
  const s = f.scenario();
  s.bind();
  const h = harness(s);
  h.owner.start();
  h.clients[0]!.callbacks.onReady();
  const before = nativeMessages(s.dm.id);
  expect(
    h.clients[0]!.handlers[FEISHU_MESSAGE_EVENT]!(messageEvent(s, "om_rejected", "text", extras)),
  ).toEqual({});
  expect(nativeMessages(s.dm.id)).toBe(before);
  h.owner.stop();
});

it("never admits input while the epoch is closed and never replays it after reconnect", () => {
  const s = f.scenario();
  s.bind();
  const h = harness(s);
  h.owner.start();
  h.clients[0]!.callbacks.onReady();
  const before = nativeMessages(s.dm.id);
  const firstEpoch = h.epoch.id;

  h.clients[0]!.callbacks.onReconnecting();
  const duringOutage = h.owner.snapshot();
  expect(duringOutage.phase).toBe("reconnecting");
  expect(duringOutage.epochId).toBeNull();
  expect(
    h.clients[0]!.handlers[FEISHU_MESSAGE_EVENT]!(messageEvent(s, "om_offline", "断线期间")),
  ).toEqual({});
  expect(nativeMessages(s.dm.id)).toBe(before);

  // 假 client 的 getConnectionStatus 一直回 reconnecting：owner 不能据此改写已完成的重连。
  expect(h.clients[0]!.status().state).toBe("reconnecting");
  h.clients[0]!.callbacks.onReconnected();
  expect(h.owner.snapshot().phase).toBe("connected");
  expect(h.epoch.id).not.toBe(firstEpoch);
  expect(
    h.clients[0]!.handlers[FEISHU_MESSAGE_EVENT]!(messageEvent(s, "om_online", "重连之后")),
  ).toEqual({});
  expect(nativeMessages(s.dm.id)).toBe(before + 1);
  expect(
    f.sqlite
      .prepare("SELECT count(*) n FROM feishu_inbound_receipt WHERE message_id=?")
      .get("om_offline"),
  ).toEqual({ n: 0 });
  h.owner.stop();
});

it("fences a replaced owner: stale callbacks cannot admit or change the current epoch", () => {
  const s = f.scenario();
  s.bind();
  const first = harness(s);
  first.owner.start();
  const stale = first.clients[0]!;
  stale.callbacks.onReady();
  const firstEpoch = first.owner.snapshot().epochId;
  const before = nativeMessages(s.dm.id);

  const second = harness(s);
  second.owner.start();
  expect(stale.closed).toBe(true);
  second.clients[0]!.callbacks.onReady();
  expect(second.owner.snapshot().generation).toBe(1);

  // 旧代号的回调即使晚到也进不了领域层。
  expect(stale.handlers[FEISHU_MESSAGE_EVENT]!(messageEvent(s, "om_stale", "迟到的输入"))).toEqual(
    {},
  );
  stale.callbacks.onReady();
  expect(second.owner.snapshot().epochId).not.toBe(firstEpoch);
  expect(nativeMessages(s.dm.id)).toBe(before);
  second.owner.stop();
});

it("tells a late card tap it expired instead of answering nothing", () => {
  const s = f.scenario();
  s.bind();
  const h = harness(s);
  h.owner.start();
  const client = h.clients[0]!;
  client.callbacks.onReady();
  const token = proposalCardToken(s);
  h.owner.stop();
  const reply = client.handlers[FEISHU_CARD_EVENT]!(cardEvent(s, token)) as FeishuCardAck;
  expect(reply.toast?.type).toBe("error");
  expect(reply.toast?.content).toContain("失效");
});

it("ignores a stale reconnect instead of closing the current epoch", () => {
  const s = f.scenario();
  s.bind();
  const first = harness(s);
  first.owner.start();
  const stale = first.clients[0]!;
  stale.callbacks.onReady();
  const second = harness(s);
  second.owner.start();
  second.clients[0]!.callbacks.onReady();
  const live = second.owner.snapshot();
  stale.callbacks.onReconnecting();
  stale.callbacks.onReconnected();
  expect(second.owner.snapshot().epochId).toBe(live.epochId);
  expect(second.owner.snapshot().phase).toBe(live.phase);
  // 当前连接仍能收输入，说明旧代号没有把它关掉。
  const before = nativeMessages(s.dm.id);
  second.clients[0]!.handlers[FEISHU_MESSAGE_EVENT]!(messageEvent(s, "om_live", "还活着"));
  expect(nativeMessages(s.dm.id)).toBe(before + 1);
  second.owner.stop();
});

it("stops the client and rejects callbacks after shutdown", () => {
  const s = f.scenario();
  s.bind();
  const h = harness(s);
  h.owner.start();
  h.clients[0]!.callbacks.onReady();
  const client = h.clients[0]!;
  const stopped = h.owner.stop();
  expect(stopped.phase).toBe("stopped");
  expect(stopped.epochId).toBeNull();
  expect(client.closed).toBe(true);
  const before = nativeMessages(s.dm.id);
  expect(
    client.handlers[FEISHU_MESSAGE_EVENT]!(messageEvent(s, "om_after_stop", "关闭之后")),
  ).toEqual({});
  expect(nativeMessages(s.dm.id)).toBe(before);
  expect(
    f.sqlite
      .prepare(
        "SELECT count(*) n FROM feishu_connection_epoch WHERE app_id=? AND closed_at_ms IS NULL",
      )
      .get(s.identity.appId),
  ).toEqual({ n: 0 });
});

it("confirms a delivered card exactly once and answers without echoing results", () => {
  const s = f.scenario();
  s.bind();
  const h = harness(s);
  h.owner.start();
  h.clients[0]!.callbacks.onReady();
  const token = proposalCardToken(s);
  const handler = h.clients[0]!.handlers[FEISHU_CARD_EVENT]!;

  const first = handler(cardEvent(s, token)) as FeishuCardAck;
  expect(first.toast?.type).toBe("success");
  expect(first.toast?.content).toBe("已处理，结果见 Web 对话");
  expect(JSON.stringify(first)).not.toContain("submitted");
  const workMessages = f.sqlite
    .prepare("SELECT count(*) n FROM message WHERE chat_id=? AND body=?")
    .get(s.work.id, "确认后执行的工作") as { n: number };
  expect(workMessages.n).toBe(1);

  // 同一个 token 再来一次：已消费 → 只回「失效」，不会执行第二次。
  // 重放同一个 token 幂等：返回同一次结果，但绝不执行第二次。
  const duplicate = handler(cardEvent(s, token)) as FeishuCardAck;
  expect(duplicate.toast?.type).toBe("success");
  const again = f.sqlite
    .prepare("SELECT count(*) n FROM message WHERE chat_id=? AND body=?")
    .get(s.work.id, "确认后执行的工作") as { n: number };
  expect(again.n).toBe(1);
  h.owner.stop();
});

it.each(["altered", "foreign identity", "expired"] as const)(
  "rejects a %s card token without executing the action",
  (mode) => {
    const s = f.scenario();
    s.bind();
    const h = harness(s);
    h.owner.start();
    h.clients[0]!.callbacks.onReady();
    const token = proposalCardToken(s);
    const handler = h.clients[0]!.handlers[FEISHU_CARD_EVENT]!;
    const receiptsBefore = (
      f.sqlite.prepare("SELECT count(*) n FROM channel_action_receipt").get() as { n: number }
    ).n;
    let event: unknown;
    if (mode === "altered") event = cardEvent(s, `${token}x`);
    else if (mode === "foreign identity") event = cardEvent(s, token, { openId: "other-human" });
    else {
      h.advance(11 * 60_000);
      event = cardEvent(s, token);
    }
    const ack = handler(event) as FeishuCardAck;
    expect(ack.toast?.type).toBe("error");
    expect(ack.toast?.content).toBe("这个操作已失效，请到 Web 查看");
    const status = f.sqlite
      .prepare("SELECT status FROM assistant_proposal ORDER BY rowid DESC LIMIT 1")
      .get() as { status: string };
    expect(status.status).toBe("pending");
    expect(
      (f.sqlite.prepare("SELECT count(*) n FROM channel_action_receipt").get() as { n: number }).n,
    ).toBe(receiptsBefore);
    h.owner.stop();
  },
);

it("names the gate that rejected a message instead of a bare unsupported_message", () => {
  const base = {
    app_id: "cli_test",
    tenant_key: "tnt",
    event_id: "evt-reject",
    create_time: "1794279931000",
    sender: { sender_id: { open_id: "ou_human" }, sender_type: "user" },
    message: {
      message_id: "om_reject",
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "123456" }),
      create_time: "1794279931000",
    },
  };
  const withMessage = (patch: Record<string, unknown>) => ({
    ...base,
    message: { ...base.message, ...patch },
  });

  expect(classifyFeishuMessageEvent(base, "cli_test").ok).toBe(true);
  expect(classifyFeishuMessageEvent(withMessage({ chat_type: "group" }), "cli_test")).toEqual({
    ok: false,
    reason: "chat_type:group",
  });
  expect(classifyFeishuMessageEvent(withMessage({ message_type: "image" }), "cli_test")).toEqual({
    ok: false,
    reason: "message_type:image",
  });
  expect(
    classifyFeishuMessageEvent(
      { ...base, sender: { ...base.sender, sender_type: "app" } },
      "cli_test",
    ),
  ).toEqual({ ok: false, reason: "sender_type:app" });
  expect(classifyFeishuMessageEvent(withMessage({ content: "not json" }), "cli_test")).toEqual({
    ok: false,
    reason: "payload:message.content",
  });
});

it("admits a message whose unused sender ids arrive as empty strings or null", () => {
  const event = {
    app_id: "cli_test",
    tenant_key: "tnt",
    event_id: null,
    create_time: "1794279931000",
    sender: {
      sender_id: { open_id: "ou_human", union_id: "", user_id: null },
      sender_type: "user",
      tenant_key: null,
    },
    message: {
      message_id: "om_empty_ids",
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "123456" }),
      create_time: "1794279931000",
    },
  };
  const admission = classifyFeishuMessageEvent(event, "cli_test");
  expect(admission.ok).toBe(true);
  if (admission.ok) {
    expect(admission.message.identity.openId).toBe("ou_human");
    expect(admission.message.rawEventId).toBeNull();
  }
});
