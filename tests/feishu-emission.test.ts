import { afterAll, expect, it } from "vite-plus/test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChannelOutcome, ChannelRequest } from "../src/contracts/channel";
import type { FeishuTransportConfig } from "../src/contracts/feishu-channel";
import {
  FeishuHttpFailure,
  classifyFeishuResponse,
  createFeishuEmissionPort,
  createFeishuTokenSource,
  nodeHttpsTransport,
  type FeishuHttpTransport,
} from "../src/server/feishu/emission";
import { channelNativeFixture } from "./fixtures/channel-native";

const f = await channelNativeFixture();

type PlatformMode =
  | "accepted"
  | "rate_limited"
  | "bot_not_in_chat"
  | "server_error"
  | "malformed"
  | "missing_id"
  | "destroy";

const platform = {
  tokenMode: "ok" as "ok" | "error",
  mode: "accepted" as PlatformMode,
  tokenRequests: 0,
  messages: [] as { path: string; body: string; authorization: string }[],
  /** 置位后消息响应先挂起，用来制造「响应未完成时另一个 writer 解绑」的真实竞态。 */
  hold: false,
  held: [] as ServerResponse[],
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function tokenReply(response: ServerResponse) {
  platform.tokenRequests += 1;
  if (platform.tokenMode === "error") {
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"code":99991663,"msg":"token endpoint unavailable"}');
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ code: 0, tenant_access_token: "t-1", expire: 7200 }));
}

function messageReply(response: ServerResponse, body: string) {
  platform.messages.push({
    path: "/open-apis/im/v1/messages",
    body,
    authorization: String(response.req.headers.authorization ?? ""),
  });
  if (platform.hold) {
    platform.held.push(response);
    return;
  }
  replyPlatform(response);
}

function replyPlatform(response: ServerResponse) {
  const json = (payload: unknown) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  switch (platform.mode) {
    case "accepted":
      return json({ code: 0, data: { message_id: "om_platform_1" } });
    case "rate_limited":
      return json({ code: 230020, msg: "too many request" });
    case "bot_not_in_chat":
      return json({ code: 230002, msg: "bot is not in the chat" });
    case "server_error":
      response.writeHead(502, { "content-type": "text/html" });
      return response.end("<html>bad gateway</html>");
    case "malformed":
      response.writeHead(200, { "content-type": "application/json" });
      return response.end("not json at all");
    case "missing_id":
      return json({ code: 0, data: {} });
    case "destroy":
      return response.req.socket.destroy();
  }
}

const server: Server = createServer((request, response) => {
  void readBody(request).then((body) => {
    const path = request.url ?? "";
    if (path.endsWith("/auth/v3/tenant_access_token/internal")) return tokenReply(response);
    if (path.startsWith("/open-apis/im/v1/messages")) return messageReply(response, body);
    response.writeHead(404).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const config: FeishuTransportConfig = Object.freeze({
  appId: "cli_0123456789abcdef",
  appSecret: "local-test-secret-never-logs",
  origin,
  enabled: true,
});

function makePort(transport: FeishuHttpTransport = nodeHttpsTransport) {
  return createFeishuEmissionPort({
    config,
    transport,
    tokens: createFeishuTokenSource({ config, transport }),
  });
}

type DeliveryRow = {
  id: string;
  uuid: string;
  route: string;
  envelope: string;
  state: string;
  attempts: number;
  error: string | null;
  platform_message_id: string | null;
};

function latestDelivery(chatId: string): DeliveryRow {
  const row = f.sqlite
    .prepare(
      "SELECT * FROM channel_delivery WHERE json_extract(route,'$.chatId')=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(chatId) as DeliveryRow | undefined;
  if (!row) throw new Error("no delivery");
  return row;
}

function deliveryById(id: string): DeliveryRow {
  return f.sqlite.prepare("SELECT * FROM channel_delivery WHERE id=?").get(id) as DeliveryRow;
}

/** 只留这一行 ready，避免同库其它用例留下的投递抢走 claim。 */
function onlyReady(id: string) {
  f.sqlite
    .prepare("UPDATE channel_delivery SET state='failed' WHERE id<>? AND state='ready'")
    .run(id);
}

function requestOf(row: DeliveryRow): ChannelRequest {
  return {
    deliveryId: row.id,
    uuid: row.uuid,
    route: JSON.parse(row.route) as ChannelRequest["route"],
    envelope: JSON.parse(row.envelope) as ChannelRequest["envelope"],
  };
}

function queued(s: ReturnType<typeof f.scenario>): DeliveryRow {
  const row = latestDelivery(s.dm.id);
  onlyReady(row.id);
  return row;
}

afterAll(() => {
  server.close();
  f.close();
});

it("prepares a text body for the bound open_id and initiates exactly one request inside begin", async () => {
  platform.mode = "accepted";
  platform.messages = [];
  const s = f.scenario();
  s.bind();
  s.reply("同步发起的回答");
  const row = queued(s);

  let calls = 0;
  const transport: FeishuHttpTransport = (input) => {
    calls += 1;
    return nodeHttpsTransport(input);
  };
  const tokens = createFeishuTokenSource({ config, transport });
  const port = createFeishuEmissionPort({ config, transport, tokens });
  await tokens.get();
  calls = 0;

  const prepared = await port.prepare(requestOf(row));
  expect(calls).toBe(0);
  const handle = port.begin(prepared);
  // begin 返回时 I/O 已经发起：没有 await，也没有裸 Promise。
  expect(calls).toBe(1);
  expect(handle.initiated).toBe(true);
  expect(await handle.completion).toEqual({ kind: "accepted", messageId: "om_platform_1" });

  const sent = platform.messages.at(-1)!;
  const body = JSON.parse(sent.body) as Record<string, unknown>;
  expect(body.receive_id).toBe(s.identity.openId);
  expect(body.msg_type).toBe("text");
  expect(body.uuid).toBe(row.uuid);
  expect(JSON.parse(String(body.content))).toEqual({ text: "同步发起的回答" });
  expect(sent.authorization).toBe("Bearer t-1");
  // 凭据只以 Bearer 头里的 token 形式出现，永远不落在请求正文或 URL 里。
  expect(sent.body).not.toContain(config.appSecret);
  expect(sent.path).not.toContain(config.appSecret);
});

it.each([
  ["accepted", { kind: "accepted", messageId: "om_platform_1" }],
  ["rate_limited", { kind: "not_accepted", code: "rate_limited" }],
  ["bot_not_in_chat", { kind: "uncertain", code: "ambiguous" }],
  ["server_error", { kind: "uncertain", code: "ambiguous" }],
  ["malformed", { kind: "uncertain", code: "ambiguous" }],
  ["missing_id", { kind: "uncertain", code: "ambiguous" }],
  ["destroy", { kind: "uncertain", code: "ack_lost" }],
] as const)(
  "classifies a %s platform reply without guessing acceptance",
  async (mode, expected) => {
    platform.mode = mode;
    platform.messages = [];
    const s = f.scenario();
    s.bind();
    s.reply(`结果：${mode}`);
    const row = queued(s);
    const prepared = await makePort().prepare(requestOf(row));
    const outcome = await makePort().begin(prepared).completion;
    expect(outcome).toEqual(expected as ChannelOutcome);
  },
);

it("keeps unparsable or non-200 bodies uncertain at the classification boundary", () => {
  expect(classifyFeishuResponse({ status: 200, body: '{"code":0}' })).toEqual({
    kind: "uncertain",
    code: "ambiguous",
  });
  expect(classifyFeishuResponse({ status: 200, body: '{"code":0,"data":[]}' })).toEqual({
    kind: "uncertain",
    code: "ambiguous",
  });
  expect(
    classifyFeishuResponse({ status: 429, body: '{"code":0,"data":{"message_id":"x"}}' }),
  ).toEqual({ kind: "uncertain", code: "ambiguous" });
});

it("keeps a text body oversized-labelled instead of sending the full text", async () => {
  platform.mode = "accepted";
  platform.messages = [];
  const s = f.scenario();
  s.bind();
  s.reply("界".repeat(5_000));
  const row = queued(s);
  const prepared = await makePort().prepare(requestOf(row));
  const content = JSON.parse(JSON.parse(prepared.request.body).content) as { text: string };
  expect(Buffer.byteLength(content.text, "utf8")).toBeLessThan(1_000);
  expect(content.text).toContain("未在此发送完整内容");
});

it("leaves no armed attempt when prepare cannot obtain a tenant token", async () => {
  platform.tokenMode = "error";
  platform.tokenRequests = 0;
  const s = f.scenario();
  s.bind();
  s.reply("token 失败时不 arm");
  const row = queued(s);
  const outcome = await f.delivery.emitNextFeishuDelivery(makePort());
  platform.tokenMode = "ok";
  expect(outcome).toBe(row.id);
  const after = deliveryById(row.id);
  expect(after.state).toBe("failed");
  expect(after.error).toBe("prepare_failed");
  expect(after.attempts).toBe(0);
  expect(
    f.sqlite.prepare("SELECT count(*) n FROM channel_attempt WHERE delivery_id=?").get(row.id),
  ).toEqual({ n: 0 });
  // 换 token 有硬超时/失败上限，不会把 prepare 挂住：第二次仍会重新尝试换取。
  expect(platform.tokenRequests).toBeGreaterThan(0);
});

it("retries a proven rate limit with the same uuid and never resends an uncertain result", async () => {
  platform.mode = "rate_limited";
  platform.messages = [];
  const s = f.scenario();
  s.bind();
  s.reply("限流后重试");
  const row = queued(s);
  const port = makePort();
  await f.delivery.emitNextFeishuDelivery(port);
  const afterRateLimit = deliveryById(row.id);
  expect(afterRateLimit.state).toBe("ready");
  expect(afterRateLimit.attempts).toBe(1);

  platform.mode = "accepted";
  const later = () => new Date(Date.now() + 5_000);
  await f.delivery.emitNextFeishuDelivery(port, { now: later });
  const afterRetry = deliveryById(row.id);
  expect(afterRetry.state).toBe("accepted");
  expect(afterRetry.platform_message_id).toBe("om_platform_1");
  const bodies = platform.messages.map(
    (entry) => JSON.parse(entry.body) as { uuid: string; content: string },
  );
  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.uuid).toBe(row.uuid);
  expect(bodies[1]!.uuid).toBe(row.uuid);
  expect(bodies[1]!.content).toBe(bodies[0]!.content);

  platform.mode = "destroy";
  platform.messages = [];
  const uncertainCase = f.scenario();
  uncertainCase.bind();
  uncertainCase.reply("应答丢失");
  const lost = queued(uncertainCase);
  await f.delivery.emitNextFeishuDelivery(port);
  const afterLoss = deliveryById(lost.id);
  expect(afterLoss.state).toBe("uncertain");
  expect(platform.messages).toHaveLength(1);
  await f.delivery.emitNextFeishuDelivery(port, { now: later });
  expect(platform.messages).toHaveLength(1);
});

it("lets another writer unbind while the real HTTP response is still pending", async () => {
  const s = f.scenario();
  s.bind();
  s.reply("挂起期间被解绑");
  const row = queued(s);

  platform.hold = true;
  platform.held = [];
  const pending = f.delivery.emitNextFeishuDelivery(makePort());
  const startedAt = Date.now();
  while (platform.held.length === 0) {
    if (Date.now() - startedAt > 5_000) throw new Error("request never reached the platform");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // 请求已经在飞，投递不持有写事务：另一个 writer 立即可以解绑。
  expect(f.sqlite.inTransaction).toBe(false);
  const unbound = f.feishu.unbindFeishuIdentity(f.feishu.getFeishuBinding(s.ctx).revision, s.ctx);
  expect(unbound.bound).toBe(false);
  platform.hold = false;
  platform.mode = "accepted";
  replyPlatform(platform.held[0]!);
  await pending;
  const after = deliveryById(row.id);
  expect(after.state).toBe("accepted");
  expect(after.platform_message_id).toBe("om_platform_1");
});

it("sends a card as interactive content whose buttons carry only opaque tokens", async () => {
  platform.mode = "accepted";
  platform.messages = [];
  const s = f.scenario();
  const { scope } = s.bind();
  const source = s.principal();
  f.assistant.createAssistantProposal(
    source,
    { kind: "dm_agent", projectId: s.project.id, agentProfileId: s.worker.id },
    "需要确认的工作",
    s.now,
  );
  const cardRow = f.sqlite
    .prepare(
      "SELECT * FROM channel_delivery WHERE json_extract(route,'$.chatId')=? AND json_extract(envelope,'$.kind')='card' ORDER BY rowid DESC LIMIT 1",
    )
    .get(s.dm.id) as DeliveryRow;
  onlyReady(cardRow.id);
  const prepared = await makePort().prepare(requestOf(cardRow));
  const outer = JSON.parse(prepared.request.body) as { msg_type: string; content: string };
  expect(outer.msg_type).toBe("interactive");
  const content = JSON.parse(outer.content) as {
    elements: {
      tag: string;
      text?: { content: string };
      actions?: { value: { token: string } }[];
    }[];
  };
  expect(content.elements[0]?.text?.content).toContain("需要确认的工作");
  const tokens = content.elements[1]?.actions?.map((action) => action.value.token) ?? [];
  expect(tokens.length).toBeGreaterThan(0);
  expect(tokens.every((token) => token.length > 0)).toBe(true);
  expect(outer.content).not.toContain("submitted");
  expect(scope.epoch.appId).toBe(s.identity.appId);
});

it("bounds token preparation with its own deadline even if the transport hangs", async () => {
  let aborts = 0;
  const tokens = createFeishuTokenSource({
    config,
    timeoutMs: 20,
    transport: () => ({
      initiated: true,
      response: new Promise(() => {}),
      abort: () => {
        aborts += 1;
      },
    }),
  });
  const startedAt = Date.now();
  await expect(tokens.get()).rejects.toMatchObject({ code: "token_unavailable" });
  expect(Date.now() - startedAt).toBeLessThan(1_500);
  expect(aborts).toBeGreaterThan(0);
  // 失败不缓存：下一次调用重新尝试，而不是拿着坏状态继续。
  await expect(tokens.get()).rejects.toMatchObject({ code: "token_unavailable" });
  expect(aborts).toBeGreaterThan(1);
});

it("maps a transport timeout into an uncertain timeout outcome", async () => {
  const transport: FeishuHttpTransport = () =>
    ({
      initiated: true,
      response: Promise.reject(new FeishuHttpFailure("timeout")),
      abort: () => {},
    }) satisfies ReturnType<FeishuHttpTransport>;
  const s = f.scenario();
  s.bind();
  s.reply("超时");
  const row = queued(s);
  const tokens = { get: () => Promise.resolve("t-1") };
  const port = createFeishuEmissionPort({ config, transport, tokens });
  const outcome = await port.begin(await port.prepare(requestOf(row))).completion;
  expect(outcome).toEqual({ kind: "uncertain", code: "timeout" });
});
